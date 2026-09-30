import { AsyncLocalStorage } from 'node:async_hooks';

import type { ChainConfig, NetworkFeeds, PerpMarketDef, PerpNetwork } from '@robinchan/shared';
import { PERP_NETWORKS, PERP_NETWORK_DEFS, PRIMARY_PERP_NETWORK, perpMarketsOn, tradablePerpMarkets } from '@robinchan/shared';
import { cacheKey, type PerpChainScope } from '@robinchan/store';

import { withChainOverride, withoutChainOverride } from '../chain-scope';
import { chainConfig, isDev } from '../env';

/**
 * Perps on more than one chain (Multichain brief). Robinhood Chain — the
 * primary network — keeps its configuration exactly as it was: the
 * AGRI_*_ADDRESS, PERPS_* and NEXT_PUBLIC_CHAIN_* variables. Base and
 * Arbitrum each run their own AgriPerp stack, configured under a prefix of
 * their own (BASE_…, ARB_…), and the same code serves them: a caller runs it
 * inside `withPerpNetwork`, where the perps configuration, the chain and
 * every cache key are that network's.
 *
 * A network other than the primary is on once its RPC is set
 * (`BASE_RPC_URL`); it trades once its three contract addresses are.
 *
 *   BASE_RPC_URL                  the server's endpoint (a provider's, with its key)
 *   BASE_CHAIN_ID                 8453 (default), or 84532 for Base Sepolia
 *   BASE_AGRI_PERP_ADDRESS        the stack scripts/deploy.ts printed
 *   BASE_AGRI_VAULT_ADDRESS
 *   BASE_AGRI_FEED_ADDRESS
 *   BASE_AGRI_DEPLOY_BLOCK        where the indexer starts
 *   BASE_REPORTED_FEEDS           {"CORN":"0x…",…}: ReportedRoundFeeds not in the registry yet (a testnet's)
 *   BASE_PERPS_EXECUTION_FEE_WEI  sent with each order for its executor
 *   BASE_PERPS_ORACLE=mock        testnets only: MockAggregators, fed from mainnet's Chainlink
 *   BASE_ORACLE_RPC_URL           mainnet endpoint the mock oracle reads (default: the public one)
 *   BASE_EXPLORER_URL             default: BaseScan for the chain id
 *
 * The same names with ARB_ for Arbitrum. KEEPER_PRIVATE_KEY is shared: one
 * keeper, gas on every chain.
 */

export type AgriPerpContracts = { perp: `0x${string}`; vault: `0x${string}`; feed: `0x${string}` };

/** A network other than the primary, as its environment configures it. */
export type SecondaryDeployment = {
  network: Exclude<PerpNetwork, 'robinhood'>;
  chain: ChainConfig;
  contracts: AgriPerpContracts | null;
  deployBlock: bigint;
  reportedFeeds: Record<string, `0x${string}`>;
  executionFeeWei: bigint;
  oracleMode: 'chainlink' | 'mock';
  oracleRpcUrl: string;
  collateralSymbol: string;
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const LOCAL_CHAIN_ID = 31337;

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}
const addr = (name: string): `0x${string}` | null => {
  const v = env(name);
  return v && ADDRESS.test(v) ? (v as `0x${string}`) : null;
};

const parsedFeeds = new Map<string, Record<string, `0x${string}`>>();

function reportedFeedsFrom(raw: string | undefined, prefix: string): Record<string, `0x${string}`> {
  if (!raw) return {};
  const known = parsedFeeds.get(raw);
  if (known) return known;
  const out: Record<string, `0x${string}`> = {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [symbol, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && ADDRESS.test(value)) out[symbol.toUpperCase()] = value as `0x${string}`;
    }
  } catch {
    warnOnce(`${prefix}:feeds`, `[perps] ${prefix}_REPORTED_FEEDS isn't JSON like {"CORN":"0x…"}: ignored`);
  }
  parsedFeeds.set(raw, out);
  return out;
}

/** The primary's chain id as configured, whatever scope the caller is in. */
function primaryChainId(): number | null {
  return withoutChainOverride(() => chainConfig()?.id ?? null);
}

/** A network's deployment from its environment; null while its RPC isn't set (the network is off). */
export function secondaryDeploymentFor(network: PerpNetwork): SecondaryDeployment | null {
  if (network === 'robinhood') return null;
  const def = PERP_NETWORK_DEFS[network];
  const p = def.envPrefix as string;
  const rpcUrl = env(`${p}_RPC_URL`);
  if (!rpcUrl) return null;
  const chainId = Number(env(`${p}_CHAIN_ID`) ?? def.mainnet.id);
  // The network's mainnet or testnet — or, in development, a local node standing in for it.
  const known = chainId === def.mainnet.id ? def.mainnet : chainId === def.testnet.id ? def.testnet : null;
  if (!known && !(chainId === LOCAL_CHAIN_ID && isDev())) {
    warnOnce(`${p}:chain`, `[perps] ${p}_CHAIN_ID=${chainId} isn't ${def.name} (${def.mainnet.id}, or ${def.testnet.id} for its testnet): ${def.name} is off`);
    return null;
  }
  // Two networks on one chain would share its rows (positions are keyed by chain id).
  if (chainId === primaryChainId()) {
    warnOnce(`${p}:same`, `[perps] ${p}_CHAIN_ID=${chainId} is the primary network's chain too: ${def.name} is off`);
    return null;
  }
  const perp = addr(`${p}_AGRI_PERP_ADDRESS`);
  const vault = addr(`${p}_AGRI_VAULT_ADDRESS`);
  const feed = addr(`${p}_AGRI_FEED_ADDRESS`);
  const block = env(`${p}_AGRI_DEPLOY_BLOCK`);
  const fee = env(`${p}_PERPS_EXECUTION_FEE_WEI`);
  // Mock feeds take anyone's price: never on a network's mainnet.
  const mock = env(`${p}_PERPS_ORACLE`) === 'mock' && chainId !== def.mainnet.id;
  return {
    network,
    chain: {
      id: chainId,
      name: known?.name ?? `${def.name} (local)`,
      rpcUrl,
      explorerUrl: (env(`${p}_EXPLORER_URL`) ?? known?.explorerUrl ?? '').replace(/\/$/, '') || null,
      nativeSymbol: def.nativeSymbol,
      devFallback: false,
    },
    contracts: perp && vault && feed ? { perp, vault, feed } : null,
    deployBlock: block && /^\d+$/.test(block) ? BigInt(block) : 0n,
    reportedFeeds: reportedFeedsFrom(env(`${p}_REPORTED_FEEDS`), p),
    executionFeeWei: fee && /^\d{1,30}$/.test(fee) ? BigInt(fee) : 0n,
    oracleMode: mock ? 'mock' : 'chainlink',
    oracleRpcUrl: env(`${p}_ORACLE_RPC_URL`) ?? def.mainnet.rpcUrl,
    collateralSymbol: env(`${p}_PERPS_COLLATERAL_SYMBOL`) ?? 'USDC',
  };
}

/** Every network perps run on here: the primary, then each one its environment turns on. */
export function perpNetworks(): PerpNetwork[] {
  return PERP_NETWORKS.filter((n) => n === PRIMARY_PERP_NETWORK || secondaryDeploymentFor(n) != null);
}

const current = new AsyncLocalStorage<SecondaryDeployment>();

/** The secondary network in scope, or null on the primary. */
export function secondaryDeployment(): SecondaryDeployment | null {
  return current.getStore() ?? null;
}

/** The network in scope: the primary outside any. */
export function perpNetwork(): PerpNetwork {
  return current.getStore()?.network ?? PRIMARY_PERP_NETWORK;
}

export class PerpNetworkOff extends Error {
  constructor(readonly network: PerpNetwork) {
    super(`${PERP_NETWORK_DEFS[network]?.name ?? network} perps aren't configured on this server.`);
  }
}

/**
 * Runs `fn` on a network: its perps configuration, its chain, its caches.
 * The primary runs with no override at all, exactly as before. Throws
 * PerpNetworkOff for a network this server doesn't run.
 */
export function withPerpNetwork<T>(network: PerpNetwork, fn: () => T): T {
  if (network === PRIMARY_PERP_NETWORK) return current.exit(() => withoutChainOverride(fn));
  const deployment = secondaryDeploymentFor(network);
  if (!deployment) throw new PerpNetworkOff(network);
  return current.run(deployment, () => withChainOverride(deployment.chain, fn));
}

/** The network's own ReportedRoundFeeds and chain, for its registry. */
function networkFeeds(): NetworkFeeds {
  const d = secondaryDeployment();
  return d ? { chainId: d.chain.id, reported: d.reportedFeeds } : {};
}

/** The network in scope's markets (its registry). */
export function marketsHere(): PerpMarketDef[] {
  return perpMarketsOn(perpNetwork(), networkFeeds());
}

/** The network in scope's markets with an oracle. */
export function tradableHere(): PerpMarketDef[] {
  return tradablePerpMarkets(perpNetwork(), networkFeeds());
}

/** A market of the network in scope. */
export function marketHere(symbol: string): PerpMarketDef | null {
  const s = symbol.toUpperCase();
  return marketsHere().find((m) => m.symbol === s) ?? null;
}

/**
 * A cache key of the network in scope. The primary's are the keys it always
 * had, so nothing it cached is lost; another network's carry its name.
 */
export function perpKey(namespace: string, id: string): string {
  const network = perpNetwork();
  return cacheKey(namespace, network === PRIMARY_PERP_NETWORK ? id : `${network}:${id}`);
}

/**
 * The network in scope's rows. The primary's include rows from before rows
 * carried a chain id — paper, and its early actions; another network's are
 * only its own chain's.
 */
export function perpChainScope(): PerpChainScope {
  const d = secondaryDeployment();
  if (d) return { chainId: d.chain.id, legacy: false };
  return { chainId: chainConfig()?.id ?? null, legacy: true };
}

/** The network a stored row's chain id belongs to on this server; null for a chain it doesn't run. */
export function perpNetworkForChainId(chainId: number | null | undefined): PerpNetwork | null {
  if (chainId == null || chainId === primaryChainId()) return PRIMARY_PERP_NETWORK;
  for (const network of PERP_NETWORKS) {
    if (secondaryDeploymentFor(network)?.chain.id === chainId) return network;
  }
  return null;
}

/** Where the network in scope's contracts started: its indexer's first block. */
export function perpDeployBlock(): bigint {
  const d = secondaryDeployment();
  if (d) return d.deployBlock;
  const raw = process.env.AGRI_DEPLOY_BLOCK?.trim();
  return raw && /^\d+$/.test(raw) ? BigInt(raw) : 0n;
}

/** Whether a stored row (by its chain id) belongs to the network in scope. */
export function inPerpScope(chainId: number | null | undefined): boolean {
  const scope = perpChainScope();
  if (chainId == null) return scope.legacy;
  return chainId === scope.chainId;
}
