import type { OrderStatus } from '@robinchan/shared';
import {
  LlmError,
  cancelOrder,
  checkPendingOrder,
  parseOrderText,
  quoteOrder,
  quoteRateLimit,
  recordOrder,
  toRecord,
  tradingEnabled,
  walletRateLimit,
} from '@robinchan/core';
import { getDb } from '@robinchan/store';
import { z } from 'zod';

import { ApiFailure, fresh } from '../envelope';
import type { ApiRouter } from '../router';
import { asApiFailure, orderUser } from '../viewer';

const STATUS_SETS: Record<string, OrderStatus[] | null> = {
  open: ['open'],
  pending: ['pending'],
  active: ['open', 'pending'],
  // Done, failed, and expired (Trade §3 "Riwayat"); an unsigned quote that
  // lapsed isn't an order anyone placed, so it's left out.
  history: ['filled', 'failed', 'expired', 'cancelled', 'pending'],
  all: null,
};

const listQuery = z.object({
  status: z.enum(['open', 'pending', 'active', 'history', 'all']).default('all'),
  symbol: z.string().regex(/^[A-Za-z0-9.-]{1,12}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const intentSchema = z.object({
  side: z.enum(['buy', 'sell']),
  symbol: z.string().regex(/^[A-Za-z0-9.-]{1,12}$/),
  qty: z.number().positive().finite(),
  orderType: z.enum(['market', 'limit']),
  limitPrice: z.number().positive().finite().nullable(),
});

const quoteBody = z.object({
  intent: intentSchema,
  source: z.enum(['form', 'chat']).default('form'),
});

const recordBody = z
  .object({
    orderId: z.string().uuid(),
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(2000).optional(),
    txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
    step: z.number().int().min(0).max(4).optional(),
  })
  .refine((b) => Boolean(b.signature) !== Boolean(b.txHash), 'send either a signature or a transaction hash');

const parseBody = z.object({
  text: z.string().trim().min(1).max(500),
  /** The symbol open on the page — used only when the sentence names none. */
  symbol: z.string().regex(/^[A-Za-z0-9.-]{1,12}$/).nullable().optional(),
});

const idParams = z.object({ id: z.string().uuid() });

const walletRate = { name: 'wallet', max: walletRateLimit };
const quoteRate = { name: 'quote', max: quoteRateLimit };

function assertTrading(): void {
  if (!tradingEnabled()) throw new ApiFailure('FEATURE_DISABLED', 'Trading is not live yet.', 403);
}

const PENDING_RECHECK_MS = 5_000;

export function orderRoutes(app: ApiRouter): void {
  /**
   * The user's orders — the Trade page's tabs and the Portfolio history
   * both read this. Reading stays available with trading switched off, so
   * past orders never disappear behind the flag.
   */
  app.get(
    '/api/orders',
    async (request) => {
      const parsed = listQuery.safeParse(request.query);
      if (!parsed.success) throw new ApiFailure('BAD_REQUEST', parsed.error.issues[0]?.message ?? 'invalid query');
      const { status, symbol, limit } = parsed.data;
      const statuses = STATUS_SETS[status];
      const rows = await getDb().listOrders({
        userId: request.session!.userId,
        statuses: statuses ?? undefined,
        symbol: symbol?.toUpperCase(),
        limit,
      });
      const visible = rows.filter((o) => o.status !== 'quoted' && !(o.status === 'expired' && !o.submittedAt));
      return fresh((status === 'all' ? rows : visible).map(toRecord));
    },
    { auth: 'wallet', rate: walletRate },
  );

  /** One order — polled while a transaction is pending, and checked against the chain on the way. */
  app.get(
    '/api/orders/:id',
    async (request) => {
      const parsed = idParams.safeParse(request.params);
      if (!parsed.success) throw new ApiFailure('BAD_REQUEST', 'invalid order id');
      const db = getDb();
      let order = await db.getOrder(parsed.data.id);
      if (!order || order.userId !== request.session!.userId) throw new ApiFailure('NOT_FOUND', 'Order not found.', 404);
      if (order.status === 'pending' && (!order.checkedAt || Date.now() - Date.parse(order.checkedAt) > PENDING_RECHECK_MS)) {
        await checkPendingOrder(order).catch((err) => console.warn(`[orders] check ${order?.id}: ${(err as Error).message}`));
        order = (await db.getOrder(order.id)) ?? order;
      }
      return fresh(toRecord(order));
    },
    { auth: 'wallet' },
  );

  app.post(
    '/api/orders/:id/cancel',
    async (request) => {
      assertTrading();
      const parsed = idParams.safeParse(request.params);
      if (!parsed.success) throw new ApiFailure('BAD_REQUEST', 'invalid order id');
      try {
        return fresh(await cancelOrder(await orderUser(request.session!), parsed.data.id));
      } catch (err) {
        asApiFailure(err);
      }
    },
    { auth: 'wallet', rate: walletRate },
  );

  /* ---- the order pipeline (main brief §12) ---- */

  app.post(
    '/api/order/parse',
    async (request) => {
      assertTrading();
      const parsed = parseBody.safeParse(request.body);
      if (!parsed.success) throw new ApiFailure('BAD_REQUEST', 'invalid body');
      try {
        const result = await parseOrderText(parsed.data.text, { symbol: parsed.data.symbol?.toUpperCase() });
        if (!result) throw new ApiFailure('PARSE_FAILED', "That doesn't read as an order.", 422);
        if (!result.ok) {
          throw new ApiFailure('PARSE_INCOMPLETE', `Missing: ${result.missing.join(', ')}.`, 422, null, {
            missing: result.missing,
            partial: result.partial,
          });
        }
        return fresh(result);
      } catch (err) {
        if (err instanceof LlmError) throw new ApiFailure('PARSE_FAILED', err.message, 503);
        asApiFailure(err);
      }
    },
    { auth: 'wallet', rate: walletRate },
  );

  app.post(
    '/api/order/quote',
    async (request) => {
      assertTrading();
      const parsed = quoteBody.safeParse(request.body);
      if (!parsed.success) throw new ApiFailure('BAD_REQUEST', parsed.error.issues[0]?.message ?? 'invalid order');
      try {
        const quote = await quoteOrder({
          user: await orderUser(request.session!),
          intent: parsed.data.intent,
          source: parsed.data.source,
        });
        return fresh(quote);
      } catch (err) {
        asApiFailure(err);
      }
    },
    { auth: 'wallet', rate: quoteRate },
  );

  app.post(
    '/api/order/record',
    async (request) => {
      assertTrading();
      const parsed = recordBody.safeParse(request.body);
      if (!parsed.success) throw new ApiFailure('BAD_REQUEST', parsed.error.issues[0]?.message ?? 'invalid body');
      try {
        return fresh(
          await recordOrder({
            user: await orderUser(request.session!),
            orderId: parsed.data.orderId,
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
}
