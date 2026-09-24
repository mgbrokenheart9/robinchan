'use client';

import { createContext, useContext, type ReactNode } from 'react';

import type { PublicConfig } from '@/server/config';

/**
 * Server configuration the browser needs (chain, feature flags), handed
 * down from the layout as a prop so it reflects the running server's
 * environment rather than whatever was baked in at build time.
 */
const ConfigContext = createContext<PublicConfig | null>(null);

export function ConfigProvider({ config, children }: { config: PublicConfig; children: ReactNode }) {
  return <ConfigContext.Provider value={config}>{children}</ConfigContext.Provider>;
}

export function useConfig(): PublicConfig {
  const config = useContext(ConfigContext);
  if (!config) throw new Error('useConfig must be used inside <ConfigProvider>');
  return config;
}

/** Outside the dashboard (Home), where no provider is mounted. */
export function useOptionalConfig(): PublicConfig | null {
  return useContext(ConfigContext);
}
