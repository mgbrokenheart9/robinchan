import { getRateLimiter } from '@robinchan/store';

import type { Session } from '../auth/session';
import { ApiFailure } from './envelope';

export type ApiRequest = {
  method: string;
  params: Record<string, string>;
  query: Record<string, string | string[]>;
  /** Parsed JSON body for POST/PUT; undefined otherwise. */
  body: unknown;
  headers: Headers;
  /** The verified session from the cookie, or null. Never from the body. */
  session: Session | null;
};

export type ApiReply = {
  statusCode: number;
  status(code: number): ApiReply;
  /** Extra response headers, e.g. Set-Cookie. */
  headers: Headers;
};

export type ApiHandler = (request: ApiRequest, reply: ApiReply) => unknown;

export type RouteOptions = {
  /** `wallet`: 401 without a signed-in session (brief §9 "Auth: wallet"). */
  auth?: 'wallet';
  /**
   * Per-address limit, on top of the per-IP one: 20/min for wallet
   * endpoints, 10/min for quotes (brief §9).
   */
  rate?: { name: string; max: () => number };
};

export type ApiResult = { status: number; body: unknown; headers: Headers };

type Route = { method: string; segments: string[]; handler: ApiHandler; options: RouteOptions };

export type RouteMatch = { route: Route; params: Record<string, string> };

export type RunContext = {
  body?: unknown;
  headers?: Headers;
  session?: Session | null;
};

const RATE_WINDOW_MS = 60_000;

/**
 * The slice of Fastify's routing surface the API routes were written
 * against — `app.get(path, handler)` with `:param` segments,
 * `request.params` / `request.query` and `reply.status()` — extended with
 * `post`/`put`, a parsed body and the session. Transport-agnostic: the
 * `/api/*` route handler serves it over HTTP, and server components call it
 * in-process for their first render.
 */
export class ApiRouter {
  private readonly routes: Route[] = [];

  get(path: string, handler: ApiHandler, options: RouteOptions = {}): void {
    this.routes.push({ method: 'GET', segments: splitPath(path), handler, options });
  }

  post(path: string, handler: ApiHandler, options: RouteOptions = {}): void {
    this.routes.push({ method: 'POST', segments: splitPath(path), handler, options });
  }

  put(path: string, handler: ApiHandler, options: RouteOptions = {}): void {
    this.routes.push({ method: 'PUT', segments: splitPath(path), handler, options });
  }

  /** Resolves the route and runs it; `null` when no route matches. */
  async dispatch(method: string, url: URL, ctx: RunContext = {}): Promise<ApiResult | null> {
    const match = this.match(method, url.pathname);
    return match ? this.run(match, url, ctx) : null;
  }

  /** Runs a matched route, mapping failures the way the Fastify error handler did. */
  async run(match: RouteMatch, url: URL, ctx: RunContext = {}): Promise<ApiResult> {
    const headers = new Headers();
    const reply: ApiReply = {
      statusCode: 200,
      headers,
      status(code) {
        this.statusCode = code;
        return this;
      },
    };
    const { options } = match.route;
    const session = ctx.session ?? null;
    try {
      if (options.auth === 'wallet' && !session) {
        throw new ApiFailure('UNAUTHORIZED', 'Connect and sign in with your wallet first.', 401);
      }
      if (options.rate && session) {
        const max = options.rate.max();
        const { count, resetAt } = await getRateLimiter().hit(
          `${options.rate.name}:${session.address.toLowerCase()}`,
          RATE_WINDOW_MS,
        );
        if (count > max) {
          headers.set('retry-after', String(Math.max(0, Math.ceil((resetAt - Date.now()) / 1000))));
          throw new ApiFailure('RATE_LIMITED', 'Too many requests from this wallet. Try again in a moment.', 429);
        }
      }
      const body = await match.route.handler(
        {
          method: match.route.method,
          params: match.params,
          query: parseQuery(url.searchParams),
          body: ctx.body,
          headers: ctx.headers ?? new Headers(),
          session,
        },
        reply,
      );
      return { status: reply.statusCode, body, headers };
    } catch (err) {
      if (err instanceof ApiFailure) {
        return {
          status: err.status,
          body: { error: { code: err.code, message: err.message, ...(err.field ? { field: err.field } : {}), ...(err.details ?? {}) } },
          headers,
        };
      }
      console.error('[api]', err);
      return {
        status: 500,
        body: { error: { code: 'INTERNAL', message: 'an internal error occurred' } },
        headers,
      };
    }
  }

  match(method: string, pathname: string): RouteMatch | null {
    let segments: string[];
    try {
      segments = splitPath(pathname).map((s) => decodeURIComponent(s));
    } catch {
      return null; // Malformed percent-encoding can't match any route.
    }

    outer: for (const route of this.routes) {
      if (route.method !== method || route.segments.length !== segments.length) continue;
      const params: Record<string, string> = {};
      for (let i = 0; i < segments.length; i += 1) {
        const pattern = route.segments[i] as string;
        const value = segments[i] as string;
        if (pattern.startsWith(':')) params[pattern.slice(1)] = value;
        else if (pattern !== value) continue outer;
      }
      return { route, params };
    }
    return null;
  }

  /** Methods registered for a path — for the 405 / CORS preflight answer. */
  methodsFor(pathname: string): string[] {
    return ['GET', 'POST', 'PUT'].filter((m) => this.match(m, pathname));
  }
}

function splitPath(path: string): string[] {
  return path.split('/').slice(1);
}

/** Repeated keys become arrays, as Fastify's query-string parser does. */
function parseQuery(search: URLSearchParams): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = Object.create(null);
  for (const [key, value] of search) {
    const previous = query[key];
    if (previous === undefined) query[key] = value;
    else if (Array.isArray(previous)) previous.push(value);
    else query[key] = [previous, value];
  }
  return query;
}
