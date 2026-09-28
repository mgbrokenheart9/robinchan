'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import type { OrderQuote } from '@robinchan/shared';
import { shortAddress } from '@robinchan/shared';

import { Avatar } from '@/components/Avatar';
import { CloseIcon, SendIcon } from '@/components/icons';
import { OrderPreviewCard } from '@/components/orders/OrderPreviewCard';
import { cx } from '@/components/ui';
import { ApiClientError, apiFetch } from '@/lib/api';
import { CHAT_MAX_MESSAGE } from '@/lib/chat';
import {
  chatServerSnapshot,
  chatSnapshot,
  replaceOrder,
  subscribeChat,
  type ChatMessage,
} from '@/lib/chatStore';
import { sendChat } from '@/lib/sendChat';

import { useCompanion } from './CompanionProvider';

/**
 * Robinchan's chat on the dashboard pages (Trade-Heat-Portfolio §2) — the
 * same thread as `/robinchan`, with the page's context attached to each
 * message, opened from the peeking Robinchan's note. Text only here; her
 * voice and full stage live on `/robinchan`.
 *
 * Not rendered on `/market`: that page carries no character likeness
 * (design.md §6).
 */
const PAGE_LABEL: Record<string, string> = {
  heat: 'Heat',
  portfolio: 'Portfolio',
  perps: 'Perps',
  gap: 'Gap',
  check: 'Token Check',
};

export function CompanionDock() {
  const c = useCompanion();
  if (!(c.context.page in PAGE_LABEL)) return null;
  // No avatar button of its own: the peeking Robinchan's "Ask me about it"
  // (and a heat row's "Ask Robinchan") opens the chat.
  // Re-keyed on each "Ask Robinchan", so the new question lands in the composer.
  return c.open ? <Panel key={c.draftSeq} /> : null;
}

function Panel() {
  const c = useCompanion();
  const { messages, loading } = useSyncExternalStore(subscribeChat, chatSnapshot, chatServerSnapshot);
  // "Ask Robinchan" from a heat row arrives with its text ready.
  const [draft, setDraft] = useState(() => c.draft ?? '');
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [messages.length, thinking]);

  const { setOpen } = c;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [setOpen]);

  const send = async () => {
    const message = draft.trim();
    if (!message || thinking) return;
    setDraft('');
    setError(null);
    setThinking(true);
    try {
      await sendChat(message, { context: c.context, voice: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
    } finally {
      setThinking(false);
    }
  };

  const where = PAGE_LABEL[c.context.page] ?? c.context.page;
  // On Token Check the "symbol" is the token's address.
  const subject = c.context.symbol ? (c.context.symbol.startsWith('0x') ? shortAddress(c.context.symbol) : c.context.symbol) : null;

  return (
    <section
      id="companion-panel"
      aria-label="Chat with Robinchan"
      className="fixed bottom-4 right-4 z-40 flex h-[min(580px,calc(100dvh-112px))] w-[min(400px,calc(100vw-32px))] flex-col overflow-hidden rounded-card border border-border bg-surface shadow-[0_32px_80px_-30px_rgba(0,0,0,0.7)] sm:right-6"
    >
      <header className="flex items-center gap-3 border-b border-border-soft px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="font-display text-[15px] font-semibold">Robinchan</p>
          <p className="truncate font-mono text-[11px] text-text-3">
            sees: {where}
            {subject ? ` · ${subject}` : ''}
          </p>
        </div>
        <Link href="/robinchan" className="rounded-full px-2.5 py-1 text-[12px] text-text-3 transition-colors hover:text-text">
          Full view
        </Link>
        <button
          type="button"
          onClick={() => c.setOpen(false)}
          aria-label="Close chat"
          className="-mr-1 flex h-9 w-9 items-center justify-center rounded-full text-text-3 transition-colors hover:text-text"
        >
          <CloseIcon width={18} height={18} />
        </button>
      </header>

      <div ref={list} className="flex-1 space-y-3 overflow-y-auto px-4 py-4" role="log" aria-label="Conversation">
        {loading ? (
          <p className="text-center text-[12px] text-text-3">Loading your conversation…</p>
        ) : messages.length === 0 ? (
          <p className="rounded-panel bg-surface-2 px-4 py-3 text-[13px] leading-relaxed text-text-2">
            I can see the {where} page with you. Ask what a number means, why something is hot, or how
            funding and liquidation work. You decide and sign; I only explain.
          </p>
        ) : (
          messages.map((m) => <Message key={m.id} message={m} />)
        )}
        {thinking ? (
          <div className="flex items-center gap-1.5 pl-1" role="status" aria-label="Robinchan is thinking">
            {[0, 1, 2].map((i) => (
              <span key={i} className="h-1.5 w-1.5 animate-pod-bounce rounded-full bg-text-3" style={{ animationDelay: `${i * 0.16}s` }} />
            ))}
          </div>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="border-t border-border-soft px-4 py-2 text-[12px] text-down">
          {error}
        </p>
      ) : null}

      <form
        className="flex items-center gap-2 border-t border-border-soft p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label htmlFor="companion-input" className="sr-only">
          Message Robinchan
        </label>
        <input
          ref={input}
          id="companion-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={CHAT_MAX_MESSAGE}
          autoComplete="off"
          placeholder={`Ask about ${subject ?? where}…`}
          className="min-h-[44px] min-w-0 flex-1 rounded-full border border-border bg-surface-2 px-4 text-[14px] text-text placeholder:text-text-3 focus:border-text-3 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!draft.trim() || thinking}
          aria-label="Send"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink transition disabled:opacity-45"
        >
          <SendIcon width={18} height={18} />
        </button>
      </form>
    </section>
  );
}

function Message({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-[16px] rounded-br-[6px] border border-border bg-surface-2 px-3.5 py-2 text-[13.5px] leading-relaxed text-text">
          {message.text}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex gap-2.5">
        <Avatar height={36} />
        <p
          className={cx(
            'max-w-[85%] rounded-[16px] rounded-bl-[6px] border px-3.5 py-2 text-[13.5px] leading-relaxed text-text',
            message.notice ? 'border-warning/40 bg-warning/[0.07]' : 'border-accent-fg/20 bg-accent/[0.05]',
          )}
        >
          {message.text}
        </p>
      </div>
      {message.order ? <ChatOrder message={message} /> : null}
    </div>
  );
}

/**
 * An order card inside the chat. "Refresh price" re-quotes the same intent
 * through the same pipeline — the card never edits a number itself.
 */
export function ChatOrder({ message, className = 'ml-8' }: { message: ChatMessage; className?: string }) {
  const [error, setError] = useState<string | null>(null);
  if (!message.order) return null;
  const requote = async () => {
    setError(null);
    try {
      const { data } = await apiFetch<OrderQuote>('/api/order/quote', {
        json: { intent: message.order?.intent, source: 'chat' },
      });
      replaceOrder(message.id, data);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't refresh the price.");
    }
  };
  return (
    <div className={className}>
      <OrderPreviewCard key={message.order.id} quote={message.order} onRequote={() => void requote()} />
      {error ? (
        <p role="alert" className="mt-2 text-[12px] text-down">
          {error}
        </p>
      ) : null}
    </div>
  );
}
