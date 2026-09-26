import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { PerpMarket } from '@robinchan/shared';
import { perpMarket } from '@robinchan/shared';
import { perpsEnabled } from '@robinchan/core';

import { PerpsView } from '@/components/perps/PerpsView';
import { getEnvelope } from '@/lib/api-server';

export const metadata: Metadata = {
  title: 'Perps',
  description: 'Perpetuals on crypto and US stocks, priced by Chainlink on Robinhood Chain. Robinchan builds the order; you sign it.',
};

export const dynamic = 'force-dynamic';

/**
 * Perps (Agri Perps brief) — replaces Trade. Behind `FEATURE_PERPS`, off by
 * default until the regulatory questions are answered: leveraged
 * derivatives need their own answers, on top of the main brief's (§15).
 * With the flag off, the route doesn't exist.
 */
export default async function PerpsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!perpsEnabled()) notFound();
  const raw = (await searchParams).symbol;
  const requested = (Array.isArray(raw) ? raw[0] : raw)?.toUpperCase() ?? 'BTC';
  const symbol = perpMarket(requested) ? requested : 'BTC';
  // Market data is public: rendered without the viewer's cookie, like Home's panels.
  const markets = await getEnvelope<PerpMarket[] | null>('/api/perps/markets', null);
  return <PerpsView initialSymbol={symbol} initialMarkets={markets.data ? (markets as { data: PerpMarket[]; stale: boolean; asOf: string }) : null} />;
}
