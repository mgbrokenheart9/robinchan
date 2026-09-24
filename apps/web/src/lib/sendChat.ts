'use client';

import type { PageContext } from '@robinchan/shared';

import type { ChatErrorBody, ChatRequestBody, ChatResponseBody } from './chat';
import { appendChat, chatHistoryForRequest, newMessageId } from './chatStore';

/**
 * One turn with Robinchan, from anywhere: the user's line goes into the
 * shared thread, the page context rides along as metadata, and her reply
 * (with an order preview, if the message asked for one) is appended when it
 * lands. Throws with a readable message on failure.
 */
export async function sendChat(
  message: string,
  opts: { context: PageContext; voice: boolean },
): Promise<ChatResponseBody> {
  const history = chatHistoryForRequest();
  appendChat({ id: newMessageId(), role: 'user', text: message });

  const payload: ChatRequestBody = { message, history, voice: opts.voice, context: opts.context };
  let response: Response;
  try {
    response = await fetch('/api/chat', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error("I couldn't reach the server. Check your connection and try again.");
  }
  const body = (await response.json().catch(() => null)) as ChatResponseBody | ChatErrorBody | null;
  if (!response.ok || !body || 'error' in body) {
    throw new Error(body && 'error' in body ? body.error.message : `Chat request failed (${response.status}).`);
  }
  appendChat({ id: newMessageId(), role: 'assistant', text: body.reply, order: body.order ?? null });
  return body;
}
