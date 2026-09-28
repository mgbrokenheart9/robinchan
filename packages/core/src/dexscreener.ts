/**
 * DexScreener's public API, for a token's pools on Robinhood Chain (its
 * chain id there is `robinhood`). No key; 300 requests a minute. The worker
 * reads it for the Gap board, and Token Check for the token it's asked about.
 */
const BASE = 'https://api.dexscreener.com';
export const DEX_CHAIN = 'robinhood';

export type DexToken = { address: string; name: string; symbol: string };

export type DexPair = {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  labels?: string[];
  baseToken: DexToken;
  quoteToken: DexToken;
  priceUsd?: string;
  txns?: { h24?: { buys?: number; sells?: number } };
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    websites?: Array<{ url: string; label?: string }>;
    socials?: Array<{ url: string; type?: string }>;
  };
};

/** Every pool of `token` on Robinhood Chain, whichever side of the pair it's on. */
export async function fetchDexPairs(token: string, timeoutMs = 8_000): Promise<DexPair[]> {
  const res = await fetch(`${BASE}/token-pairs/v1/${DEX_CHAIN}/${token}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`);
  const body = (await res.json()) as unknown;
  const pairs = Array.isArray(body) ? (body as DexPair[]) : [];
  return pairs.filter((p) => p && p.chainId === DEX_CHAIN && p.baseToken && p.quoteToken);
}

/** Pools where `token` is the base — the side DexScreener's `priceUsd` prices. */
export function basePairs(pairs: DexPair[], token: string): DexPair[] {
  const t = token.toLowerCase();
  return pairs.filter((p) => p.baseToken.address.toLowerCase() === t);
}

export const pairLiquidity = (p: DexPair): number => (Number.isFinite(p.liquidity?.usd) ? (p.liquidity?.usd as number) : 0);
export const pairVolume = (p: DexPair): number => (Number.isFinite(p.volume?.h24) ? (p.volume?.h24 as number) : 0);

export function pairPrice(p: DexPair): number | null {
  const n = Number(p.priceUsd);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** "v3", "v4" … from DexScreener's labels. */
export function pairVersion(p: DexPair): string | null {
  return p.labels?.find((l) => /^v\d/i.test(l)) ?? null;
}

/**
 * One price across a token's pools: the liquidity-weighted mean of the pools
 * that agree with the median within `band`. A shallow pool left at an old
 * price (nobody has traded it since) mustn't move the answer.
 */
export function blendedPrice(
  pairs: DexPair[],
  opts: { minLiquidityUsd?: number; band?: number } = {},
): { price: number; pools: DexPair[] } | null {
  const minLiq = opts.minLiquidityUsd ?? 5_000;
  const band = opts.band ?? 0.15;
  const priced = pairs.filter((p) => pairPrice(p) != null && pairLiquidity(p) >= minLiq);
  if (!priced.length) return null;
  const prices = priced.map((p) => pairPrice(p) as number).sort((a, b) => a - b);
  const mid = prices.length / 2;
  const median = prices.length % 2 ? (prices[Math.floor(mid)] as number) : ((prices[mid - 1] as number) + (prices[mid] as number)) / 2;
  const kept = priced.filter((p) => Math.abs((pairPrice(p) as number) / median - 1) <= band);
  const weight = kept.reduce((s, p) => s + pairLiquidity(p), 0);
  if (!kept.length || weight <= 0) return null;
  const price = kept.reduce((s, p) => s + (pairPrice(p) as number) * pairLiquidity(p), 0) / weight;
  return { price, pools: kept.sort((a, b) => pairLiquidity(b) - pairLiquidity(a)) };
}
