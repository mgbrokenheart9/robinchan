'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Image from 'next/image';
import Link from 'next/link';

import { TierCards } from '@/components/chat/TierCards';
import { ChatOrder } from '@/components/companion/CompanionDock';
import {
  useCompanionChat,
  type ChatNote,
  type ChatPhase,
  type Speaker,
} from '@/components/chat/useCompanionChat';
import { STAGE_BACKGROUNDS, type StageBackgroundId } from '@/components/effects/StageBackdrop';
import {
  BackgroundIcon,
  CloseIcon,
  HomeIcon,
  SendIcon,
  SmileIcon,
  TiersIcon,
  VoiceOffIcon,
  VoiceOnIcon,
} from '@/components/icons';
import { MOODS, MOOD_GLOW, MOOD_LABEL, type Mood } from '@/components/live2d/expressions';
import type { StageStatus } from '@/components/live2d/Live2DCanvas';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Pill, cx } from '@/components/ui';
import { CHAT_MAX_MESSAGE } from '@/lib/chat';
import { chatServerSnapshot, chatSnapshot, subscribeChat } from '@/lib/chatStore';

/**
 * Everything that floats over the full-screen Live2D stage on `/robinchan`:
 * a Home button top-left, Expression / Background / Tiers top-right, her
 * reply in a speech bubble beside her, and the composer pinned to the
 * bottom.
 *
 * The root is `pointer-events: none` and each control opts back in, so the
 * empty space still passes the cursor through to the canvas underneath.
 *
 * Each reply comes from MegaLLM through `POST /api/chat` and is spoken with
 * ElevenLabs; the bubble reveals the text in step with her voice (see
 * `useCompanionChat`).
 */

type Panel = 'mood' | 'bg' | null;

const CHIP_MOTION =
  'transition-[transform,border-color] duration-300 ease-soft hover:-translate-y-0.5 hover:border-overlay/25 active:translate-y-0 active:scale-[0.98]';

/** Floating glass pill shared by the top-left and top-right controls. */
const CHIP = cx(
  'card-glass pointer-events-auto flex h-11 items-center gap-2 rounded-full px-3.5 text-[14px] font-medium text-text sm:px-4',
  CHIP_MOTION,
);

/** Icon-only variant of `CHIP` (the theme switch). */
const CHIP_ICON = cx(
  'card-glass pointer-events-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-text',
  CHIP_MOTION,
);

export function ChatOverlay({
  status,
  mood,
  onMood,
  bg,
  onBg,
  speak,
  stopSpeaking,
}: {
  status: StageStatus;
  mood: Mood;
  onMood: (mood: Mood) => void;
  bg: StageBackgroundId;
  onBg: (bg: StageBackgroundId) => void;
  speak: Speaker;
  stopSpeaking: () => void;
}) {
  const chat = useCompanionChat({ speak, stopSpeaking, onMood });
  const [draft, setDraft] = useState('');
  const [panel, setPanel] = useState<Panel>(null);
  const [tiersOpen, setTiersOpen] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);

  const ready = status === 'ready';

  // Popovers close on a click anywhere outside the toolbar, or Escape.
  useEffect(() => {
    if (!panel) return;
    const onPointer = (e: PointerEvent) => {
      if (!toolbarRef.current?.contains(e.target as Node)) setPanel(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPanel(null);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [panel]);

  const toggle = (next: Exclude<Panel, null>) => setPanel((cur) => (cur === next ? null : next));

  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      {/* ---- top bar ---- */}
      <div className="absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 p-4 sm:p-6">
        <Link href="/" className={CHIP} aria-label="Back to Home">
          <HomeIcon width={16} height={16} />
          <span>Home</span>
        </Link>

        <div ref={toolbarRef} className="relative flex items-center gap-2">
          <button
            type="button"
            onClick={() => toggle('mood')}
            aria-expanded={panel === 'mood'}
            aria-controls="panel-mood"
            aria-label="Expression"
            className={CHIP}
          >
            <SmileIcon />
            <span className="hidden sm:inline">Expression</span>
          </button>
          <button
            type="button"
            onClick={() => toggle('bg')}
            aria-expanded={panel === 'bg'}
            aria-controls="panel-bg"
            aria-label="Background"
            className={CHIP}
          >
            <BackgroundIcon />
            <span className="hidden sm:inline">Background</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setPanel(null);
              setTiersOpen(true);
            }}
            aria-label="Tiers"
            className={CHIP}
          >
            <TiersIcon />
            <span className="hidden sm:inline">Tiers</span>
          </button>
          <ThemeToggle base={CHIP_ICON} />

          {panel === 'mood' ? (
            <div id="panel-mood" className={PANEL}>
              <div className="mb-3 flex items-center justify-between gap-3">
                <span className="t-eyebrow">Expression</span>
                <Pill tone={ready ? 'accent' : 'muted'}>
                  {status === 'loading' ? 'loading model' : ready ? MOOD_LABEL[mood] : 'static mode'}
                </Pill>
              </div>
              <div className="flex flex-wrap gap-2">
                {MOODS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    // Interaction is held until the model finishes loading.
                    disabled={!ready}
                    onClick={() => onMood(option)}
                    aria-pressed={mood === option}
                    className={cx(
                      'min-h-[40px] rounded-full border px-4 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-45',
                      mood === option && ready
                        ? 'border-accent-fg/45 bg-accent/[0.1] text-text'
                        : 'border-overlay/10 text-text-2 hover:border-overlay/25 hover:text-text',
                    )}
                  >
                    {MOOD_LABEL[option]}
                  </button>
                ))}
              </div>
              <p className="mt-3.5 text-[12px] leading-relaxed text-text-3">
                She also changes expression on her own to match each reply.
              </p>
            </div>
          ) : null}

          {panel === 'bg' ? (
            <div id="panel-bg" className={PANEL}>
              <span className="t-eyebrow mb-3 block">Choose background</span>
              <div className="flex flex-col gap-2">
                {STAGE_BACKGROUNDS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => onBg(option.id)}
                    aria-pressed={bg === option.id}
                    className={cx(
                      'flex items-center gap-3 rounded-[12px] border p-2 text-left transition-colors',
                      bg === option.id
                        ? 'border-accent-fg/45 bg-accent/[0.08]'
                        : 'border-transparent bg-overlay/[0.04] hover:border-overlay/15 hover:bg-overlay/[0.07]',
                    )}
                  >
                    <Image
                      src={option.poster}
                      alt=""
                      width={56}
                      height={32}
                      className="h-8 w-14 shrink-0 rounded-[6px] border border-overlay/10 object-cover"
                    />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-[13px] font-medium text-text">
                        {option.label}
                      </span>
                      <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-text-3">
                        Video loop
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <SpeechBubble status={status} mood={mood} phase={chat.phase} text={chat.shown} />

      {/* ---- composer ---- */}
      <div className="absolute inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] mx-auto flex max-w-[620px] flex-col items-center gap-3 sm:bottom-8">
        {chat.note ? <StatusNote note={chat.note} /> : null}

        <LatestOrder />

        {chat.lastUser ? (
          <p className="card-glass max-w-[85%] self-end truncate rounded-[16px] rounded-br-[6px] px-3.5 py-2 text-[13px] text-text-2">
            <span className="sr-only">You said: </span>
            {chat.lastUser}
          </p>
        ) : null}

        <form
          className={cx(
            'card-glass pointer-events-auto flex w-full items-center gap-2 rounded-full p-2 sm:gap-2.5',
            'transition-[border-color] duration-300 focus-within:border-overlay/25',
          )}
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim() || chat.phase === 'thinking') return;
            void chat.send(draft);
            setDraft('');
          }}
          aria-label="Send a message"
        >
          <button
            type="button"
            onClick={chat.toggleVoice}
            aria-pressed={chat.voiceOn}
            aria-label="Voice"
            title={chat.voiceOn ? 'Voice on' : 'Voice off: text only'}
            className={cx(
              'flex h-11 w-11 shrink-0 items-center justify-center rounded-full border transition-colors',
              chat.voiceOn
                ? 'border-accent-fg/35 bg-accent/[0.1] text-accent-fg hover:bg-accent/[0.16]'
                : 'border-overlay/10 bg-overlay/[0.05] text-text-3 hover:bg-overlay/10 hover:text-text',
            )}
          >
            {chat.voiceOn ? <VoiceOnIcon /> : <VoiceOffIcon />}
          </button>

          <label htmlFor="chat-input" className="sr-only">
            Write a message to Robinchan
          </label>
          <input
            id="chat-input"
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={CHAT_MAX_MESSAGE}
            autoComplete="off"
            placeholder="Ask Robinchan something…"
            className="min-w-0 flex-1 bg-transparent px-2 text-[14px] text-text placeholder:text-text-3 focus:outline-none sm:text-[15px]"
          />

          <button
            type="submit"
            disabled={!draft.trim() || chat.phase === 'thinking'}
            aria-label="Send"
            className="flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink transition disabled:opacity-45 enabled:hover:scale-105 enabled:hover:shadow-glow-accent"
          >
            <SendIcon />
          </button>
        </form>
      </div>

      <TiersDialog open={tiersOpen} onClose={() => setTiersOpen(false)} />
    </div>
  );
}

/** Popovers hang off the toolbar's right edge, so they never run off-screen left on phones. */
const PANEL =
  'card-glass pointer-events-auto absolute right-0 top-[calc(100%+10px)] w-[min(290px,calc(100vw-32px))] p-4';

/* ------------------------------------------------------------------ */

/**
 * Her latest line, in a cloud beside her head — the demo-style bubble with a
 * trail of three shrinking circles as the tail. While she's speaking the
 * text grows in step with her voice; while she's thinking it shows typing
 * dots. On narrow screens it centres above her instead, tail down.
 */
function SpeechBubble({
  status,
  mood,
  phase,
  text,
}: {
  status: StageStatus;
  mood: Mood;
  phase: ChatPhase;
  text: string;
}) {
  const scroller = useRef<HTMLSpanElement>(null);
  const waiting = status === 'loading' || phase === 'thinking';

  // Long replies scroll inside the bubble; keep the newest words in view.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <div className="absolute inset-x-4 top-[72px] mx-auto max-w-[340px] sm:top-[88px] lg:inset-x-auto lg:left-[calc(50%+6rem)] lg:top-[12%] lg:mx-0 lg:w-[340px] xl:w-[360px] xl:max-w-none">
      <div
        className="card-glass pointer-events-auto relative block w-full animate-float-bubble rounded-[20px] px-4 py-3 text-left transition-[box-shadow] duration-700 sm:rounded-[24px] sm:px-6 sm:py-4"
        style={{
          boxShadow: `var(--glass-shadow)${
            status === 'ready' ? `, ${MOOD_GLOW[mood]}` : ''
          }`,
        }}
      >
        <span className="mb-1.5 flex items-center justify-between gap-3 sm:mb-2">
          <span className="t-eyebrow text-accent-fg">Robinchan</span>
          <span className="font-mono text-[10px] text-text-3">
            {phase === 'thinking' ? 'thinking…' : phase === 'speaking' ? 'speaking' : ''}
          </span>
        </span>

        {waiting ? (
          <span
            className="flex items-center justify-center gap-1.5 py-1.5"
            role="status"
            aria-label={phase === 'thinking' ? 'Robinchan is thinking' : 'Loading'}
          >
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="h-2 w-2 animate-pod-bounce rounded-full bg-text-2"
                style={{ animationDelay: `${i * 0.16}s` }}
              />
            ))}
          </span>
        ) : (
          <span
            ref={scroller}
            aria-hidden
            className="block max-h-[28vh] overflow-y-auto text-[13.5px] leading-relaxed text-text sm:max-h-[34vh] sm:text-[14.5px]"
          >
            {text}
            {phase === 'speaking' ? (
              <span className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[3px] animate-caret-blink rounded-full bg-accent" />
            ) : null}
          </span>
        )}

        {/* The visible text grows a character at a time; announce the reply
            once, whole, instead of on every frame. */}
        <span className="sr-only" aria-live="polite">
          {phase === 'idle' ? text : ''}
        </span>

        <Tail className="-bottom-[15px] h-5 w-5 lg:left-2" />
        <Tail className="-bottom-8 h-[13px] w-[13px] lg:-left-2" />
        <Tail className="-bottom-12 h-2 w-2 lg:-left-[22px]" />
      </div>
    </div>
  );
}

/**
 * When her latest reply came with an order preview, it sits above the
 * composer — the same card, and the same signing path, as everywhere else.
 */
function LatestOrder() {
  const { messages } = useSyncExternalStore(subscribeChat, chatSnapshot, chatServerSnapshot);
  const last = messages.at(-1);
  if (!last || last.role !== 'assistant' || !last.order) return null;
  return (
    <div className="pointer-events-auto max-h-[46vh] w-full max-w-[420px] self-start overflow-y-auto">
      <ChatOrder message={last} className="" />
    </div>
  );
}

/** Errors and voice fallbacks, in the demo's status-note slot above the composer. */
function StatusNote({ note }: { note: ChatNote }) {
  return (
    <p
      role={note.tone === 'error' ? 'alert' : 'status'}
      className="card-glass flex items-center gap-2.5 rounded-[18px] px-4 py-2 text-[12.5px] leading-snug text-text-2"
    >
      <span
        aria-hidden
        className={cx(
          'h-2 w-2 shrink-0 rounded-full',
          note.tone === 'error' ? 'bg-down' : 'bg-companion-pink',
        )}
      />
      {note.text}
    </p>
  );
}

function Tail({ className }: { className: string }) {
  return (
    <span
      aria-hidden
      className={cx(
        'card-glass pointer-events-none absolute left-1/2 -translate-x-1/2 rounded-full lg:translate-x-0',
        className,
      )}
    />
  );
}

/* ------------------------------------------------------------------ */

/**
 * Tier details, moved off the page and into a modal now that the stage
 * takes the whole viewport. Native `<dialog>` gives focus trapping and
 * Escape-to-close for free.
 */
function TiersDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      // A click that lands on the dialog element itself is the backdrop.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-labelledby="tiers-title"
      className="pointer-events-auto m-auto max-h-[88dvh] w-[min(calc(100%-32px),1040px)] overflow-y-auto rounded-card border border-border bg-bg p-0 text-text backdrop:bg-text/40 dark:backdrop:bg-black/70 backdrop:backdrop-blur-sm"
    >
      <div className="p-5 sm:p-8">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <p className="t-eyebrow mb-2.5">Tiers</p>
            <h2 id="tiers-title" className="t-h3">
              What unlocks as your $RCHAN balance grows
            </h2>
            <p className="mt-2 max-w-[520px] text-[12px] leading-relaxed text-text-3">
              Each tier&apos;s threshold is read from your on-chain balance, not a claim made in
              the browser. The threshold values aren&apos;t final yet and are stored as
              configuration.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close tiers"
            className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-text-3 transition-colors hover:text-text"
          >
            <CloseIcon />
          </button>
        </div>

        <TierCards />
      </div>
    </dialog>
  );
}
