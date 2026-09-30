'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChainConfig, PerpChainInfo } from '@robinchan/shared';
import { defineChain, type Chain } from 'viem';
import { WagmiProvider, createConfig, http, injected, type Config } from 'wagmi';

/**
 * wagmi + viem (brief §2), injected wallets only: every browser wallet that
 * announces itself over EIP-6963 (MetaMask, Rabby, Coinbase Wallet's
 * extension, …) shows up in the picker. No RainbowKit: its default setup
 * needs a WalletConnect Cloud project id that doesn't exist yet, and it ships
 * its own modal UI — the same reason the brief rules out TradingView's
 * embedded widget. The picker here is ours, in the product's own design.
 *
 * The app's chain comes first; every other chain perps run on (Multichain
 * brief: Base, Arbitrum) follows, so the wallet can be switched to it — and
 * asked to add it when it doesn't know it.
 *
 * With no chain configured (outside dev), a placeholder chain keeps the
 * hooks mounted and the connect button says wallet features aren't set up.
 */
const PLACEHOLDER: ChainConfig = {
  id: 1,
  name: 'Unconfigured',
  rpcUrl: 'http://127.0.0.1:0',
  explorerUrl: null,
  nativeSymbol: 'ETH',
  devFallback: false,
};

function toChain(c: { id: number; name: string; nativeSymbol: string; rpcUrl: string; explorerUrl: string | null }): Chain {
  return defineChain({
    id: c.id,
    name: c.name,
    nativeCurrency: { name: c.nativeSymbol, symbol: c.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [c.rpcUrl] } },
    blockExplorers: c.explorerUrl ? { default: { name: 'Explorer', url: c.explorerUrl } } : undefined,
  });
}

function makeConfig(chain: ChainConfig, perpChains: PerpChainInfo[]): Config {
  const primary = toChain(chain);
  const others = perpChains
    .filter((p) => p.chainId !== chain.id)
    .map((p) => toChain({ id: p.chainId, name: p.chainName, nativeSymbol: p.nativeSymbol, rpcUrl: p.rpcUrl, explorerUrl: p.explorerUrl }));
  const chains = [primary, ...others] as [Chain, ...Chain[]];
  return createConfig({
    chains,
    connectors: [injected()],
    transports: Object.fromEntries(chains.map((c) => [c.id, http(c.rpcUrls.default.http[0])])),
    // Wallet state is client-only; hydrate after mount so the server render
    // and the first client render agree.
    ssr: true,
  });
}

export function WalletProvider({
  chain,
  perpChains = [],
  children,
}: {
  chain: ChainConfig | null;
  perpChains?: PerpChainInfo[];
  children: ReactNode;
}) {
  const [config] = useState(() => makeConfig(chain ?? PLACEHOLDER, chain ? perpChains : []));
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } }),
  );
  return (
    <WagmiProvider config={config} reconnectOnMount>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
