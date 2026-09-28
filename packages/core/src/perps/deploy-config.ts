import { PERP_MARKETS, tradablePerpMarkets } from '@robinchan/shared';

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

/** Where each local MockAggregator starts, in USD — the live feeds' levels on 2026-09-26; only local chains read it. */
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
  return tradablePerpMarkets().map((m) => {
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
