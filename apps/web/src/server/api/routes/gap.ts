import type { GapBoard, GapHistory } from '@robinchan/shared';
import { stockToken } from '@robinchan/shared';
import { gapHistoryFor, type GapHistoryStore } from '@robinchan/core';
import { cacheKey, getCache } from '@robinchan/store';
import { z } from 'zod';

import { ApiFailure, emptyEnvelope, envelope, readCached } from '../envelope';
import type { ApiRouter } from '../router';

const symbolParams = z.object({ symbol: z.string().regex(/^[A-Za-z0-9.-]{1,12}$/) });

/** How far back a row's chart goes. */
const HISTORY_SEC = 72 * 3_600;

/**
 * The Gap board: Robinhood's stock tokens on chain against their stocks.
 * The worker writes it every two minutes (jobs/gap.ts); these only read.
 */
export function gapRoutes(app: ApiRouter): void {
  app.get('/api/gap', async () => {
    const hit = await readCached<GapBoard>('gap', 'board');
    if (!hit) return emptyEnvelope<GapBoard | null>(null);
    return envelope(hit.data, hit);
  });

  /** One row's gap over the last three days, for its chart. */
  app.get('/api/gap/:symbol', async (request) => {
    const parsed = symbolParams.safeParse(request.params);
    if (!parsed.success) throw new ApiFailure('BAD_REQUEST', 'invalid symbol');
    const token = stockToken(parsed.data.symbol);
    if (!token || token.unlisted) throw new ApiFailure('NOT_FOUND', `${parsed.data.symbol.toUpperCase()} isn't on the Gap board`, 404);

    const hit = await getCache().getWithAge<GapHistoryStore>(cacheKey('gap', 'history'));
    const nowSec = Math.floor(Date.now() / 1000);
    const history: GapHistory = { symbol: token.symbol, points: gapHistoryFor(hit?.value ?? null, token.symbol, nowSec - HISTORY_SEC) };
    if (!hit) return emptyEnvelope(history);
    return envelope(history, { stale: hit.ageSec > 900, asOf: new Date(Date.now() - hit.ageSec * 1000).toISOString() });
  });
}
