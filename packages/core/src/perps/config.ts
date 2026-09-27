import type { Address, PerpVenueId } from '@robinchan/shared';
import { PERP_CHAIN_SLIPPAGE_BPS, PERP_CLOSE_FEE_BPS, PERP_DEFAULT_SLIPPAGE_BPS, PERP_FEE_BPS, PERP_MAX_PROFIT_MULTIPLE } from '@robinchan/shared';

import { isDev } from '../env';
import { DEFAULT_FUNDING_RATE_PER_HOUR } from './deploy-config';

/**
 * Perps configuration (Agri Perps brief §5A), read on every call like the
 * rest of `env.ts`: the worker loads `.env` after import, and tests flip
 * values between calls.
 */

const flag = (name: string): boolean => {
  const v = process.env[name]?.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'on';
};

const num = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const addr = (name: string): Address | null => {
  const v = process.env[name]?.trim();
  return v && ADDRESS.test(v) ? (v as Address) : null;
};

/** The Perps page and every perps-writing endpoint. Off unless explicitly on, like trading. */
export const perpsEnabled = (): boolean => flag('FEATURE_PERPS');

/**
 * Where positions live. `paper` (dev only, refused elsewhere): the
 * database, against a virtual USDC balance. `agri-perp`: the contracts,
 * which need all three addresses.
 */
export function perpsVenue(): PerpVenueId | null {
  const v = (process.env.PERPS_VENUE ?? '').trim();
  if (v === 'agri-perp') return agriPerpContracts() ? 'agri-perp' : null;
  if (v === 'paper' || v === '') return isDev() ? 'paper' : null;
  return null;
}

export type AgriPerpContracts = { perp: Address; vault: Address; feed: Address };

export function agriPerpContracts(): AgriPerpContracts | null {
  const perp = addr('AGRI_PERP_ADDRESS');
  const vault = addr('AGRI_VAULT_ADDRESS');
  const feed = addr('AGRI_FEED_ADDRESS');
  return perp && vault && feed ? { perp, vault, feed } : null;
}

/**
 * - `chainlink`: Chainlink Data Feeds on Robinhood Chain — free to read, no key.
 * - `mock`: dev only — the local chain runs a MockAggregator per market, and
 *   the worker posts the prices it reads into them as new rounds (standing in
 *   for Chainlink's nodes). Refused outside `RC_ENV=dev`: it would let anyone
 *   settle on a price they made up.
 */
export function perpsOracleMode(): 'chainlink' | 'mock' {
  return process.env.PERPS_ORACLE?.trim() === 'mock' && isDev() ? 'mock' : 'chainlink';
}

/**
 * Where prices are read when the contracts aren't on Robinhood Chain itself —
 * the paper venue, a local chain, a server with no venue: Robinhood Chain
 * mainnet, whose feeds anyone can read. Robinhood's own RPC is blocked by
 * Indonesian ISPs; dRPC's public endpoint isn't.
 */
export function perpOracleRpcUrl(): string {
  return process.env.PERPS_ORACLE_RPC_URL?.trim() || 'https://robinhood.drpc.org';
}

/**
 * Funding per hour as a fraction of size (paper venue; on chain it's the
 * contract's `setFundingRate`). Zero unless set — see
 * DEFAULT_FUNDING_RATE_PER_HOUR — per market with
 * PERPS_FUNDING_RATES='{"COFF":0.00002}', or for all with
 * PERPS_FUNDING_RATE_PER_HOUR. Capped at 0.01%/hour, like the contract.
 */
export function fundingRatePerHour(symbol: string): number {
  const raw = process.env.PERPS_FUNDING_RATES?.trim();
  if (raw) {
    try {
      const rates = JSON.parse(raw) as Record<string, unknown>;
      const v = Number(rates[symbol.toUpperCase()]);
      if (Number.isFinite(v) && Math.abs(v) <= MAX_FUNDING_RATE_PER_HOUR) return v;
    } catch {
      /* malformed: fall back to the default */
    }
  }
  const v = num('PERPS_FUNDING_RATE_PER_HOUR', DEFAULT_FUNDING_RATE_PER_HOUR);
  return Math.abs(v) <= MAX_FUNDING_RATE_PER_HOUR ? v : DEFAULT_FUNDING_RATE_PER_HOUR;
}

/** The contract's MAX_FUNDING_RATE_PER_HOUR: 0.01% of size per hour. */
export const MAX_FUNDING_RATE_PER_HOUR = 0.0001;

export const perpFeeBps = (): number => num('PERPS_FEE_BPS', PERP_FEE_BPS);
export const perpCloseFeeBps = (): number => num('PERPS_CLOSE_FEE_BPS', PERP_CLOSE_FEE_BPS);
/** The fill-price bound: PERPS_SLIPPAGE_BPS if set, else 0.5% on paper and 1.5% on chain (see PERP_CHAIN_SLIPPAGE_BPS). */
export const perpSlippageBps = (venue: PerpVenueId | null = perpsVenue()): number =>
  num('PERPS_SLIPPAGE_BPS', venue === 'agri-perp' ? PERP_CHAIN_SLIPPAGE_BPS : PERP_DEFAULT_SLIPPAGE_BPS);
export const perpMaxProfitMultiple = (): number => num('PERPS_MAX_PROFIT_MULTIPLE', PERP_MAX_PROFIT_MULTIPLE);
/** Per side, per market, USD — the paper venue's copy of the contract's `maxOi`. */
export const perpMaxOpenInterest = (): number => num('PERPS_MAX_OI_USD', 1_000_000);
/** Test USDC one faucet press gives, and the most a paper account can hold from it. */
/**
 * The settlement stablecoin's symbol, as traders see it. On Robinhood Chain
 * that's USDG — bridged USDC arrives as Paxos' Global Dollar, and the chain's
 * bridged USDC has barely any supply. 6 decimals either way.
 */
export const perpCollateralSymbol = (): string => process.env.PERPS_COLLATERAL_SYMBOL?.trim() || 'USDC';

export const paperFaucetAmount = (): number => num('PERPS_FAUCET_USDC', 10_000);
export const paperFaucetCap = (): number => num('PERPS_FAUCET_CAP_USDC', 100_000);

/**
 * Wei sent with each on-chain order for whoever executes it — at least the
 * contract's `minExecutionFee`. Covers the keeper's gas; 0 on a dev chain.
 */
export function perpExecutionFeeWei(): bigint {
  const raw = process.env.PERPS_EXECUTION_FEE_WEI?.trim();
  return raw && /^\d{1,30}$/.test(raw) ? BigInt(raw) : 0n;
}

/** How often the worker reads the Chainlink feeds. One multicall covers every market. */
export const perpPriceIntervalMs = (): number => Math.max(2_000, num('PERPS_PRICE_INTERVAL_MS', 5_000));

/**
 * The keeper's key. It only ever calls AgriPerp's permissionless functions —
 * `executeOrder`, `cancelOrder`, `liquidate`, `settleDelisted` — and holds gas
 * money plus the execution fees it earns, never user funds. Without one,
 * on-chain orders wait for someone else to execute them.
 */
export function keeperKey(): `0x${string}` | null {
  const v = process.env.KEEPER_PRIVATE_KEY?.trim();
  return v && /^0x[0-9a-fA-F]{64}$/.test(v) ? (v as `0x${string}`) : null;
}
