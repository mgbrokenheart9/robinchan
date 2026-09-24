import 'server-only';

import type { PageContext } from '@robinchan/shared';
import { formatPct, formatPriceSmart, symbolInfo } from '@robinchan/shared';
import {
  HeatAccessError,
  buildHeatBoard,
  buildHeatDetail,
  buildPortfolio,
  fenceText,
  getPrice,
  heatAccessFor,
  readHoldings,
} from '@robinchan/core';
import { getDb } from '@robinchan/store';

import type { Session } from '../auth/session';
import { tierFor } from '../api/viewer';

/**
 * The page the user is on, as data for Robinchan's prompt — so in Trade she
 * knows the open symbol, in Heat the open row, in Portfolio its contents
 * (Trade-Heat-Portfolio §2). The page sends only *which* page and symbol;
 * every figure is looked up here, server-side, at the viewer's own access
 * level. The chat must never become a way around the heat board's gating.
 */
export async function pageContextBlock(ctx: PageContext | undefined, session: Session | null): Promise<string | null> {
  if (!ctx) return null;
  const lines: string[] = [];
  try {
    if (ctx.page === 'heat') await heatLines(ctx.symbol ?? null, session, lines);
    else if (ctx.page === 'trade') await tradeLines(ctx.symbol ?? null, session, lines);
    else if (ctx.page === 'portfolio') await portfolioLines(session, lines);
    else return null;
  } catch (err) {
    console.warn(`[chat] page context for ${ctx.page} unavailable: ${(err as Error).message}`);
    lines.push(`The user is on the ${ctx.page} page; its data couldn't be loaded right now.`);
  }
  if (!lines.length) return null;
  return `<page_context>\n${lines.map((l) => fenceText(l, 400)).join('\n')}\n</page_context>`;
}

async function heatLines(symbol: string | null, session: Session | null, lines: string[]): Promise<void> {
  const tier = await tierFor(session);
  const viewer = { access: heatAccessFor(tier), userId: session?.userId ?? null };
  lines.push('Page: Heat board (a reading of market conditions, not recommendations).');

  if (!symbol) {
    const board = await buildHeatBoard(viewer, { filter: 'all', sort: 'score', page: 1 });
    const shown = board.rows.filter((r) => !r.locked).slice(0, 5);
    for (const r of shown) {
      if (r.locked) continue;
      lines.push(`#${r.rank} ${r.symbol}: heat ${r.score}${r.rounded ? ' (rounded to 10)' : ''}`);
    }
    if (board.access.next) lines.push(`More rows are locked for this user (next level: ${board.access.next}).`);
    return;
  }

  lines.push(`Row the user has open: ${symbol}.`);
  try {
    const { detail } = await buildHeatDetail(viewer, symbol);
    lines.push(`${detail.symbol} is #${detail.rank} with heat ${detail.score}.`);
    for (const c of detail.components) {
      lines.push(
        c.score == null
          ? `${c.label} component: inactive (${c.inactive === 'belum_aktif' ? 'not switched on yet' : 'no data'}) — not the same as zero activity.`
          : `${c.label} component: ${Math.round(c.score * 100)}/100, weight ${Math.round(c.weight * 100)}% — ${c.note}`,
      );
    }
    if (detail.triggers) {
      for (const t of detail.triggers) lines.push(`Trigger (${t.kind}, ${t.at}): ${t.title}`);
    } else {
      lines.push('The triggers behind this row are locked for this user (Tier 1).');
    }
  } catch (err) {
    if (!(err instanceof HeatAccessError)) throw err;
    lines.push(`The details of ${symbol} are locked for this user: ${err.message}`);
  }
}

async function tradeLines(symbol: string | null, session: Session | null, lines: string[]): Promise<void> {
  lines.push('Page: Trade (chart and order ticket). You never place orders yourself; the user signs.');
  if (!symbol) return;
  const info = symbolInfo(symbol);
  const live = await getPrice(symbol);
  lines.push(
    `Open symbol: ${symbol}${info ? ` (${info.name})` : ''}` +
      (live ? `, price ${formatPriceSmart(live.price)}, today ${formatPct(live.changePct)}` : ', no live price'),
  );
  if (info && !info.tradable) lines.push(`${symbol} can't be ordered here: ${info.untradableReason ?? 'not tradable'}`);
  if (!session) {
    lines.push('The user has not connected a wallet.');
    return;
  }
  const holdings = await readHoldings(session.address, session.userId).catch(() => null);
  const held = holdings?.holdings.find((h) => h.symbol === symbol);
  lines.push(held ? `The user holds ${held.qty} ${symbol}.` : `The user holds no ${symbol}.`);
  const open = await getDb().listOrders({ userId: session.userId, statuses: ['open', 'pending'], symbol, limit: 5 });
  for (const o of open) {
    lines.push(`Open order: ${o.orderType} ${o.side} ${o.qty} ${o.symbol}${o.limitPrice ? ` at ${o.limitPrice}` : ''} (${o.status}).`);
  }
}

async function portfolioLines(session: Session | null, lines: string[]): Promise<void> {
  lines.push('Page: Portfolio. Describe it if asked; never advise what to do with it.');
  if (!session) {
    lines.push('The user has not connected a wallet, so there is no portfolio to read.');
    return;
  }
  const p = await buildPortfolio({ id: session.userId, address: session.address });
  lines.push(`Total value: $${p.totalValue.toFixed(2)}; today ${p.change24h >= 0 ? '+' : '−'}$${Math.abs(p.change24h).toFixed(2)}.`);
  for (const h of p.holdings.slice(0, 8)) {
    lines.push(
      `${h.symbol}: ${h.qty} units, ${h.allocation != null ? `${(h.allocation * 100).toFixed(1)}% of total` : 'unpriced'}` +
        (h.change24hPct != null ? `, today ${formatPct(h.change24hPct)}` : '') +
        (h.costBasis === 'unknown' ? ', purchase price unknown' : ''),
    );
  }
  if (p.excludedFromPnl) lines.push(`${p.excludedFromPnl} asset(s) have no known purchase price, so PnL leaves them out.`);
  if (p.unrealizedPnl != null) lines.push(`Unrealized PnL on assets with a known cost: $${p.unrealizedPnl.toFixed(2)}.`);
}
