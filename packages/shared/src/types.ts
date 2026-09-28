/**
 * Data shapes shared by web, api, and worker.
 * All times are ISO 8601 UTC.
 */

export type ApiEnvelope<T> = {
  data: T;
  stale: boolean;
  asOf: string;
};

export type ApiErrorCode =
  | 'RATE_LIMITED'
  | 'PARSE_FAILED'
  | 'PARSE_INCOMPLETE'
  | 'QUOTE_EXPIRED'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'UPSTREAM_DOWN'
  | 'INTERNAL'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'TIER_REQUIRED'
  | 'FEATURE_DISABLED'
  | 'NOT_CONFIGURED'
  | 'NOT_TRADABLE'
  | 'INSUFFICIENT_BALANCE'
  | 'INSUFFICIENT_GAS'
  | 'ORDER_IN_FLIGHT'
  | 'ADDRESS_MISMATCH'
  | 'CONFLICT'
  /** Perps: the oracle isn't publishing (market hours) or the market is close-only. */
  | 'MARKET_CLOSED'
  /** Perps: the open-interest cap or the pool's free liquidity can't take the position. */
  | 'LIQUIDITY_LIMIT';

export type ApiError = {
  error: { code: ApiErrorCode; message: string };
};

/* ---------- symbols ---------- */

export type SymbolKind = 'stock' | 'token' | 'index';

/** One entry of the symbol registry — what Robinchan knows how to show and trade. */
export type SymbolInfo = {
  symbol: string;
  name: string;
  kind: SymbolKind;
  /** Whether an order can be built for it at all. */
  tradable: boolean;
  /** Shown in place of the order ticket when `tradable` is false (Trade §4). */
  untradableReason?: string;
};

/* ---------- market ---------- */

export type Ticker = {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePct: number;
  currency: string;
};

export type MarketIndex = Ticker & {
  /** 24 sparkline points, oldest to newest */
  spark: number[];
};

export const CANDLE_INTERVALS = ['1m', '5m', '15m', '1H', '4H', '1D'] as const;
export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

/** One OHLCV bar. `time` is the bar's open, in UNIX seconds (UTC). */
export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type CandleSeries = {
  symbol: string;
  interval: CandleInterval;
  candles: Candle[];
  /** `fixture` only ever appears in `RC_ENV=dev`. */
  source: 'provider' | 'fixture';
};

/* ---------- news ---------- */

export const NEWS_CATEGORIES = ['SEC', 'NEWS', 'CHAIN', 'SOCIAL'] as const;
export type NewsCategory = (typeof NEWS_CATEGORIES)[number];

export type NewsItem = {
  id: string;
  cat: NewsCategory;
  title: string;
  /** short version for the tape */
  short: string;
  symbols: string[];
  /** -1..1 */
  sentiment: number;
  url: string;
  source: string;
  publishedAt: string;
  pinned?: boolean;
  /** Article thumbnail from the provider, when it sends one. */
  image?: string;
};

/* ---------- media ---------- */

export type MediaChannel = {
  id: string;
  label: string;
  /** Empty when an active stream can't be confirmed — frontend falls back to a poster. */
  videoId: string;
  live: boolean;
  /** Target of the 'Open on YouTube' button when the iframe can't load. */
  url: string;
  /**
   * YouTube channel id. Lets the frontend embed the channel's current live
   * stream (`embed/live_stream?channel=`) when `videoId` isn't confirmed yet
   * — that embed resolves the stream on YouTube's side and costs no API quota.
   */
  channelId?: string;
};

export type MediaClip = {
  id: string;
  title: string;
  channel: string;
  videoId: string;
  durationSec: number;
  publishedAt: string;
  url: string;
};

/* ---------- calendar ---------- */

export type CalendarKind = 'earnings' | 'macro' | 'chain';

export type CalendarEvent = {
  id: string;
  date: string;
  title: string;
  subtitle: string;
  kind: CalendarKind;
  symbol: string | null;
};

/* ---------- heat ---------- */

/** Summary form: one 0..1 number per component, `null` when it isn't active. */
export type HeatComponents = {
  onchain: number | null;
  news: number | null;
  social: number | null;
};

/** Why a component has no score. `belum_aktif` = not switched on yet, not "zero activity". */
export type HeatInactiveReason = 'belum_aktif' | 'tidak_ada_data';

export type HeatOnchainComponent = {
  score: number | null;
  /** 24h volume over the 20-day average. */
  volumeRatio: number | null;
  /** Holder growth over the last day, as a fraction. */
  holderGrowth: number | null;
  /** 0..1 — depth of the main pool relative to its volume. */
  liquidityHealth: number | null;
  note: string;
  reason?: HeatInactiveReason;
  /** Where the numbers came from; `fixture` only in `RC_ENV=dev`. */
  source?: string;
};

export type HeatNewsComponent = {
  score: number;
  count24h: number;
  avgSentiment: number;
  /** News ids that pushed this component the most, strongest first. */
  drivers: string[];
  note: string;
};

export type HeatSocialComponent =
  | { score: number; mentionGrowth: number; note: string }
  | { score: null; reason: HeatInactiveReason };

/** An on-chain happening worth listing as a trigger next to the news drivers. */
export type HeatOnchainEvent = {
  id: string;
  title: string;
  at: string;
  url: string | null;
};

/**
 * What's stored in `heat_scores.components` (Heat §6): not just the score of
 * each component but the references that drove it, so an opened row has
 * something to explain.
 */
export type HeatComponentsDetail = {
  onchain: HeatOnchainComponent;
  news: HeatNewsComponent;
  social: HeatSocialComponent;
  /** The weights actually applied, after redistributing inactive components. */
  weights: { onchain: number; news: number; social: number };
  events: HeatOnchainEvent[];
};

export type HeatScore = {
  symbol: string;
  name: string;
  score: number;
  /** null when the user doesn't meet the tier — score rounded to the nearest 10 */
  components: HeatComponents | null;
  rounded: boolean;
  computedAt: string;
};

/** Who is looking at the heat board, decided on the server from the session and tier. */
export type HeatAccess = 'anon' | 'wallet' | 'tier1';
export const HEAT_FILTERS = ['all', 'stocks', 'chain', 'watchlist'] as const;
export type HeatFilter = (typeof HEAT_FILTERS)[number];
export const HEAT_SORTS = ['score', 'change', 'volume'] as const;
export type HeatSort = (typeof HEAT_SORTS)[number];

export type HeatBoardRow = {
  locked: false;
  /** Rank by heat score across the whole board. */
  rank: number;
  symbol: string;
  name: string;
  kind: SymbolKind;
  score: number;
  rounded: boolean;
  /** null when the viewer's access level doesn't include component detail. */
  components: HeatComponents | null;
  price: number | null;
  changePct: number | null;
  /** Notional 24h volume in USD, when known. */
  volume24h: number | null;
  /** 7-day closes, oldest first. */
  spark: number[];
  expandable: boolean;
  watchlisted: boolean;
};

/**
 * A row the viewer isn't allowed to see. It carries no market data at all —
 * gating happens on the server, the client only draws a blurred placeholder
 * with the label of the tier that opens it (Heat §6).
 */
export type HeatLockedRow = {
  locked: true;
  requiredTier: 'wallet' | 'tier1';
};

export type HeatBoard = {
  rows: Array<HeatBoardRow | HeatLockedRow>;
  page: number;
  pageSize: number;
  /** Rows in the current filter, locked ones included. */
  total: number;
  pages: number;
  filter: HeatFilter;
  sort: HeatSort;
  access: {
    level: HeatAccess;
    /** How many rows this level may see (null = all). */
    visibleLimit: number | null;
    canExpand: boolean;
    canSeeTriggers: boolean;
    canWatchlist: boolean;
    /** The tier that would open more, or null when nothing is left to open. */
    next: 'wallet' | 'tier1' | null;
  };
  computedAt: string | null;
};

export type HeatTrigger = {
  id: string;
  kind: 'news' | 'onchain';
  title: string;
  at: string;
  url: string | null;
  source: string;
  sentiment: number | null;
};

export type HeatComponentLine = {
  key: 'onchain' | 'news' | 'social';
  label: string;
  score: number | null;
  weight: number;
  note: string;
  inactive: HeatInactiveReason | null;
};

export type CompanionRead = {
  text: string;
  computedAt: string;
  source: 'llm' | 'template';
};

export type HeatDetail = {
  symbol: string;
  name: string;
  rank: number;
  score: number;
  computedAt: string;
  components: HeatComponentLine[];
  /** null = locked for this viewer (Tier 1 opens it). */
  triggers: HeatTrigger[] | null;
  /** null when there's no cached read yet, or it's locked — see `readLocked`. */
  read: CompanionRead | null;
  readLocked: boolean;
  access: HeatAccess;
};

/* ---------- provider status ---------- */

export type SourceState = 'ok' | 'idle' | 'down';

export type SourceStatus = {
  id: string;
  label: string;
  state: SourceState;
  lastOkAt: string | null;
  note: string;
};

/* ---------- session & tier ---------- */

export type Address = `0x${string}`;

export type SessionInfo = {
  address: Address;
  chainId: number;
  expiresAt: string;
};

export type TierId = 'free' | 'tier1' | 'tier2' | 'tier3';

export type TierState = {
  tier: TierId;
  /** $RCHAN balance as a decimal string, never a float. */
  balance: string;
  unlocked: string[];
  /** `chain` = read from the contract; `dev-override` = `RC_DEV_TIER`; `unconfigured` = no contract/RPC yet. */
  source: 'chain' | 'dev-override' | 'unconfigured';
};

/* ---------- order ---------- */

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';
/** Where the order object was filled in — both go through the same pipeline. */
export type OrderSource = 'form' | 'chat';

/**
 * - `quoted`    quote issued, waiting for a signature (30s)
 * - `expired`   quote lapsed unsigned, or a limit order passed its expiry
 * - `pending`   transaction sent, waiting for the chain
 * - `open`      limit order signed, waiting for its price
 * - `filled`    done
 * - `failed`    rejected on chain, or couldn't execute
 * - `cancelled` limit order cancelled by the user
 */
export type OrderStatus =
  | 'quoted'
  | 'expired'
  | 'pending'
  | 'open'
  | 'filled'
  | 'failed'
  | 'cancelled';

export type OrderIntent = {
  side: OrderSide;
  symbol: string;
  qty: number;
  orderType: OrderType;
  limitPrice: number | null;
};

/** An unsigned transaction exactly as the wallet should send it. `value` is wei, as a decimal string. */
export type TxRequest = {
  to: Address;
  data: `0x${string}`;
  value: string;
  chainId: number;
  /** What this step does, e.g. "Approve USDC" or "Swap". */
  label: string;
};

export type OrderTypedData = {
  domain: { name: string; version: string; chainId: number };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, string>;
};

export type OrderExecution =
  | { kind: 'transactions'; txs: TxRequest[] }
  | { kind: 'signature'; typedData: OrderTypedData };

export type OrderQuote = {
  /** The order row this quote is bound to. */
  id: string;
  intent: OrderIntent;
  /** Quotes are bound to one address (Trade §4: wallet switch mid-flow). */
  address: Address;
  venue: string;
  estPrice: number;
  estTotal: number;
  /** Network fee estimate in the chain's native token. */
  estGas: number;
  gasSymbol: string;
  protocolFee: number;
  feeBps: number;
  slippageBps: number;
  quotedAt: string;
  expiresAt: string;
  warnings: string[];
  /** A warning the user has to tick before signing, e.g. a limit far from market. */
  ack: { code: 'LIMIT_DEVIATION'; message: string } | null;
  execution: OrderExecution;
};

export type OrderRecord = {
  id: string;
  side: OrderSide;
  symbol: string;
  qty: number;
  orderType: OrderType;
  limitPrice: number | null;
  status: OrderStatus;
  source: OrderSource;
  venue: string;
  quotePrice: number | null;
  fillPrice: number | null;
  estTotal: number | null;
  fee: number | null;
  /** Every hash sent for this order — the original plus any speed-up/cancel replacement. */
  txHashes: string[];
  /** The hash that settled it, or the latest one while pending. */
  txHash: string | null;
  explorerUrl: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  filledAt: string | null;
  expiresAt: string | null;
};

/* ---------- portfolio ---------- */

/**
 * - `known`   every unit was bought through Robinchan
 * - `partial` some units came from elsewhere; PnL covers the known part only
 * - `manual`  the user typed the purchase price in
 * - `unknown` never guessed (Portfolio §8) — the column stays empty
 * - `cash`    the settlement stablecoin; valued at par, no PnL to speak of
 */
export type CostBasisState = 'known' | 'partial' | 'manual' | 'unknown' | 'cash';

export type Holding = {
  symbol: string;
  name: string;
  kind: SymbolKind | 'other';
  /** In Robinchan's symbol registry. Unsupported tokens are listed separately. */
  supported: boolean;
  tokenAddress: string | null;
  qty: number;
  price: number | null;
  change24hPct: number | null;
  value: number | null;
  avgCost: number | null;
  costBasis: CostBasisState;
  /** Units the average cost covers. */
  knownQty: number;
  pnl: number | null;
  pnlPct: number | null;
  /** Share of the portfolio's total value, 0..1. */
  allocation: number | null;
  /** The manual price the user entered, when there is one. */
  manualAvgCost: number | null;
};

export type PortfolioSummary = {
  address: Address;
  totalValue: number;
  change24h: number;
  change24hPct: number | null;
  /** Only assets with a known cost basis are summed (Portfolio §8). */
  unrealizedPnl: number | null;
  unrealizedPnlPct: number | null;
  /** Assets left out of the PnL total because their purchase price is unknown. */
  excludedFromPnl: number;
  /** Assets counted only for the part bought through Robinchan. */
  partialInPnl: number;
  /** Supported assets worth at least $1, largest first. */
  holdings: Holding[];
  /** Supported assets under $1, folded into one "Other" row. */
  dust: Holding[];
  /** Tokens outside Robinchan's registry. */
  unsupported: Holding[];
  /** The gas token. Shown, but not in the totals — there's no price feed for it yet. */
  native: { symbol: string; qty: number };
  /**
   * `registry` = only tokens in Robinchan's list were read; `explorer` =
   * every token in the wallet was listed (unsupported ones go to their own section).
   */
  discovery: 'registry' | 'explorer';
  source: 'chain' | 'fixture';
  asOf: string;
  /** The first snapshot date — the chart starts here, never earlier. */
  trackedSince: string | null;
};

export const PORTFOLIO_RANGES = ['24h', '7d', '30d', 'all'] as const;
export type PortfolioRange = (typeof PORTFOLIO_RANGES)[number];

export type PortfolioPoint = { time: number; value: number };

export type PortfolioHistory = {
  range: PortfolioRange;
  points: PortfolioPoint[];
  /** `prices` = rebuilt from price history (24h); `snapshots` = the daily table. */
  basis: 'prices' | 'snapshots';
  trackedSince: string | null;
};

/* ---------- companion ---------- */

export type CompanionPage = 'home' | 'robinchan' | 'market' | 'heat' | 'portfolio' | 'perps' | 'gap' | 'check';

/** Page context sent with each chat message as metadata — one chat, one history. */
export type PageContext = {
  page: CompanionPage;
  symbol?: string | null;
};

export type CompanionNotice = {
  id: string;
  orderId: string;
  symbol: string;
  text: string;
  at: string;
};
