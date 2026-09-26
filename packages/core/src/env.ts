import { resolveChainConfig, type ChainConfig, type TierId } from '@robinchan/shared';

/**
 * Typed access to the environment for everything server-side. Read on every
 * call rather than captured at import time: the worker loads `.env` after its
 * modules are imported, and tests flip values between calls.
 */

export function rcEnv(): 'dev' | 'staging' | 'production' {
  const v = process.env.RC_ENV ?? 'dev';
  return v === 'production' || v === 'staging' ? v : 'dev';
}

export const isDev = (): boolean => rcEnv() === 'dev';

const flag = (name: string, fallback = false): boolean => {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === 'true' || v === '1' || v === 'on';
};

const int = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

/** Trade page and every order-writing endpoint. Off unless explicitly on (brief §15). */
export const tradingEnabled = (): boolean => flag('FEATURE_TRADING');

/**
 * Serving Robinchan's heat reads to users. The worker writes them either way,
 * so they can be reviewed (`npm run reads -w @robinchan/worker`) before this
 * is switched on (Heat §6: "tinjau keluarannya sebelum fitur ini dibuka").
 */
export const heatReadsEnabled = (): boolean => flag('FEATURE_HEAT_READS');

export const socialHeatEnabled = (): boolean => flag('FEATURE_SOCIAL_HEAT');

/**
 * The chain as the server sees it. `RPC_URL`, when set, is the server's own
 * endpoint (the worker, the keeper, the API's reads) — a paid provider URL
 * with its key stays out of the browser, which uses NEXT_PUBLIC_RPC_URL.
 */
export function chainConfig(): ChainConfig | null {
  return resolveChainConfig({
    chainId: process.env.NEXT_PUBLIC_CHAIN_ID,
    chainName: process.env.NEXT_PUBLIC_CHAIN_NAME,
    rpcUrl: process.env.RPC_URL?.trim() || process.env.NEXT_PUBLIC_RPC_URL,
    explorerUrl: process.env.NEXT_PUBLIC_EXPLORER_URL,
    nativeSymbol: process.env.NEXT_PUBLIC_NATIVE_SYMBOL,
    rcEnv: rcEnv(),
  });
}

/** Protocol fee per order, basis points (open decision #5 — a placeholder until set). */
export const protocolFeeBps = (): number => int('PROTOCOL_FEE_BPS', 10);

/** Default slippage tolerance, basis points (open decision #3). */
export const slippageBps = (): number => int('DEFAULT_SLIPPAGE_BPS', 50);

/** Upper bound on one order's notional — "qty positif dan di bawah batas wajar" (brief §12). */
export const maxOrderUsd = (): number => int('ORDER_MAX_NOTIONAL_USD', 50_000);

export const walletRateLimit = (): number => int('RATE_LIMIT_WALLET', 20);
export const quoteRateLimit = (): number => int('RATE_LIMIT_QUOTE', 10);

export type VenueId = 'paper' | 'uniswap-v3';

/**
 * Where orders execute (open decision #4 in the main brief: which DEX).
 * `paper` is the dev venue and is refused outside `RC_ENV=dev`.
 */
export function venueId(): VenueId | null {
  const v = (process.env.RC_VENUE ?? '').trim();
  if (v === 'uniswap-v3') return v;
  if (v === 'paper' || v === '') return isDev() ? 'paper' : null;
  return null;
}

/** Paper venue only: send a real zero-value transaction instead of signing typed data. */
export const paperOnchain = (): boolean => flag('RC_PAPER_ONCHAIN');

/**
 * Dev-only tier override. `tier1` applies to every wallet;
 * `0xabc…=tier3,*=free` sets it per address. Ignored outside `RC_ENV=dev`,
 * so a misconfigured production can't hand out tiers.
 */
export function devTierFor(address: string): TierId | null {
  if (!isDev()) return null;
  const raw = process.env.RC_DEV_TIER?.trim();
  if (!raw) return null;
  const valid = (t: string | undefined): TierId | null =>
    t === 'free' || t === 'tier1' || t === 'tier2' || t === 'tier3' ? t : null;
  if (!raw.includes('=')) return valid(raw);
  let wildcard: TierId | null = null;
  for (const part of raw.split(',')) {
    const [who, tier] = part.split('=').map((s) => s.trim());
    if (!who) continue;
    if (who === '*') wildcard = valid(tier);
    else if (who.toLowerCase() === address.toLowerCase()) return valid(tier);
  }
  return wildcard;
}
