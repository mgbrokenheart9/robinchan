import type { OrderQuote } from '@robinchan/shared';
import {
  LlmError,
  OrderError,
  looksLikeOrder,
  parseOrderText,
  quoteOrder,
  tradingEnabled,
} from '@robinchan/core';
import { getDb, getRateLimiter } from '@robinchan/store';
import { z } from 'zod';

import {
  CHAT_MAX_HISTORY,
  CHAT_MAX_MESSAGE,
  type ChatErrorBody,
  type ChatResponseBody,
} from '@/lib/chat';
import { sessionFromCookieHeader, type Session } from '@/server/auth/session';
import { SECURITY_HEADERS, clientIp, sameOriginWrite } from '@/server/api/http';
import { orderUser } from '@/server/api/viewer';
import { pageContextBlock } from '@/server/companion/context';
import { complete, type ChatTurn } from '@/server/companion/megallm';
import { buildSystemPrompt, parseReply } from '@/server/companion/prompt';
import { synthesize } from '@/server/companion/voice';

/**
 * `POST /api/chat` — one turn with Robinchan.
 *
 * The one endpoint that calls providers on the request path: MegaLLM for the
 * reply, then ElevenLabs for her voice. Both finish before the response goes
 * out, so the text, the audio, and the per-character timings arrive together
 * and the client can play them back in sync. That's the trade against token
 * streaming (brief §5): a spoken line can't start before it's complete.
 *
 * One chat everywhere (Trade-Heat-Portfolio §2): the page the message came
 * from arrives as `context`, and the server looks up what that page shows.
 * A signed-in wallet's history is kept on the server. When the message asks
 * for a spot order (with `FEATURE_TRADING` on), it goes through the parse →
 * quote order pipeline, and the preview comes back alongside the reply.
 * Perps aren't traded from the chat yet (Agri Perps brief §12.6).
 *
 * Takes precedence over the `[...path]` catch-all, so it applies the same
 * security headers itself, plus a tighter per-IP limit than the read-only
 * API — every call here costs provider credits.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const body = z.object({
  message: z.string().trim().min(1).max(CHAT_MAX_MESSAGE),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        text: z.string().max(2000),
      }),
    )
    .max(CHAT_MAX_HISTORY)
    .default([]),
  voice: z.boolean().default(true),
  context: z
    .object({
      page: z.enum(['home', 'robinchan', 'market', 'heat', 'portfolio', 'perps', 'gap', 'check']),
      // A ticker — or, on Token Check, the token's address.
      symbol: z
        .string()
        .regex(/^(?:[A-Za-z0-9.-]{1,12}|0x[0-9a-fA-F]{40})$/)
        .nullable()
        .optional(),
    })
    .optional(),
});

const RATE_WINDOW_MS = 60_000;

export async function POST(request: Request): Promise<Response> {
  const headers = new Headers(SECURITY_HEADERS);

  if (!sameOriginWrite(request)) {
    return fail(403, 'FORBIDDEN', 'cross-origin writes are not allowed', headers);
  }

  const max = Number(process.env.RATE_LIMIT_CHAT ?? 12);
  try {
    const { count, resetAt } = await getRateLimiter().hit(
      `chat:${clientIp(request)}`,
      RATE_WINDOW_MS,
    );
    if (count > max) {
      headers.set('retry-after', String(Math.max(0, Math.ceil((resetAt - Date.now()) / 1000))));
      return fail(429, 'RATE_LIMITED', "That's a lot of messages at once — give me a moment.", headers);
    }
  } catch (err) {
    console.warn(`[chat] rate limiter unavailable: ${err instanceof Error ? err.message : err}`);
  }

  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return fail(400, 'BAD_REQUEST', parsed.error.issues[0]?.message ?? 'invalid body', headers);
  }
  const { message, voice, context } = parsed.data;
  const session = sessionFromCookieHeader(request.headers.get('cookie'));

  // Signed in: the server's copy of the thread. Signed out: what the page kept.
  const history = session
    ? (await getDb().listChat(session.userId, CHAT_MAX_HISTORY).catch(() => [])).map((r) => ({
        role: r.role,
        text: r.content,
      }))
    : parsed.data.history;

  const trading = tradingEnabled();
  const [pageContext, orderStep] = await Promise.all([
    pageContextBlock(context, session),
    trading && looksLikeOrder(message) ? orderFromMessage(message, session, context?.symbol ?? null) : null,
  ]);

  const messages: ChatTurn[] = [
    {
      role: 'system',
      content: await buildSystemPrompt({ trading, pageContext, orderStatus: orderStep?.status ?? null }),
    },
    ...history.map((turn) => ({ role: turn.role, content: turn.text })),
    { role: 'user', content: message },
  ];

  let raw: string;
  try {
    raw = await complete(messages);
  } catch (err) {
    if (err instanceof LlmError) return fail(err.status, 'LLM_UNAVAILABLE', err.message, headers);
    console.error('[chat]', err);
    return fail(500, 'INTERNAL', 'an internal error occurred', headers);
  }

  const { mood, text } = parseReply(raw);
  if (!text) return fail(502, 'LLM_UNAVAILABLE', 'The chat model returned an empty reply.', headers);

  if (session) {
    await getDb()
      .appendChat(session.userId, [
        { role: 'user', content: message },
        { role: 'assistant', content: text },
      ])
      .catch((err) => console.warn(`[chat] history not saved: ${(err as Error).message}`));
  }

  const result: ChatResponseBody = { reply: text, mood, voice: null, order: orderStep?.quote ?? null };
  if (voice) {
    const spoken = await synthesize(text);
    if (spoken.ok) result.voice = spoken.voice;
    else result.voiceNote = spoken.reason;
  }

  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(result), { status: 200, headers });
}

/**
 * The chat's side of the spot order pipeline: the sentence is parsed into an
 * intent (function calling, nothing guessed), then quoted by `quoteOrder`. What the model is told about it goes in
 * `<order_status>`; the numbers themselves reach the user only through the
 * preview card, which renders the server's quote.
 */
async function orderFromMessage(
  message: string,
  session: Session | null,
  pageSymbol: string | null,
): Promise<{ status: string; quote: OrderQuote | null }> {
  const fence = (s: string) => `<order_status>\n${s}\n</order_status>`;
  if (!session) {
    return {
      status: fence('The user asked for an order but has not connected and signed in with a wallet. Tell them to do that first; nothing was prepared.'),
      quote: null,
    };
  }
  try {
    const parsed = await parseOrderText(message, { symbol: pageSymbol });
    if (!parsed) return { status: '', quote: null };
    if (!parsed.ok) {
      return {
        status: fence(
          `The user wants to place an order, but these details were not stated clearly: ${parsed.missing.join(', ')}` +
            `${parsed.reason ? ` (${parsed.reason})` : ''}. Ask for exactly those, in one short question. Do not guess or suggest values. Nothing was prepared.`,
        ),
        quote: null,
      };
    }
    const quote = await quoteOrder({ user: await orderUser(session), intent: parsed.intent, source: 'chat' });
    const i = quote.intent;
    return {
      status: fence(
        `An order preview is shown below your reply: ${i.orderType} ${i.side} ${i.qty} ${i.symbol}` +
          `${i.limitPrice != null ? ` with a limit of ${i.limitPrice}` : ''}${parsed.symbolFromContext ? ` (${i.symbol} taken from the page the user is on — mention that)` : ''}.` +
          ' Confirm in one sentence what it is, say the user reviews and signs it themselves, and that the price holds for 30 seconds. Do not repeat totals or fees.',
      ),
      quote,
    };
  } catch (err) {
    if (err instanceof OrderError) {
      return {
        status: fence(`The user asked for an order, but it could not be prepared: ${err.message} Explain that briefly. Nothing was prepared.`),
        quote: null,
      };
    }
    if (err instanceof LlmError) {
      return { status: fence('Order parsing is unavailable right now. Say so briefly; nothing was prepared.'), quote: null };
    }
    console.error('[chat] order step', err);
    return { status: fence('The order could not be prepared because of an internal error. Nothing was prepared.'), quote: null };
  }
}

function fail(status: number, code: string, message: string, headers: Headers): Response {
  headers.set('content-type', 'application/json; charset=utf-8');
  const payload: ChatErrorBody = { error: { code, message } };
  return new Response(JSON.stringify(payload), { status, headers });
}
