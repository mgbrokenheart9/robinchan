import type { CandleSeries, PerpMarket, PerpMarketStats } from '@robinchan/shared';
import { CANDLE_INTERVALS, PERP_CATEGORIES, perpMarket } from '@robinchan/shared';
import {
  checkPendingPerpAction,
  perpAccount,
  perpAction,
  perpFaucet,
  perpHistory,
  perpMarkFor,
  perpMarketStats,
  perpMarketViews,
  perpPositions,
  perpWaitingOrders,
  quotePerpCancel,
  quotePerpClose,
  quotePerpCollateral,
  quotePerpOpen,
  quoteRateLimit,
  readFeedPrices,
  readPerpCandles,
  recordPerpAction,
  walletRateLimit,
} from '@robinchan/core';
import { z } from 'zod';

import { ApiFailure, FRESH_FOR, emptyEnvelope, envelope, fresh } from '../envelope';
import type { ApiRouter } from '../router';
import { asApiFailure, perpUser } from '../viewer';

/**
 * Perps (Agri Perps brief §6). Market data reads only the caches the worker
 * fills — no oracle call on a page request. The wallet routes go through the
 * one perps pipeline in @robinchan/core.
 */

const symbolParams = z.object({ symbol: z.string().regex(/^[A-Za-z0-9.-]{1,12}$/) });
const idParams = z.object({ id: z.string().uuid() });
const marketsQuery = z.object({ category: z.enum(PERP_CATEGORIES).optional() });
const candleQuery = z.object({ interval: z.enum(CANDLE_INTERVALS).default('1H') });
const historyQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const quoteBody = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('open'),
    symbol: z.string().regex(/^[A-Za-z0-9.-]{1,12}$/),
    side: z.enum(['long', 'short']),
    collateral: z.number().positive().finite(),
    leverage: z.number().int().min(1).max(50),
  }),
  z.object({ action: z.literal('close'), positionId: z.string().uuid() }),
]);

const recordBody = z
  .object({
    actionId: z.string().uuid(),
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(2000).optional(),
    txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
    step: z.number().int().min(0).max(4).optional(),
  })
  .refine((b) => Boolean(b.signature) !== Boolean(b.txHash), 'send either a signature or a transaction hash');

const cancelBody = z.object({ actionId: z.string().uuid() });

const collateralBody = z.object({
  kind: z.enum(['deposit', 'withdraw']),
  amount: z.number().positive().finite(),
});

const walletRate = { name: 'wallet', max: walletRateLimit };
const quoteRate = { name: 'quote', max: quoteRateLimit };
/** The page polls waiting orders on its own schedule: a bucket of its own, so it never eats the wallet's. */
const ordersRate = { name: 'perp-orders', max: () => 30 };

const PENDING_RECHECK_MS = 5_000;

/** Market data is as fresh as the worker's last Chainlink read. */
async function feedsFreshness(): Promise<{ stale: boolean; asOf?: string }> {
  const feeds = await readFeedPrices();
  if (!feeds) return { stale: true };
  return { stale: feeds.ageSec > (FRESH_FOR.price ?? 30), asOf: new Date(Date.now() - feeds.ageSec * 1000).toISOString() };
}

export function perpsRoutes(app: ApiRouter): void {
  /* ---- market data (public) ---- */

  app.get('/api/perps/markets', async (request) => {
    const parsed = marketsQuery.safeParse(request.query);
    if (!parsed.success) throw new ApiFailure('BAD_REQUEST', 'category is agri, crypto or stocks');
    const [markets, freshness] = await Promise.all([perpMarketViews(parsed.data.category), feedsFreshness()]);
    return envelope<PerpMarket[]>(markets, freshness);
  });

  app.get('/api/perps/stats/:symbol', async (request) => {
    const parsed = symbolParams.safeParse(request.params);
    if (!parsed.success) throw new ApiFailure('BAD_REQUEST', 'invalid symbol');
    const stats = await perpMarketStats(parsed.data.symbol);
    if (!stats) throw new ApiFailure('NOT_FOUND', `${parsed.data.symbol.toUpperCase()} isn't a perps market`, 404);
    return envelope<PerpMarketStats>(stats, await feedsFreshness());
  });

  /** The latest cached price. (The brief also returned oracle update data here: Chainlink's feeds are pushed on chain, so there's none.) */
  app.get('/api/perps/price/:symbol', async (request) => {
    const parsed = symbolParams.safeParse(request.params);
    if (!parsed.success) throw new ApiFailure('BAD_REQUEST', 'invalid symbol');
    const def = perpMarket(parsed.data.symbol);
    if (!def) throw new ApiFailure('NOT_FOUND', `${parsed.data.symbol.toUpperCase()} isn't a perps market`, 404);
    const mark = await perpMarkFor(def.symbol);
    if (!mark) throw new ApiFailure('NOT_FOUND', `no price yet for ${def.symbol}`, 404);
    return envelope(
      {
        symbol: def.symbol,
        price: mark.price,
        confidence: mark.conf,
        publishTime: new Date(mark.publishTime * 1000).toISOString(),
        ageSec: mark.ageSec,
        fresh: mark.fresh,
        source: mark.source,
      },
      await feedsFreshness(),
    );
  });

  app.get('/api/perps/candles/:symbol', async (request) => {
    const params = symbolParams.safeParse(request.params);
    const query = candleQuery.safeParse(request.query);
    if (!params.success || !query.success) throw new ApiFailure('BAD_REQUEST', 'invalid symbol or interval');
    const def = perpMarket(params.data.symbol);
    if (!def) throw new ApiFailure('NOT_FOUND', `${params.data.symbol.toUpperCase()} isn't a perps market`, 404);
    const { interval } = query.data;
    const mark = await perpMarkFor(def.symbol);
    // The latest round is the price of record until the next: it holds through now.
    const read = await readPerpCandles(def.symbol, interval, mark?.fresh ? { price: mark.price, timeSec: Math.floor(Date.now() / 1000) } : null);
    if (!read) return emptyEnvelope<CandleSeries>({ symbol: def.symbol, interval, candles: [], source: 'provider' });
    return envelope(
      { ...read.series, source: mark?.source === 'fixture' ? 'fixture' : 'provider' } satisfies CandleSeries,
      { stale: read.ageSec > (FRESH_FOR.candles ?? 600), asOf: new Date(Date.now() - read.ageSec * 1000).toISOString() },
    );
  });

  /* ---- the wallet's side ---- */

  // Reading stays available with the flag off: positions never disappear behind it.
  app.get(
    '/api/perps/positions',
    async (request) => {
      try {
        return fresh(await perpPositions(perpUser(request.session!)));
      } catch (err) {
        asApiFailure(err);
      }
    },
    { auth: 'wallet', rate: walletRate },
  );

  app.get(
    '/api/perps/history',
    async (request) => {
      const parsed = historyQuery.safeParse(request.query);
      if (!parsed.success) throw new ApiFailure('BAD_REQUEST', parsed.error.issues[0]?.message ?? 'invalid query');
      try {
        return fresh(await perpHistory(perpUser(request.session!), parsed.data));
      } catch (err) {
        asApiFailure(err);
      }
    },
    { auth: 'wallet', rate: walletRate },
  );

  // On chain: orders still waiting for their Chainlink round — hours, on a quiet feed.
  app.get(
    '/api/perps/orders',
    async (request) => {
      try {
        return fresh(
          await perpWaitingOrders(perpUser(request.session!), async (a) => {
            if (!a.checkedAt || Date.now() - Date.parse(a.checkedAt) > PENDING_RECHECK_MS) await checkPendingPerpAction(a);
          }),
        );
      } catch (err) {
        asApiFailure(err);
      }
    },
    { auth: 'wallet', rate: ordersRate },
  );

  app.get(
    '/api/perps/collateral',
    async (request) => {
      try {
        return fresh(await perpAccount(perpUser(request.session!)));
      } catch (err) {
        asApiFailure(err);
      }
    },
    { auth: 'wallet', rate: walletRate },
  );

  app.get(
    '/api/perps/actions/:id',
    async (request) => {
      const parsed = idParams.safeParse(request.params);
      if (!parsed.success) throw new ApiFailure('BAD_REQUEST', 'invalid id');
      try {
        return fresh(
          await perpAction(perpUser(request.session!), parsed.data.id, async (a) => {
            if (!a.checkedAt || Date.now() - Date.parse(a.checkedAt) > PENDING_RECHECK_MS) await checkPendingPerpAction(a);
          }),
        );
      } catch (err) {
        asApiFailure(err);
      }
    },
    { auth: 'wallet' },
  );

  app.post(
    '/api/perps/quote',
    async (request) => {
      const parsed = quoteBody.safeParse(request.body);
      if (!parsed.success) throw new ApiFailure('BAD_REQUEST', parsed.error.issues[0]?.message ?? 'invalid quote request');
      const user = perpUser(request.session!);
      try {
        const body = parsed.data;
        return fresh(
          body.action === 'open'
            ? await quotePerpOpen(user, { symbol: body.symbol, side: body.side, collateral: body.collateral, leverage: body.leverage })
            : await quotePerpClose(user, body.positionId),
        );
      } catch (err) {
        asApiFailure(err);
      }
    },
    { auth: 'wallet', rate: quoteRate },
  );

  app.post(
    '/api/perps/record',
    async (request) => {
      const parsed = recordBody.safeParse(request.body);
      if (!parsed.success) throw new ApiFailure('BAD_REQUEST', parsed.error.issues[0]?.message ?? 'invalid body');
      try {
        return fresh(
          await recordPerpAction(perpUser(request.session!), {
            actionId: parsed.data.actionId,
            signature: parsed.data.signature as `0x${string}` | undefined,
            txHash: parsed.data.txHash as `0x${string}` | undefined,
            step: parsed.data.step,
          }),
        );
      } catch (err) {
        asApiFailure(err);
      }
    },
    { auth: 'wallet', rate: walletRate },
  );

  // Asking for a waiting order back: the transaction the wallet sends.
  app.post(
    '/api/perps/cancel',
    async (request) => {
      const parsed = cancelBody.safeParse(request.body);
      if (!parsed.success) throw new ApiFailure('BAD_REQUEST', parsed.error.issues[0]?.message ?? 'invalid body');
      try {
        return fresh(await quotePerpCancel(perpUser(request.session!), parsed.data.actionId));
      } catch (err) {
        asApiFailure(err);
      }
    },
    { auth: 'wallet', rate: quoteRate },
  );

  app.post(
    '/api/perps/collateral',
    async (request) => {
      const parsed = collateralBody.safeParse(request.body);
      if (!parsed.success) throw new ApiFailure('BAD_REQUEST', parsed.error.issues[0]?.message ?? 'invalid body');
      try {
        return fresh(await quotePerpCollateral(perpUser(request.session!), parsed.data));
      } catch (err) {
        asApiFailure(err);
      }
    },
    { auth: 'wallet', rate: walletRate },
  );

  app.post(
    '/api/perps/faucet',
    async (request) => {
      try {
        return fresh(await perpFaucet(perpUser(request.session!)));
      } catch (err) {
        asApiFailure(err);
      }
    },
    { auth: 'wallet', rate: walletRate },
  );
}
