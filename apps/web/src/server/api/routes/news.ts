import type { NewsItem } from '@robinchan/shared';
import { NEWS_CATEGORIES } from '@robinchan/shared';
import { getDb } from '@robinchan/store';
import { z } from 'zod';

import { ApiFailure, envelope, readCached } from '../envelope';
import type { ApiRouter } from '../router';

const query = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cat: z.enum(NEWS_CATEGORIES).optional(),
  symbol: z
    .string()
    .regex(/^[A-Za-z0-9.\-]{1,12}$/)
    .optional(),
  pinned: z.enum(['true', 'false']).optional(),
});

export function newsRoutes(app: ApiRouter): void {
  app.get('/api/news', async (request) => {
    const parsed = query.safeParse(request.query);
    if (!parsed.success) {
      throw new ApiFailure('BAD_REQUEST', parsed.error.issues[0]?.message ?? 'invalid query');
    }
    const { limit, cat, symbol, pinned } = parsed.data;

    // Fast path: the default feed is served straight from the cache the worker writes.
    if (!cat && !symbol && !pinned) {
      const hit = await readCached<NewsItem[]>('news', 'latest');
      if (hit) return envelope(hit.data.slice(0, limit), hit);
    }

    // Filtered queries fall back to Postgres — still reading from our own
    // storage, never calling a provider on an incoming request (brief §8).
    const rows = await getDb().listNews({
      limit,
      cat,
      symbol: symbol?.toUpperCase(),
      pinnedOnly: pinned === 'true',
    });

    const newest = rows[0]?.publishedAt;
    return envelope(rows, {
      stale: newest ? Date.now() - Date.parse(newest) > 30 * 60_000 : true,
    });
  });
}
