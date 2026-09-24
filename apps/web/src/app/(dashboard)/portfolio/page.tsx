import type { Metadata } from 'next';

import { PortfolioView } from '@/components/portfolio/PortfolioView';

export const metadata: Metadata = {
  title: 'Portfolio',
  description: 'Your wallet read from the chain: holdings, value over time, and PnL where the purchase price is known.',
};

/**
 * Portfolio (Trade-Heat-Portfolio §7). Everything on it belongs to one
 * wallet, so it's fetched in the browser under that wallet's session rather
 * than rendered into a cacheable page. Rendered per request all the same,
 * so the shell's feature flags reflect the running server, not the build.
 */
export const dynamic = 'force-dynamic';

export default function PortfolioPage() {
  return <PortfolioView />;
}
