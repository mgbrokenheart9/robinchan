'use client';

import type { ReactNode } from 'react';

import { CompanionProvider } from '@/components/companion/CompanionProvider';
import { SessionProvider } from '@/components/wallet/SessionProvider';
import { WalletProvider } from '@/components/wallet/WalletProvider';
import { ConfigProvider } from '@/lib/config';
import type { PublicConfig } from '@/server/config';

/**
 * Everything the working surfaces share: server config, the wallet, the
 * signed-in session, and Robinchan's page context. Mounted by the dashboard
 * and chat layouts — not by Home, which stays a static marketing page
 * without wallet code in its bundle.
 */
export function AppProviders({ config, children }: { config: PublicConfig; children: ReactNode }) {
  return (
    <ConfigProvider config={config}>
      <WalletProvider chain={config.chain} perpChains={config.perpChains}>
        <SessionProvider chain={config.chain} otherChainIds={config.perpChains.map((c) => c.chainId)}>
          <CompanionProvider>{children}</CompanionProvider>
        </SessionProvider>
      </WalletProvider>
    </ConfigProvider>
  );
}
