import { SYMBOLS, tierAtLeast } from '@robinchan/shared';
import { ackNotices, pendingNotices, walletRateLimit } from '@robinchan/core';
import { getDb } from '@robinchan/store';
import { z } from 'zod';

import { ApiFailure, fresh } from '../envelope';
import type { ApiRouter } from '../router';
import { tierFor } from '../viewer';

const KNOWN = new Set(SYMBOLS.map((s) => s.symbol));

const watchlistBody = z.object({
  symbols: z.array(z.string().regex(/^[A-Za-z0-9.-]{1,12}$/)).max(50),
});

const ackBody = z.object({ ids: z.array(z.string().max(64)).max(50) });

const walletRate = { name: 'wallet', max: walletRateLimit };

export function userRoutes(app: ApiRouter): void {
  // Tier from the $RCHAN balance on chain, cached 60s per address (brief §14).
  app.get(
    '/api/user/tier',
    async (request) => fresh(await tierFor(request.session)),
    { auth: 'wallet', rate: walletRate },
  );

  app.get(
    '/api/user/watchlist',
    async (request) => fresh(await getDb().getWatchlist(request.session!.userId)),
    { auth: 'wallet', rate: walletRate },
  );

  // Watchlist is a Tier 1 feature (brief §14).
  app.put(
    '/api/user/watchlist',
    async (request) => {
      const tier = await tierFor(request.session);
      if (!tier || !tierAtLeast(tier.tier, 'tier1')) {
        throw new ApiFailure('TIER_REQUIRED', 'The watchlist opens at Tier 1.', 403, null, { requiredTier: 'tier1' });
      }
      const parsed = watchlistBody.safeParse(request.body);
      if (!parsed.success) throw new ApiFailure('BAD_REQUEST', 'invalid watchlist');
      const symbols = parsed.data.symbols.map((s) => s.toUpperCase()).filter((s) => KNOWN.has(s));
      return fresh(await getDb().setWatchlist(request.session!.userId, symbols));
    },
    { auth: 'wallet', rate: walletRate },
  );

  /**
   * Order results the user hasn't seen — a limit order that filled while
   * they were away, a transaction that confirmed after they closed the tab
   * (Trade §4). Robinchan says them when they're back.
   */
  app.get(
    '/api/user/notifications',
    async (request) => fresh(await pendingNotices(request.session!.userId)),
    { auth: 'wallet' },
  );

  app.post(
    '/api/user/notifications/ack',
    async (request) => {
      const parsed = ackBody.safeParse(request.body);
      if (!parsed.success) throw new ApiFailure('BAD_REQUEST', 'invalid ids');
      await ackNotices(request.session!.userId, parsed.data.ids);
      return fresh({ ok: true });
    },
    { auth: 'wallet' },
  );
}
