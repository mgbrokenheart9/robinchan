import type { HeatScore } from '@robinchan/shared';
import { HEAT_FILTERS, HEAT_SORTS, SYMBOL_NAMES, roundToTen } from '@robinchan/shared';
import {
  buildHeatBoard,
  buildHeatDetail,
  heatAccessFor,
  heatUniverseForReads,
  refreshHeatRead,
} from '@robinchan/core';
import { getDb, type HeatRow } from '@robinchan/store';
import { after } from 'next/server';
import { z } from 'zod';

import type { Session } from '../../auth/session';
import { ApiFailure, envelope, readCached } from '../envelope';
import type { ApiRouter } from '../router';
import { asApiFailure, tierFor } from '../viewer';

const query = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(5),
});

const fullQuery = z.object({
  filter: z.enum(HEAT_FILTERS).default('all'),
  sort: z.enum(HEAT_SORTS).default('score'),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});

const symbolParams = z.object({ symbol: z.string().regex(/^[A-Za-z0-9.-]{1,12}$/) });

/**
 * `/api/heat` is Home's five-row board (brief §4): always the anonymous
 * view — top five, scores rounded to the nearest 10, no components. Home is
 * a cached marketing page, so it never varies by viewer. The full,
 * tier-aware board is `/api/heat/full`.
 */
function toPublic(row: HeatRow): HeatScore {
  return {
    symbol: row.symbol,
    name: SYMBOL_NAMES[row.symbol] ?? row.symbol,
    score: roundToTen(row.score),
    components: null,
    rounded: true,
    computedAt: row.computedAt,
  };
}

async function viewerFor(session: Session | null) {
  const tier = await tierFor(session);
  return { access: heatAccessFor(tier), userId: session?.userId ?? null };
}

/** Reads being generated on demand in this process — one per symbol at a time. */
const generating = new Set<string>();

function generateReadLater(symbol: string): void {
  if (generating.has(symbol)) return;
  generating.add(symbol);
  after(async () => {
    try {
      const u = (await heatUniverseForReads()).find((r) => r.row.symbol === symbol);
      if (!u) return;
      const drivers = await getDb().getNewsByIds(u.row.components.news.drivers.slice(0, 3));
      await refreshHeatRead({ row: u.row, rank: u.rank, drivers, changePct: u.changePct });
    } catch (err) {
      console.warn(`[heat] on-demand read for ${symbol} failed: ${(err as Error).message}`);
    } finally {
      generating.delete(symbol);
    }
  });
}

export function heatRoutes(app: ApiRouter): void {
  app.get('/api/heat', async (request) => {
    const parsed = query.safeParse(request.query);
    if (!parsed.success) throw new ApiFailure('BAD_REQUEST', 'invalid limit');

    const limit = Math.min(parsed.data.limit, 5);

    const hit = await readCached<HeatRow[]>('heat', 'top');
    if (hit) return envelope(hit.data.slice(0, limit).map(toPublic), hit);

    const rows = await getDb().listHeat(limit);
    return envelope(rows.map(toPublic), { stale: rows.length === 0 });
  });

  /**
   * The whole board (Heat §5–6), already cut down to what this viewer may
   * see: locked rows come back as placeholders, never as data to hide.
   */
  app.get('/api/heat/full', async (request) => {
    const parsed = fullQuery.safeParse(request.query);
    if (!parsed.success) throw new ApiFailure('BAD_REQUEST', parsed.error.issues[0]?.message ?? 'invalid query');
    try {
      const board = await buildHeatBoard(await viewerFor(request.session), parsed.data);
      const age = board.computedAt ? (Date.now() - Date.parse(board.computedAt)) / 1000 : Infinity;
      return envelope(board, { stale: age > 600, asOf: board.computedAt ?? new Date(0).toISOString() });
    } catch (err) {
      asApiFailure(err);
    }
  });

  /** One row opened: component breakdown for a wallet, triggers and read for Tier 1. */
  app.get('/api/heat/:symbol', async (request) => {
    const parsed = symbolParams.safeParse(request.params);
    if (!parsed.success) throw new ApiFailure('BAD_REQUEST', 'invalid symbol');
    try {
      const { detail, readMissing } = await buildHeatDetail(await viewerFor(request.session), parsed.data.symbol);
      // No cached read: show the components without it now, and write one
      // for next time (Heat §5 — never an LLM call on the click itself).
      if (readMissing) generateReadLater(detail.symbol);
      const age = (Date.now() - Date.parse(detail.computedAt)) / 1000;
      return envelope(detail, { stale: age > 600, asOf: detail.computedAt });
    } catch (err) {
      asApiFailure(err);
    }
  });
}
