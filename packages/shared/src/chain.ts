/**
 * Chain settings, resolved from environment values the caller passes in —
 * this file is shared with the browser bundle, where `process.env.X` only
 * works when written out literally, so it never reads `process.env` itself.
 */
export type ChainConfig = {
  id: number;
  name: string;
  rpcUrl: string;
  /** Block explorer base, e.g. `https://explorer.example`; null when not configured. */
  explorerUrl: string | null;
  nativeSymbol: string;
  /** True when this is the dev stand-in because no chain is configured yet. */
  devFallback: boolean;
};

/**
 * Robinhood Chain is an Arbitrum Orbit L2, so when `NEXT_PUBLIC_CHAIN_ID` /
 * `NEXT_PUBLIC_RPC_URL` are still empty, `RC_ENV=dev` stands in Arbitrum
 * Sepolia — the closest public testnet — and flags it as a fallback. Every
 * other environment gets `null` and the wallet features say "not configured".
 */
const DEV_FALLBACK: ChainConfig = {
  id: 421614,
  name: 'Arbitrum Sepolia (dev stand-in)',
  rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
  explorerUrl: 'https://sepolia.arbiscan.io',
  nativeSymbol: 'ETH',
  devFallback: true,
};

export function resolveChainConfig(env: {
  chainId?: string;
  chainName?: string;
  rpcUrl?: string;
  explorerUrl?: string;
  nativeSymbol?: string;
  rcEnv?: string;
}): ChainConfig | null {
  const id = Number(env.chainId);
  const rpcUrl = env.rpcUrl?.trim();
  if (Number.isInteger(id) && id > 0 && rpcUrl) {
    return {
      id,
      name: env.chainName?.trim() || 'Robinhood Chain',
      rpcUrl,
      explorerUrl: env.explorerUrl?.trim().replace(/\/$/, '') || null,
      nativeSymbol: env.nativeSymbol?.trim() || 'ETH',
      devFallback: false,
    };
  }
  return (env.rcEnv ?? 'dev') === 'dev' ? DEV_FALLBACK : null;
}

/** Robinhood Chain mainnet. */
export const ROBINHOOD_CHAIN_MAINNET_ID = 4663;
/** Robinhood Chain's public testnet. */
export const ROBINHOOD_CHAIN_TESTNET_ID = 46630;

export function isMainnet(chain: Pick<ChainConfig, 'id' | 'devFallback'> | null): boolean {
  return Boolean(chain && !chain.devFallback && chain.id === ROBINHOOD_CHAIN_MAINNET_ID);
}

/** What the top bar says about the network: never "testnet" on mainnet, never "mainnet" on anything else. */
export function networkLabel(chain: Pick<ChainConfig, 'id' | 'devFallback'> | null): string {
  if (!chain) return 'no network';
  if (chain.devFallback) return 'testnet · dev';
  if (chain.id === ROBINHOOD_CHAIN_MAINNET_ID) return 'mainnet';
  if (chain.id === ROBINHOOD_CHAIN_TESTNET_ID) return 'testnet';
  if (chain.id === 31337) return 'local chain';
  return `chain ${chain.id}`;
}

export function explorerTxUrl(chain: ChainConfig | null, hash: string): string | null {
  if (!chain?.explorerUrl || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return null;
  return `${chain.explorerUrl}/tx/${hash}`;
}

export function explorerAddressUrl(chain: ChainConfig | null, address: string): string | null {
  if (!chain?.explorerUrl || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  return `${chain.explorerUrl}/address/${address}`;
}
