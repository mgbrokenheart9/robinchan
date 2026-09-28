import {
  PERP_MARKETS,
  RH_TOKEN_MAX_POSITION_USD,
  RH_TOKEN_MIN_LIQUIDITY_USD,
  TWAP_MAX_AGE_SEC,
  TWAP_WINDOW_SEC,
  tradablePerpMarkets,
} from '@robinchan/shared';

/**
 * What the contracts' deploy script lists on chain, derived from the one
 * market registry in @robinchan/shared. `scripts/perps-markets.mts` writes it
 * to `contracts/deploy/markets.json`; a core test fails when that file and
 * the registry disagree.
 */
export type DeployMarket = {
  symbol: string;
  maxLeverage: number;
  /** Open-interest cap per side, USD (the deploy's MAX_OI_USD caps it lower at launch). */
  maxOiUsd: number;
  /** 1e18 = 100% of size per hour, as a decimal string. */
  fundingRatePerHour: string;
  /** The Chainlink feed on Robinhood Chain mainnet, and the name its `description()` returns. */
  feed: { proxy: string; description: string };
  /** A local chain's MockAggregator starts here (USD); the worker then mirrors live prices into it. */
  mockPrice: number;
};

/**
 * Funding starts at zero and is set by hand per market (brief §12.4). The
 * pool is every trader's counterparty, so a standing positive rate isn't
 * neutral: a lone short would collect it from the pool (security review,
 * finding 8). The brief's placeholder, 0.01%/hour, would also be ~88% a
 * year for a long. Set PERPS_FUNDING_RATES / `setFundingRate` from the
 * long/short imbalance instead.
 */
export const DEFAULT_FUNDING_RATE_PER_HOUR = 0;

/** Where each local MockAggregator starts, in USD — the live feeds' levels on 2026-09-26 (the last five, 09-28); only local chains read it. */
const MOCK_PRICES: Record<string, number> = {
  BTC: 83_750,
  ETH: 2_690,
  AAPL: 341,
  TSLA: 372,
  NVDA: 226,
  AMZN: 250,
  GOOGL: 344,
  MSFT: 517,
  META: 749,
  SPCX: 147,
  SPY: 771,
  CRCL: 86,
  MU: 1_051,
  GLD: 380,
};

/** An agri market's PythRoundFeed, for contracts/scripts/deploy-pyth-feeds.ts. */
export type DeployPythFeed = {
  symbol: string;
  description: string;
  unitExp: number;
  /** Prints with a wider confidence interval answer 0 (a bad-price round). */
  maxConfBps: number;
  maxLeverage: number;
  maxOiUsd: number;
  months: Array<{ pythSymbol: string; feedId: string; rollAt: string | null }>;
};

/** An agri market's ReportedRoundFeed, for contracts/scripts/deploy-reported-feeds.ts. */
export type DeployReportedFeed = {
  symbol: string;
  description: string;
  /** The most one round may move the price; past it the owner posts (reportUnchecked). */
  maxMoveBps: number;
  maxLeverage: number;
  months: Array<{ symbol: string; rollAt: string | null }>;
};

/** An RH Token's TwapRoundFeed, for contracts/scripts/deploy-twap-feeds.ts. */
export type DeployTwapFeed = {
  symbol: string;
  description: string;
  /** The token priced, and the Uniswap pool its average is read from. */
  token: string;
  pair: string;
  /** TwapRoundFeed.PoolKind: 0 a Uniswap V2 pair, 1 a V3 pool. */
  kind: 0 | 1;
  /** The pool, for people: the feed's `source()`. */
  source: string;
  /** Chainlink's USD feed for the pool's other side (ETH/USD: every RH Token pool is against WETH). */
  quoteUsdFeed: string;
  windowSec: number;
  /** Seconds between observations: the keeper's cadence. */
  granularitySec: number;
  /** The circuit breaker: the latest round reads 0 once it's this old. */
  maxStalenessSec: number;
  /** The quote feed's heartbeat, and an hour. */
  quoteFeedMaxAgeSec: number;
  /** Rounds price only while the pool holds this much, USD (both sides). */
  minLiquidityUsd: number;
  maxLeverage: number;
  /** The most open interest a side may reach (the brief's $10k max position); listing starts at the launch cap. */
  maxOiUsd: number;
};

/** A TwapRoundFeed may observe every minute at most; the keeper chooses how often (twap.ts). */
export const TWAP_GRANULARITY_SEC = 60;
/** Chainlink's ETH/USD proxy on Robinhood Chain mainnet. */
const ETH_USD_FEED = '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9';

/** The RH Tokens with a Uniswap V2 or V3 pool to average, deployed or not. */
export function twapFeedsForDeploy(): DeployTwapFeed[] {
  return PERP_MARKETS.filter((m) => m.twap?.pool && m.twap.token).map((m) => ({
    symbol: m.symbol,
    description: m.twap!.description,
    token: m.twap!.token!,
    pair: m.twap!.pool!.address,
    kind: m.twap!.pool!.kind === 'uniswap-v3' ? 1 : 0,
    source: m.twap!.pool!.label,
    quoteUsdFeed: ETH_USD_FEED,
    windowSec: TWAP_WINDOW_SEC,
    granularitySec: TWAP_GRANULARITY_SEC,
    maxStalenessSec: TWAP_MAX_AGE_SEC,
    quoteFeedMaxAgeSec: 90_000,
    minLiquidityUsd: RH_TOKEN_MIN_LIQUIDITY_USD,
    maxLeverage: m.maxLeverage,
    maxOiUsd: RH_TOKEN_MAX_POSITION_USD,
  }));
}

/** The agri markets the operator prices from Yahoo Finance, deployed or not. */
export function reportedFeedsForDeploy(): DeployReportedFeed[] {
  return PERP_MARKETS.filter((m) => m.reported).map((m) => ({
    symbol: m.symbol,
    description: m.reported!.description,
    maxMoveBps: 1500,
    maxLeverage: m.maxLeverage,
    months: m.reported!.months.map((x) => ({ ...x })),
  }));
}

/** The agri markets Pyth prices, deployed or not. */
export function pythFeedsForDeploy(): DeployPythFeed[] {
  return PERP_MARKETS.filter((m) => m.pyth).map((m) => ({
    symbol: m.symbol,
    description: m.pyth!.description,
    unitExp: m.pyth!.unitExp,
    maxConfBps: 300,
    maxLeverage: m.maxLeverage,
    maxOiUsd: 1_000_000,
    months: m.pyth!.months.map((x) => ({ ...x })),
  }));
}

export function perpMarketsForDeploy(): DeployMarket[] {
  // The Chainlink markets: the agri and RH Token ones are listed on their
  // round feeds by contracts/scripts/list-agri-markets.ts, not by the stack's deploy.
  return tradablePerpMarkets()
    .filter((m) => !m.reported && !m.pyth && !m.twap)
    .map((m) => {
      const feed = m.contracts[0]!;
      return {
        symbol: m.symbol,
        maxLeverage: m.maxLeverage,
        maxOiUsd: 1_000_000,
        fundingRatePerHour: BigInt(Math.round(DEFAULT_FUNDING_RATE_PER_HOUR * 1e18)).toString(),
        feed: { proxy: feed.feedId, description: feed.oracleSymbol },
        mockPrice: MOCK_PRICES[m.symbol] ?? 100,
      };
    });
}
