import type { ApiEnvelope } from '@robinchan/shared';

/**
 * If the API fails, the page still renders with empty values — no error
 * message on the landing page and the layout must not jump (brief §4). So
 * this client never throws; it returns an empty envelope marked `stale`.
 *
 * The API is served by this same Next.js app (`app/api/[...path]`), so
 * browser polling uses same-origin relative paths. Server components use
 * `getEnvelope` from `./api-server` instead, which runs the route in-process.
 */
export async function getEnvelope<T>(
  path: string,
  fallback: T,
  init: RequestInit = {},
): Promise<ApiEnvelope<T>> {
  try {
    const res = await fetch(path, {
      ...init,
      headers: { accept: 'application/json', ...(init.headers ?? {}) },
      signal: init.signal ?? AbortSignal.timeout(6000),
    });
    if (!res.ok) return emptyEnvelope(fallback);
    const body = (await res.json()) as ApiEnvelope<T> | { error: unknown };
    if (!body || typeof body !== 'object' || !('data' in body)) return emptyEnvelope(fallback);
    return body;
  } catch {
    return emptyEnvelope(fallback);
  }
}

export function emptyEnvelope<T>(data: T): ApiEnvelope<T> {
  return { data, stale: true, asOf: new Date(0).toISOString() };
}

/** Never populated at all — different from "populated but stale". */
export function isUnset(envelope: ApiEnvelope<unknown>): boolean {
  return Date.parse(envelope.asOf) === 0;
}

/**
 * A failed API call, carrying the server's error code so the UI can react to
 * it (a tier label for TIER_REQUIRED, a message under the input named by
 * `field`) rather than printing a technical string (Trade §2).
 */
export class ApiClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly field: string | null = null,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

/**
 * For the pages that need to know *why* something failed — the dashboard's
 * error and gating states — unlike `getEnvelope`, which never throws.
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<ApiEnvelope<T>> {
  const { json, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(path, {
      ...rest,
      method: rest.method ?? (json !== undefined ? 'POST' : 'GET'),
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(rest.headers ?? {}),
      },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
      signal: rest.signal ?? AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new ApiClientError(
      'NETWORK',
      err instanceof Error && err.name === 'TimeoutError' ? 'The server took too long to answer.' : "Couldn't reach the server.",
      0,
    );
  }
  const body = (await res.json().catch(() => null)) as
    | ApiEnvelope<T>
    | { error?: { code?: string; message?: string; field?: string } & Record<string, unknown> }
    | null;
  if (!res.ok || !body || !('data' in body)) {
    const err = body && 'error' in body ? body.error : undefined;
    const { code, message, field, ...details } = err ?? {};
    throw new ApiClientError(
      code ?? 'INTERNAL',
      message ?? `Request failed (${res.status}).`,
      res.status,
      field ?? null,
      details,
    );
  }
  return body;
}
