import type {
  GapBoard,
  GapPool,
  GapReferenceSource,
  GapRow,
  GapSummary,
  StockToken,
  UsSession,
} from '@robinchan/shared';

import { blendedPrice, pairLiquidity, pairPrice, pairVersion, pairVolume, type DexPair } from './dexscreener';

/**
 * The Gap board: Robinhood's stock tokens trade on chain around the clock,
 * the stocks don't. Each row sets a token's on-chain price (its pools,
 * blended by liquidity) against the stock's own regular-session price: live
 * while Wall Street is open, its last close otherwise. The worker computes
 * it (jobs/gap.ts); these are its pure parts.
 */

export type GapReference = { price: number; at: number; source: GapReferenceSource };

export function gapPoolsOf(pairs: DexPair[]): GapPool[] {
  return pairs.slice(0, 5).map((p) => ({
    dex: p.dexId,
    version: pairVersion(p),
    quote: p.quoteToken.symbol,
    priceUsd: pairPrice(p) ?? 0,
    liquidityUsd: pairLiquidity(p),
    volume24h: pairVolume(p),
    url: p.url,
  }));
}

export function gapRow(token: StockToken, pairs: DexPair[], ref: GapReference | null, spark: number[]): GapRow {
  const blended = blendedPrice(pairs);
  const onchain = blended?.price ?? null;
  const gapPct = onchain != null && ref && ref.price > 0 ? (onchain / ref.price - 1) * 100 : null;
  return {
    symbol: token.symbol,
    name: token.name,
    token: token.address,
    onchain,
    reference: ref?.price ?? null,
    referenceAt: ref ? new Date(ref.at * 1000).toISOString() : null,
    referenceSource: ref?.source ?? null,
    gapPct,
    liquidityUsd: (blended?.pools ?? []).reduce((s, p) => s + pairLiquidity(p), 0),
    volume24h: pairs.reduce((s, p) => s + pairVolume(p), 0),
    pools: gapPoolsOf(blended?.pools ?? []),
    spark,
  };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length / 2;
  return s.length % 2 ? (s[Math.floor(mid)] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

export function summarizeGap(rows: GapRow[]): GapSummary {
  const gaps = rows.filter((r): r is GapRow & { gapPct: number } => r.gapPct != null);
  const widest = gaps.reduce<(GapRow & { gapPct: number }) | null>(
    (best, r) => (!best || Math.abs(r.gapPct) > Math.abs(best.gapPct) ? r : best),
    null,
  );
  return {
    tracked: gaps.length,
    above: gaps.filter((r) => r.gapPct > 0).length,
    below: gaps.filter((r) => r.gapPct < 0).length,
    typicalGapPct: median(gaps.map((r) => Math.abs(r.gapPct))),
    widest: widest ? { symbol: widest.symbol, gapPct: widest.gapPct } : null,
    liquidityUsd: rows.reduce((s, r) => s + r.liquidityUsd, 0),
    volume24h: rows.reduce((s, r) => s + r.volume24h, 0),
  };
}

/**
 * Robinchan's line on the board — written from the numbers, never generated,
 * so it can't get one wrong. It describes; it never says what to do.
 */
export function gapRead(session: UsSession, summary: GapSummary): string {
  const w = summary.widest;
  if (!w || !summary.tracked) {
    return "I'm still collecting prices from the pools. The board fills in within a couple of minutes.";
  }
  const off = `${Math.abs(w.gapPct).toFixed(2)}% ${w.gapPct >= 0 ? 'above' : 'below'}`;
  const typical = summary.typicalGapPct != null ? `${summary.typicalGapPct.toFixed(2)}%` : 'small';
  if (session.closed) {
    const why = session.state === 'holiday' && session.holiday ? `Wall Street is off for ${session.holiday}` : 'Wall Street is closed for the weekend';
    return (
      `${why}, but the chain never sleeps. ${w.symbol} trades ${off} its last close, the widest gap on the board. ` +
      `${summary.above} of ${summary.tracked} stock tokens sit above their close and ${summary.below} below.`
    );
  }
  if (session.state === 'regular') {
    return `The US market is open, so the tokens hug their stocks: the typical gap is just ${typical}. ${w.symbol} is furthest off, ${off}.`;
  }
  const phase =
    session.state === 'overnight' ? "It's overnight in New York" : session.label === 'Pre-market' ? "It's pre-market in New York" : "It's after hours in New York";
  return `${phase}, so every token is measured against its stock's last close, after-hours moves and all. The typical gap is ${typical}; ${w.symbol} is furthest off, ${off}.`;
}

export function buildGapBoard(
  session: UsSession,
  rows: GapRow[],
  source: GapBoard['source'],
  now: number = Date.now(),
): GapBoard {
  const priced = rows.filter((r) => r.onchain != null);
  const summary = summarizeGap(priced);
  // Widest gap first; a token without a reference price sinks to the bottom.
  const sorted = [...priced].sort((a, b) => Math.abs(b.gapPct ?? -1) - Math.abs(a.gapPct ?? -1));
  return {
    session,
    rows: sorted,
    unpriced: rows.filter((r) => r.onchain == null).map((r) => r.symbol),
    summary,
    read: gapRead(session, summary),
    source,
    computedAt: new Date(now).toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

/** Every symbol's gap, one point per 10 minutes, kept four days. */
export type GapHistoryStore = { points: Array<{ t: number; g: Record<string, number> }> };

export const GAP_HISTORY_STEP_SEC = 600;
export const GAP_HISTORY_KEEP_SEC = 4 * 86_400;

/** Adds this run's gaps; a run in the same 10-minute slot replaces that slot's point. */
export function appendGapHistory(store: GapHistoryStore | null, tSec: number, gaps: Record<string, number>): GapHistoryStore {
  const points = store?.points ?? [];
  const slot = (t: number) => Math.floor(t / GAP_HISTORY_STEP_SEC);
  const last = points.at(-1);
  const next = last && slot(last.t) === slot(tSec) ? [...points.slice(0, -1), { t: tSec, g: gaps }] : [...points, { t: tSec, g: gaps }];
  return { points: next.filter((p) => p.t >= tSec - GAP_HISTORY_KEEP_SEC) };
}

export function gapHistoryFor(store: GapHistoryStore | null, symbol: string, sinceSec = 0): Array<[number, number]> {
  return (store?.points ?? [])
    .filter((p) => p.t >= sinceSec && Number.isFinite(p.g[symbol]))
    .map((p) => [p.t, p.g[symbol] as number]);
}

/** The last 24 hours at one point per half hour, for a row's sparkline. */
export function gapSpark(store: GapHistoryStore | null, symbol: string, nowSec: number): number[] {
  const points = gapHistoryFor(store, symbol, nowSec - 86_400);
  const out: number[] = [];
  let lastSlot = -1;
  for (const [t, g] of points) {
    const s = Math.floor(t / 1_800);
    if (s === lastSlot) out[out.length - 1] = g;
    else out.push(g);
    lastSlot = s;
  }
  return out;
}
