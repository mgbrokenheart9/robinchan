import type { CostBasisState } from '@robinchan/shared';
import type { OrderRow } from '@robinchan/store';

/**
 * Cost basis (Portfolio §8). The wallet belongs to the user outright: they
 * can buy through Robinchan, through another DEX, receive a transfer, or have
 * held the asset since before Robinchan existed. So we know how much they
 * hold, but only sometimes what they paid.
 *
 * What we know comes from one place — filled orders in our own `orders`
 * table — plus whatever price the user typed in themselves. Nothing is ever
 * inferred from the price when a token first showed up in the wallet: that
 * number would look official and be wrong.
 */
export type RobinchanPosition = {
  /** Units still held that were bought through Robinchan. */
  qty: number;
  /** Average cost of those units, fees included. */
  avgCost: number | null;
};

const EPS = 1e-9;

/**
 * Average-cost bookkeeping over the user's filled Robinchan orders, oldest
 * first. A sell through Robinchan draws down the Robinchan-bought units
 * first: which units were sold is ambiguous, and assuming they were ours
 * is the choice that never overstates what we know.
 */
export function positionsFromOrders(orders: OrderRow[]): Map<string, RobinchanPosition> {
  const out = new Map<string, RobinchanPosition>();
  const filled = orders
    .filter((o) => o.status === 'filled' && o.fillPrice != null && o.qty > 0)
    .sort((a, b) => (a.filledAt ?? a.updatedAt).localeCompare(b.filledAt ?? b.updatedAt));

  for (const o of filled) {
    const pos = out.get(o.symbol) ?? { qty: 0, avgCost: null };
    const price = o.fillPrice as number;
    if (o.side === 'buy') {
      const cost = (pos.avgCost ?? 0) * pos.qty + price * o.qty + (o.fee ?? 0);
      const qty = pos.qty + o.qty;
      out.set(o.symbol, { qty, avgCost: cost / qty });
    } else {
      const qty = Math.max(0, pos.qty - o.qty);
      out.set(o.symbol, { qty, avgCost: qty > EPS ? pos.avgCost : null });
    }
  }
  return out;
}

export type AppliedBasis = {
  state: CostBasisState;
  avgCost: number | null;
  /** Units `avgCost` covers. */
  knownQty: number;
};

export function applyBasis(
  walletQty: number,
  position: RobinchanPosition | undefined,
  manualAvgCost: number | null,
): AppliedBasis {
  const rcQty = position?.avgCost != null ? position.qty : 0;
  const rcAvg = position?.avgCost ?? null;

  if (rcQty <= EPS || rcAvg == null) {
    return manualAvgCost != null
      ? { state: 'manual', avgCost: manualAvgCost, knownQty: walletQty }
      : { state: 'unknown', avgCost: null, knownQty: 0 };
  }

  // Everything in the wallet is accounted for by Robinchan buys (it may even
  // hold fewer, if some were moved out).
  if (rcQty >= walletQty - EPS) {
    return { state: 'known', avgCost: rcAvg, knownQty: walletQty };
  }

  // Part came from elsewhere. With a manual price for the rest, every unit
  // is covered; without one, PnL covers the Robinchan part only.
  if (manualAvgCost != null) {
    const outside = walletQty - rcQty;
    return {
      state: 'manual',
      avgCost: (rcAvg * rcQty + manualAvgCost * outside) / walletQty,
      knownQty: walletQty,
    };
  }
  return { state: 'partial', avgCost: rcAvg, knownQty: rcQty };
}
