/**
 * Which perps network a chain belongs to (Multichain brief), for the deploy
 * and listing scripts: Robinhood Chain's markets are in deploy/*.json, Base's
 * in deploy/base/, Arbitrum's in deploy/arbitrum/ — each generated from the
 * app's registry by `npx tsx scripts/perps-markets.mts` at the repo root.
 *
 * DEPLOY_NETWORK=base (or arbitrum) makes a local chain (31337) stand in for
 * that network, to rehearse its deploy.
 */
export type PerpNetwork = 'robinhood' | 'base' | 'arbitrum';

type NetworkInfo = {
  network: PerpNetwork;
  name: string;
  mainnetId: number;
  testnetId: number;
  /** Where its deploy files live, under contracts/deploy/. */
  dir: string;
  /** The app's environment prefix for its settings; '' for Robinhood Chain's original names. */
  envPrefix: string;
  /** Hardhat's network names, for the commands the scripts print. */
  hardhat: { mainnet: string; testnet: string };
  /** Chainlink's feed directory for its mainnet. */
  chainlinkDirectory: string;
  /** Circle's USDC on its mainnet and testnet; null where there's none (Robinhood Chain: USDG, set by hand). */
  usdc: { mainnet: string | null; testnet: string | null };
};

export const NETWORKS: Record<PerpNetwork, NetworkInfo> = {
  robinhood: {
    network: 'robinhood',
    name: 'Robinhood Chain',
    mainnetId: 4663,
    testnetId: 46630,
    dir: '',
    envPrefix: '',
    hardhat: { mainnet: 'rhMainnet', testnet: 'rhTestnet' },
    chainlinkDirectory: 'https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json',
    usdc: { mainnet: null, testnet: null },
  },
  base: {
    network: 'base',
    name: 'Base',
    mainnetId: 8453,
    testnetId: 84532,
    dir: 'base/',
    envPrefix: 'BASE_',
    hardhat: { mainnet: 'base', testnet: 'baseSepolia' },
    chainlinkDirectory: 'https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-base-1.json',
    usdc: { mainnet: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', testnet: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
  },
  arbitrum: {
    network: 'arbitrum',
    name: 'Arbitrum One',
    mainnetId: 42161,
    testnetId: 421614,
    dir: 'arbitrum/',
    envPrefix: 'ARB_',
    hardhat: { mainnet: 'arbitrum', testnet: 'arbitrumSepolia' },
    chainlinkDirectory: 'https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-arbitrum-1.json',
    usdc: { mainnet: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', testnet: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d' },
  },
};

export type ChainTarget = NetworkInfo & {
  chainId: number;
  /** The network's mainnet: the checks that only warn elsewhere fail here. */
  mainnet: boolean;
  local: boolean;
  /** Hardhat's name for this chain, for printed commands. */
  hardhatName: string;
};

/** The network a chain id belongs to; a local chain is Robinhood Chain's unless DEPLOY_NETWORK says otherwise. */
export function targetOf(chainId: number): ChainTarget {
  const local = chainId === 31337;
  const forced = process.env.DEPLOY_NETWORK?.trim() as PerpNetwork | undefined;
  if (forced && !(forced in NETWORKS)) throw new Error('DEPLOY_NETWORK is robinhood, base or arbitrum');
  const info =
    Object.values(NETWORKS).find((n) => n.mainnetId === chainId || n.testnetId === chainId) ??
    (local ? NETWORKS[forced ?? 'robinhood'] : null);
  if (!info) throw new Error(`Chain ${chainId} isn't Robinhood Chain, Base or Arbitrum (or their testnets)`);
  if (forced && !local && forced !== info.network) throw new Error(`DEPLOY_NETWORK=${forced}, but chain ${chainId} is ${info.name}`);
  const mainnet = chainId === info.mainnetId;
  return { ...info, chainId, mainnet, local, hardhatName: local ? 'localhost' : mainnet ? info.hardhat.mainnet : info.hardhat.testnet };
}

/** A deploy file of the network, e.g. deployFile(target, 'markets.json'). */
export const deployFile = (target: Pick<ChainTarget, 'dir'>, file: string): URL => new URL(`../../deploy/${target.dir}${file}`, import.meta.url);
