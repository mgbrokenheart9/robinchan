import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { PerpMarket, PerpNetwork } from '@robinchan/shared';
import { PRIMARY_PERP_NETWORK, isPerpNetwork, perpMarket } from '@robinchan/shared';
import { perpNetworks, perpsEnabled } from '@robinchan/core';

import { PerpsView } from '@/components/perps/PerpsView';
import { getEnvelope } from '@/lib/api-server';

export const metadata: Metadata = {
  title: 'Perps',
  description:
    'Perpetuals on crypto, US stocks, agri futures and commodities — on Robinhood Chain, Base and Arbitrum, priced by Chainlink. Robinchan builds the order; you sign it.',
};

export const dynamic = 'force-dynamic';

/** Where each network lands when the address names no market. */
const DEFAULT_SYMBOL: Record<PerpNetwork, string> = { robinhood: 'BTC', base: 'XAU', arbitrum: 'XAU' };

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * Perps (Agri Perps brief) — replaces Trade. Behind `FEATURE_PERPS`, off by
 * default until the regulatory questions are answered: leveraged
 * derivatives need their own answers, on top of the main brief's (§15).
 * With the flag off, the route doesn't exist. `?chain=base` (or `arbitrum`)
 * opens on that network (Multichain brief) when the server runs it.
 */
export default async function PerpsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!perpsEnabled()) notFound();
  const params = await searchParams;
  const rawChain = first(params.chain)?.toLowerCase();
  const network: PerpNetwork = isPerpNetwork(rawChain) && perpNetworks().includes(rawChain) ? rawChain : PRIMARY_PERP_NETWORK;
  const requested = first(params.symbol)?.toUpperCase() ?? DEFAULT_SYMBOL[network];
  const symbol = perpMarket(requested, network) ? requested : DEFAULT_SYMBOL[network];
  // Market data is public: rendered without the viewer's cookie, like Home's panels.
  const path = network === PRIMARY_PERP_NETWORK ? '/api/perps/markets' : `/api/perps/markets?chain=${network}`;
  const markets = await getEnvelope<PerpMarket[] | null>(path, null);
  return (
    <PerpsView
      initialSymbol={symbol}
      initialNetwork={network}
      initialMarkets={markets.data ? (markets as { data: PerpMarket[]; stale: boolean; asOf: string }) : null}
    />
  );
}
