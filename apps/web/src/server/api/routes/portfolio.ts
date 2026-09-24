import type { CompanionRead, PortfolioSummary } from '@robinchan/shared';
import { PORTFOLIO_RANGES } from '@robinchan/shared';
import {
  buildPortfolio,
  ensureTodaySnapshot,
  generatePortfolioRead,
  portfolioFingerprint,
  portfolioHistory,
  walletRateLimit,
} from '@robinchan/core';
import { cacheKey, getCache, getDb } from '@robinchan/store';
import { z } from 'zod';

import type { Session } from '../../auth/session';
import { ApiFailure, envelope, fresh } from '../envelope';
import type { ApiRouter } from '../router';
import { asApiFailure } from '../viewer';

const historyQuery = z.object({ range: z.enum(PORTFOLIO_RANGES).default('24h') });

const costBasisBody = z.object({
  symbol: z.string().regex(/^[A-Za-z0-9.$_-]{1,16}$/),
  /** null clears a manual price. */
  avgPrice: z.number().positive().max(10_000_000).nullable(),
});

const walletRate = { name: 'wallet', max: walletRateLimit };

const READ_TTL_SEC = 30 * 60;

async function summaryFor(session: Session): Promise<PortfolioSummary> {
  const user = { id: session.userId, address: session.address };
  try {
    const summary = await buildPortfolio(user);
    // The first load is the first point on the value chart (Portfolio §8).
    summary.trackedSince = await ensureTodaySnapshot(user.id, summary);
    return summary;
  } catch (err) {
    asApiFailure(err);
  }
}

/**
 * Read-only (Portfolio §7): nothing here writes to chain. The one write is
 * the user's own purchase price for an asset whose cost basis we don't know.
 */
export function portfolioRoutes(app: ApiRouter): void {
  app.get(
    '/api/portfolio',
    async (request) => {
      const session = request.session!;
      const summary = await summaryFor(session);
      await getDb().touchUser(session.userId);
      return envelope(summary, { stale: false, asOf: summary.asOf });
    },
    { auth: 'wallet', rate: walletRate },
  );

  app.get(
    '/api/portfolio/history',
    async (request) => {
      const parsed = historyQuery.safeParse(request.query);
      if (!parsed.success) throw new ApiFailure('BAD_REQUEST', 'range must be 24h, 7d, 30d or all');
      const session = request.session!;
      try {
        return fresh(await portfolioHistory({ id: session.userId, address: session.address }, parsed.data.range));
      } catch (err) {
        asApiFailure(err);
      }
    },
    { auth: 'wallet', rate: walletRate },
  );

  app.put(
    '/api/portfolio/cost-basis',
    async (request) => {
      const parsed = costBasisBody.safeParse(request.body);
      if (!parsed.success) {
        throw new ApiFailure('BAD_REQUEST', 'Enter a purchase price above zero.', 400, 'avgPrice');
      }
      const session = request.session!;
      const symbol = parsed.data.symbol.toUpperCase();
      // Only for something actually in the wallet.
      const summary = await summaryFor(session);
      const held = [...summary.holdings, ...summary.dust, ...summary.unsupported].find((h) => h.symbol.toUpperCase() === symbol);
      if (!held) throw new ApiFailure('NOT_FOUND', `${symbol} isn't in this wallet.`, 404);
      if (held.costBasis === 'cash') throw new ApiFailure('BAD_REQUEST', 'The settlement stablecoin has no purchase price to set.');
      await getDb().setCostBasis(session.userId, held.symbol, parsed.data.avgPrice);
      return fresh(await summaryFor(session));
    },
    { auth: 'wallet', rate: walletRate },
  );

  /**
   * Robinchan's one-paragraph read of the portfolio — describes, never
   * advises (Portfolio §7). Reused until the portfolio's shape changes.
   */
  app.get(
    '/api/portfolio/read',
    async (request) => {
      const session = request.session!;
      const summary = await summaryFor(session);
      if (summary.holdings.length === 0) return fresh<CompanionRead | null>(null);
      const key = cacheKey('pread', session.userId);
      const fingerprint = portfolioFingerprint(summary);
      const cached = await getCache().get<{ fingerprint: string; read: CompanionRead }>(key);
      if (cached?.fingerprint === fingerprint) return fresh<CompanionRead | null>(cached.read);
      const read = await generatePortfolioRead(summary);
      await getCache().set(key, { fingerprint, read }, READ_TTL_SEC);
      return fresh<CompanionRead | null>(read);
    },
    { auth: 'wallet', rate: walletRate },
  );
}
