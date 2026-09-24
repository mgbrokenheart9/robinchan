import type { Candle, CandleInterval, CandleSeries } from '@robinchan/shared';
import { CANDLE_INTERVALS, HEAT_SYMBOLS, INDEX_SYMBOLS, WATCHED_SYMBOLS } from '@robinchan/shared';
import { CANDLES_KEPT, CANDLES_TTL_SEC, INTERVAL_SEC, candlesKey, getPrices } from '@robinchan/core';
import { cacheKey, getCache } from '@robinchan/store';

import { fetchCandles } from '../providers/finnhub.js';
import { fixtureCandles, fixturesEnabled } from '../providers/fixtures.js';
import { log } from '../lib/log.js';

/**
 * Chart bars for every symbol the app can open, at all six intervals
 * (Trade §3). Written to the cache like prices are — the API only reads.
 *
 * Real bars come from the equity provider when the plan allows it; the
 * probe result is remembered for six hours so a plan without candle access
 * doesn't burn quota every minute. In `RC_ENV=dev` a deterministic fixture
 * fills in, anchored to the current (fixture or real) price.
 */
const SYMBOLS = [...new Set<string>([...HEAT_SYMBOLS, ...INDEX_SYMBOLS])];
const PROBE_KEY = cacheKey('candles', 'provider-probe');
const PROBE_TTL_SEC = 6 * 3600;
/** Real fetches rotate through the symbols, two per run, to stay inside the provider's rate limit. */
const PER_RUN = 2;
let cursor = 0;

const RESOLUTION: Record<CandleInterval, '1' | '5' | '15' | '60' | 'D'> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '1H': '60',
  '4H': '60',
  '1D': 'D',
};

async function providerAvailable(): Promise<boolean> {
  const cached = await getCache().get<{ ok: boolean }>(PROBE_KEY);
  if (cached) return cached.ok;
  const now = Math.floor(Date.now() / 1000);
  let ok = false;
  try {
    ok = (await fetchCandles('AAPL', 'D', now - 10 * 86_400, now)).length > 0;
  } catch (err) {
    log.debug('candles', `provider probe failed: ${(err as Error).message}`);
  }
  await getCache().set(PROBE_KEY, { ok }, PROBE_TTL_SEC);
  log.info('candles', ok ? 'provider serves candles' : 'provider has no candle access; using fallback');
  return ok;
}

/** Four 1-hour bars into one 4-hour bar, aligned to 00/04/08/… UTC. */
function toFourHour(hourly: Candle[]): Candle[] {
  const out = new Map<number, Candle>();
  for (const c of hourly) {
    const t = Math.floor(c.time / INTERVAL_SEC['4H']) * INTERVAL_SEC['4H'];
    const cur = out.get(t);
    out.set(
      t,
      cur
        ? { time: t, open: cur.open, high: Math.max(cur.high, c.high), low: Math.min(cur.low, c.low), close: c.close, volume: cur.volume + c.volume }
        : { ...c, time: t },
    );
  }
  return [...out.values()].sort((a, b) => a.time - b.time);
}

async function fromProvider(symbol: string): Promise<Array<{ key: string; value: CandleSeries; ttlSec: number }>> {
  const now = Math.floor(Date.now() / 1000);
  const out: Array<{ key: string; value: CandleSeries; ttlSec: number }> = [];
  let hourly: Candle[] | null = null;
  for (const interval of CANDLE_INTERVALS) {
    const size = INTERVAL_SEC[interval];
    let candles: Candle[];
    if (interval === '4H') {
      hourly ??= await fetchCandles(symbol, '60', now - CANDLES_KEPT * 4 * 3600, now);
      candles = toFourHour(hourly);
    } else {
      candles = await fetchCandles(symbol, RESOLUTION[interval], now - CANDLES_KEPT * size, now);
      if (interval === '1H') hourly = candles;
    }
    if (candles.length) {
      out.push({ key: candlesKey(symbol, interval), value: { symbol, interval, candles: candles.slice(-CANDLES_KEPT), source: 'provider' }, ttlSec: CANDLES_TTL_SEC * 10 });
    }
  }
  return out;
}

export async function runCandles(): Promise<void> {
  const entries: Array<{ key: string; value: CandleSeries; ttlSec: number }> = [];
  const useProvider = await providerAvailable();

  if (useProvider) {
    // Only equities come from the equity provider; indices and $RCHAN don't.
    const batch = WATCHED_SYMBOLS.slice(cursor, cursor + PER_RUN);
    cursor = (cursor + PER_RUN) % WATCHED_SYMBOLS.length;
    for (const symbol of batch) {
      try {
        entries.push(...(await fromProvider(symbol)));
      } catch (err) {
        log.debug('candles', `${symbol}: ${(err as Error).message}`);
      }
    }
  }

  if (fixturesEnabled()) {
    const prices = await getPrices(SYMBOLS);
    const provided = new Set(entries.map((e) => e.value.symbol));
    for (const symbol of SYMBOLS) {
      // A symbol the provider covers keeps its real bars between rotations.
      if (useProvider && (WATCHED_SYMBOLS as readonly string[]).includes(symbol)) continue;
      if (provided.has(symbol)) continue;
      const anchor = prices.get(symbol)?.price;
      if (!anchor) continue;
      for (const interval of CANDLE_INTERVALS) {
        entries.push({
          key: candlesKey(symbol, interval),
          value: { symbol, interval, candles: fixtureCandles(symbol, interval, anchor, CANDLES_KEPT), source: 'fixture' },
          ttlSec: CANDLES_TTL_SEC,
        });
      }
    }
  }

  if (entries.length === 0) {
    log.warn('candles', 'no candle source available; charts keep their last data');
    return;
  }
  await getCache().setMany(entries);
  log.info('candles', `${entries.length} series updated`);
}
