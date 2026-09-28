import { perpOracleFeeds, answerToUsd } from '@robinchan/shared';
import { createPublicClient, defineChain, http, type Hex, type PublicClient } from 'viem';

import { publicClient } from '../chain';
import { CHAINLINK_FEED_ABI } from './abi';
import { perpOracleRpcUrl, perpsOracleMode, perpsVenue } from './config';
import type { OraclePrice } from './prices';

/**
 * Chainlink Data Feeds, read straight from the chain: `latestRoundData` for
 * the price, `getRoundData` for the round an order settles on. No key, no
 * subscription — the feeds are public contracts.
 */

let oracle: { url: string; client: PublicClient } | null = null;

/** Robinhood Chain mainnet, where the registry's feeds live — with Multicall3, so reads batch. */
const robinhoodChain = (url: string) =>
  defineChain({
    id: 4663,
    name: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [url] } },
    contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
  });

/**
 * Where the feeds are read. On the on-chain venue against a live oracle,
 * that's the app's own chain (the contracts read the same feeds). Everywhere
 * else — paper, a local chain whose mock feeds mirror live prices, a server
 * with no venue — it's Robinhood Chain mainnet, where anyone can read them.
 */
export function oracleClient(): PublicClient | null {
  if (perpsVenue() === 'agri-perp' && perpsOracleMode() === 'chainlink') return publicClient();
  const url = perpOracleRpcUrl();
  if (oracle?.url !== url) {
    oracle = {
      url,
      client: createPublicClient({ chain: robinhoodChain(url), transport: http(url, { timeout: 8_000, retryCount: 1 }), batch: { multicall: true } }) as PublicClient,
    };
  }
  return oracle.client;
}

const decimalsCache = new Map<string, number>();

async function decimalsOf(client: PublicClient, feed: Hex): Promise<number> {
  const key = feed.toLowerCase();
  const known = decimalsCache.get(key);
  if (known != null) return known;
  const value = Number(await client.readContract({ address: feed, abi: CHAINLINK_FEED_ABI, functionName: 'decimals' }));
  decimalsCache.set(key, value);
  return value;
}

/** Every listed market's latest round, read in one multicall (one call each where Multicall3 is missing). */
export async function readOraclePrices(
  feeds: Array<{ symbol: string; feed: Hex }> = perpOracleFeeds(),
  client: PublicClient | null = oracleClient(),
): Promise<OraclePrice[]> {
  if (!client || !feeds.length) return [];
  // Each feed on its own: one that can't be read — a new round feed with no
  // round yet reverts — leaves its market without a price, not every market.
  const rounds = await Promise.all(
    feeds.map(async ({ symbol, feed }) => {
      try {
        const [roundId, answer, , updatedAt] = await client.readContract({ address: feed, abi: CHAINLINK_FEED_ABI, functionName: 'latestRoundData' });
        const decimals = await decimalsOf(client, feed);
        return { symbol, feed, roundId, answer, updatedAt, decimals };
      } catch {
        return null;
      }
    }),
  );
  return rounds
    .filter((r): r is NonNullable<typeof r> => r !== null && r.answer > 0n && r.updatedAt > 0n)
    .map((r) => ({
      symbol: r.symbol,
      feed: r.feed.toLowerCase() as Hex,
      price: answerToUsd(r.answer, r.decimals),
      publishTime: Number(r.updatedAt),
      roundId: r.roundId.toString(),
      source: 'chainlink' as const,
    }));
}

/**
 * A feed's rounds back to `sinceSec` (at most `maxRounds`), oldest first, in
 * USD — the worker's first chart bars for a market. Stops at a phase start.
 */
export async function roundHistory(
  client: PublicClient,
  feed: Hex,
  sinceSec: number,
  maxRounds = 600,
): Promise<Array<{ timeSec: number; price: number }>> {
  const [latestId, latestAnswer, , latestAt] = await client.readContract({ address: feed, abi: CHAINLINK_FEED_ABI, functionName: 'latestRoundData' });
  const decimals = await decimalsOf(client, feed);
  const out = [{ timeSec: Number(latestAt), price: answerToUsd(latestAnswer, decimals) }];
  const phase = latestId >> 64n;
  let round = latestId & 0xffffffffffffffffn;
  while (round > 1n && out.length < maxRounds && (out.at(-1) as { timeSec: number }).timeSec >= sinceSec) {
    const ids: bigint[] = [];
    for (let k = 1n; k <= 50n && round - k >= 1n; k += 1n) ids.push((phase << 64n) | (round - k));
    const batch = await Promise.all(
      ids.map((id) => client.readContract({ address: feed, abi: CHAINLINK_FEED_ABI, functionName: 'getRoundData', args: [id] }).catch(() => null)),
    );
    for (const r of batch) {
      if (!r || r[3] === 0n || r[1] <= 0n) continue;
      out.push({ timeSec: Number(r[3]), price: answerToUsd(r[1], decimals) });
    }
    round -= BigInt(ids.length);
  }
  // Newest first: keep the rounds since `sinceSec`, and the one in force at it.
  const cut = out.findIndex((r) => r.timeSec < sinceSec);
  return (cut === -1 ? out : out.slice(0, cut + 1)).reverse();
}

/** A round as the proofs read it. */
export type FeedRound = { roundId: bigint; startedAt: number; updatedAt: number };

/** What settles an order, as AgriFeed will prove it. */
export type OrderRound =
  /** Its round: the first observed after the request and landed in its window. Execute it. */
  | { kind: 'fill'; roundId: bigint; observedAt: number; updatedAt: number }
  /** Its window passed without one; `roundId` proves it (`expireOrder`). */
  | { kind: 'expire'; roundId: bigint }
  /** Nothing yet — or too far back to tell. */
  | { kind: 'wait' }
  /** The feed moved to a new aggregator: the order can only be cancelled. */
  | { kind: 'upgraded' };

const ROUND_MASK = 0xffffffffffffffffn;
/** Rounds walked back per order, at most: weeks of BTC rounds, for an order the keeper missed. */
const MAX_WALK = 600;
const WALK_BATCH = 25n;

export const phaseOf = (roundId: bigint): number => Number(roundId >> 64n);

/** When a round's price was observed: no later than it landed, whatever the oracles' clocks say. */
export const observedAt = (r: FeedRound): number => Math.min(r.startedAt, r.updatedAt);

export async function latestRound(client: PublicClient, feed: Hex): Promise<FeedRound> {
  const [roundId, , startedAt, updatedAt] = await client.readContract({ address: feed, abi: CHAINLINK_FEED_ABI, functionName: 'latestRoundData' });
  return { roundId, startedAt: Number(startedAt), updatedAt: Number(updatedAt) };
}

async function roundAt(client: PublicClient, feed: Hex, roundId: bigint): Promise<FeedRound | null> {
  const r = await client.readContract({ address: feed, abi: CHAINLINK_FEED_ABI, functionName: 'getRoundData', args: [roundId] }).catch(() => null);
  return r && r[3] > 0n ? { roundId: r[0], startedAt: Number(r[2]), updatedAt: Number(r[3]) } : null;
}

/**
 * What settles an order, read from its feed's history exactly as AgriFeed
 * proves it: in the order's phase, the first round observed at or after
 * `observedFrom` and landed between `notBefore` and `notAfter` — or, past the
 * window with none, the round that proves there was none (the first landed
 * after the window, or the latest). Pass the market's latest round when it's
 * already been read this cycle.
 */
export async function orderRound(
  client: PublicClient,
  feed: Hex,
  order: { phase: number; observedFrom: number; notBefore: number; notAfter: number },
  now: number,
  latest?: FeedRound,
): Promise<OrderRound> {
  const top = latest ?? (await latestRound(client, feed));
  if (phaseOf(top.roundId) !== order.phase) return { kind: 'upgraded' };
  const past = now > order.notAfter;

  // Newest first: the rounds after the window, then the window's, down to the first before it.
  let firstAfter: FeedRound | null = null;
  const inWindow: FeedRound[] = [];
  /** Sorts a round into place; false once one landed before the window — the walk is done. */
  const place = (r: FeedRound): boolean => {
    if (r.updatedAt > order.notAfter) firstAfter = r;
    else if (r.updatedAt >= order.notBefore) inWindow.push(r);
    else return false;
    return true;
  };
  if (place(top)) {
    let reachedStart = false;
    let next = top.roundId;
    let walked = 0;
    while (!reachedStart && walked < MAX_WALK) {
      const ids: bigint[] = [];
      for (let k = 1n; k <= WALK_BATCH && ((next - k) & ROUND_MASK) >= 1n; k += 1n) ids.push(next - k);
      // The start of the phase inside the window: nothing can be proven.
      if (!ids.length) return { kind: 'wait' };
      const batch = await Promise.all(ids.map((id) => roundAt(client, feed, id)));
      for (const r of batch) {
        walked += 1;
        if (!r) return { kind: 'wait' };
        if (!place(r)) {
          reachedStart = true;
          break;
        }
        next = r.roundId;
      }
    }
    if (!reachedStart) return { kind: 'wait' };
  }
  const first = inWindow.reverse().find((r) => observedAt(r) >= order.observedFrom);
  if (first) return { kind: 'fill', roundId: first.roundId, observedAt: observedAt(first), updatedAt: first.updatedAt };
  if (!past) return { kind: 'wait' };
  return { kind: 'expire', roundId: ((firstAfter as FeedRound | null) ?? top).roundId };
}
