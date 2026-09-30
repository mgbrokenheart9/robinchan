import type { PerpMarketDef, PerpVenueId } from '@robinchan/shared';
import { scheduledContract } from '@robinchan/shared';
import { getPerpStore, type PerpMarketStateRow } from '@robinchan/store';
import type { Hex } from 'viem';

import { chainState, type ChainState } from './chain';
import { fundingRatePerHour, perpMaxOpenInterest, perpsVenue } from './config';
import { perpChainScope, tradableHere } from './network';

/**
 * What a market is doing on the configured venue, in one shape: which feed
 * it reads, the roll adjustment, funding, open interest and limits. On
 * paper this lives in `perp_markets` (kept by the worker); on chain it's the
 * contract's own state, mirrored through `chainState()`.
 */
export type MarketState = {
  symbol: string;
  venue: PerpVenueId;
  /** Listed and able to take opens (closes are always allowed). */
  enabled: boolean;
  /** On chain: the price stopped and positions settle at `settlementPrice`. */
  delisted: boolean;
  settlementPrice: number | null;
  /** The feed the market reads: a Chainlink proxy (or a local MockAggregator). */
  feedId: Hex;
  /** Cumulative roll adjustment; 1 for every Chainlink feed, which never rolls. */
  rollFactor: number;
  /** Fraction of size per hour; positive = longs pay. */
  fundingRate: number;
  fundingIndex: number;
  /** ms */
  fundingUpdatedAt: number;
  maxLeverage: number;
  /** Per side, USD. */
  maxOi: number;
  longOi: number;
  shortOi: number;
};

/** The funding index accrued up to `at` — continuous, like the contract's per-second accrual. */
export function fundingIndexAt(s: Pick<MarketState, 'fundingIndex' | 'fundingRate' | 'fundingUpdatedAt'>, at = Date.now()): number {
  return s.fundingIndex + (s.fundingRate * Math.max(0, at - s.fundingUpdatedAt)) / 3_600_000;
}

/** Funding a position owes: positive = it pays, negative = it receives. */
export function fundingOwed(p: { side: 'long' | 'short'; size: number; entryFunding: number }, indexNow: number): number {
  const owed = p.size * (indexNow - p.entryFunding);
  return p.side === 'long' ? owed : -owed;
}

function initialRow(def: PerpMarketDef, at: number): Omit<PerpMarketStateRow, 'updatedAt'> {
  const contract = scheduledContract(def, at) ?? def.contracts.at(-1);
  return {
    symbol: def.symbol,
    feedId: (contract?.feedId ?? '0x') as string,
    rollFactor: 1,
    fundingRate: fundingRatePerHour(def.symbol),
    fundingIndex: 0,
    fundingUpdatedAt: new Date(at).toISOString(),
    rolledAt: null,
  };
}

/**
 * Paper market rows, created on first sight with the contract scheduled for
 * today, factor 1 and the configured funding rate.
 */
export async function paperMarketRows(): Promise<Map<string, PerpMarketStateRow>> {
  const store = getPerpStore();
  const rows = new Map((await store.listMarketStates()).map((r) => [r.symbol, r]));
  const now = Date.now();
  for (const def of tradableHere()) {
    if (rows.has(def.symbol)) continue;
    const row = initialRow(def, now);
    await store.upsertMarketState(row);
    rows.set(def.symbol, { ...row, updatedAt: row.fundingUpdatedAt });
  }
  return rows;
}

function fromChain(state: ChainState, def: PerpMarketDef): MarketState | null {
  const m = state.markets[def.symbol];
  if (!m?.listed) return null;
  return {
    symbol: def.symbol,
    venue: 'agri-perp',
    enabled: m.enabled && !m.delisted,
    delisted: m.delisted,
    settlementPrice: m.settlementPrice,
    feedId: m.feed,
    rollFactor: 1,
    fundingRate: m.fundingRatePerHour,
    fundingIndex: m.fundingIndex,
    fundingUpdatedAt: m.fundingUpdatedAt,
    maxLeverage: m.maxLeverage,
    maxOi: m.maxOi,
    longOi: m.longOi,
    shortOi: m.shortOi,
  };
}

/** Every tradable market's state on the configured venue; empty when no venue is. */
export async function perpMarketStates(): Promise<Map<string, MarketState>> {
  const venue = perpsVenue();
  const out = new Map<string, MarketState>();
  if (venue === 'agri-perp') {
    const state = await chainState();
    if (!state) return out;
    for (const def of tradableHere()) {
      const s = fromChain(state, def);
      if (s) out.set(def.symbol, s);
    }
    return out;
  }
  if (venue !== 'paper') return out;

  const store = getPerpStore();
  const [rows, oi] = await Promise.all([paperMarketRows(), store.openInterest('paper', perpChainScope())]);
  for (const def of tradableHere()) {
    const row = rows.get(def.symbol);
    if (!row) continue;
    out.set(def.symbol, {
      symbol: def.symbol,
      venue: 'paper',
      enabled: true,
      delisted: false,
      settlementPrice: null,
      feedId: row.feedId as Hex,
      rollFactor: row.rollFactor,
      fundingRate: row.fundingRate,
      fundingIndex: row.fundingIndex,
      fundingUpdatedAt: Date.parse(row.fundingUpdatedAt),
      maxLeverage: def.maxLeverage,
      maxOi: perpMaxOpenInterest(),
      longOi: oi.find((x) => x.symbol === def.symbol && x.side === 'long')?.size ?? 0,
      shortOi: oi.find((x) => x.symbol === def.symbol && x.side === 'short')?.size ?? 0,
    });
  }
  return out;
}

export async function perpMarketState(symbol: string): Promise<MarketState | null> {
  return (await perpMarketStates()).get(symbol.toUpperCase()) ?? null;
}
