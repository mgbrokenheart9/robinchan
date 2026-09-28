import type { PerpMarket, PerpMarketDef, RhToken, RhTokenPool, RhTokensBoard } from '@robinchan/shared';
import {
  PERP_MARKETS,
  RH_TOKEN_MAX_LEVERAGE,
  RH_TOKEN_MAX_POSITION_USD,
  RH_TOKEN_MIN_LIQUIDITY_USD,
  RH_TOKEN_WARNING,
  TWAP_BADGE,
  TWAP_WINDOW_SEC,
} from '@robinchan/shared';
import { cacheKey, getCache } from '@robinchan/store';
import type { PublicClient } from 'viem';

import { basePairs, blendedPrice, fetchDexPairs, pairLiquidity, pairVersion, type DexPair } from '../dexscreener';
import { TWAP_ROUND_FEED_ABI } from './abi';
import { oracleClient } from './chainlink';

/**
 * The RH Tokens board (`GET /api/rh-tokens`): every RH Token's pools on
 * Robinhood Chain and whether the one its price comes from is deep enough
 * to list (RH Tokens brief: $500k). The worker reads the pools every two
 * minutes (runRhPools); the API adds each market's live status and price.
 */

export const RH_POOLS_KEY = cacheKey('perp', 'rh-pools');
const RH_POOLS_TTL_SEC = 3_600;

/** What the worker records per token. */
export type RhPools = {
  symbol: string;
  spotPrice: number | null;
  totalLiquidityUsd: number | null;
  /** The oracle pool's depth: the deployed feed's own reading, else DexScreener's. */
  oraclePoolLiquidityUsd: number | null;
  pools: RhTokenPool[];
};

export type RhPoolsSnapshot = { tokens: RhPools[]; checkedAt: string };

const rhMarkets = (): PerpMarketDef[] => PERP_MARKETS.filter((m) => m.category === 'rh');

const poolOf = (p: DexPair): RhTokenPool => ({
  dex: p.dexId,
  version: pairVersion(p),
  address: p.pairAddress,
  pair: `${p.baseToken.symbol}/${p.quoteToken.symbol}`,
  liquidityUsd: pairLiquidity(p),
  url: p.url,
});

/** One token's pools as DexScreener lists them, and the oracle pool's depth (`feedLiquidityUsd` wins when the feed is deployed). */
export function rhPoolsFrom(def: PerpMarketDef, pairs: DexPair[] | null, feedLiquidityUsd: number | null): RhPools {
  const token = def.twap?.token ?? null;
  if (!token || !pairs) {
    return { symbol: def.symbol, spotPrice: null, totalLiquidityUsd: token ? null : 0, oraclePoolLiquidityUsd: feedLiquidityUsd, pools: [] };
  }
  const pools = pairs.map(poolOf).sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  const oracle = def.twap?.pool?.address.toLowerCase();
  const listed = oracle ? pools.find((p) => p.address.toLowerCase() === oracle) : undefined;
  return {
    symbol: def.symbol,
    spotPrice: blendedPrice(basePairs(pairs, token), { minLiquidityUsd: 1_000 })?.price ?? null,
    totalLiquidityUsd: pools.reduce((s, p) => s + p.liquidityUsd, 0),
    oraclePoolLiquidityUsd: feedLiquidityUsd ?? listed?.liquidityUsd ?? (oracle ? null : 0),
    pools,
  };
}

/** A deployed feed's own reading of its pool, USD — what its rounds are gated on. */
async function feedLiquidity(client: PublicClient | null, def: PerpMarketDef): Promise<number | null> {
  const feed = def.twap?.roundFeed;
  if (!client || !feed) return null;
  try {
    const wei = await client.readContract({ address: feed, abi: TWAP_ROUND_FEED_ABI, functionName: 'liquidityUsd' });
    return Number(wei) / 1e18;
  } catch {
    return null;
  }
}

/** Every RH Token's pools, now. A token whose pools can't be read is recorded without them. */
export async function readRhPools(
  opts: { fetchPairs?: (token: string) => Promise<DexPair[]>; client?: PublicClient | null } = {},
): Promise<RhPoolsSnapshot> {
  const fetchPairs = opts.fetchPairs ?? ((token: string) => fetchDexPairs(token));
  const client = opts.client === undefined ? oracleClient() : opts.client;
  const tokens = await Promise.all(
    rhMarkets().map(async (def) => {
      const token = def.twap?.token;
      const [pairs, feed] = await Promise.all([token ? fetchPairs(token).catch(() => null) : Promise.resolve(null), feedLiquidity(client, def)]);
      return rhPoolsFrom(def, pairs, feed);
    }),
  );
  return { tokens, checkedAt: new Date().toISOString() };
}

/** The worker's job: read the pools and keep them for the API. Returns how many tokens have pools on record. */
export async function runRhPools(): Promise<number> {
  const snapshot = await readRhPools();
  // A run where DexScreener answered nothing keeps the last good read.
  if (snapshot.tokens.every((t) => t.totalLiquidityUsd == null)) return 0;
  await getCache().set(RH_POOLS_KEY, snapshot, RH_POOLS_TTL_SEC);
  return snapshot.tokens.filter((t) => t.pools.length > 0).length;
}

export async function readRhPoolsSnapshot(): Promise<{ snapshot: RhPoolsSnapshot; ageSec: number } | null> {
  const hit = await getCache()
    .getWithAge<RhPoolsSnapshot>(RH_POOLS_KEY)
    .catch(() => null);
  return hit ? { snapshot: hit.value, ageSec: hit.ageSec } : null;
}

/** The board: the registry's RH Tokens, each with its market's live status and price and its pools as last read. */
export function rhTokensBoard(markets: PerpMarket[], snapshot: RhPoolsSnapshot | null): RhTokensBoard {
  const tokens = rhMarkets().map((def): RhToken => {
    const market = markets.find((m) => m.symbol === def.symbol);
    const pools = snapshot?.tokens.find((t) => t.symbol === def.symbol) ?? null;
    const pool = def.twap?.pool ?? null;
    const oracleLiquidity = pools?.oraclePoolLiquidityUsd ?? null;
    const twapLive = Boolean(def.twap?.roundFeed && market?.price != null);
    return {
      symbol: def.symbol,
      name: def.name,
      token: def.twap?.token ?? null,
      status: market?.status ?? 'unavailable',
      statusNote: market?.statusNote ?? def.unavailable ?? null,
      spotPrice: pools?.spotPrice ?? null,
      twapPrice: twapLive ? (market?.price ?? null) : null,
      twapAt: twapLive ? (market?.publishTime ?? null) : null,
      totalLiquidityUsd: pools?.totalLiquidityUsd ?? null,
      oraclePool: pool ? { address: pool.address, label: pool.label, liquidityUsd: oracleLiquidity } : null,
      meetsLiquidity: pool != null && oracleLiquidity != null && oracleLiquidity >= RH_TOKEN_MIN_LIQUIDITY_USD,
      pools: pools?.pools ?? [],
      maxLeverage: market?.maxLeverage ?? def.maxLeverage ?? RH_TOKEN_MAX_LEVERAGE,
      maxPositionUsd: def.maxPositionUsd ?? RH_TOKEN_MAX_POSITION_USD,
    };
  });
  return {
    tokens,
    minLiquidityUsd: RH_TOKEN_MIN_LIQUIDITY_USD,
    windowSec: TWAP_WINDOW_SEC,
    oracle: TWAP_BADGE,
    warning: RH_TOKEN_WARNING,
    checkedAt: snapshot?.checkedAt ?? null,
  };
}
