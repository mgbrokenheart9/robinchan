import type { Address, OrderExecution } from './types';

/**
 * Perps (Agri Perps brief): synthetic perpetuals on crypto and stocks,
 * priced by Chainlink Data Feeds on Robinhood Chain and settled in USDC
 * against a liquidity pool. The brief's agricultural markets stay listed but
 * can't trade: Chainlink has no feed for them there. Shared by web, API and
 * worker — the market registry, the shapes the API returns, and the math
 * every layer has to agree on.
 */

export const PERP_CATEGORIES = ['agri', 'crypto', 'stocks'] as const;
export type PerpCategory = (typeof PERP_CATEGORIES)[number];

export type PerpSide = 'long' | 'short';

/**
 * `paper` — dev only: positions live in the database against a virtual USDC
 * balance, opened and closed with a wallet signature, marked to the live
 * Chainlink price. `agri-perp` — the AgriPerp contracts on chain.
 */
export type PerpVenueId = 'paper' | 'agri-perp';

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

/**
 * The Chainlink feed a market's price comes from, on Robinhood Chain
 * mainnet (chain 4663). Its proxy address is what AgriFeed lists; locally
 * the contracts read a MockAggregator standing in for it.
 */
export type PerpFeedContract = {
  /** The Chainlink feed proxy: 0x + 40 hex characters. */
  feedId: `0x${string}`;
  /** Chainlink's name for the feed, exactly as its `description()` returns it: `RHNVDA / USD`. */
  oracleSymbol: string;
  /** What the feed is, for people. */
  label: string;
  /** When to move to the next contract (ISO, UTC); null for a continuous feed — every Chainlink one. */
  rollAt: string | null;
};

export type PerpMarketDef = {
  symbol: string;
  /** English name. */
  name: string;
  /** The brief's Indonesian name, e.g. "Kopi Arabika". */
  localName: string;
  category: PerpCategory;
  /** Unit after the price, e.g. "/lb". Empty for per-share and per-coin prices. */
  unit: string;
  contracts: PerpFeedContract[];
  maxLeverage: number;
  /** When the market trades, for the market header. */
  hours: string;
  /** `24/5` markets are shut from Friday 20:00 to Sunday 20:00 New York. */
  schedule: '24/7' | '24/5';
  /** Set when there's no oracle for this market at all — listed, but not tradable. */
  unavailable?: string;
};

/**
 * Chainlink's Robinhood Chain feeds publish a new round when the price
 * moves 0.5% (their deviation threshold), or every 24 hours. Between rounds
 * the on-chain price can be up to 0.5% off the market. At 50× a position is
 * liquidated by a 1.6% move, and that lag would be a third of its margin;
 * at 20× it's an eighth. The brief's 50× comes down to 20× for crypto.
 */
export const CRYPTO_MAX_LEVERAGE = 20;
/**
 * Stocks stop trading every weekend and reopen wherever the news took them.
 * Nothing can be liquidated while the feed is quiet, so at 50× a long and a
 * short opened together before a close are a free bet on the gap, paid by
 * the pool (security review, finding 2). A single stock can gap 20% on
 * earnings: at 5× that costs a position its collateral, no more.
 */
export const GAPPING_MAX_LEVERAGE = 5;
/** Chainlink's feed directory for Robinhood Chain, checked for the markets below. */
const CHAINLINK_CHECKED = '2026-09-26';

/** A market with no Chainlink feed on Robinhood Chain: listed, with the reason, never tradable. */
function noFeed(symbol: string, name: string, localName: string, category: PerpCategory, unit: string, hours: string): PerpMarketDef {
  return {
    symbol,
    name,
    localName,
    category,
    unit,
    contracts: [],
    maxLeverage: category === 'crypto' ? CRYPTO_MAX_LEVERAGE : GAPPING_MAX_LEVERAGE,
    hours,
    schedule: category === 'crypto' ? '24/7' : '24/5',
    unavailable: `Chainlink has no ${name.toLowerCase()} price feed on Robinhood Chain (checked ${CHAINLINK_CHECKED}), so there's no oracle to settle against.`,
  };
}

const agri = (symbol: string, name: string, localName: string, unit: string, hours: string) => noFeed(symbol, name, localName, 'agri', unit, hours);

export const PERP_MARKETS: PerpMarketDef[] = [
  /* ---- Agri: no Chainlink feed for any of them on Robinhood Chain ---- */
  agri('CORN', 'Corn', 'Jagung', '/bu', 'CBOT hours'),
  agri('SOYB', 'Soybeans', 'Kedelai', '/bu', 'CBOT hours'),
  agri('WEAT', 'Wheat', 'Gandum', '/bu', 'CBOT hours'),
  agri('COFF', 'Arabica Coffee', 'Kopi Arabika', '/lb', 'ICE hours'),
  agri('COCC', 'Cocoa', 'Kakao', '/t', 'ICE hours'),
  agri('SUGA', 'Raw Sugar', 'Gula', '/lb', 'ICE hours'),
  agri('PALM', 'Crude Palm Oil', 'Minyak Sawit', '/t', 'Bursa Malaysia hours'),
  agri('RICE', 'Rough Rice', 'Beras', '/cwt', 'CBOT hours'),
  agri('COTT', 'Cotton', 'Kapas', '/lb', 'ICE hours'),

  /* ---- Crypto ---- */
  crypto('BTC', 'Bitcoin', '0xa2c5184bF03d373Dc9dE4876eb4Bce595B460251', 'BTC / USD'),
  crypto('ETH', 'Ethereum', '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9', 'ETH / USD'),
  noFeed('SOL', 'Solana', 'Solana', 'crypto', '', '24/7'),
  noFeed('ARB', 'Arbitrum', 'Arbitrum', 'crypto', '', '24/7'),

  /*
   * ---- Stocks: Robinhood's tokenized equities, total return value ----
   * The descriptions are the feeds' own, read on chain (2026-09-26) — some
   * say "Robinhood X", some "RHX". They publish nothing while the market is
   * shut: the weekend of 2026-09-19 went 52–57 hours without a round.
   */
  stock('AAPL', 'Apple', '0x6B22A786bAa607d76728168703a39Ea9C99f2cD0', 'Robinhood AAPL / USD'),
  stock('TSLA', 'Tesla', '0x4A1166a659A55625345e9515b32adECea5547C38', 'RHTSLA / USD'),
  stock('NVDA', 'NVIDIA', '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15', 'RHNVDA / USD'),
  stock('AMZN', 'Amazon', '0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C', 'Robinhood AMZN / USD'),
  // The brief says GOOG (class C); Chainlink and the rest of the app have GOOGL (class A).
  stock('GOOGL', 'Alphabet', '0xF6f373a037c30F0e5010d854385cA89185AE638b', 'Robinhood GOOGL / USD'),
  stock('MSFT', 'Microsoft', '0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E', 'RHMSFT / USD'),
  stock('META', 'Meta Platforms', '0x7C38C00C30BEe9378381E7B6135d7283356D71b1', 'Robinhood META / USD'),
];

function crypto(symbol: string, name: string, feedId: `0x${string}`, oracleSymbol: string): PerpMarketDef {
  return {
    symbol,
    name,
    localName: name,
    category: 'crypto',
    unit: '',
    contracts: [{ feedId, oracleSymbol, label: `Chainlink ${oracleSymbol}`, rollAt: null }],
    maxLeverage: CRYPTO_MAX_LEVERAGE,
    hours: '24/7',
    schedule: '24/7',
  };
}

function stock(symbol: string, name: string, feedId: `0x${string}`, oracleSymbol: string): PerpMarketDef {
  return {
    symbol,
    name,
    localName: name,
    category: 'stocks',
    unit: '',
    contracts: [{ feedId, oracleSymbol, label: `Chainlink ${oracleSymbol}`, rollAt: null }],
    maxLeverage: GAPPING_MAX_LEVERAGE,
    hours: 'Sun 20:00 – Fri 20:00 New York (24/5)',
    schedule: '24/5',
  };
}

const MARKET_INDEX = new Map(PERP_MARKETS.map((m) => [m.symbol, m]));

export function perpMarket(symbol: string): PerpMarketDef | null {
  return MARKET_INDEX.get(symbol.toUpperCase()) ?? null;
}

/** Markets that have an oracle — the ones that can ever be traded. */
export function tradablePerpMarkets(): PerpMarketDef[] {
  return PERP_MARKETS.filter((m) => !m.unavailable && m.contracts.length > 0);
}

/** Every tradable market's Chainlink feed on Robinhood Chain mainnet. */
export function perpOracleFeeds(): Array<{ symbol: string; feed: `0x${string}`; oracleSymbol: string }> {
  return tradablePerpMarkets().map((m) => ({ symbol: m.symbol, feed: m.contracts[0]!.feedId, oracleSymbol: m.contracts[0]!.oracleSymbol }));
}

/**
 * The contract a market should be on at `at`: the first one whose roll time
 * hasn't come yet. Every Chainlink feed is continuous, so this is its only
 * one; null for a market without an oracle.
 */
export function scheduledContract(def: PerpMarketDef, at: number = Date.now()): PerpFeedContract | null {
  for (const c of def.contracts) {
    if (c.rollAt == null || Date.parse(c.rollAt) > at) return c;
  }
  return null;
}

export function contractByFeed(def: PerpMarketDef, feedId: string): PerpFeedContract | null {
  return def.contracts.find((c) => c.feedId.toLowerCase() === feedId.toLowerCase()) ?? null;
}

/**
 * Whether a market's session is open at `at`. `24/5` (Robinhood's stock
 * feeds: regular, pre-, post-market and overnight) runs from Sunday 20:00 to
 * Friday 20:00 New York time; its feed holds the last price outside it.
 */
export function perpSessionOpen(def: Pick<PerpMarketDef, 'schedule'>, at: number = Date.now()): boolean {
  if (def.schedule === '24/7') return true;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(at));
  const weekday = parts.find((p) => p.type === 'weekday')?.value;
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  if (weekday === 'Sat') return false;
  if (weekday === 'Fri') return hour < 20;
  if (weekday === 'Sun') return hour >= 20;
  return true;
}

/* ------------------------------------------------------------------ */
/* Parameters                                                          */
/* ------------------------------------------------------------------ */

/**
 * The brief's numbers. The contract carries its own copy of each (set at
 * deploy, changeable by the owner); these are what the paper venue uses and
 * what the UI explains.
 */
export const PERP_MAX_LEVERAGE = 50;
/** A position is liquidated once its losses (price and funding) reach 80% of its collateral. */
export const PERP_LIQUIDATION_THRESHOLD = 0.8;
/** 0.1% of the position size, charged when it opens. */
export const PERP_FEE_BPS = 10;
/** 0.1% of the size again when it closes, so an open-and-close round trip is never free. */
export const PERP_CLOSE_FEE_BPS = 10;
/** The liquidator keeps 10% of what's left of the collateral… */
export const PERP_LIQUIDATOR_REWARD = 0.1;
/** …and at least 0.5% of the collateral, so a position past zero equity is still worth liquidating. */
export const PERP_MIN_LIQUIDATION_REWARD = 0.005;
/**
 * Profit on one position is capped at 9× its collateral, and at its size (a
 * 100% move). Not in the brief: the pool has to be able to pay every open
 * position's best case, so each open reserves that much pool liquidity —
 * without a cap a long's upside is unbounded and no reserve would be enough.
 */
export const PERP_MAX_PROFIT_MULTIPLE = 9;

/** Pool liquidity a position can ever take: min(9 × collateral, size). */
export function perpReserve(collateral: number, size: number, maxProfitMultiple = PERP_MAX_PROFIT_MULTIPLE): number {
  return Math.min(collateral * maxProfitMultiple, size);
}
export const PERP_MIN_COLLATERAL = 1;
/** How long a perps quote holds. Shorter than spot: the oracle price moves under it. */
export const PERP_QUOTE_TTL_SEC = 20;
/**
 * A feed quieter than this has stopped (or its market is shut): nothing opens,
 * closes or liquidates against it. Chainlink's Robinhood Chain feeds publish
 * at least every 24 hours; this is that and an hour to spare, like the
 * contract's `requestPriceAge`.
 */
export const PERP_PRICE_MAX_AGE_SEC = 90_000;
/** Default slippage bound on the fill price, basis points: paper fills at the price the trader signs. */
export const PERP_DEFAULT_SLIPPAGE_BPS = 50;
/**
 * On chain an order fills at Chainlink's next round — which comes *because*
 * the price moved 0.5% (or a day passed) — so its bound leaves room for that
 * move and a little more: 1.5%.
 */
export const PERP_CHAIN_SLIPPAGE_BPS = 150;

/* ------------------------------------------------------------------ */
/* API shapes                                                          */
/* ------------------------------------------------------------------ */

/**
 * - `open`        fresh oracle price, trading allowed
 * - `closed`      the oracle has stopped publishing (outside market hours)
 * - `halted`      close-only: the next futures contract isn't listed, or trading was paused
 * - `unavailable` no oracle for this market at all
 */
export type PerpMarketStatus = 'open' | 'closed' | 'halted' | 'unavailable';

export type PerpMarket = {
  symbol: string;
  name: string;
  localName: string;
  category: PerpCategory;
  unit: string;
  status: PerpMarketStatus;
  /** Why it isn't open, in a sentence. */
  statusNote: string | null;
  /** Mark price in USD: the feed's latest round. */
  price: number | null;
  /** The oracle's confidence interval, ± USD; null for Chainlink, which publishes none. */
  confidence: number | null;
  change24hPct: number | null;
  /** When the feed published the price (ISO). */
  publishTime: string | null;
  /** Funding per hour as a fraction of size: positive = longs pay. */
  fundingRatePerHour: number;
  openInterest: { long: number; short: number };
  maxLeverage: number;
  /** The feed behind the price, e.g. "Chainlink Robinhood NVDA / USD". */
  contract: string | null;
  nextRollAt: string | null;
  hours: string;
  source: 'chainlink' | 'fixture' | null;
};

export type PerpMarketStats = PerpMarket & {
  /** Notional opened in the last 24 hours, USD. */
  volume24h: number;
  /** Share of open interest that's long, 0..100. */
  longOiPercent: number;
  /** Cumulative price adjustment from contract rolls (1 = none yet). */
  rollFactor: number;
};

export type PerpQuoteBase = {
  /** The action row this quote is bound to. */
  id: string;
  venue: PerpVenueId;
  /** Bound to one address, like spot quotes. */
  address: Address;
  symbol: string;
  side: PerpSide;
  /** Mark price the quote was built on, USD. */
  markPrice: number;
  /** The fill must be at or better than this, or nothing happens. */
  acceptablePrice: number;
  slippageBps: number;
  /**
   * On chain, sent with the request in the native token: what whoever
   * executes the order (the keeper) is paid. 0 on paper.
   */
  executionFee: number;
  estGas: number;
  gasSymbol: string;
  quotedAt: string;
  expiresAt: string;
  warnings: string[];
  execution: OrderExecution;
};

export type PerpOpenQuote = PerpQuoteBase & {
  action: 'open';
  collateral: number;
  leverage: number;
  size: number;
  liquidationPrice: number;
  fee: number;
  feeBps: number;
  fundingRatePerHour: number;
  /** Estimated price impact as a fraction (brief: linear in size, capped at 0.5%). */
  priceImpact: number;
  /** Collateral that has to be deposited first (on-chain venue), USDC. */
  depositNeeded: number;
};

export type PerpCloseQuote = PerpQuoteBase & {
  action: 'close';
  positionId: string;
  collateral: number;
  size: number;
  entryPrice: number;
  estPnl: number;
  estFunding: number;
  /** The closing fee. */
  fee: number;
  feeBps: number;
  estPayout: number;
};

export type PerpQuote = PerpOpenQuote | PerpCloseQuote;

export type PerpPositionStatus = 'open' | 'closed' | 'liquidated';

export type PerpPosition = {
  id: string;
  venue: PerpVenueId;
  /** On-chain position id, as a decimal string; null on paper. */
  chainPositionId: string | null;
  symbol: string;
  category: PerpCategory;
  side: PerpSide;
  collateral: number;
  size: number;
  leverage: number;
  /** Entry price in terms of the current contract (adjusted for rolls since opening). */
  entryPrice: number;
  markPrice: number | null;
  liquidationPrice: number;
  /** Price PnL at the mark, capped at the max profit; null without a price. */
  unrealizedPnl: number | null;
  /** Funding owed by the position so far: positive = paid, negative = received. */
  fundingAccrued: number;
  /** Collateral + PnL − funding. */
  equity: number | null;
  /** PnL after funding as a percentage of collateral. */
  pnlPct: number | null;
  fee: number;
  status: PerpPositionStatus;
  openedAt: string;
  closedAt: string | null;
  exitPrice: number | null;
  realizedPnl: number | null;
  fundingPaid: number | null;
  /** What came back to the trader's free collateral at close. */
  payout: number | null;
  txOpen: string | null;
  txClose: string | null;
  explorerOpen: string | null;
  explorerClose: string | null;
  /** A close is on its way (signed, not yet settled). */
  closing: boolean;
};

export type PerpAccount = {
  venue: PerpVenueId | null;
  /** Collateral not backing any position — withdrawable, usable for new ones. */
  free: number;
  /** Collateral backing open positions. */
  locked: number;
  unrealizedPnl: number;
  /** free + locked + unrealized PnL − funding owed. */
  equity: number;
  openPositions: number;
  /** USDC in the wallet itself that could be deposited (on-chain venue). */
  walletUsdc: number | null;
  /** Paper venue in dev: test USDC on request. */
  canFaucet: boolean;
  collateralSymbol: string;
};

export type PerpActionKind = 'open' | 'close' | 'deposit' | 'withdraw';
/**
 * - `quoted`  waiting for a signature (20s)
 * - `pending` sent: waiting for the chain, then (on chain) for the order to execute
 * - `done`    settled
 * - `failed`  rejected on chain, or the order was cancelled at execution
 * - `expired` the quote lapsed unsigned
 */
export type PerpActionStatus = 'quoted' | 'pending' | 'done' | 'failed' | 'expired';

export type PerpActionRecord = {
  id: string;
  kind: PerpActionKind;
  status: PerpActionStatus;
  venue: PerpVenueId;
  symbol: string | null;
  /** The position it opened or closed, once known. */
  positionId: string | null;
  amount: number | null;
  error: string | null;
  txHash: string | null;
  explorerUrl: string | null;
  /** On chain: the request landed and the order waits for its price (the keeper executes it). */
  awaitingExecution: boolean;
  /** On chain: the order is still waiting for its round, and its trader hasn't asked for it back yet. */
  cancellable: boolean;
  /**
   * On chain: when the trader asked for it back. It's released
   * `PERP_CANCEL_DELAY_SEC` later — unless Chainlink had observed its price
   * before the ask, in which case it fills at that price.
   */
  cancelRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Where the on-chain venue lives, for anyone to check on the explorer
 * (`/api/perps/venue`): the network, the contracts, the settlement token,
 * the pool, and each market's Chainlink feed as the contracts read it.
 */
export type PerpVenueInfo = {
  venue: PerpVenueId | null;
  chain: { id: number; name: string; explorerUrl: string | null; mainnet: boolean } | null;
  contracts: { perp: Address; vault: Address; feed: Address } | null;
  collateral: { symbol: string; address: Address | null };
  /** USD (the settlement token's units). */
  pool: { balance: number; reserved: number; available: number } | null;
  deployBlock: number | null;
  feeds: Array<{ symbol: string; feed: Address; description: string }>;
};

/** AgriPerp.CANCEL_DELAY: a cancel releases the order this long after it's asked for, unless its round lands first. */
export const PERP_CANCEL_DELAY_SEC = 300;

/** An on-chain open or close still waiting for its Chainlink round, as the Positions panel lists it. */
export type PerpWaitingOrder = PerpActionRecord & {
  kind: 'open' | 'close';
  symbol: string;
  side: PerpSide;
  collateral: number;
  leverage: number;
  size: number;
  /** The worst fill it accepts, USD. */
  acceptablePrice: number;
};

/** Taking back an on-chain order that's still waiting for its round: one transaction (the ask). */
export type PerpCancelQuote = {
  /** The open or close action whose order it cancels. */
  id: string;
  kind: 'cancel';
  address: Address;
  venue: PerpVenueId;
  /** USDC the trader forfeits: the order's opening fee (0 for a close). */
  openingFee: number;
  execution: OrderExecution;
};

/** Deposit / withdraw on the on-chain venue: transactions the wallet sends. */
export type PerpCollateralQuote = {
  id: string;
  kind: 'deposit' | 'withdraw';
  amount: number;
  address: Address;
  venue: PerpVenueId;
  expiresAt: string;
  execution: OrderExecution;
};

/* ------------------------------------------------------------------ */
/* Math — the same formulas as AgriPerp.sol                            */
/* ------------------------------------------------------------------ */

/**
 * Price PnL of a position: size × (mark / entry − 1), mirrored for shorts,
 * capped at the max profit. Entry and mark must be in the same terms (both
 * index prices, or both adjusted to the current contract).
 */
export function perpPricePnl(p: {
  side: PerpSide;
  size: number;
  collateral: number;
  entry: number;
  mark: number;
  maxProfitMultiple?: number;
}): number {
  const move = (p.mark - p.entry) / p.entry;
  const raw = p.size * (p.side === 'long' ? move : -move);
  return Math.min(raw, p.collateral * (p.maxProfitMultiple ?? PERP_MAX_PROFIT_MULTIPLE));
}

/**
 * The price at which losses reach the liquidation threshold, counting the
 * funding already owed: for a long, entry × (1 − (threshold × collateral −
 * funding) / size). The brief's (0.8 / leverage) × entry is this with no
 * funding owed yet.
 */
export function perpLiquidationPrice(p: {
  side: PerpSide;
  entry: number;
  collateral: number;
  size: number;
  fundingOwed?: number;
  threshold?: number;
}): number {
  const room = (p.threshold ?? PERP_LIQUIDATION_THRESHOLD) * p.collateral - (p.fundingOwed ?? 0);
  const move = room / p.size;
  const price = p.side === 'long' ? p.entry * (1 - move) : p.entry * (1 + move);
  return Math.max(0, price);
}

/** Losses (price and funding) at or past the threshold. */
export function perpIsLiquidatable(p: {
  collateral: number;
  pnl: number;
  fundingOwed: number;
  threshold?: number;
}): boolean {
  return p.fundingOwed - p.pnl >= (p.threshold ?? PERP_LIQUIDATION_THRESHOLD) * p.collateral;
}

/** The brief's estimate: impact grows linearly with size, capped at 0.5%. */
export function perpPriceImpact(size: number): number {
  return Math.min(size / 1_000_000, 0.005);
}

/** What a close pays out: collateral + PnL − funding, never below zero. */
export function perpPayout(p: { collateral: number; pnl: number; fundingOwed: number }): number {
  return Math.max(0, p.collateral + p.pnl - p.fundingOwed);
}

/** An oracle's integer answer as USD: `answer × 10^-decimals`. */
export function answerToUsd(answer: bigint | number | string, decimals: number): number {
  return Number(answer) / 10 ** decimals;
}
