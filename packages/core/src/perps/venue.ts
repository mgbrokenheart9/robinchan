import type { PerpChainInfo, PerpVenueInfo } from '@robinchan/shared';
import { PERP_NETWORK_DEFS, PRIMARY_PERP_NETWORK, isMainnet } from '@robinchan/shared';

import { chainConfig } from '../env';
import { chainState } from './chain';
import { oracleFeedsHere } from './chainlink';
import { agriPerpContracts, perpCollateralSymbol, perpsVenue } from './config';
import { marketHere, perpDeployBlock, perpNetwork, perpNetworks, withPerpNetwork } from './network';

/**
 * Where the venue lives, for anyone to check on the explorer: the network,
 * the three contracts, the settlement token, the pool, and each market's
 * Chainlink feed — the addresses the contracts actually read, not a copy.
 * Public: none of it is private, and all of it is on chain.
 */
export async function perpVenueInfo(): Promise<PerpVenueInfo> {
  const network = perpNetwork();
  const venue = perpsVenue();
  const chain = chainConfig();
  const contracts = venue === 'agri-perp' ? agriPerpContracts() : null;
  const cs = contracts ? await chainState({ maxAgeSec: 60 }).catch(() => null) : null;
  const block = Number(perpDeployBlock());
  const feeds = cs
    ? Object.values(cs.markets)
        .filter((m) => m.listed)
        .map((m) => ({ symbol: m.symbol, feed: m.feed, description: marketHere(m.symbol)?.contracts[0]?.oracleSymbol ?? m.symbol }))
    : oracleFeedsHere().map((f) => ({ symbol: f.symbol, feed: f.feed, description: marketHere(f.symbol)?.contracts[0]?.oracleSymbol ?? f.symbol }));
  const mainnet = network === PRIMARY_PERP_NETWORK ? isMainnet(chain) : chain?.id === PERP_NETWORK_DEFS[network].mainnet.id;
  return {
    network,
    venue,
    chain: chain ? { id: chain.id, name: chain.name, explorerUrl: chain.explorerUrl, mainnet } : null,
    contracts,
    collateral: { symbol: perpCollateralSymbol(), address: cs?.usdc ?? null },
    pool: cs?.pool ?? null,
    deployBlock: Number.isInteger(block) && block > 0 ? block : null,
    feeds,
  };
}

/**
 * Every network perps run on here, for the chain switcher: its chain (with a
 * public endpoint the wallet can add it with) and whether it trades yet.
 */
export function perpChainInfos(): PerpChainInfo[] {
  return perpNetworks().flatMap((network) =>
    withPerpNetwork(network, () => {
      const chain = chainConfig();
      if (!chain) return [];
      const def = PERP_NETWORK_DEFS[network];
      const known = chain.id === def.mainnet.id ? def.mainnet : chain.id === def.testnet.id ? def.testnet : null;
      // The primary's RPC is the one the browser already uses (NEXT_PUBLIC_RPC_URL);
      // another network's server endpoint may carry a key, so the wallet gets the public one.
      const rpcUrl =
        network === PRIMARY_PERP_NETWORK ? process.env.NEXT_PUBLIC_RPC_URL?.trim() || chain.rpcUrl : (known?.rpcUrl ?? chain.rpcUrl);
      return [
        {
          network,
          name: def.name,
          color: def.color,
          chainId: chain.id,
          chainName: chain.name,
          rpcUrl,
          explorerUrl: chain.explorerUrl,
          nativeSymbol: chain.nativeSymbol,
          testnet: network === PRIMARY_PERP_NETWORK ? !isMainnet(chain) : chain.id !== def.mainnet.id,
          venue: perpsVenue(),
          collateralSymbol: perpCollateralSymbol(),
          features: def.features,
        } satisfies PerpChainInfo,
      ];
    }),
  );
}
