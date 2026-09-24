import type { MarketIndex, Ticker } from '@robinchan/shared';
import { cacheKey, getCache } from '@robinchan/store';

/**
 * Current prices, read from the cache the worker's `prices` job writes every
 * 20 seconds — nothing here calls a provider (brief §8).
 */
export type PricePoint = {
  symbol: string;
  price: number;
  change: number;
  changePct: number;
  ageSec: number;
  asOf: string;
};

/** A quote may not be built on a price older than this. */
export const QUOTE_PRICE_MAX_AGE_SEC = 60;

export async function getPrices(symbols: readonly string[]): Promise<Map<string, PricePoint>> {
  const cache = getCache();
  const out = new Map<string, PricePoint>();
  const wanted = [...new Set(symbols.map((s) => s.toUpperCase()))];

  // Indices and $RCHAN live in one list; stocks each have their own key.
  const indices = await cache.getWithAge<MarketIndex[]>(cacheKey('market', 'indices')).catch(() => null);
  const indexBySymbol = new Map((indices?.value ?? []).map((i) => [i.symbol, i]));

  await Promise.all(
    wanted.map(async (symbol) => {
      const idx = indexBySymbol.get(symbol);
      if (idx && indices) {
        out.set(symbol, toPoint(idx, indices.ageSec));
        return;
      }
      const hit = await cache.getWithAge<Ticker>(cacheKey('price', symbol)).catch(() => null);
      if (hit) out.set(symbol, toPoint(hit.value, hit.ageSec));
    }),
  );
  return out;
}

export async function getPrice(symbol: string): Promise<PricePoint | null> {
  return (await getPrices([symbol])).get(symbol.toUpperCase()) ?? null;
}

function toPoint(t: Ticker, ageSec: number): PricePoint {
  return {
    symbol: t.symbol,
    price: t.price,
    change: t.change,
    changePct: t.changePct,
    ageSec,
    asOf: new Date(Date.now() - ageSec * 1000).toISOString(),
  };
}
