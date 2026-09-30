/**
 * The chains perps run on (Multichain brief). Robinhood Chain is where
 * everything started and stays as it is: every market, the RH Tokens and the
 * Gap board. Base and Arbitrum One each get their own AgriPerp stack with the
 * agri markets (the operator's Yahoo Finance feed, as on Robinhood Chain —
 * Chainlink publishes no agri feed on either chain, checked 2026-09-30) and
 * the commodities Chainlink does publish there: gold and silver on both, WTI
 * oil on Arbitrum.
 *
 * Shared with the browser: the wallet adds and switches to these chains, so
 * only public RPC endpoints live here. The server's own RPC for each chain
 * comes from its environment.
 */

export const PERP_NETWORKS = ['robinhood', 'base', 'arbitrum'] as const;
export type PerpNetwork = (typeof PERP_NETWORKS)[number];

/** The network every request means when it names none: Robinhood Chain. */
export const PRIMARY_PERP_NETWORK: PerpNetwork = 'robinhood';

export type PerpNetworkChain = {
  id: number;
  name: string;
  /** A public endpoint, for the wallet to add the chain with. */
  rpcUrl: string;
  explorerUrl: string;
  /** Circle's USDC (6 decimals); null where there's none to settle in yet. */
  usdc: `0x${string}` | null;
  testnet: boolean;
};

export type PerpNetworkDef = {
  id: PerpNetwork;
  /** How the switcher says it. */
  name: string;
  /** The switcher's dot. */
  color: string;
  nativeSymbol: string;
  mainnet: PerpNetworkChain;
  testnet: PerpNetworkChain;
  /** What exists only here. Robinhood Chain's own tokens and stock tokens live nowhere else. */
  features: { rhTokens: boolean; gap: boolean };
  /** The environment prefix for this network's server settings (`BASE_RPC_URL`…); null for the primary, which keeps the original names. */
  envPrefix: string | null;
};

export const PERP_NETWORK_DEFS: Record<PerpNetwork, PerpNetworkDef> = {
  robinhood: {
    id: 'robinhood',
    name: 'RH Chain',
    color: '#4ade80',
    nativeSymbol: 'ETH',
    mainnet: {
      id: 4663,
      name: 'Robinhood Chain',
      // Robinhood's own endpoint is blocked by some ISPs; this one isn't.
      rpcUrl: 'https://robinhood.drpc.org',
      explorerUrl: 'https://robinhoodchain.blockscout.com',
      usdc: null,
      testnet: false,
    },
    // The primary network's chain always comes from the environment
    // (NEXT_PUBLIC_CHAIN_ID, NEXT_PUBLIC_RPC_URL…): these are only its ids.
    testnet: {
      id: 46630,
      name: 'Robinhood Chain Testnet',
      rpcUrl: '',
      explorerUrl: '',
      usdc: null,
      testnet: true,
    },
    features: { rhTokens: true, gap: true },
    envPrefix: null,
  },
  base: {
    id: 'base',
    name: 'Base',
    color: '#0052ff',
    nativeSymbol: 'ETH',
    mainnet: {
      id: 8453,
      name: 'Base',
      rpcUrl: 'https://mainnet.base.org',
      explorerUrl: 'https://basescan.org',
      usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      testnet: false,
    },
    testnet: {
      id: 84532,
      name: 'Base Sepolia',
      rpcUrl: 'https://sepolia.base.org',
      explorerUrl: 'https://sepolia.basescan.org',
      usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      testnet: true,
    },
    features: { rhTokens: false, gap: false },
    envPrefix: 'BASE',
  },
  arbitrum: {
    id: 'arbitrum',
    name: 'Arbitrum',
    color: '#2d374b',
    nativeSymbol: 'ETH',
    mainnet: {
      id: 42161,
      name: 'Arbitrum One',
      rpcUrl: 'https://arb1.arbitrum.io/rpc',
      explorerUrl: 'https://arbiscan.io',
      usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      testnet: false,
    },
    testnet: {
      id: 421614,
      name: 'Arbitrum Sepolia',
      rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
      explorerUrl: 'https://sepolia.arbiscan.io',
      usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
      testnet: true,
    },
    features: { rhTokens: false, gap: false },
    envPrefix: 'ARB',
  },
};

export function isPerpNetwork(value: unknown): value is PerpNetwork {
  return typeof value === 'string' && (PERP_NETWORKS as readonly string[]).includes(value);
}

/** Which network a chain id belongs to (mainnet or testnet); null for any other chain. */
export function perpNetworkOfChain(chainId: number): PerpNetwork | null {
  for (const def of Object.values(PERP_NETWORK_DEFS)) {
    if (def.mainnet.id === chainId || def.testnet.id === chainId) return def.id;
  }
  return null;
}

/**
 * One network's perps as the browser sees it (`/api/perps/chains` and the
 * page's config): the chain its contracts are on, and whether they're there.
 */
export type PerpChainInfo = {
  network: PerpNetwork;
  name: string;
  color: string;
  chainId: number;
  chainName: string;
  /** Public: for the wallet to add the chain. */
  rpcUrl: string;
  explorerUrl: string | null;
  nativeSymbol: string;
  testnet: boolean;
  /** `agri-perp` once the contracts are configured; null while the network is announced only. */
  venue: 'paper' | 'agri-perp' | null;
  collateralSymbol: string;
  features: PerpNetworkDef['features'];
};
