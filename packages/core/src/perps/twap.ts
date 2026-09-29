import type { PerpMarketDef, PerpTwapFeed } from '@robinchan/shared';
import { PERP_MARKETS } from '@robinchan/shared';
import { parseEventLogs } from 'viem';

import { publicClient } from '../chain';
import { TWAP_ROUND_FEED_ABI } from './abi';
import { chainNow, chainState } from './chain';
import { perpsVenue } from './config';
import { keeperWallet, waitingOrderMarkets } from './keeper';

/**
 * The RH Tokens' feeds (contracts/contracts/oracles/TwapRoundFeed.sol): each
 * reads its token's Uniswap V2 or V3 pool and makes a round from the pool's
 * own cumulative price (or tick) — the keeper only has to call `update()`,
 * as often as the market needs (twapCadenceSec).
 * Nothing it sends sets a price: anyone may call it, and calling it at a
 * chosen moment only moves which second a 15-minute average ends on.
 *
 * Should the keeper stop, the feeds stop with it: an hour without a round
 * and the latest reads as 0 — no new orders, no liquidations — until it's
 * back.
 */

type TwapDef = PerpMarketDef & { twap: PerpTwapFeed & { roundFeed: `0x${string}` } };

/** The RH Token markets with a deployed TwapRoundFeed. */
export function twapRoundMarkets(): TwapDef[] {
  return PERP_MARKETS.filter((m): m is TwapDef => Boolean(m.twap?.roundFeed));
}

/** Seconds past a feed's turn before trying: a block's clock can trail the wall's a little. */
const CLOCK_MARGIN_SEC = 2;

/**
 * Seconds between a feed's updates. Each costs the keeper ~150–220k gas, so
 * the feed only ticks every minute (the contract's floor) while an order
 * waits on it — the order fills on the first 15-minute average that starts
 * after it, so that average has to start soon. With positions open, every
 * five minutes keeps liquidations near the market. Otherwise every sixteen:
 * each update still finds the one before it a window back (the contract
 * takes a start 900–1,140 s old) and makes a round, and the market never
 * nears its hour-long circuit breaker. About 90 updates a day per quiet feed
 * instead of 1,440.
 */
export const TWAP_CADENCE_SEC = { orderWaiting: 60, positionsOpen: 300, quiet: 960 } as const;

export function twapCadenceSec(state: { orderWaiting: boolean; openInterest: number }): number {
  if (state.orderWaiting) return TWAP_CADENCE_SEC.orderWaiting;
  if (state.openInterest > 0) return TWAP_CADENCE_SEC.positionsOpen;
  return TWAP_CADENCE_SEC.quiet;
}

/** When each feed last observed, as this worker saw it (read from the chain on first sight). */
const observedAt = new Map<string, number>();

const warned = new Map<string, number>();
function warnOnce(key: string, message: string, everyMs = 300_000): void {
  const last = warned.get(key);
  if (last != null && Date.now() - last < everyMs) return;
  warned.set(key, Date.now());
  console.warn(message);
}

/** Calls `update()` on every deployed TwapRoundFeed whose turn has come (twapCadenceSec). */
export async function runTwapRounds(): Promise<{ updated: number; rounds: number; made: Array<{ symbol: string; usd: number }> }> {
  const out = { updated: 0, rounds: 0, made: [] as Array<{ symbol: string; usd: number }> };
  const markets = twapRoundMarkets();
  if (perpsVenue() !== 'agri-perp' || markets.length === 0) return out;
  const client = publicClient();
  const wallet = keeperWallet();
  if (!client || !wallet) return out;

  const [now, cs] = await Promise.all([chainNow(), chainState({ maxAgeSec: 30 }).catch(() => null)]);
  const waiting = waitingOrderMarkets();
  for (const def of markets) {
    const on = { address: def.twap.roundFeed, abi: TWAP_ROUND_FEED_ABI } as const;
    const key = def.twap.roundFeed.toLowerCase();
    try {
      if (!observedAt.has(key)) {
        const next = Number(await client.readContract({ ...on, functionName: 'nextUpdateAt' }));
        // nextUpdateAt is a minute after the last observation (0 before the first).
        observedAt.set(key, next === 0 ? 0 : next - TWAP_CADENCE_SEC.orderWaiting);
      }
      const m = cs?.markets[def.symbol];
      const cadence = twapCadenceSec({ orderWaiting: waiting.has(def.symbol), openInterest: m ? m.longOi + m.shortOi : 0 });
      if ((observedAt.get(key) ?? 0) + cadence + CLOCK_MARGIN_SEC > now) continue;
      const hash = await wallet.writeContract({ ...on, functionName: 'update' });
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
      if (receipt.status !== 'success') throw new Error(`update ${hash} reverted`);
      observedAt.set(key, now);
      out.updated += 1;
      const made = parseEventLogs({ abi: TWAP_ROUND_FEED_ABI, logs: receipt.logs, eventName: 'RoundMade' });
      for (const ev of made) {
        out.rounds += 1;
        // TwapRoundFeed answers with 18 decimals.
        out.made.push({ symbol: def.symbol, usd: Number(ev.args.answer) / 1e18 });
        // A round answering 0: the pool fell under the floor, or ETH/USD went stale.
        if (ev.args.answer === 0n) {
          warnOnce(
            `twap:zero:${def.symbol}`,
            `[perps] ${def.symbol}: its average priced nothing — the pool holds $${Math.round(Number(ev.args.liquidityUsd) / 1e18).toLocaleString('en-US')} (under its floor) or ETH/USD is stale`,
            3_600_000,
          );
        }
      }
    } catch (err) {
      // Read the chain again next time: someone else may have updated it.
      observedAt.delete(key);
      warnOnce(`twap:err:${def.symbol}`, `[perps] ${def.symbol} TWAP update failed: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  return out;
}
