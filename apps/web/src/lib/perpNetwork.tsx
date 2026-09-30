'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { PerpChainInfo, PerpNetwork } from '@robinchan/shared';
import { PRIMARY_PERP_NETWORK } from '@robinchan/shared';

/**
 * Which network the Perps page is on (Multichain brief): Robinhood Chain,
 * Base or Arbitrum. Every perps request carries it as `?chain=`; the
 * primary's requests carry nothing, exactly as before.
 */
export type PerpNetworkState = {
  network: PerpNetwork;
  /** The network's chain as the server runs it; null while the network isn't configured here. */
  chain: PerpChainInfo | null;
  /** Every network the server runs. */
  chains: PerpChainInfo[];
  setNetwork: (network: PerpNetwork) => void;
};

const PerpNetworkContext = createContext<PerpNetworkState | null>(null);

export function PerpNetworkProvider({ value, children }: { value: PerpNetworkState; children: ReactNode }) {
  return <PerpNetworkContext.Provider value={value}>{children}</PerpNetworkContext.Provider>;
}

const PRIMARY: PerpNetworkState = { network: PRIMARY_PERP_NETWORK, chain: null, chains: [], setNetwork: () => {} };

/** Outside the Perps page, the primary network. */
export function usePerpNetwork(): PerpNetworkState {
  return useContext(PerpNetworkContext) ?? PRIMARY;
}

/** A perps API path on `network`: `?chain=` added, except on the primary. */
export function perpPath(path: string, network: PerpNetwork): string {
  if (network === PRIMARY_PERP_NETWORK) return path;
  return `${path}${path.includes('?') ? '&' : '?'}chain=${network}`;
}
