import { getCache } from '@robinchan/store';
import type { Hex } from 'viem';

import { perpKey } from './network';

/**
 * Every market's latest oracle price, as one cache entry the worker rewrites
 * every few seconds (one multicall reads every Chainlink feed). The API only
 * reads it — no page load ever reaches an RPC for a price (brief §8). One
 * entry per network (network.ts): each chain's feeds are its own.
 */
const feedsKey = (): string => perpKey('perp', 'feeds');
const FEEDS_TTL_SEC = 30;

export type OraclePrice = {
  symbol: string;
  /** The feed it was read from: a Chainlink proxy, or a local chain's MockAggregator. */
  feed: Hex;
  /** USD. */
  price: number;
  /** When the round was published, UNIX seconds. */
  publishTime: number;
  /** The round, as a decimal string (the cache is JSON). */
  roundId: string;
  /** `fixture` only ever appears in `RC_ENV=dev`, when no feed could be read. */
  source: 'chainlink' | 'fixture';
};

/** Keyed by market symbol. */
export type FeedPrices = Record<string, OraclePrice>;

/** Merges into what's stored, so a market missing from one read keeps its last price. */
export async function writeFeedPrices(prices: OraclePrice[]): Promise<void> {
  if (!prices.length) return;
  const cache = getCache();
  const current = (await cache.get<FeedPrices>(feedsKey()).catch(() => null)) ?? {};
  for (const p of prices) current[p.symbol.toUpperCase()] = p;
  await cache.set(feedsKey(), current, FEEDS_TTL_SEC);
}

export async function readFeedPrices(): Promise<{ feeds: FeedPrices; ageSec: number } | null> {
  const hit = await getCache()
    .getWithAge<FeedPrices>(feedsKey())
    .catch(() => null);
  return hit ? { feeds: hit.value, ageSec: hit.ageSec } : null;
}

export function feedPrice(feeds: FeedPrices | undefined, symbol: string): OraclePrice | null {
  return feeds?.[symbol.toUpperCase()] ?? null;
}
