import 'server-only';

import type { TierState } from '@robinchan/shared';
import {
  HeatAccessError,
  HoldingsUnavailable,
  LlmError,
  OrderError,
  PerpError,
  resolveTier,
  type OrderUser,
  type PerpUser,
} from '@robinchan/core';

import type { Session } from '../auth/session';
import { ApiFailure } from './envelope';

/** Tier for a session, from the chain (cached 60s) — never from the request. */
export async function tierFor(session: Session | null): Promise<TierState | null> {
  if (!session) return null;
  try {
    return await resolveTier(session.address);
  } catch (err) {
    console.warn(`[tier] ${session.address}: ${(err as Error).message}`);
    throw new ApiFailure('UPSTREAM_DOWN', "Your tier couldn't be read from the chain right now.", 503);
  }
}

export async function orderUser(session: Session): Promise<OrderUser> {
  const tier = await tierFor(session);
  return { id: session.userId, address: session.address, tier: tier?.tier ?? 'free' };
}

/** The signed-in wallet as the perps pipeline sees it. */
export function perpUser(session: Session): PerpUser {
  return { id: session.userId, address: session.address };
}

/** Domain errors from `@robinchan/core`, mapped onto the API's error envelope. */
export function asApiFailure(err: unknown): never {
  if (err instanceof ApiFailure) throw err;
  if (err instanceof OrderError) throw new ApiFailure(err.code, err.message, err.status, err.field);
  if (err instanceof PerpError) throw new ApiFailure(err.code, err.message, err.status, err.field);
  if (err instanceof HeatAccessError) {
    throw new ApiFailure(err.status === 404 ? 'NOT_FOUND' : 'TIER_REQUIRED', err.message, err.status, null, {
      requiredTier: err.requiredTier,
    });
  }
  if (err instanceof HoldingsUnavailable) throw new ApiFailure('NOT_CONFIGURED', err.message, 503);
  if (err instanceof LlmError) throw new ApiFailure('UPSTREAM_DOWN', err.message, err.status === 503 ? 503 : 502);
  throw err;
}
