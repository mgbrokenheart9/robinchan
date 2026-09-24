import type { Candle, CandleInterval, CandleSeries } from '@robinchan/shared';
import { cacheKey, getCache } from '@robinchan/store';

import { getPrice } from './prices';

export const INTERVAL_SEC: Record<CandleInterval, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1H': 3_600,
  '4H': 14_400,
  '1D': 86_400,
};

/** Bars kept per series — enough for a full chart at every interval. */
export const CANDLES_KEPT = 300;
export const CANDLES_TTL_SEC = 180;

export function candlesKey(symbol: string, interval: CandleInterval): string {
  return cacheKey('candles', `${symbol}:${interval}`);
}

export function bucketStart(timeSec: number, interval: CandleInterval): number {
  const size = INTERVAL_SEC[interval];
  return Math.floor(timeSec / size) * size;
}

export type CandleRead = {
  series: CandleSeries;
  ageSec: number;
};

/**
 * The stored series with its last bar brought up to the latest cached price.
 * The candle job runs once a minute and the price job every 20 seconds, so
 * without this the chart's last candle would lag the price shown above it.
 */
export async function readCandles(
  symbol: string,
  interval: CandleInterval,
  opts: { from?: number; to?: number; live?: boolean } = {},
): Promise<CandleRead | null> {
  const hit = await getCache()
    .getWithAge<CandleSeries>(candlesKey(symbol, interval))
    .catch(() => null);
  if (!hit) return null;

  let candles = hit.value.candles;
  if (opts.live !== false) candles = await patchLive(symbol, interval, candles);
  if (opts.from != null) candles = candles.filter((c) => c.time >= (opts.from as number));
  if (opts.to != null) candles = candles.filter((c) => c.time <= (opts.to as number));

  return { series: { ...hit.value, candles }, ageSec: hit.ageSec };
}

async function patchLive(
  symbol: string,
  interval: CandleInterval,
  candles: Candle[],
): Promise<Candle[]> {
  const last = candles.at(-1);
  if (!last) return candles;
  const live = await getPrice(symbol).catch(() => null);
  if (!live || live.ageSec > 120) return candles;

  const liveAt = Math.floor(Date.parse(live.asOf) / 1000);
  const bucket = bucketStart(liveAt, interval);
  const price = live.price;
  const out = candles.slice();
  if (bucket === last.time) {
    out[out.length - 1] = {
      ...last,
      close: price,
      high: Math.max(last.high, price),
      low: Math.min(last.low, price),
    };
  } else if (bucket > last.time) {
    out.push({ time: bucket, open: last.close, high: Math.max(last.close, price), low: Math.min(last.close, price), close: price, volume: 0 });
    if (out.length > CANDLES_KEPT) out.shift();
  }
  return out;
}

/** Last `count` closes, oldest first — for sparklines. */
export async function recentCloses(
  symbol: string,
  interval: CandleInterval,
  count: number,
): Promise<number[]> {
  const read = await readCandles(symbol, interval);
  return read ? read.series.candles.slice(-count).map((c) => c.close) : [];
}

/** Notional USD volume over the last 24 hours, from the hourly bars. */
export async function volume24hUsd(symbol: string): Promise<number | null> {
  const read = await readCandles(symbol, '1H', { live: false });
  if (!read) return null;
  const since = Date.now() / 1000 - 24 * 3600;
  const bars = read.series.candles.filter((c) => c.time >= since);
  if (bars.length === 0) return null;
  return bars.reduce((sum, c) => sum + c.volume * ((c.high + c.low + c.close) / 3), 0);
}
