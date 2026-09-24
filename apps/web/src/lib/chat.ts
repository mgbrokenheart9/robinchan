import type { OrderQuote, PageContext } from '@robinchan/shared';

import type { Mood } from '@/components/live2d/expressions';

/** Wire contract for `POST /api/chat`, shared by the route handler and the chat UI. */

export type ChatHistoryItem = { role: 'user' | 'assistant'; text: string };

export type ChatRequestBody = {
  message: string;
  /**
   * Recent turns, oldest first — only used when signed out. A signed-in
   * wallet's history lives on the server and this is ignored.
   */
  history: ChatHistoryItem[];
  /** Skip text-to-speech when the viewer has muted her. */
  voice: boolean;
  /** Which page the message was sent from; the server looks up the rest. */
  context?: PageContext;
};

export type ChatResponseBody = {
  reply: string;
  mood: Mood;
  voice: {
    audio: string;
    mime: 'audio/mpeg';
    alignment: { chars: string[]; starts: number[] };
  } | null;
  /** Why `voice` is null when it was asked for — shown as a status note, the text still plays. */
  voiceNote?: string;
  /**
   * An order preview built from the message through the same pipeline the
   * Trade page uses — rendered as `<OrderPreviewCard>` under the reply.
   */
  order?: OrderQuote | null;
};

export type ChatErrorBody = { error: { code: string; message: string } };

export const CHAT_MAX_MESSAGE = 1000;
export const CHAT_MAX_HISTORY = 12;
