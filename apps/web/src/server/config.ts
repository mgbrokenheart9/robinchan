import 'server-only';

import type { ChainConfig, PerpVenueId } from '@robinchan/shared';
import {
  chainConfig,
  heatReadsEnabled,
  isDev,
  perpCollateralSymbol,
  perpsEnabled,
  perpsVenue,
  tradingEnabled,
  venueId,
} from '@robinchan/core';

/**
 * What the browser needs to know about server configuration, resolved on
 * the server (where `RC_ENV` and the flags live) and passed down as props —
 * not baked into the bundle at build time.
 */
export type PublicConfig = {
  chain: ChainConfig | null;
  /** Spot orders from Robinchan's chat (`FEATURE_TRADING`). */
  trading: boolean;
  heatReads: boolean;
  venue: string | null;
  /** Whether the venue can hold a resting limit order at all. */
  limitOrders: boolean;
  /** The Perps page (`FEATURE_PERPS`). */
  perps: boolean;
  /** Where perps positions live: `paper` (dev), `agri-perp` (the contracts), or not configured. */
  perpsVenue: PerpVenueId | null;
  /** The settlement stablecoin traders deposit (USDG on Robinhood Chain). */
  perpsCollateral: string;
  dev: boolean;
};

export function publicConfig(): PublicConfig {
  const venue = venueId();
  return {
    chain: chainConfig(),
    trading: tradingEnabled(),
    heatReads: heatReadsEnabled(),
    venue,
    limitOrders: venue === 'paper',
    perps: perpsEnabled(),
    perpsVenue: perpsVenue(),
    perpsCollateral: perpCollateralSymbol(),
    dev: isDev(),
  };
}
