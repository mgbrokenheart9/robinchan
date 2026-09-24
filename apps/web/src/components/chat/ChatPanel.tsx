'use client';

import { useState } from 'react';

import { Avatar } from '@/components/Avatar';
import { ArrowRightIcon } from '@/components/icons';
import { CardHead, cx } from '@/components/ui';

/**
 * Chat panel on the `/robinchan` page (brief §5).
 *
 * This is the real chat's skeleton — a message list, composer, and a slot
 * for inserting an order card mid-conversation. The SSE connection to
 * `POST /api/chat` and server-side history only ship in M3 alongside SIWE, so
 * the composer is disabled and the reason is stated outright, rather than
 * looking active and silently failing when pressed.
 */

type Message = { id: string; role: 'user' | 'chan'; text: string };

const SEED: Message[] = [
  {
    id: 'm1',
    role: 'chan',
    text: "Hi. I can read out price moves, filings, and news — and help build an order if you want one. Signing is still done from your own wallet.",
  },
  {
    id: 'm2',
    role: 'chan',
    text: 'Full chat goes live in milestone M3, once wallet connect and SIWE are wired up. In the meantime, the Market page is already populated with real data.',
  },
];

export function ChatPanel() {
  const [draft, setDraft] = useState('');

  return (
    <section className="card flex h-full min-h-[560px] flex-col">
      <CardHead
        title="Conversation"
        aside={<span className="font-mono text-[11px] text-text-3">M3</span>}
      />

      <div className="flex-1 space-y-4 overflow-y-auto p-4" role="log" aria-label="Message history">
        {SEED.map((message) => (
          <Bubble key={message.id} message={message} />
        ))}

        {/* Streaming-token cursor: a soft accent blink, not a plain caret. */}
        <div className="flex gap-3 pl-[40px]">
          <span
            className="inline-block h-[15px] w-[2px] animate-caret-blink rounded-full bg-accent"
            aria-hidden
          />
        </div>
      </div>

      <form
        className="border-t border-border-soft p-3"
        onSubmit={(e) => e.preventDefault()}
        aria-label="Send a message"
      >
        <div className="flex items-end gap-2">
          <label htmlFor="chat-input" className="sr-only">
            Write a message to Robinchan
          </label>
          <textarea
            id="chat-input"
            rows={1}
            value={draft}
            disabled
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Chat activates once a wallet is connected (M3)"
            className={cx(
              'min-h-[44px] flex-1 resize-none rounded-panel border border-border bg-surface-2 px-3.5 py-3',
              'text-[14px] text-text placeholder:text-text-3 disabled:cursor-not-allowed disabled:opacity-70',
            )}
          />
          <button
            type="submit"
            disabled
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink transition-shadow disabled:opacity-45 enabled:hover:shadow-glow-pink"
            aria-label="Send"
          >
            <ArrowRightIcon />
          </button>
        </div>
        <p className="mt-2.5 px-1 text-[11px] leading-relaxed text-text-3">
          History is stored on the server, not in the browser, so it stays consistent across
          devices.
        </p>
      </form>
    </section>
  );
}

function Bubble({ message }: { message: Message }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <p className="max-w-[86%] rounded-[16px] rounded-br-[6px] border border-border bg-surface-2 px-3.5 py-2.5 text-[14px] leading-relaxed">
          {message.text}
        </p>
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <Avatar />
      <p className="max-w-[86%] rounded-[16px] rounded-bl-[6px] border border-accent-fg/20 bg-accent/[0.05] px-3.5 py-2.5 text-[14px] leading-relaxed">
        {message.text}
      </p>
    </div>
  );
}
