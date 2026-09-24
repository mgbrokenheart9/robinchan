import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { symbolInfo } from '@robinchan/shared';
import { tradingEnabled } from '@robinchan/core';

import { TradeView } from '@/components/trade/TradeView';

export const metadata: Metadata = {
  title: 'Trade',
  description: 'Chart and order ticket for tokenized stocks. Robinchan builds the order; you sign it.',
};

export const dynamic = 'force-dynamic';

/**
 * Trade (Trade-Heat-Portfolio §3). The whole page sits behind
 * `FEATURE_TRADING`, off by default until the regulatory questions in the
 * main brief (§15) are answered — with it off, the route doesn't exist.
 */
export default async function TradePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!tradingEnabled()) notFound();
  const raw = (await searchParams).symbol;
  const requested = (Array.isArray(raw) ? raw[0] : raw)?.toUpperCase() ?? 'NVDA';
  const symbol = symbolInfo(requested) ? requested : 'NVDA';
  return <TradeView initialSymbol={symbol} />;
}
