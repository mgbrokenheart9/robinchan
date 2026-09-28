import { LlmError, tradingEnabled } from '@robinchan/core';
import { getRateLimiter } from '@robinchan/store';
import { z } from 'zod';

import type { ChatErrorBody, ChatResponseBody } from '@/lib/chat';
import { sessionFromCookieHeader } from '@/server/auth/session';
import { SECURITY_HEADERS, clientIp, sameOriginWrite } from '@/server/api/http';
import { pageContextBlock } from '@/server/companion/context';
import { complete, type ChatTurn } from '@/server/companion/megallm';
import { buildSystemPrompt, parseReply } from '@/server/companion/prompt';
import { synthesize } from '@/server/companion/voice';

/**
 * `POST /api/companion/look` — Robinchan reads the screen.
 *
 * The peeking Robinchan was tapped: she says, in a sentence or two and in her
 * own voice, what the page in front of the user shows right now — the open
 * market and its price, their positions, the heat board, the indices. The
 * page sends only which page and symbol; every figure is looked up here, as
 * for the chat (server/companion/context.ts), so she can't be made to read
 * out anything the viewer couldn't see.
 *
 * Not a chat turn: nothing is added to the thread. Rate-limited per IP on
 * its own bucket — each tap costs an LLM call and a voice clip.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const body = z.object({
  voice: z.boolean().default(true),
  context: z.object({
    page: z.enum(['home', 'robinchan', 'market', 'heat', 'portfolio', 'perps']),
    symbol: z
      .string()
      .regex(/^[A-Za-z0-9.-]{1,12}$/)
      .nullable()
      .optional(),
  }),
});

const RATE_WINDOW_MS = 60_000;

/** What she's asked when tapped. The page's figures are in the system prompt's <page_context> and <market_data>. */
const LOOK =
  '[The user just tapped you.] Glance at my screen and tell me what it shows right now, like a friend looking over my shoulder: ' +
  'one or two short, natural sentences, under 35 words. Pick the one or two things that matter most — the market I have open ' +
  'and its price and move, or my position and its profit or loss — and say numbers the way people say them (rounded, no long ' +
  'decimals). Leave out fixed terms like funding rates, leverage limits and liquidation rules unless something is off. If ' +
  'something needs attention (a position close to liquidation, a closed market, no price yet), lead with it. No advice.';

export async function POST(request: Request): Promise<Response> {
  const headers = new Headers(SECURITY_HEADERS);
  if (!sameOriginWrite(request)) return fail(403, 'FORBIDDEN', 'cross-origin writes are not allowed', headers);

  const max = Number(process.env.RATE_LIMIT_LOOK ?? 8);
  try {
    const { count, resetAt } = await getRateLimiter().hit(`look:${clientIp(request)}`, RATE_WINDOW_MS);
    if (count > max) {
      headers.set('retry-after', String(Math.max(0, Math.ceil((resetAt - Date.now()) / 1000))));
      return fail(429, 'RATE_LIMITED', 'Give me a second — I just looked!', headers);
    }
  } catch (err) {
    console.warn(`[look] rate limiter unavailable: ${err instanceof Error ? err.message : err}`);
  }

  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail(400, 'BAD_REQUEST', parsed.error.issues[0]?.message ?? 'invalid body', headers);
  const { voice, context } = parsed.data;
  const session = sessionFromCookieHeader(request.headers.get('cookie'));

  const pageContext = await pageContextBlock(context, session);
  const messages: ChatTurn[] = [
    { role: 'system', content: await buildSystemPrompt({ trading: tradingEnabled(), pageContext }) },
    { role: 'user', content: LOOK },
  ];

  let raw: string;
  try {
    raw = await complete(messages);
  } catch (err) {
    if (err instanceof LlmError) return fail(err.status, 'LLM_UNAVAILABLE', err.message, headers);
    console.error('[look]', err);
    return fail(500, 'INTERNAL', 'an internal error occurred', headers);
  }
  const { mood, text } = parseReply(raw);
  if (!text) return fail(502, 'LLM_UNAVAILABLE', 'The chat model returned an empty reply.', headers);

  const result: ChatResponseBody = { reply: text, mood, voice: null, order: null };
  if (voice) {
    const spoken = await synthesize(text);
    if (spoken.ok) result.voice = spoken.voice;
    else result.voiceNote = spoken.reason;
  }

  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(result), { status: 200, headers });
}

function fail(status: number, code: string, message: string, headers: Headers): Response {
  headers.set('content-type', 'application/json; charset=utf-8');
  const payload: ChatErrorBody = { error: { code, message } };
  return new Response(JSON.stringify(payload), { status, headers });
}
