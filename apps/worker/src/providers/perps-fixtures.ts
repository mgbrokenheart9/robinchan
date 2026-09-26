import type { OraclePrice } from '@robinchan/core';
import { tradablePerpMarkets } from '@robinchan/shared';

/**
 * Stand-in Chainlink prices for `RC_ENV=dev` when Robinhood Chain can't be
 * reached: a smooth, deterministic walk per market around its level in
 * September 2026, every price marked `fixture`.
 */
const BASE: Record<string, number> = {
  BTC: 83_750,
  ETH: 2_690,
  AAPL: 341,
  TSLA: 372,
  NVDA: 226,
  AMZN: 250,
  GOOGL: 344,
  MSFT: 517,
  META: 749,
};

const MARKETS = new Map(tradablePerpMarkets().map((m) => [m.symbol, { feed: m.contracts[0]?.feedId, amplitude: m.category === 'crypto' ? 0.03 : 0.024 }] as const));

function seedOf(s: string): number {
  return [...s].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 1_000_003, 7);
}

/** A market's fixture price at `atMs`, USD. */
export function fixtureValue(symbol: string, atMs: number): number | null {
  const m = MARKETS.get(symbol.toUpperCase());
  const base = BASE[symbol.toUpperCase()];
  if (!m || base == null) return null;
  const seed = seedOf(symbol.toUpperCase());
  const t = atMs / 60_000;
  const x = Math.sin(seed * 0.37 + t * 0.11) + 0.5 * Math.sin(seed * 1.91 + t * 0.043) + 0.15 * Math.sin(seed * 3.3 + t * 1.7);
  return base * (1 + (m.amplitude * x) / 1.65);
}

export function fixtureOraclePrices(atMs = Date.now()): OraclePrice[] {
  const publishTime = Math.floor(atMs / 1000);
  return [...MARKETS].flatMap(([symbol, m]) => {
    const price = fixtureValue(symbol, atMs);
    if (price == null || !m.feed) return [];
    return [{ symbol, feed: m.feed, price: Math.round(price * 1e8) / 1e8, publishTime, roundId: String(publishTime), source: 'fixture' as const }];
  });
}
