import 'server-only';

import type { ApiEnvelope } from '@robinchan/shared';

import { sessionFromCookieHeader } from '@/server/auth/session';
import { api } from '@/server/api/app';

import { emptyEnvelope } from './api';

const TIMEOUT_MS = 6000;

/**
 * Server-side twin of `getEnvelope` in `./api`, for the pages' first render.
 *
 * The API now lives in this Next.js server, so instead of an HTTP round trip
 * to itself this runs the very same route in-process — same validation,
 * same envelope. The contract is unchanged: it never throws, and anything
 * other than a populated envelope (error status, timeout, unreachable
 * database) falls back to an empty one marked `stale`, so the page still
 * renders without the layout jumping (brief §4).
 *
 * Pass the request's cookie header for pages whose content depends on who's
 * looking (the heat board's gating); leave it out for the cached public
 * pages, which must never render one viewer's data for another.
 */
export async function getEnvelope<T>(
  path: string,
  fallback: T,
  opts: { cookie?: string | null } = {},
): Promise<ApiEnvelope<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      api.dispatch('GET', new URL(path, 'http://internal'), {
        session: sessionFromCookieHeader(opts.cookie),
      }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), TIMEOUT_MS);
      }),
    ]);
    if (!result || result.status !== 200) return emptyEnvelope(fallback);
    // Serialize exactly as the HTTP response would, so server and client
    // renders see identical data (dropped `undefined`s, ISO strings, …).
    const body = JSON.parse(JSON.stringify(result.body)) as ApiEnvelope<T> | { error: unknown };
    if (!body || typeof body !== 'object' || !('data' in body)) return emptyEnvelope(fallback);
    return body;
  } catch {
    return emptyEnvelope(fallback);
  } finally {
    clearTimeout(timer);
  }
}
