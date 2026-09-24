import type { ApiEnvelope, ApiErrorCode } from '@robinchan/shared';
import { cacheKey, getCache } from '@robinchan/store';

/**
 * Every response is wrapped as `{ data, stale, asOf }` (brief §9).
 *
 * `stale` isn't a "cache miss" — if the worker falls behind, the API still
 * returns the old data with a flag, and the frontend dims its text. Always
 * serve stale data rather than fail (brief §8).
 */
export function envelope<T>(data: T, opts: { stale: boolean; asOf?: string }): ApiEnvelope<T> {
  return {
    data,
    stale: opts.stale,
    asOf: opts.asOf ?? new Date().toISOString(),
  };
}

export class ApiFailure extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status = 400,
    /** The input the message belongs next to, when there is one. */
    readonly field: string | null = null,
    /** Extra fields merged into the error body (e.g. `missing` for PARSE_INCOMPLETE). */
    readonly details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = 'ApiFailure';
  }
}

/** Reasonable age limit per domain, in seconds. Past this, data is marked `stale`. */
export const FRESH_FOR: Record<string, number> = {
  price: 30,
  market: 30,
  news: 120,
  heat: 600,
  media: 900,
  calendar: 7200,
  candles: 600,
};

export type Cached<T> = { data: T; stale: boolean; asOf: string };

/**
 * Read a single cache key and determine its staleness from the value's age.
 * Returns `null` only when the key has genuinely never been written.
 */
export async function readCached<T>(domain: string, key: string): Promise<Cached<T> | null> {
  const hit = await getCache().getWithAge<T>(cacheKey(domain, key));
  if (!hit) return null;
  const limit = FRESH_FOR[domain] ?? 60;
  return {
    data: hit.value,
    stale: hit.ageSec > limit,
    asOf: new Date(Date.now() - hit.ageSec * 1000).toISOString(),
  };
}

/**
 * The response shape when the worker hasn't had a chance to fill anything in
 * yet. The layout must not jump and the landing page must not show an error
 * (brief §4), so what's sent is a valid empty shape, not an HTTP 5xx.
 */
export function emptyEnvelope<T>(data: T): ApiEnvelope<T> {
  return { data, stale: true, asOf: new Date(0).toISOString() };
}

/** For routes that compute their answer now: fresh by definition. */
export function fresh<T>(data: T): ApiEnvelope<T> {
  return envelope(data, { stale: false });
}
