import 'server-only';

import { getRateLimiter } from '@robinchan/store';

import { sessionFromCookieHeader } from '../auth/session';
import { api } from './app';
import { clientIpFrom } from './ip';

/**
 * HTTP edge of the API, served by `app/api/[...path]/route.ts`. Carries over
 * what the Fastify plugins used to add around the routes: helmet's security
 * headers, CORS, the public rate limit, and the JSON 404 — plus, now that
 * some routes write, body parsing, the session cookie, and a same-origin
 * check on anything that isn't a GET.
 */

/** `@fastify/helmet`'s defaults, minus CSP — the page CSP lives in next.config. */
export const SECURITY_HEADERS: Record<string, string> = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'origin-agent-cluster': '?1',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-dns-prefetch-control': 'off',
  'x-download-options': 'noopen',
  'x-frame-options': 'SAMEORIGIN',
  'x-permitted-cross-domain-policies': 'none',
  'x-xss-protection': '0',
};

const RATE_WINDOW_MS = 60_000;
const MAX_BODY_BYTES = 16 * 1024;

function allowedOrigins(): string[] {
  return (process.env.CORS_ORIGIN ?? 'http://localhost:3000').split(',').map((s) => s.trim());
}

/** The rate-limit key for a request — see `clientIpFrom`. */
export function clientIp(request: Request): string {
  return clientIpFrom(request.headers);
}

/**
 * Writes carry the session cookie, so a cross-site page must not be able to
 * send one. SameSite=Lax already keeps the cookie off cross-site POSTs; this
 * refuses them outright when the browser says where they came from.
 */
export function sameOriginWrite(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  const url = new URL(request.url);
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? url.host;
  try {
    const from = new URL(origin);
    return from.host === host || allowedOrigins().includes(origin);
  } catch {
    return false;
  }
}

function json(status: number, body: unknown, headers: Headers, omitBody = false): Response {
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(omitBody ? null : JSON.stringify(body), { status, headers });
}

async function readBody(request: Request): Promise<{ ok: true; body: unknown } | { ok: false; message: string }> {
  const type = request.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) return { ok: false, message: 'expected an application/json body' };
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { ok: false, message: 'request body too large' };
  if (!text) return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, message: 'malformed JSON body' };
  }
}

export async function handleApiRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers(SECURITY_HEADERS);

  // CORS: the origin list is reflected, never `*`, and `Vary: Origin` goes
  // on every response so caches keep per-origin variants apart.
  headers.set('vary', 'Origin');
  const origin = request.headers.get('origin');
  if (origin && allowedOrigins().includes(origin)) {
    headers.set('access-control-allow-origin', origin);
    headers.set('access-control-allow-credentials', 'true');
  }

  if (request.method === 'OPTIONS') {
    if (!origin || !request.headers.get('access-control-request-method')) {
      headers.set('content-type', 'text/plain; charset=utf-8');
      return new Response('Invalid Preflight Request', { status: 400, headers });
    }
    headers.set('access-control-allow-methods', 'GET, POST, PUT');
    headers.set('vary', 'Origin, Access-Control-Request-Headers');
    const requested = request.headers.get('access-control-request-headers');
    if (requested !== null) headers.set('access-control-allow-headers', requested);
    headers.set('content-length', '0');
    return new Response(null, { status: 204, headers });
  }

  const isHead = request.method === 'HEAD';
  const method = isHead ? 'GET' : request.method;
  const match = api.match(method, url.pathname);
  if (!match) {
    const allowed = api.methodsFor(url.pathname);
    if (allowed.length) {
      headers.set('allow', allowed.join(', '));
      return json(405, { error: { code: 'BAD_REQUEST', message: 'method not allowed' } }, headers, isHead);
    }
    return json(404, { error: { code: 'NOT_FOUND', message: 'unknown endpoint' } }, headers, isHead);
  }

  // Public endpoints: 60 requests per minute per IP (brief §9).
  const max = Number(process.env.RATE_LIMIT_PUBLIC ?? 60);
  try {
    const { count, resetAt } = await getRateLimiter().hit(`ip:${clientIp(request)}`, RATE_WINDOW_MS);
    const resetSec = Math.max(0, Math.ceil((resetAt - Date.now()) / 1000));
    headers.set('x-ratelimit-limit', String(max));
    headers.set('x-ratelimit-remaining', String(Math.max(0, max - count)));
    headers.set('x-ratelimit-reset', String(resetSec));
    if (count > max) {
      headers.set('retry-after', String(resetSec));
      // The Fastify server meant to send this, but its error handler turned
      // the rate-limit plugin's thrown object into a 500 INTERNAL.
      return json(
        429,
        { error: { code: 'RATE_LIMITED', message: 'too many requests, try again shortly' } },
        headers,
        isHead,
      );
    }
  } catch (err) {
    // A limiter outage must not take the read-only API down with it.
    console.warn(`[api] rate limiter unavailable: ${err instanceof Error ? err.message : err}`);
  }

  let body: unknown;
  if (method === 'POST' || method === 'PUT') {
    if (!sameOriginWrite(request)) {
      return json(403, { error: { code: 'FORBIDDEN', message: 'cross-origin writes are not allowed' } }, headers);
    }
    const parsed = await readBody(request);
    if (!parsed.ok) return json(400, { error: { code: 'BAD_REQUEST', message: parsed.message } }, headers);
    body = parsed.body;
  }

  const session = sessionFromCookieHeader(request.headers.get('cookie'));
  const result = await api.run(match, url, { body, headers: request.headers, session });
  for (const [key, value] of result.headers) {
    if (key === 'set-cookie') headers.append(key, value);
    else headers.set(key, value);
  }
  // Anything that depends on who's asking must never be cached as if it didn't.
  if (session || result.headers.has('set-cookie')) headers.set('cache-control', 'private, no-store');
  return json(result.status, result.body, headers, isHead);
}
