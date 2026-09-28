import type { RecentCheck, TokenCheck } from '@robinchan/shared';
import { looksLikeAddress } from '@robinchan/shared';
import { CheckUnavailable, runTokenCheck } from '@robinchan/core';
import { cacheKey, getCache, getRateLimiter } from '@robinchan/store';

import { ApiFailure, emptyEnvelope, envelope } from '../envelope';
import { clientIpFrom } from '../ip';
import type { ApiRouter } from '../router';

/**
 * Token Check. Unlike the market routes, this one reads the chain and
 * DexScreener on the request — any address can be asked about, so there's
 * nothing for the worker to prepare. A result is reused for two minutes,
 * the same address asked twice at once runs once, and each IP gets its own
 * budget of fresh checks (RATE_LIMIT_CHECK, 10 a minute) on top of the
 * public limit.
 */
const REUSE_SEC = 120;
const KEEP_SEC = 7 * 86_400;
const RECENT_MAX = 12;
const RATE_WINDOW_MS = 60_000;

const running = new Map<string, Promise<TokenCheck>>();

async function remember(check: TokenCheck): Promise<void> {
  const cache = getCache();
  await cache.set(cacheKey('check', check.address.toLowerCase()), check, KEEP_SEC);
  // Only tokens go on the public list — never a wallet someone pasted.
  if (!check.token || check.verdict === 'unknown') return;
  const recent = (await cache.get<RecentCheck[]>(cacheKey('check', 'recent'))) ?? [];
  const entry: RecentCheck = {
    address: check.address,
    symbol: check.token.symbol,
    name: check.token.name,
    verdict: check.verdict,
    imageUrl: check.market?.imageUrl ?? null,
    at: check.checkedAt,
  };
  const next = [entry, ...recent.filter((r) => r.address.toLowerCase() !== check.address.toLowerCase())].slice(0, RECENT_MAX);
  await cache.set(cacheKey('check', 'recent'), next, KEEP_SEC);
}

export function checkRoutes(app: ApiRouter): void {
  app.get('/api/check/recent', async () => {
    const recent = await getCache().get<RecentCheck[]>(cacheKey('check', 'recent'));
    return envelope(recent ?? [], { stale: false });
  });

  /**
   * `?peek=1` answers from what's already been checked and never runs a new
   * check — for the page's first render, which mustn't read the chain on
   * every visit to a shared link.
   */
  app.get('/api/check/:address', async (request) => {
    const raw = request.params.address ?? '';
    if (!looksLikeAddress(raw)) {
      throw new ApiFailure('BAD_REQUEST', "That doesn't look like a token address. It should start with 0x and be 42 characters long.", 400, 'address');
    }
    const address = raw.toLowerCase();
    const cached = await getCache().getWithAge<TokenCheck>(cacheKey('check', address));
    const peek = request.query.peek === '1';
    if (cached && (peek || cached.ageSec < REUSE_SEC)) {
      return envelope(cached.value, { stale: false, asOf: cached.value.checkedAt });
    }
    if (peek) return emptyEnvelope<TokenCheck | null>(null);

    let pending = running.get(address);
    if (!pending) {
      const max = Number(process.env.RATE_LIMIT_CHECK ?? 10);
      try {
        const { count } = await getRateLimiter().hit(`check:${clientIpFrom(request.headers)}`, RATE_WINDOW_MS);
        if (count > max) throw new ApiFailure('RATE_LIMITED', "That's a lot of checks in a minute. Give me a moment and try again.", 429);
      } catch (err) {
        if (err instanceof ApiFailure) throw err;
        console.warn(`[check] rate limiter unavailable: ${err instanceof Error ? err.message : err}`);
      }
      pending = runTokenCheck(address).finally(() => running.delete(address));
      running.set(address, pending);
    }

    try {
      const check = await pending;
      await remember(check).catch((err) => console.warn(`[check] couldn't store ${address}: ${(err as Error).message}`));
      return envelope(check, { stale: false, asOf: check.checkedAt });
    } catch (err) {
      if (err instanceof CheckUnavailable) throw new ApiFailure('UPSTREAM_DOWN', err.message, 503);
      throw err;
    }
  });
}
