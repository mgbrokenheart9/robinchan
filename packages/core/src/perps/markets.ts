import type { PerpCategory, PerpMarket, PerpMarketDef, PerpMarketStats } from '@robinchan/shared';
import { PERP_MARKETS, PERP_PRICE_MAX_AGE_SEC, perpMarket, perpSessionOpen, scheduledContract } from '@robinchan/shared';
import { cacheKey, getCache, getPerpStore } from '@robinchan/store';
import type { Hex } from 'viem';

import { fundingRatePerHour, perpMaxOpenInterest, perpsVenue } from './config';
import { feedPrice, readFeedPrices } from './prices';
import { perpMarketStates, type MarketState } from './state';

/**
 * Mark prices and the market list (brief §5C `getMarkets`, §6
 * `/api/perps/markets` and `/stats`). Everything here reads caches and the
 * database; nothing calls the chain for a price.
 */

export type Mark = {
  symbol: string;
  def: PerpMarketDef;
  /** USD: the feed's latest round. */
  price: number;
  /** What positions are marked on: the price itself (Chainlink feeds never roll). */
  index: number;
  /** Chainlink publishes no confidence interval. */
  conf: number;
  /** When the round was published, UNIX seconds. */
  publishTime: number;
  ageSec: number;
  /**
   * Good to open, close or liquidate against: the feed published within its
   * heartbeat, and the market's session is open. A Chainlink round can be
   * hours old and still current — the feed only publishes when the price
   * moves 0.5% or its 24 hours are up.
   */
  fresh: boolean;
  source: 'chainlink' | 'fixture';
  feedId: Hex;
  state: MarketState;
};

/** The worker's record of each market's price about 24 hours ago, for the change column. */
export const DAY_AGO_KEY = cacheKey('perp', 'day-ago');

/**
 * A market's state when no venue is configured: the registry's feed —
 * enough to show prices on a server that can't trade.
 */
function displayState(def: PerpMarketDef): MarketState | null {
  const contract = scheduledContract(def);
  if (!contract) return null;
  return {
    symbol: def.symbol,
    venue: 'paper',
    enabled: false,
    delisted: false,
    settlementPrice: null,
    feedId: contract.feedId,
    rollFactor: 1,
    fundingRate: fundingRatePerHour(def.symbol),
    fundingIndex: 0,
    fundingUpdatedAt: Date.now(),
    maxLeverage: def.maxLeverage,
    maxOi: perpMaxOpenInterest(),
    longOi: 0,
    shortOi: 0,
  };
}

export async function perpMarks(): Promise<Map<string, Mark>> {
  const [feeds, states] = await Promise.all([readFeedPrices(), perpMarketStates()]);
  const venue = perpsVenue();
  const nowMs = Date.now();
  const out = new Map<string, Mark>();
  for (const def of PERP_MARKETS) {
    if (def.unavailable) continue;
    const state = states.get(def.symbol) ?? (venue ? null : displayState(def));
    if (!state) continue;
    const p = feedPrice(feeds?.feeds, def.symbol);
    if (!p) continue;
    const ageSec = Math.max(0, Math.round(nowMs / 1000 - p.publishTime));
    out.set(def.symbol, {
      symbol: def.symbol,
      def,
      price: p.price,
      index: p.price * state.rollFactor,
      conf: 0,
      publishTime: p.publishTime,
      ageSec,
      fresh: ageSec <= PERP_PRICE_MAX_AGE_SEC && perpSessionOpen(def, nowMs),
      source: p.source,
      feedId: state.feedId,
      state,
    });
  }
  return out;
}

export async function perpMarkFor(symbol: string): Promise<Mark | null> {
  return (await perpMarks()).get(symbol.toUpperCase()) ?? null;
}

function ago(seconds: number): string {
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/** Open, closed (session shut or feed quiet), halted (close-only) or unavailable (no oracle) — and why. */
export function perpMarketStatus(
  def: PerpMarketDef,
  state: MarketState | null,
  mark: Mark | null,
  opts: { venueConfigured: boolean },
): Pick<PerpMarket, 'status' | 'statusNote'> {
  if (def.unavailable) return { status: 'unavailable', statusNote: def.unavailable };
  if (opts.venueConfigured && !state) {
    return {
      status: 'unavailable',
      statusNote:
        def.category === 'agri'
          ? `Coming soon. ${def.name} perps open once its Pyth feed is listed on the perps contract.`
          : `${def.symbol} isn't listed on the perps contract yet.`,
    };
  }
  if (state?.delisted) {
    const at = state.settlementPrice != null ? ` at $${state.settlementPrice.toPrecision(6)}` : '';
    return { status: 'halted', statusNote: `Delisted: its feed stopped, so open positions settle${at}, its last price.` };
  }
  if (state && opts.venueConfigured && !state.enabled) {
    return { status: 'halted', statusNote: 'Paused: positions can be closed, not opened.' };
  }
  if (!perpSessionOpen(def)) {
    return { status: 'closed', statusNote: `Market closed for the weekend. ${def.symbol} trades ${def.hours}.` };
  }
  if (!mark) return { status: 'closed', statusNote: 'No price from Chainlink yet.' };
  if (!mark.fresh) {
    return {
      status: 'closed',
      statusNote: `Chainlink's ${def.symbol} feed last published ${ago(mark.ageSec)} — past its daily heartbeat, so it isn't trading. It trades ${def.hours}.`,
    };
  }
  return { status: 'open', statusNote: null };
}

export async function perpMarketViews(category?: PerpCategory): Promise<PerpMarket[]> {
  const venue = perpsVenue();
  const [allMarks, states, dayAgo] = await Promise.all([
    perpMarks(),
    perpMarketStates(),
    getCache()
      .get<Record<string, number>>(DAY_AGO_KEY)
      .catch(() => null),
  ]);
  return PERP_MARKETS.filter((def) => !category || def.category === category).map((def) => {
    const state = states.get(def.symbol) ?? null;
    const mark = allMarks.get(def.symbol) ?? null;
    const shown = mark?.state ?? state;
    const contract = scheduledContract(def);
    const reference = dayAgo?.[def.symbol];
    return {
      symbol: def.symbol,
      name: def.name,
      category: def.category,
      unit: def.unit,
      ...perpMarketStatus(def, state, mark, { venueConfigured: Boolean(venue) }),
      price: mark?.price ?? null,
      confidence: null,
      change24hPct: mark && reference ? ((mark.price - reference) / reference) * 100 : null,
      publishTime: mark ? new Date(mark.publishTime * 1000).toISOString() : null,
      fundingRatePerHour: shown?.fundingRate ?? fundingRatePerHour(def.symbol),
      openInterest: { long: state?.longOi ?? 0, short: state?.shortOi ?? 0 },
      maxLeverage: shown?.maxLeverage ?? def.maxLeverage,
      contract: contract?.label ?? null,
      nextRollAt: null,
      hours: def.hours,
      source: mark?.source ?? null,
    } satisfies PerpMarket;
  });
}

export async function perpMarketStats(symbol: string): Promise<PerpMarketStats | null> {
  const def = perpMarket(symbol);
  if (!def) return null;
  const [market] = await perpMarketViews().then((all) => all.filter((m) => m.symbol === def.symbol));
  if (!market) return null;
  const venue = perpsVenue();
  const volume = venue ? await getPerpStore().volumeSince(venue, new Date(Date.now() - 86_400_000)) : [];
  const oi = market.openInterest.long + market.openInterest.short;
  return {
    ...market,
    volume24h: volume.find((v) => v.symbol === def.symbol)?.size ?? 0,
    longOiPercent: oi > 0 ? (market.openInterest.long / oi) * 100 : 50,
    rollFactor: 1,
  };
}
