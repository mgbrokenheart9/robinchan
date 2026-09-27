import 'server-only';

import type { PageContext } from '@robinchan/shared';
import { formatPct, formatPriceSmart, perpMarket } from '@robinchan/shared';
import {
  HeatAccessError,
  buildHeatBoard,
  buildHeatDetail,
  buildPortfolio,
  fenceText,
  heatAccessFor,
  perpMarketViews,
  perpPositions,
} from '@robinchan/core';

import type { Session } from '../auth/session';
import { tierFor } from '../api/viewer';

/**
 * The page the user is on, as data for Robinchan's prompt — so in Perps she
 * knows the open market, in Heat the open row, in Portfolio its contents
 * (Trade-Heat-Portfolio §2). The page sends only *which* page and symbol;
 * every figure is looked up here, server-side, at the viewer's own access
 * level. The chat must never become a way around the heat board's gating.
 */
export async function pageContextBlock(ctx: PageContext | undefined, session: Session | null): Promise<string | null> {
  if (!ctx) return null;
  const lines: string[] = [];
  try {
    if (ctx.page === 'heat') await heatLines(ctx.symbol ?? null, session, lines);
    else if (ctx.page === 'perps') await perpsLines(ctx.symbol ?? null, session, lines);
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

async function perpsLines(symbol: string | null, session: Session | null, lines: string[]): Promise<void> {
  lines.push(
    'Page: Perps — synthetic perpetuals on crypto and US stocks, priced by Chainlink on Robinhood Chain, settled in USDC ' +
      '(the agricultural markets are listed but untradable: Chainlink has no feed for them there). On chain an order fills at ' +
      "Chainlink's next price for the market, which can take hours on a quiet market. " +
      'You never open or close positions yourself; the user signs. Explain mechanics (margin, leverage, funding, liquidation) ' +
      'but never suggest a direction, a size or a leverage.',
  );
  const def = symbol ? perpMarket(symbol) : null;
  if (def) {
    const market = (await perpMarketViews()).find((m) => m.symbol === def.symbol);
    if (market) {
      lines.push(
        `Open market: ${def.symbol} (${def.name}, ${def.category}), ${market.status}` +
          (market.statusNote ? ` — ${market.statusNote}` : '') +
          (market.price != null ? `; price $${formatPriceSmart(market.price)}${market.unit}` : '; no price yet') +
          (market.change24hPct != null ? `, 24h ${formatPct(market.change24hPct)}` : '') +
          `; funding ${(market.fundingRatePerHour * 100).toFixed(5)}% of size per hour (positive: longs pay shorts)` +
          `; up to ${market.maxLeverage}× leverage; liquidation when losses reach 80% of a position's collateral.` +
          (market.contract ? ` Priced by the ${market.contract} feed.` : ''),
      );
    }
  }
  if (!session) {
    lines.push('The user has not connected a wallet.');
    return;
  }
  const positions = await perpPositions({ id: session.userId, address: session.address }).catch(() => []);
  if (!positions.length) lines.push('The user has no open perps positions.');
  for (const p of positions.slice(0, 6)) {
    lines.push(
      `Open position: ${p.side} ${p.symbol} at ${p.leverage}×, collateral $${p.collateral.toFixed(2)}, entry $${formatPriceSmart(p.entryPrice)}, ` +
        `liquidation $${formatPriceSmart(p.liquidationPrice)}, unrealized PnL ${p.unrealizedPnl == null ? 'unknown (no fresh price)' : `$${p.unrealizedPnl.toFixed(2)}`}.`,
    );
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
