import type { Pool } from 'pg';

import { ensureSchema, getPgPool } from './pg';

/**
 * Fixed-window request counter (brief §9: public endpoints get 60 requests
 * per minute per IP). Same algorithm as the `@fastify/rate-limit` local
 * store the old API server used: the first request opens a window, every
 * request in it increments the count, and the window resets once it lapses.
 */
export type RateLimitHit = {
  /** Requests counted in the current window, this one included. */
  count: number;
  /** Epoch milliseconds when the current window closes. */
  resetAt: number;
};

export interface RateLimiter {
  hit(key: string, windowMs: number): Promise<RateLimitHit>;
}

/**
 * Serverless instances don't share memory, so with Postgres configured the
 * count lives in the `rate_limits` table — one atomic upsert per request.
 */
class PgRateLimiter implements RateLimiter {
  constructor(private readonly pool: Pool) {}

  async hit(key: string, windowMs: number): Promise<RateLimitHit> {
    await ensureSchema(this.pool);
    const now = new Date();
    const reset = new Date(now.getTime() + windowMs);
    const res = await this.pool.query(
      `insert into rate_limits (key, count, reset_at)
       values ($1, 1, $3)
       on conflict (key) do update
         set count = case when rate_limits.reset_at <= $2 then 1 else rate_limits.count + 1 end,
             reset_at = case when rate_limits.reset_at <= $2 then $3 else rate_limits.reset_at end
       returning count, reset_at`,
      [key, now, reset],
    );
    const row = res.rows[0] as { count: number; reset_at: Date };
    return { count: row.count, resetAt: new Date(row.reset_at).getTime() };
  }
}

/** Local dev without a database: one Next.js process, so memory is shared enough. */
class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, RateLimitHit>();

  async hit(key: string, windowMs: number): Promise<RateLimitHit> {
    const now = Date.now();
    if (this.windows.size > 5000) {
      for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
    }
    const current = this.windows.get(key);
    const next =
      !current || current.resetAt <= now
        ? { count: 1, resetAt: now + windowMs }
        : { count: current.count + 1, resetAt: current.resetAt };
    this.windows.set(key, next);
    return next;
  }
}

let limiter: RateLimiter | null = null;

export function getRateLimiter(): RateLimiter {
  if (limiter) return limiter;
  const pool = getPgPool();
  limiter = pool ? new PgRateLimiter(pool) : new MemoryRateLimiter();
  return limiter;
}
