import type { PerpAccount, PerpPosition } from '@robinchan/shared';

/**
 * What a wallet would see, blurred behind the connect card (brief §2: show
 * the real layout before connecting). Inert, and never mistaken for data —
 * it's hidden from assistive tech and can't be clicked.
 */
export const SAMPLE_ACCOUNT: PerpAccount = {
  venue: 'paper',
  free: 8_420.5,
  locked: 1_500,
  unrealizedPnl: 212.84,
  equity: 10_133.34,
  openPositions: 2,
  walletUsdc: null,
  canFaucet: false,
  collateralSymbol: 'USDC',
};

const now = Date.now();

function sample(p: Partial<PerpPosition> & Pick<PerpPosition, 'id' | 'symbol' | 'side' | 'collateral' | 'leverage' | 'entryPrice' | 'markPrice'>): PerpPosition {
  const size = p.collateral * p.leverage;
  const move = ((p.markPrice as number) - p.entryPrice) / p.entryPrice;
  const pnl = size * (p.side === 'long' ? move : -move);
  return {
    venue: 'paper',
    chainPositionId: null,
    category: 'crypto',
    size,
    liquidationPrice: p.side === 'long' ? p.entryPrice * (1 - 0.8 / p.leverage) : p.entryPrice * (1 + 0.8 / p.leverage),
    unrealizedPnl: pnl,
    fundingAccrued: 0.42,
    equity: p.collateral + pnl,
    pnlPct: (pnl / p.collateral) * 100,
    fee: size * 0.001,
    status: 'open',
    openedAt: new Date(now - 5 * 3_600_000).toISOString(),
    closedAt: null,
    exitPrice: null,
    realizedPnl: null,
    fundingPaid: null,
    payout: null,
    txOpen: null,
    txClose: null,
    explorerOpen: null,
    explorerClose: null,
    closing: false,
    ...p,
  };
}

export const SAMPLE_POSITIONS: PerpPosition[] = [
  sample({ id: 's1', symbol: 'NVDA', category: 'stocks', side: 'long', collateral: 1_000, leverage: 5, entryPrice: 221.4, markPrice: 225.66 }),
  sample({ id: 's2', symbol: 'ETH', side: 'short', collateral: 500, leverage: 10, entryPrice: 2_712, markPrice: 2_686.81 }),
];
