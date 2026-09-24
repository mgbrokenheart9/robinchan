import 'server-only';

import type { ChainConfig } from '@robinchan/shared';
import { chainConfig, heatReadsEnabled, isDev, tradingEnabled, venueId } from '@robinchan/core';

/**
 * What the browser needs to know about server configuration, resolved on
 * the server (where `RC_ENV` and the flags live) and passed down as props —
 * not baked into the bundle at build time.
 */
export type PublicConfig = {
  chain: ChainConfig | null;
  trading: boolean;
  heatReads: boolean;
  venue: string | null;
  /** Whether the venue can hold a resting limit order at all. */
  limitOrders: boolean;
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
    dev: isDev(),
  };
}
