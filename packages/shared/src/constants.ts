import type { SourceStatus, SymbolInfo, TierId } from './types';

/** Thresholds mapping sentiment to three dot colors (brief §9). */
export const SENTIMENT_POS = 0.15;
export const SENTIMENT_NEG = -0.15;

/** Symbols watched in phase 1. */
export const WATCHED_SYMBOLS = [
  'AAPL',
  'NVDA',
  'TSLA',
  'MSFT',
  'AMZN',
  'META',
  'GOOGL',
  'COIN',
] as const;

export const SYMBOL_NAMES: Record<string, string> = {
  AAPL: 'Apple Inc.',
  NVDA: 'NVIDIA Corp.',
  TSLA: 'Tesla Inc.',
  MSFT: 'Microsoft Corp.',
  AMZN: 'Amazon.com Inc.',
  META: 'Meta Platforms',
  GOOGL: 'Alphabet Inc.',
  COIN: 'Coinbase Global',
  RCHAN: 'Robinchan',
};

/** $RCHAN on Robinhood Chain (launched 2026-09-28; checked on chain: "Robinchan Perps", 18 decimals). */
export const RCHAN_TOKEN = {
  address: '0x9ff3f587b9d46b51d92982011e32fcdba4e531f0',
  symbol: 'RCHAN',
  name: 'Robinchan Perps',
  decimals: 18,
  chainId: 4663,
} as const;

/** Paxos' Global Dollar on Robinhood Chain: where bridged USDC lands, and what the perps settle in. */
export const USDG_TOKEN = {
  address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  symbol: 'USDG',
  decimals: 6,
  chainId: 4663,
} as const;

export const INDEX_SYMBOLS = ['SPX', 'NDX', 'DJI', 'VIX', 'RCHAN'] as const;

export const INDEX_NAMES: Record<string, string> = {
  SPX: 'S&P 500',
  NDX: 'Nasdaq 100',
  DJI: 'Dow Jones',
  VIX: 'Volatility',
  RCHAN: '$RCHAN / USD',
};

/**
 * The Market page's strip, in order. The worker (jobs/prices.ts) reads the
 * first four from Chainlink on Robinhood Chain — the S&P 500 and the Nasdaq
 * 100 through their SPY and QQQ feeds, since Chainlink has no index feed there
 * (nor one for the Dow or the VIX). $RCHAN joins once it trades.
 */
export const MARKET_STRIP: ReadonlyArray<{ symbol: string; name: string }> = [
  { symbol: 'SPY', name: 'S&P 500 · SPY' },
  { symbol: 'QQQ', name: 'Nasdaq 100 · QQQ' },
  { symbol: 'BTC', name: 'Bitcoin' },
  { symbol: 'ETH', name: 'Ether' },
  { symbol: 'RCHAN', name: '$RCHAN / USD' },
];

/**
 * Every symbol the app can show a page for. Tokenized stocks are tradable;
 * $RCHAN and the indices are shown (chart, heat) but can't be ordered here,
 * each for a reason the order panel states in place of the ticket.
 */
export const SYMBOLS: SymbolInfo[] = [
  ...WATCHED_SYMBOLS.map(
    (symbol): SymbolInfo => ({
      symbol,
      name: SYMBOL_NAMES[symbol] ?? symbol,
      kind: 'stock',
      tradable: true,
    }),
  ),
  {
    symbol: 'RCHAN',
    name: 'Robinchan',
    kind: 'token',
    tradable: false,
    untradableReason:
      "$RCHAN trades on the Pons launchpad. Robinchan doesn't route orders for its own token.",
  },
  ...(['SPX', 'NDX', 'DJI', 'VIX'] as const).map(
    (symbol): SymbolInfo => ({
      symbol,
      name: INDEX_NAMES[symbol] ?? symbol,
      kind: 'index',
      tradable: false,
      untradableReason: "An index is a reference level, not a token you can hold, so it can't be ordered.",
    }),
  ),
];

const SYMBOL_INDEX = new Map(SYMBOLS.map((s) => [s.symbol, s]));

export function symbolInfo(symbol: string): SymbolInfo | null {
  return SYMBOL_INDEX.get(symbol.toUpperCase()) ?? null;
}

/** The heat board covers the tokenized stocks plus the chain-native token. */
export const HEAT_SYMBOLS = [...WATCHED_SYMBOLS, 'RCHAN'] as const;

/** Eight slots in the "Sources monitored" card (brief §6). */
export const SOURCE_SLOTS: Array<Pick<SourceStatus, 'id' | 'label'>> = [
  { id: 'finnhub-quote', label: 'Finnhub — prices' },
  { id: 'finnhub-news', label: 'Finnhub — news' },
  { id: 'finnhub-calendar', label: 'Finnhub — calendar' },
  { id: 'sec-edgar', label: 'SEC EDGAR' },
  { id: 'dexscreener', label: 'DexScreener' },
  { id: 'youtube', label: 'YouTube embed' },
  { id: 'alphavantage', label: 'Alpha Vantage' },
  { id: 'stocktwits', label: 'StockTwits' },
];

export const TIER_LABELS: Record<TierId, string> = {
  free: 'Free',
  tier1: 'Tier 1',
  tier2: 'Tier 2',
  tier3: 'Tier 3',
};

export const TIER_ORDER: TierId[] = ['free', 'tier1', 'tier2', 'tier3'];

export function tierAtLeast(tier: TierId, min: TierId): boolean {
  return TIER_ORDER.indexOf(tier) >= TIER_ORDER.indexOf(min);
}

/** What each tier opens (brief §14) — the `unlocked` list of `/api/user/tier`. */
export const TIER_FEATURES: Record<TierId, string[]> = {
  free: ['chat', 'market', 'heat_rounded', 'market_order'],
  tier1: ['heat_full', 'watchlist', 'voice'],
  tier2: ['memory', 'alerts'],
  tier3: ['custom_personality', 'limit_order'],
};

/** Frontend polling intervals, milliseconds (brief §6). */
export const POLL_MS = {
  indices: 15_000,
  news: 30_000,
  clips: 300_000,
  calendar: 3_600_000,
  sources: 60_000,
  snapshot: 15_000,
  heat: 60_000,
  quote: 15_000,
  candles: 30_000,
  orders: 10_000,
  portfolio: 60_000,
} as const;

/* ---------- heat (Heat §6) ---------- */

export const HEAT_PAGE_SIZE = 25;
/** Rows visible without a wallet, and with a wallet but below Tier 1. */
export const HEAT_VISIBLE = { anon: 5, wallet: 15 } as const;
/** Robinchan's reads are generated for this many of the hottest symbols; the rest on demand. */
export const HEAT_READ_TOP = 20;

/* ---------- trade (Trade §4) ---------- */

export const QUOTE_TTL_SEC = 30;
/** The countdown turns warning-colored for the last this-many seconds. */
export const QUOTE_WARN_SEC = 10;
/** A limit more than this far from market needs a ticked acknowledgement. */
export const LIMIT_DEVIATION_MAX = 0.2;
/** After this long, a pending transaction offers speed-up or cancel. */
export const PENDING_SLOW_MS = 120_000;
/** Limit orders lapse after this long unfilled. */
export const LIMIT_ORDER_TTL_DAYS = 30;

/* ---------- portfolio (Portfolio §7) ---------- */

/** Assets worth less than this are folded into one "Other" row. */
export const DUST_USD = 1;
