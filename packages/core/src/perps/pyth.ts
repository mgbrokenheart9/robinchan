import type { PerpMarketDef } from '@robinchan/shared';
import { PERP_MARKETS } from '@robinchan/shared';
import type { Hex } from 'viem';

import { publicClient } from '../chain';
import { PYTH_ROUND_FEED_ABI } from './abi';
import { chainNow } from './chain';
import { perpsVenue } from './config';
import { keeperWallet } from './keeper';

/**
 * The agri markets' Pyth side (contracts/contracts/oracles/PythRoundFeed.sol):
 * the keeper brings each round's price on chain from Hermes, carries out the
 * futures rolls, and — when its wallet owns the feeds — announces the next
 * roll a day or more ahead. A round is Pyth's first print at or after the
 * feed's `nextSlot`, which the contract checks, so the keeper only decides
 * when a round lands, never which price it carries.
 *
 * Hermes needs an API key (PYTH_API_KEY), and a plan that covers commodities:
 * without one it answers 403 and the markets stay without rounds.
 */

const HERMES_URL = (): string => process.env.HERMES_URL?.trim() || 'https://hermes.pyth.network';
const hermesKey = (): string | null => process.env.PYTH_API_KEY?.trim() || null;

/** A round is pushed this long after its slot opens: Hermes has the print by then. */
const PUSH_LAG_SEC = 5;
/** Rounds pushed per feed per run: catching up after downtime takes a few runs, a slot at a time. */
const MAX_PUSHES_PER_RUN = 6;
/** PythRoundFeed.ROLL_NOTICE, and the margin a scheduled roll keeps above it. */
const ROLL_NOTICE_SEC = 86_400;
const ROLL_NOTICE_MARGIN_SEC = 600;
/** A roll is announced once it's this close. */
const ROLL_ANNOUNCE_WITHIN_SEC = 7 * 86_400;
/** PythRoundFeed.ROLL_DEADLINE. */
const ROLL_DEADLINE_SEC = 3_600;

const PYTH_FEE_ABI = [
  {
    type: 'function',
    name: 'getUpdateFee',
    stateMutability: 'view',
    inputs: [{ name: 'updateData', type: 'bytes[]' }],
    outputs: [{ name: 'feeAmount', type: 'uint256' }],
  },
] as const;

export class HermesForbidden extends Error {}

export type HermesPrint = { data: Hex; publishTime: number; prevPublishTime: number };

/** The markets with a deployed PythRoundFeed. */
export function pythRoundMarkets(): Array<PerpMarketDef & { pyth: NonNullable<PerpMarketDef['pyth']> & { roundFeed: Hex } }> {
  return PERP_MARKETS.filter((m): m is PerpMarketDef & { pyth: NonNullable<PerpMarketDef['pyth']> & { roundFeed: Hex } } => Boolean(m.pyth?.roundFeed));
}

async function hermes(path: string): Promise<Response> {
  const key = hermesKey();
  const res = await fetch(`${HERMES_URL()}${path}`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 403) throw new HermesForbidden('Hermes answered 403: the Pyth plan does not cover this feed');
  return res;
}

type HermesBody = {
  binary: { data: string[] };
  parsed: Array<{ id: string; price: { publish_time: number }; metadata?: { prev_publish_time?: number } }>;
};

/** Hermes' update for `feedId` at second `t` — null when nothing printed then (a closed market). */
export async function hermesAt(feedId: Hex, t: number): Promise<HermesPrint | null> {
  const res = await hermes(`/v2/updates/price/${t}?ids[]=${feedId}&parsed=true`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Hermes ${res.status} at ${t}`);
  const body = (await res.json()) as HermesBody;
  const p = body.parsed[0];
  const data = body.binary.data[0];
  if (!p || !data) return null;
  return { data: `0x${data}` as Hex, publishTime: p.price.publish_time, prevPublishTime: p.metadata?.prev_publish_time ?? 0 };
}

/** When `feedId` last printed. */
export async function hermesLatest(feedId: Hex): Promise<number | null> {
  const res = await hermes(`/v2/updates/price/latest?ids[]=${feedId}&parsed=true`);
  if (!res.ok) return null;
  const body = (await res.json()) as HermesBody;
  return body.parsed[0]?.price.publish_time ?? null;
}

/**
 * Pyth's first print of `feedId` at or after `t`, or null if there's none
 * yet. Hermes answers for a given second, and 404 for a second nothing
 * printed in — every second of a closed market — so after a closure the
 * reopening print is found by bisecting between `t` and the latest print.
 * `at` is injectable for tests.
 */
export async function firstPrintAtOrAfter(
  feedId: Hex,
  t: number,
  at: (feedId: Hex, t: number) => Promise<HermesPrint | null> = hermesAt,
  latest: (feedId: Hex) => Promise<number | null> = hermesLatest,
): Promise<HermesPrint | null> {
  const exact = await at(feedId, t);
  if (exact && exact.prevPublishTime < t) return exact;
  const last = await latest(feedId);
  if (last == null || last < t) return null;
  let lo = t;
  let hi = last;
  let found = await at(feedId, hi);
  if (!found) return null;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const p = await at(feedId, mid);
    if (p) {
      hi = mid;
      found = p;
    } else {
      lo = mid;
    }
  }
  // The contract's own check: the print before it came before `t`.
  return found.prevPublishTime < t ? found : null;
}

const warned = new Map<string, number>();
function warnOnce(key: string, message: string, everyMs = 3_600_000): void {
  const last = warned.get(key);
  if (last != null && Date.now() - last < everyMs) return;
  warned.set(key, Date.now());
  console.warn(message);
}

/**
 * Keeps every deployed PythRoundFeed current: carries out a roll that's due,
 * announces the next one when the keeper owns the feed, and pushes the
 * rounds whose slots have opened.
 */
export async function runPythRounds(): Promise<{ pushed: number; rolled: number; scheduled: number }> {
  const out = { pushed: 0, rolled: 0, scheduled: 0 };
  const markets = pythRoundMarkets();
  if (perpsVenue() !== 'agri-perp' || markets.length === 0) return out;
  if (!hermesKey()) {
    warnOnce('pyth:key', '[perps] PYTH_API_KEY is not set: the Pyth agri feeds get no rounds');
    return out;
  }
  const client = publicClient();
  const wallet = keeperWallet();
  if (!client || !wallet) return out;

  for (const def of markets) {
    const feed = def.pyth.roundFeed;
    try {
      const on = { address: feed, abi: PYTH_ROUND_FEED_ABI } as const;
      const nextSlot = async () => Number(await client.readContract({ ...on, functionName: 'nextSlot' }));
      const [feedId, pending, owner, pyth] = await Promise.all([
        client.readContract({ ...on, functionName: 'feedId' }),
        client.readContract({ ...on, functionName: 'pendingRoll' }),
        client.readContract({ ...on, functionName: 'owner' }),
        client.readContract({ ...on, functionName: 'pyth' }),
      ]);
      const [toFeedId, rollAtBig] = pending;
      const rollAt = Number(rollAtBig);
      const now = await chainNow();
      const fee = async (data: Hex[]) => client.readContract({ address: pyth, abi: PYTH_FEE_ABI, functionName: 'getUpdateFee', args: [data] });

      // A roll that's due: nothing can be pushed until it's carried out.
      if (rollAt > 0 && now >= rollAt && now <= rollAt + ROLL_DEADLINE_SEC) {
        const [from, to] = await Promise.all([firstPrintAtOrAfter(feedId, rollAt), firstPrintAtOrAfter(toFeedId, rollAt)]);
        if (!from || !to) continue;
        const data = [from.data, to.data];
        const hash = await wallet.writeContract({ address: feed, abi: PYTH_ROUND_FEED_ABI, functionName: 'executeRoll', args: [data], value: await fee(data) });
        await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
        out.rolled += 1;
        continue;
      }
      if (rollAt > 0 && now > rollAt + ROLL_DEADLINE_SEC) {
        warnOnce(`pyth:lapsed:${def.symbol}`, `[perps] ${def.symbol}: the roll announced for ${new Date(rollAt * 1000).toISOString()} lapsed — announce it again`);
      }

      // The next roll, announced a day or more ahead, when this wallet owns the feed.
      if (rollAt === 0 || now > rollAt + ROLL_DEADLINE_SEC) {
        const i = def.pyth.months.findIndex((m) => m.feedId.toLowerCase() === feedId.toLowerCase());
        const month = def.pyth.months[i];
        const next = def.pyth.months[i + 1];
        const due = month?.rollAt ? Math.floor(Date.parse(month.rollAt) / 1000) : null;
        if (due != null && next && due - now > ROLL_NOTICE_SEC + ROLL_NOTICE_MARGIN_SEC && due - now <= ROLL_ANNOUNCE_WITHIN_SEC) {
          if (owner.toLowerCase() === wallet.account.address.toLowerCase()) {
            const hash = await wallet.writeContract({ address: feed, abi: PYTH_ROUND_FEED_ABI, functionName: 'scheduleRoll', args: [next.feedId, BigInt(due)] });
            await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
            out.scheduled += 1;
          } else {
            warnOnce(`pyth:schedule:${def.symbol}`, `[perps] ${def.symbol}: roll to ${next.pythSymbol} due ${month?.rollAt}; the feed's owner has to announce it`);
          }
        } else if (month && !month.rollAt && !next) {
          warnOnce(`pyth:last:${def.symbol}`, `[perps] ${def.symbol}: on ${month.pythSymbol}, the last month listed — add the next one when Pyth lists it`, 86_400_000);
        }
      }

      // The rounds whose slots have opened, oldest first.
      for (let i = 0; i < MAX_PUSHES_PER_RUN; i++) {
        const slot = await nextSlot();
        if ((await chainNow()) < slot + PUSH_LAG_SEC) break;
        const print = await firstPrintAtOrAfter(feedId, slot);
        if (!print) break;
        const data = [print.data];
        const hash = await wallet.writeContract({ address: feed, abi: PYTH_ROUND_FEED_ABI, functionName: 'push', args: [data], value: await fee(data) });
        await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
        out.pushed += 1;
      }
    } catch (err) {
      if (err instanceof HermesForbidden) {
        warnOnce(`pyth:403:${def.symbol}`, `[perps] ${def.symbol}: ${err.message} — the markets stay without rounds until the plan does`);
      } else {
        warnOnce(`pyth:err:${def.symbol}`, `[perps] ${def.symbol} Pyth round failed: ${(err as Error).message.split('\n')[0]}`, 300_000);
      }
    }
  }
  return out;
}
