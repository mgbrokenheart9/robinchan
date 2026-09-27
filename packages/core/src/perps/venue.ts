import type { PerpVenueInfo } from '@robinchan/shared';
import { isMainnet, perpMarket, perpOracleFeeds } from '@robinchan/shared';

import { chainConfig } from '../env';
import { chainState } from './chain';
import { agriPerpContracts, perpCollateralSymbol, perpsVenue } from './config';

/**
 * Where the venue lives, for anyone to check on the explorer: the network,
 * the three contracts, the settlement token, the pool, and each market's
 * Chainlink feed — the addresses the contracts actually read, not a copy.
 * Public: none of it is private, and all of it is on chain.
 */
export async function perpVenueInfo(): Promise<PerpVenueInfo> {
  const venue = perpsVenue();
  const chain = chainConfig();
  const contracts = venue === 'agri-perp' ? agriPerpContracts() : null;
  const cs = contracts ? await chainState({ maxAgeSec: 60 }).catch(() => null) : null;
  const block = Number(process.env.AGRI_DEPLOY_BLOCK?.trim());
  const feeds = cs
    ? Object.values(cs.markets).map((m) => ({ symbol: m.symbol, feed: m.feed, description: perpMarket(m.symbol)?.contracts[0]?.oracleSymbol ?? m.symbol }))
    : perpOracleFeeds().map((f) => ({ symbol: f.symbol, feed: f.feed, description: f.oracleSymbol }));
  return {
    venue,
    chain: chain ? { id: chain.id, name: chain.name, explorerUrl: chain.explorerUrl, mainnet: isMainnet(chain) } : null,
    contracts,
    collateral: { symbol: perpCollateralSymbol(), address: cs?.usdc ?? null },
    pool: cs?.pool ?? null,
    deployBlock: Number.isInteger(block) && block > 0 ? block : null,
    feeds,
  };
}
