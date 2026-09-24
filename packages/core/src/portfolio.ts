import type {
  Address,
  Holding,
  PortfolioHistory,
  PortfolioPoint,
  PortfolioRange,
  PortfolioSummary,
} from '@robinchan/shared';
import { DUST_USD, symbolInfo } from '@robinchan/shared';
import { getDb, type SnapshotRow } from '@robinchan/store';

import { readCandles } from './candles';
import { applyBasis, positionsFromOrders } from './costbasis';
import { readHoldings, type HoldingsRead } from './holdings';
import { getPrices } from './prices';

export type PortfolioUser = { id: string; address: Address };

/**
 * Holdings × current prices, with PnL only where the cost basis is known
 * (Portfolio §8). Read-only: nothing on the Portfolio page writes to chain.
 */
export async function buildPortfolio(user: PortfolioUser): Promise<PortfolioSummary> {
  const db = getDb();
  const read = await readHoldings(user.address, user.id);
  const [orders, overrides, snapshots] = await Promise.all([
    db.listOrders({ userId: user.id, statuses: ['filled'], limit: 1000 }),
    db.listCostBasis(user.id),
    db.listSnapshots(user.id),
  ]);

  const summary = await value(user.address, read, positionsFromOrders(orders), overrides);
  summary.trackedSince = snapshots[0]?.date ?? null;
  return summary;
}

async function value(
  address: Address,
  read: HoldingsRead,
  positions: ReturnType<typeof positionsFromOrders>,
  overrides: Array<{ symbol: string; avgPrice: number }>,
): Promise<PortfolioSummary> {
  const manual = new Map(overrides.map((o) => [o.symbol, o.avgPrice]));
  const priced = read.holdings.filter((h) => h.supported && !h.cash).map((h) => h.symbol);
  const prices = await getPrices(priced);

  const rows: Holding[] = read.holdings.map((h) => {
    const live = h.supported && !h.cash ? prices.get(h.symbol) : undefined;
    const price = h.cash ? 1 : (live?.price ?? h.externalPrice);
    const itemValue = price != null ? h.qty * price : null;
    const manualAvg = manual.get(h.symbol) ?? null;
    const basis = h.cash
      ? { state: 'cash' as const, avgCost: null, knownQty: 0 }
      : price == null
        ? // No price means no PnL either way; don't offer a manual basis for it.
          { state: 'unknown' as const, avgCost: null, knownQty: 0 }
        : applyBasis(h.qty, h.supported ? positions.get(h.symbol) : undefined, manualAvg);
    const pnl =
      basis.avgCost != null && price != null && basis.knownQty > 0
        ? (price - basis.avgCost) * basis.knownQty
        : null;
    return {
      symbol: h.symbol,
      name: h.name,
      kind: h.cash ? 'token' : (symbolInfo(h.symbol)?.kind ?? 'other'),
      supported: h.supported,
      tokenAddress: h.tokenAddress,
      qty: h.qty,
      price,
      change24hPct: h.cash ? 0 : (live?.changePct ?? null),
      value: itemValue,
      avgCost: basis.avgCost,
      costBasis: basis.state,
      knownQty: basis.knownQty,
      pnl,
      pnlPct:
        pnl != null && price != null && basis.avgCost
          ? ((price - basis.avgCost) / basis.avgCost) * 100
          : null,
      allocation: null,
      manualAvgCost: manualAvg,
    };
  });

  const totalValue = rows.reduce((sum, r) => sum + (r.value ?? 0), 0);
  for (const r of rows) r.allocation = r.value != null && totalValue > 0 ? r.value / totalValue : null;

  // 24h change from the current price and the price a day ago — available
  // from the first day, no snapshot needed (Portfolio §8).
  let change24h = 0;
  for (const r of rows) {
    if (r.value == null || r.change24hPct == null) continue;
    change24h += r.value - r.value / (1 + r.change24hPct / 100);
  }
  const previous = totalValue - change24h;

  const withPnl = rows.filter((r) => r.pnl != null);
  const unrealizedPnl = withPnl.length ? withPnl.reduce((s, r) => s + (r.pnl as number), 0) : null;
  const costOfKnown = withPnl.reduce((s, r) => s + (r.avgCost as number) * r.knownQty, 0);

  const byValue = (a: Holding, b: Holding) => (b.value ?? -1) - (a.value ?? -1);
  const supported = rows.filter((r) => r.supported);
  return {
    address,
    totalValue,
    change24h,
    change24hPct: previous > 0 ? (change24h / previous) * 100 : null,
    unrealizedPnl,
    unrealizedPnlPct: unrealizedPnl != null && costOfKnown > 0 ? (unrealizedPnl / costOfKnown) * 100 : null,
    excludedFromPnl: rows.filter((r) => r.costBasis === 'unknown').length,
    partialInPnl: rows.filter((r) => r.costBasis === 'partial').length,
    holdings: supported.filter((r) => r.value == null || r.value >= DUST_USD).sort(byValue),
    dust: supported.filter((r) => r.value != null && r.value < DUST_USD).sort(byValue),
    unsupported: rows.filter((r) => !r.supported).sort(byValue),
    native: read.native,
    discovery: read.discovery,
    source: read.source,
    asOf: read.asOf,
    trackedSince: null,
  };
}

/* ------------------------------------------------------------------ */
/* Snapshots & history                                                 */
/* ------------------------------------------------------------------ */

export const todayUtc = (at = new Date()): string => at.toISOString().slice(0, 10);

function toSnapshot(userId: string, date: string, summary: PortfolioSummary): SnapshotRow {
  const all = [...summary.holdings, ...summary.dust, ...summary.unsupported];
  return {
    userId,
    date,
    totalValueUsd: Number(summary.totalValue.toFixed(2)),
    holdings: all.map((h) => ({ symbol: h.symbol, qty: h.qty, price: h.price, value: h.value })),
  };
}

/**
 * The chart starts the day a wallet is first seen — never a flat line
 * backfilled into the past (Portfolio §8). The first portfolio load writes
 * today's point if the daily job hasn't yet.
 */
export async function ensureTodaySnapshot(userId: string, summary: PortfolioSummary): Promise<string> {
  const db = getDb();
  const today = todayUtc();
  const existing = await db.listSnapshots(userId, today);
  if (!existing.some((s) => s.date === today)) {
    await db.upsertSnapshot(toSnapshot(userId, today, summary));
  }
  const first = (await db.listSnapshots(userId))[0];
  return first?.date ?? today;
}

/** The daily job (00:00 UTC): one row per active user per day. */
export async function writeDailySnapshot(user: PortfolioUser, date = todayUtc()): Promise<number> {
  const summary = await buildPortfolio(user);
  await getDb().upsertSnapshot(toSnapshot(user.id, date, summary));
  return summary.totalValue;
}

const RANGE_DAYS: Record<Exclude<PortfolioRange, '24h'>, number | null> = {
  '7d': 7,
  '30d': 30,
  all: null,
};

export async function portfolioHistory(
  user: PortfolioUser,
  range: PortfolioRange,
): Promise<PortfolioHistory> {
  const summary = await buildPortfolio(user);
  const trackedSince = await ensureTodaySnapshot(user.id, summary);
  const now = Math.floor(Date.now() / 1000);

  if (range === '24h') {
    return { range, points: await dayCurve(summary, now), basis: 'prices', trackedSince };
  }

  const days = RANGE_DAYS[range];
  const since = days == null ? undefined : todayUtc(new Date(Date.now() - days * 86_400_000));
  const snaps = await getDb().listSnapshots(user.id, since);
  const points: PortfolioPoint[] = snaps.map((s) => ({
    time: Math.floor(Date.parse(`${s.date}T00:00:00Z`) / 1000),
    value: s.totalValueUsd,
  }));
  // Today's midnight snapshot is followed by the live value, so the line
  // ends at the number in the stat tile.
  const last = points.at(-1);
  if (!last || now - last.time > 60) points.push({ time: now, value: summary.totalValue });
  return { range, points, basis: 'snapshots', trackedSince };
}

/**
 * Last 24 hours rebuilt from hourly closes at today's quantities. Assets
 * without a price history (cash, unsupported tokens) hold their current
 * value flat, which is what they did.
 */
async function dayCurve(summary: PortfolioSummary, now: number): Promise<PortfolioPoint[]> {
  const all = [...summary.holdings, ...summary.dust, ...summary.unsupported];
  const since = now - 24 * 3600;
  let flat = 0;
  const series: Array<{ qty: number; bars: Array<{ time: number; close: number }> }> = [];

  for (const h of all) {
    if (h.value == null) continue;
    const read = h.supported && h.costBasis !== 'cash' ? await readCandles(h.symbol, '1H') : null;
    const bars = read?.series.candles.filter((c) => c.time >= since - 3600) ?? [];
    if (bars.length < 2) {
      flat += h.value;
      continue;
    }
    series.push({ qty: h.qty, bars: bars.map((c) => ({ time: c.time, close: c.close })) });
  }

  const times = [...new Set(series.flatMap((s) => s.bars.map((b) => b.time)))]
    .filter((t) => t >= since)
    .sort((a, b) => a - b);
  const points = times.map((t) => {
    let total = flat;
    for (const s of series) {
      // Last close at or before t; before the first bar, the first bar's close.
      let close = s.bars[0]?.close ?? 0;
      for (const b of s.bars) {
        if (b.time > t) break;
        close = b.close;
      }
      total += s.qty * close;
    }
    return { time: t, value: Number(total.toFixed(2)) };
  });
  points.push({ time: now, value: Number(summary.totalValue.toFixed(2)) });
  return points;
}
