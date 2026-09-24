import type { Holding, PortfolioPoint, PortfolioSummary } from '@robinchan/shared';

/**
 * Sample data for the blurred preview shown before a wallet is connected
 * (Trade-Heat-Portfolio §2). It's never rendered legibly — only its shape
 * shows through — and it never reaches a real account's page.
 */
const h = (symbol: string, name: string, qty: number, price: number, avg: number | null, alloc: number, change: number): Holding => ({
  symbol,
  name,
  kind: 'stock',
  supported: true,
  tokenAddress: null,
  qty,
  price,
  change24hPct: change,
  value: qty * price,
  avgCost: avg,
  costBasis: avg == null ? 'unknown' : 'known',
  knownQty: avg == null ? 0 : qty,
  pnl: avg == null ? null : (price - avg) * qty,
  pnlPct: avg == null ? null : ((price - avg) / avg) * 100,
  allocation: alloc,
  manualAvgCost: null,
});

export const SAMPLE_PORTFOLIO: PortfolioSummary = {
  address: '0x0000000000000000000000000000000000000000',
  totalValue: 12480.22,
  change24h: 184.1,
  change24hPct: 1.5,
  unrealizedPnl: 912.4,
  unrealizedPnlPct: 11.2,
  excludedFromPnl: 2,
  partialInPnl: 0,
  holdings: [
    h('NVDA', 'NVIDIA Corp.', 24, 176.2, 151.8, 0.34, 2.1),
    h('AAPL', 'Apple Inc.', 14, 238.4, 219.5, 0.27, -0.6),
    h('TSLA', 'Tesla Inc.', 5, 412.9, null, 0.17, -1.8),
    h('MSFT', 'Microsoft Corp.', 3, 511.0, 488.2, 0.12, 0.4),
    h('COIN', 'Coinbase Global', 4, 318.9, null, 0.1, 3.2),
  ],
  dust: [],
  unsupported: [],
  native: { symbol: 'ETH', qty: 0.042 },
  discovery: 'explorer',
  source: 'chain',
  asOf: new Date(0).toISOString(),
  trackedSince: null,
};

const DAY = 86_400;
const START = 1_788_000_000;
export const SAMPLE_HISTORY: PortfolioPoint[] = [
  11020, 11180, 11090, 11420, 11610, 11540, 11890, 12030, 11940, 12210, 12480,
].map((value, i) => ({ time: START + i * DAY, value }));
