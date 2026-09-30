import type { Candle, CandleInterval, CandleSeries } from '@robinchan/shared';
import { getCache } from '@robinchan/store';

import { CANDLES_KEPT, INTERVAL_SEC, bucketStart } from '../candles';
import { perpKey } from './network';

/**
 * Perps chart bars, built by the worker from the Chainlink price (brief §11:
 * "candle builder dari price stream"). A Chainlink feed publishes only when
 * its price moves 0.5% or a day passes, and between rounds its last answer is
 * the price of record — what positions are marked at — so bars carry it
 * forward instead of leaving gaps. Oracle prices have no volume, so bars
 * carry none.
 */

/** The network in scope's bars (network.ts): gold on Base isn't gold on Arbitrum. */
export function perpCandlesKey(symbol: string, interval: CandleInterval): string {
  return perpKey('perp-candles', `${symbol.toUpperCase()}:${interval}`);
}

/** Series outlive their TTL on purpose: a market closed for the weekend still shows its chart. */
export const PERP_CANDLES_TTL_SEC = 7 * 86_400;

/** Adds one price observation to a series; out-of-order ticks are ignored. */
export function applyTick(candles: Candle[], interval: CandleInterval, timeSec: number, price: number): Candle[] {
  if (!Number.isFinite(price) || price <= 0) return candles;
  const bucket = bucketStart(timeSec, interval);
  const last = candles.at(-1);
  if (last && bucket < last.time) return candles;
  const out = candles.slice();
  if (last && bucket === last.time) {
    out[out.length - 1] = { ...last, high: Math.max(last.high, price), low: Math.min(last.low, price), close: price };
  } else {
    out.push({ time: bucket, open: price, high: price, low: price, close: price, volume: 0 });
    if (out.length > CANDLES_KEPT) out.splice(0, out.length - CANDLES_KEPT);
  }
  return out;
}

/**
 * Bars from a feed's rounds, `fromSec` to `toSec`: each bar opens at the
 * price in force when it starts and moves through the rounds inside it.
 * Buckets `open` says the market was shut for (a stock's weekend) get none,
 * as the live chart gets no ticks then.
 */
export function stepBars(
  rounds: Array<{ timeSec: number; price: number }>,
  interval: CandleInterval,
  fromSec: number,
  toSec: number,
  open: (timeSec: number) => boolean = () => true,
): Candle[] {
  const size = INTERVAL_SEC[interval];
  const sorted = rounds.filter((r) => Number.isFinite(r.price) && r.price > 0).sort((a, b) => a.timeSec - b.timeSec);
  let i = 0;
  let current: number | null = null;
  while (i < sorted.length && (sorted[i] as { timeSec: number }).timeSec < fromSec) current = (sorted[i++] as { price: number }).price;
  const bars: Candle[] = [];
  for (let t = bucketStart(fromSec, interval); t <= toSec; t += size) {
    let bar: Candle | null = current == null ? null : { time: t, open: current, high: current, low: current, close: current, volume: 0 };
    while (i < sorted.length && (sorted[i] as { timeSec: number }).timeSec < t + size) {
      const p = (sorted[i++] as { price: number }).price;
      bar = bar ? { ...bar, high: Math.max(bar.high, p), low: Math.min(bar.low, p), close: p } : { time: t, open: p, high: p, low: p, close: p, volume: 0 };
      current = p;
    }
    if (bar && (open(t) || open(t + size - 1))) bars.push(bar);
  }
  return bars.slice(-CANDLES_KEPT);
}

export async function readPerpCandles(
  symbol: string,
  interval: CandleInterval,
  live?: { price: number; timeSec: number } | null,
): Promise<{ series: CandleSeries; ageSec: number } | null> {
  const hit = await getCache()
    .getWithAge<CandleSeries>(perpCandlesKey(symbol, interval))
    .catch(() => null);
  if (!hit) return null;
  // The worker flushes bars once a minute; bring the last one up to the
  // current price so the chart never lags the number above it.
  const candles = live ? applyTick(hit.value.candles, interval, live.timeSec, live.price) : hit.value.candles;
  return { series: { ...hit.value, candles }, ageSec: hit.ageSec };
}

/** The close roughly 24 hours ago, from the hourly bars; null without a day of history. */
export function priceDayAgo(hourly: Candle[], nowSec = Date.now() / 1000): number | null {
  const target = nowSec - 86_400;
  if (!hourly.length || (hourly[0] as Candle).time > target) return null;
  let best: Candle | null = null;
  for (const c of hourly) {
    if (c.time <= target) best = c;
    else break;
  }
  return best?.close ?? null;
}
