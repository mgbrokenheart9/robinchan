'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChainConfig } from '@robinchan/shared';
import { defineChain } from 'viem';
import { WagmiProvider, createConfig, http, injected, type Config } from 'wagmi';

/**
 * wagmi + viem (brief §2), injected wallets only: every browser wallet that
 * announces itself over EIP-6963 (MetaMask, Rabby, Coinbase Wallet's
 * extension, …) shows up in the picker. No RainbowKit: its default setup
 * needs a WalletConnect Cloud project id that doesn't exist yet, and it ships
 * its own modal UI — the same reason the brief rules out TradingView's
 * embedded widget. The picker here is ours, in the product's own design.
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

function makeConfig(chain: ChainConfig): Config {
  const c = defineChain({
    id: chain.id,
    name: chain.name,
    nativeCurrency: { name: chain.nativeSymbol, symbol: chain.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [chain.rpcUrl] } },
    blockExplorers: chain.explorerUrl ? { default: { name: 'Explorer', url: chain.explorerUrl } } : undefined,
  });
  return createConfig({
    chains: [c],
    connectors: [injected()],
    transports: { [c.id]: http(chain.rpcUrl) },
    // Wallet state is client-only; hydrate after mount so the server render
    // and the first client render agree.
    ssr: true,
  });
}

export function WalletProvider({ chain, children }: { chain: ChainConfig | null; children: ReactNode }) {
  const [config] = useState(() => makeConfig(chain ?? PLACEHOLDER));
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } }),
  );
  return (
    <WagmiProvider config={config} reconnectOnMount>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
