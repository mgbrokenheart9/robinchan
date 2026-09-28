import type { Address, OrderExecution } from './types';

/**
 * Perps (Agri Perps brief): synthetic perpetuals on crypto and stocks,
 * priced by Chainlink Data Feeds on Robinhood Chain and settled in USDC
 * against a liquidity pool. Of the brief's agricultural markets, coffee,
 * cocoa and sugar come through Pyth (a PythRoundFeed per market) once it's
 * deployed; the rest have no feed anywhere and stay coming soon. RH Tokens —
 * Robinhood Chain's own tokens — are priced by their Uniswap pool's
 * 15-minute TWAP (a TwapRoundFeed each). Shared by web, API and
 * worker — the market registry, the shapes the API returns, and the math
 * every layer has to agree on.
 */

export const PERP_CATEGORIES = ['agri', 'crypto', 'stocks', 'rh'] as const;
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
  name: string;
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
  /** Agri markets Pyth prices: where the price comes from before AgriFeed sees it. */
  pyth?: PerpPythFeed;
  /** Agri markets whose prices the operator posts (ReportedRoundFeed), read from Yahoo Finance. */
  reported?: PerpReportedFeed;
  /** RH Tokens: the DEX pool whose time-weighted average prices the market (TwapRoundFeed). */
  twap?: PerpTwapFeed;
  /** A price older than this means the feed stopped (default PERP_PRICE_MAX_AGE_SEC, Chainlink's heartbeat and an hour). */
  maxPriceAgeSec?: number;
  /** The largest one position may be (its size), USD. Unset: only the open-interest cap. */
  maxPositionUsd?: number;
};

/**
 * An RH Token market: a Robinhood Chain token priced by its own Uniswap V2 or
 * V3 pool's time-weighted average (contracts/contracts/oracles/TwapRoundFeed.sol),
 * in USD through Chainlink's ETH/USD. No oracle network prices these tokens,
 * so the pool is the oracle — and the pool has to be deep enough that moving
 * its average for 15 minutes costs more than a position could win.
 */
export type PerpTwapFeed = {
  /** The deployed TwapRoundFeed; null until then, and the market stays coming soon. */
  roundFeed: `0x${string}` | null;
  /** What the round feed's `description()` returns. */
  description: string;
  /** The token on Robinhood Chain; null when there's none trading there. */
  token: `0x${string}` | null;
  /**
   * The pool the average is read from: a Uniswap V2 pair (its cumulative
   * price) or a V3 pool (its cumulative tick). Null when the token has
   * neither: Uniswap v4 pools keep no price record on chain to read.
   */
  pool: { address: `0x${string}`; label: string; kind: 'uniswap-v2' | 'uniswap-v3' } | null;
};

/** RH Tokens brief: thin, fast-moving tokens — 5× at most. */
export const RH_TOKEN_MAX_LEVERAGE = 5;
/** RH Tokens brief: the largest one position may be, USD. */
export const RH_TOKEN_MAX_POSITION_USD = 10_000;
/** RH Tokens brief: a token is listed only while the pool its price comes from holds this much, USD (both sides). */
export const RH_TOKEN_MIN_LIQUIDITY_USD = 500_000;
/** Each round's average spans 15 minutes (TwapRoundFeed's `window`). */
export const TWAP_WINDOW_SEC = 900;
/** RH Tokens brief's circuit breaker: an hour without a fresh average and the market stops (TwapRoundFeed's `maxStaleness`). */
export const TWAP_MAX_AGE_SEC = 3_600;
/** The RH Tokens tab's banner, word for word from the brief. */
export const RH_TOKEN_WARNING =
  '⚠️ RH Chain tokens are highly volatile with lower liquidity. Max leverage is capped at 5x. Trade with caution.';
/** Where an RH Token's price comes from, as its badge says it. */
export const TWAP_BADGE = 'DEX TWAP · 15min';

/**
 * An agri market priced by the operator: the keeper reads each contract
 * month's quote from Yahoo Finance (delayed ~10 minutes) and posts it, with
 * the time the exchange quoted it, to a ReportedRoundFeed that AgriFeed lists
 * like a Chainlink proxy. Traders trust the operator for these prices.
 */
export type PerpReportedFeed = {
  /** The deployed ReportedRoundFeed; null until then, and the market stays coming soon. */
  roundFeed: `0x${string}` | null;
  /** What the round feed's `description()` returns. */
  description: string;
  /**
   * Yahoo Finance contract months in order, e.g. KCZ26.NYB. `rollAt` is when
   * to move to the next (ISO, UTC), a few sessions before first notice or
   * expiry; null while the next month isn't listed here yet.
   */
  months: Array<{ symbol: string; rollAt: string | null }>;
};

/** Where a reported market's quotes come from, as the feed's `source()` says it. */
export const reportedSource = (symbol: string): string => `Yahoo Finance ${symbol} (delayed)`;

/**
 * An agri market priced by Pyth: its dated futures months, front first, and
 * the PythRoundFeed on Robinhood Chain that turns the front month into
 * Chainlink-style rounds for AgriFeed (contracts/contracts/oracles).
 */
export type PerpPythFeed = {
  /** The deployed PythRoundFeed; null until then, and the market stays coming soon. */
  roundFeed: `0x${string}` | null;
  /** What the round feed's `description()` returns. */
  description: string;
  /** 0 for USD quotes, -2 for US cents. */
  unitExp: number;
  /**
   * Contract months in order. `rollAt` is when to move to the next one (ISO,
   * UTC); null while the next month isn't on Pyth yet.
   */
  months: Array<{ pythSymbol: string; feedId: `0x${string}`; rollAt: string | null }>;
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
function noFeed(
  symbol: string,
  name: string,
  category: PerpCategory,
  unit: string,
  hours: string,
  note?: string,
): PerpMarketDef {
  return {
    symbol,
    name,
    category,
    unit,
    contracts: [],
    maxLeverage: category === 'crypto' ? CRYPTO_MAX_LEVERAGE : GAPPING_MAX_LEVERAGE,
    hours,
    schedule: category === 'crypto' ? '24/7' : '24/5',
    unavailable:
      note ??
      `Chainlink has no ${name.toLowerCase()} price feed on Robinhood Chain (checked ${CHAINLINK_CHECKED}), so there's no oracle to settle against.`,
  };
}

/**
 * Coming soon: no commodity price reaches Robinhood Chain yet — Chainlink has
 * no agri feed there, and Pyth's commodity data needs a paid plan.
 */
const agri = (symbol: string, name: string, unit: string, hours: string) =>
  noFeed(
    symbol,
    name,
    'agri',
    unit,
    hours,
    `Coming soon. ${name} perps open once a live ${name.toLowerCase()} price feed is on Robinhood Chain for the contracts to settle against.`,
  );

/**
 * An agri market: coming soon until one of its round feeds is deployed —
 * the operator's (reported, from Yahoo Finance) or Pyth's — then a market like
 * any Chainlink one: the round feed stands where a Chainlink proxy would, and
 * AgriFeed lists it. The reported feed wins while both exist.
 */
function agriMarket(
  symbol: string,
  name: string,
  unit: string,
  hours: string,
  feeds: { pyth?: PerpPythFeed; reported?: PerpReportedFeed },
): PerpMarketDef {
  const { pyth, reported } = feeds;
  const live = reported?.roundFeed
    ? {
        feedId: reported.roundFeed,
        oracleSymbol: reported.description,
        label: `Robinchan-posted, from Yahoo Finance (delayed ~10 min)`,
        rollAt: reported.months[0]?.rollAt ?? null,
      }
    : pyth?.roundFeed
      ? {
          feedId: pyth.roundFeed,
          oracleSymbol: pyth.description,
          label: pyth.description,
          rollAt: pyth.months[0]?.rollAt ?? null,
        }
      : null;
  if (!live) return { ...agri(symbol, name, unit, hours), ...feeds };
  return {
    symbol,
    name,
    category: 'agri',
    unit,
    contracts: [live],
    maxLeverage: GAPPING_MAX_LEVERAGE,
    hours,
    schedule: '24/5',
    ...feeds,
  };
}

/** A reported feed, not deployed yet, over these Yahoo Finance months. */
/**
 * The deployed ReportedRoundFeeds on Robinhood Chain mainnet, by description
 * (contracts/deployments/4663-reported.json, 2026-09-28).
 */
const REPORTED_ROUND_FEEDS: Record<string, `0x${string}`> = {
  'Robinchan Corn / USD': '0x08c1a439ad2fdb4e863eb8e0d76259482a066e80',
  'Robinchan Soybeans / USD': '0xc95854110b452d5615e60f86620033a1819bed77',
  'Robinchan Wheat / USD': '0xbfc888795a3e18b3459d282da0e34d04825c1d06',
  'Robinchan Arabica Coffee / USD': '0x9d27d4f9d1dc45ccf10c63ff67f8214c14fe881e',
  'Robinchan Cocoa / USD': '0xc12c607d8cda0399b041afe5308022fec844f7e6',
  'Robinchan Raw Sugar / USD': '0x250973800da6531dd0f3bc9d682b6ec1cc532d84',
  'Robinchan Rough Rice / USD': '0x891c8693c02ada3f1a8161e02d44ee38c93927d3',
  'Robinchan Cotton / USD': '0x94a9fd7f61f58bb33711a3c9fc8c09a523ce46f0',
};

/** A reported feed over these Yahoo Finance months — live once deployed. */
const yahoo = (description: string, months: PerpReportedFeed['months']): PerpReportedFeed => ({
  roundFeed: REPORTED_ROUND_FEEDS[description] ?? null,
  description,
  months,
});

/** An agri or RH Token market waiting on its feed: shown as coming soon rather than as missing an oracle. */
export const perpComingSoon = (m: { category: PerpCategory; status?: string }): boolean =>
  (m.category === 'agri' || m.category === 'rh') && (m.status === undefined || m.status === 'unavailable');

/**
 * The deployed TwapRoundFeeds on Robinhood Chain mainnet, by market
 * (contracts/deployments/4663-twap.json). None yet.
 */
const TWAP_ROUND_FEEDS: Record<string, `0x${string}`> = {};

/**
 * An RH Token market: coming soon until its TwapRoundFeed is deployed, then
 * priced by it like any Chainlink market — 24/7, 5× at most, $10k a
 * position, stopped once the average is an hour old.
 */
function rhToken(
  symbol: string,
  name: string,
  feed: { token: `0x${string}` | null; pool: PerpTwapFeed['pool'] },
  waiting = feed.pool
    ? `${symbol} opens once its 15-minute price feed, read from its ${feed.pool.label} pool, is live on Robinhood Chain.`
    : `${symbol} has no Uniswap V2 or V3 pool to read a price average from.`,
): PerpMarketDef {
  const twap: PerpTwapFeed = {
    roundFeed: feed.pool ? (TWAP_ROUND_FEEDS[symbol] ?? null) : null,
    description: `Robinchan ${symbol} / USD (TWAP)`,
    ...feed,
  };
  const live = twap.roundFeed && twap.pool
    ? { feedId: twap.roundFeed, oracleSymbol: twap.description, label: `DEX TWAP · 15 min, ${twap.pool.label}`, rollAt: null }
    : null;
  return {
    symbol,
    name,
    category: 'rh',
    unit: '',
    contracts: live ? [live] : [],
    maxLeverage: RH_TOKEN_MAX_LEVERAGE,
    hours: '24/7',
    schedule: '24/7',
    maxPriceAgeSec: TWAP_MAX_AGE_SEC,
    maxPositionUsd: RH_TOKEN_MAX_POSITION_USD,
    twap,
    ...(live ? {} : { unavailable: `Coming soon. ${waiting}` }),
  };
}

export const PERP_MARKETS: PerpMarketDef[] = [
  /*
   * ---- Agri: no Chainlink feed for any of them on Robinhood Chain ----
   * Yahoo Finance symbols checked on 2026-09-28. Roll times sit a few
   * sessions before each month's first notice day (sugar: expiry). Pyth feed
   * ids checked against Hermes' feed list the same day; Pyth's next months
   * after the last listed here aren't on Pyth yet.
   */
  agriMarket('CORN', 'Corn', '/bu', 'CBOT hours', {
    reported: yahoo('Robinchan Corn / USD', [
      { symbol: 'ZCZ26.CBT', rollAt: '2026-11-20T15:00:00Z' },
      { symbol: 'ZCH27.CBT', rollAt: null },
    ]),
  }),
  agriMarket('SOYB', 'Soybeans', '/bu', 'CBOT hours', {
    reported: yahoo('Robinchan Soybeans / USD', [
      { symbol: 'ZSX26.CBT', rollAt: '2026-10-23T15:00:00Z' },
      { symbol: 'ZSF27.CBT', rollAt: '2026-12-18T15:00:00Z' },
      { symbol: 'ZSH27.CBT', rollAt: null },
    ]),
  }),
  agriMarket('WEAT', 'Wheat', '/bu', 'CBOT hours', {
    reported: yahoo('Robinchan Wheat / USD', [
      { symbol: 'ZWZ26.CBT', rollAt: '2026-11-20T15:00:00Z' },
      { symbol: 'ZWH27.CBT', rollAt: null },
    ]),
  }),
  agriMarket('COFF', 'Arabica Coffee', '/lb', 'ICE hours', {
    reported: yahoo('Robinchan Arabica Coffee / USD', [
      { symbol: 'KCZ26.NYB', rollAt: '2026-11-12T15:00:00Z' },
      { symbol: 'KCH27.NYB', rollAt: null },
    ]),
    pyth: {
      roundFeed: null,
      description: 'Pyth Arabica Coffee / USD',
      unitExp: -2,
      months: [
        {
          pythSymbol: 'Commodities.CFZ6/USc',
          feedId: '0xa61c21c0ca93300f50f231b52f59e9a6f47a07d33e78c1a9b8f84bd5928a3e8f',
          rollAt: '2026-11-12T15:00:00Z',
        },
        {
          pythSymbol: 'Commodities.CFH7/USc',
          feedId: '0x6d2ae51093c677632d215bc74b37314e61994e5dd8ec311372f468617dd30299',
          rollAt: null,
        },
      ],
    },
  }),
  agriMarket('COCC', 'Cocoa', '/t', 'ICE hours', {
    reported: yahoo('Robinchan Cocoa / USD', [
      { symbol: 'CCZ26.NYB', rollAt: '2026-11-06T15:00:00Z' },
      { symbol: 'CCH27.NYB', rollAt: null },
    ]),
    pyth: {
      roundFeed: null,
      description: 'Pyth Cocoa / USD',
      unitExp: 0,
      months: [
        {
          pythSymbol: 'Commodities.CAZ6/USD',
          feedId: '0x7452a0c6aa220280021272c3cebaaa0f32cc910cd14ea43460ff8ae2d1e773ea',
          rollAt: '2026-11-12T15:00:00Z',
        },
        {
          pythSymbol: 'Commodities.CAH7/USD',
          feedId: '0x600f4865bb8a69e773b716bf954597399861bd945cc35e06f03c42fc4f539c0c',
          rollAt: null,
        },
      ],
    },
  }),
  agriMarket('SUGA', 'Raw Sugar', '/lb', 'ICE hours', {
    reported: yahoo('Robinchan Raw Sugar / USD', [
      { symbol: 'SBH27.NYB', rollAt: '2027-02-18T15:00:00Z' },
      { symbol: 'SBK27.NYB', rollAt: null },
    ]),
    pyth: {
      roundFeed: null,
      description: 'Pyth Raw Sugar / USD',
      unitExp: -2,
      // October 2026 (RSV6) expired on 30 September: March 2027 is the front month.
      months: [
        {
          pythSymbol: 'Commodities.RSH7/USc',
          feedId: '0xdff723417798bd324ca03d568c04b22462a0fe9b6236e0fce1077d13d2ea69b4',
          rollAt: null,
        },
      ],
    },
  }),
  agri('PALM', 'Crude Palm Oil', '/t', 'Bursa Malaysia hours'),
  agriMarket('RICE', 'Rough Rice', '/cwt', 'CBOT hours', {
    reported: yahoo('Robinchan Rough Rice / USD', [
      { symbol: 'ZRX26.CBT', rollAt: '2026-10-23T15:00:00Z' },
      { symbol: 'ZRF27.CBT', rollAt: null },
    ]),
  }),
  agriMarket('COTT', 'Cotton', '/lb', 'ICE hours', {
    reported: yahoo('Robinchan Cotton / USD', [
      { symbol: 'CTZ26.NYB', rollAt: '2026-11-13T15:00:00Z' },
      { symbol: 'CTH27.NYB', rollAt: null },
    ]),
  }),

  /* ---- Crypto ---- */
  crypto('BTC', 'Bitcoin', '0xa2c5184bF03d373Dc9dE4876eb4Bce595B460251', 'BTC / USD'),
  crypto('ETH', 'Ethereum', '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9', 'ETH / USD'),
  noFeed('SOL', 'Solana', 'crypto', '', '24/7'),
  noFeed('ARB', 'Arbitrum', 'crypto', '', '24/7'),

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
  stock(
    'META',
    'Meta Platforms',
    '0x7C38C00C30BEe9378381E7B6135d7283356D71b1',
    'Robinhood META / USD',
  ),
  // More of Robinhood's stock tokens, each with a deep pool on chain and
  // its own Chainlink feed (checked on chain 2026-09-28). SpaceX is private:
  // Chainlink's SPCX feed prices Robinhood's token of it.
  stock('SPCX', 'SpaceX', '0xB265810950ba6c5C0Ff821c9963014a56fD8Bffb', 'Robinhood SPCX / USD'),
  stock('SPY', 'SPDR S&P 500 ETF', '0x319724394D3A0e3669269846abE664Cd621f9f6A', 'RHSPY / USD'),
  stock('CRCL', 'Circle', '0x6652eDf64bA3731C4F2D3ce821A0Fb1f1f6b482a', 'Robinhood CRCL / USD'),
  stock('MU', 'Micron', '0x425EEFdCf05ed6526C3cE61Af99429A228a6d596', 'RHMU / USD'),
  stock('GLD', 'SPDR Gold Trust', '0x470A51258068043bd43dC0a56245625C9fE86eB0', 'GLD / USD'),

  /*
   * ---- RH Tokens: Robinhood Chain's own tokens, priced by their pools ----
   * A mix — a launchpad's token, a memecoin, a DeFi protocol's — each with a
   * Uniswap V3 pool over $500k, checked 2026-09-28: the pool on chain
   * (Uniswap's V3 factory 0x1f7d…2EfA, observe() answering) and the token
   * through Token Check (sells with no tax, no owner). Their deepest pools
   * are on Uniswap v4, which keeps no price record to read; the V3 pools
   * named here are the deepest that do. Left out: the stock tokens, which
   * Chainlink prices (the Stocks tab's place), and "Robinhood Wallet"
   * (WALLET), which borrows Robinhood's name.
   */
  rhToken('PONS', 'Pons', {
    token: '0x39dbed3a2bd333467115de45665cc57f813c4571',
    pool: { address: '0xed50bdeea8adc232f159486192a4157281d722ff', label: 'Uniswap V3 PONS/WETH', kind: 'uniswap-v3' },
  }),
  rhToken('CASHCAT', 'Cash Cat', {
    token: '0x020bfc650a365f8bb26819deaabf3e21291018b4',
    pool: { address: '0xa70fc67c9f69da90b63a0e4c05d229954574e313', label: 'Uniswap V3 CASHCAT/WETH', kind: 'uniswap-v3' },
  }),
  rhToken('DELTA', 'Delta', {
    token: '0xe8ffd7e24187f72afb08d75b1bb13088a989a791',
    pool: { address: '0xd64fbda67e1015df43fa5e49f02ca844729e5f94', label: 'Uniswap V3 DELTA/WETH', kind: 'uniswap-v3' },
  }),
];

function crypto(
  symbol: string,
  name: string,
  feedId: `0x${string}`,
  oracleSymbol: string,
): PerpMarketDef {
  return {
    symbol,
    name,
    category: 'crypto',
    unit: '',
    contracts: [{ feedId, oracleSymbol, label: `Chainlink ${oracleSymbol}`, rollAt: null }],
    maxLeverage: CRYPTO_MAX_LEVERAGE,
    hours: '24/7',
    schedule: '24/7',
  };
}

function stock(
  symbol: string,
  name: string,
  feedId: `0x${string}`,
  oracleSymbol: string,
): PerpMarketDef {
  return {
    symbol,
    name,
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
export function perpOracleFeeds(): Array<{
  symbol: string;
  feed: `0x${string}`;
  oracleSymbol: string;
}> {
  return tradablePerpMarkets().map((m) => ({
    symbol: m.symbol,
    feed: m.contracts[0]!.feedId,
    oracleSymbol: m.contracts[0]!.oracleSymbol,
  }));
}

/**
 * The contract a market should be on at `at`: the first one whose roll time
 * hasn't come yet. Every Chainlink feed is continuous, so this is its only
 * one; null for a market without an oracle.
 */
export function scheduledContract(
  def: PerpMarketDef,
  at: number = Date.now(),
): PerpFeedContract | null {
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
export function perpSessionOpen(
  def: Pick<PerpMarketDef, 'schedule'>,
  at: number = Date.now(),
): boolean {
  if (def.schedule === '24/7') return true;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
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
export function perpReserve(
  collateral: number,
  size: number,
  maxProfitMultiple = PERP_MAX_PROFIT_MULTIPLE,
): number {
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

/** One of an RH Token's pools on Robinhood Chain, as DexScreener lists it. */
export type RhTokenPool = {
  /** "uniswap", "sushiswap"… */
  dex: string;
  /** "v2", "v3", "v4"; null when DexScreener doesn't say. */
  version: string | null;
  /** The pool's address (a v4 pool's 32-byte id). */
  address: string;
  /** "CASHCAT/WETH". */
  pair: string;
  /** Both sides, USD. */
  liquidityUsd: number;
  url: string;
};

/**
 * `GET /api/rh-tokens` (RH Tokens brief): each RH Token, its pools on
 * Robinhood Chain, and whether the pool its price comes from — the Uniswap
 * pool the 15-minute average is read from — is deep enough to list.
 */
export type RhToken = {
  symbol: string;
  name: string;
  token: `0x${string}` | null;
  status: PerpMarketStatus;
  statusNote: string | null;
  /** DexScreener's price across the token's pools, USD — the spot price, for reference. */
  spotPrice: number | null;
  /** The feed's latest 15-minute average, USD; null until it's deployed and priced. */
  twapPrice: number | null;
  /** When that average's window ended (ISO). */
  twapAt: string | null;
  /** Every pool of the token on Robinhood Chain together, USD. */
  totalLiquidityUsd: number | null;
  /** The pool the average is read from. Its depth — no other pool's — decides the listing. */
  oraclePool: { address: `0x${string}`; label: string; liquidityUsd: number | null } | null;
  /** The oracle pool holds at least `minLiquidityUsd`. */
  meetsLiquidity: boolean;
  pools: RhTokenPool[];
  maxLeverage: number;
  maxPositionUsd: number;
};

export type RhTokensBoard = {
  tokens: RhToken[];
  minLiquidityUsd: number;
  windowSec: number;
  /** "DEX TWAP · 15min". */
  oracle: string;
  warning: string;
  /** When the worker last read the pools (ISO); null before its first run. */
  checkedAt: string | null;
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
