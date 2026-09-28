'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { HeatScore, MarketIndex, PerpMarket } from '@robinchan/shared';
import { formatPrice } from '@robinchan/shared';

import { VOICE_STORAGE_KEY, revealer } from '@/components/chat/useCompanionChat';
import { ArrowRightIcon, CloseIcon } from '@/components/icons';
import type { Live2DHandle, StageStatus } from '@/components/live2d/Live2DCanvas';
import { cx } from '@/components/ui';
import { getEnvelope } from '@/lib/api';
import { base64ToArrayBuffer, unlockAudio } from '@/lib/audio';
import type { ChatErrorBody, ChatResponseBody } from '@/lib/chat';

import { useCompanion } from './CompanionProvider';

/** Same lazy, client-only load as the `/robinchan` stage — PixiJS stays out of the page bundle. */
const Live2DCanvas = dynamic(
  () => import('@/components/live2d/Live2DCanvas').then((m) => m.Live2DCanvas),
  { ssr: false, loading: () => null },
);

/**
 * Desktop only. The margin right of the 1112px content column is ~220px at
 * 1800 but shrinks toward nothing near 1280, so she comes in three sizes
 * (see the `min-[1600px]` / `min-[1800px]` classes below) and the bubble
 * clears itself after `BUBBLE_MS` — on narrower screens it can overlap the
 * content's edge and mustn't sit there for good.
 */
const WIDE_QUERY = '(min-width: 1280px)';

/** How long the greeting stays up (paused while hovered). */
const BUBBLE_MS = 14_000;

/** Where she's been dragged to (px lifted from the bottom), kept across pages and visits. */
const LIFT_KEY = 'robinchan.peek-lift';

/** Keep her head clear of the 76px topbar... */
const TOP_LIMIT = 84;
/** ...and at least this much of her on screen when dragged down. */
const MIN_VISIBLE = 240;
/** Pointer travel before a press counts as a drag rather than a tap. */
const DRAG_SLOP = 4;
/** Arrow-key step when moving her from the keyboard. */
const KEY_STEP = 32;

const ASK_LINK =
  'mt-3 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-accent-fg hover:underline';

/** `ask` seeds the chat composer when the viewer taps "Ask me about it". */
type Greeting = { title: string; text: string; ask: string };

/**
 * One greeting per page. `load` turns the page's own live data into a line
 * about what's actually on screen; `fallback` shows until it arrives, or
 * if it can't. `minWidth` keeps her off a page until the margin right of
 * its content can hold her and her note.
 */
const PAGES: Record<
  string,
  { fallback: Greeting; load?: () => Promise<Greeting | null>; minWidth?: number }
> = {
  '/market': {
    fallback: {
      title: 'Welcome to the market!',
      text: 'Index prices, filings, news, and live TV all sit on this one screen. Anything that looks odd, just ask me.',
      ask: "What's moving the market today?",
    },
    load: async () => {
      const env = await getEnvelope<MarketIndex[]>('/api/market/indices', []);
      const indices = env.data.filter((i) => i.symbol !== 'RCHAN');
      if (indices.length === 0) return null;
      const red = indices.filter((i) => i.changePct < 0).length;
      const mover = [...indices].sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))[0]!;
      const mood =
        red === indices.length
          ? 'Rough day — every index is red.'
          : red === 0
            ? 'Green across the board today!'
            : `${red} of ${indices.length} indices ${red === 1 ? 'is' : 'are'} in the red.`;
      const move = `${mover.name} ${mover.changePct < 0 ? 'is down' : 'is up'} ${Math.abs(mover.changePct).toFixed(2)}%`;
      return {
        title: 'Market pulse',
        text: `${mood} ${move}, the biggest move. News, filings, and live TV are right below.`,
        ask: `Why is the ${mover.name} ${mover.changePct < 0 ? 'down' : 'up'} today?`,
      };
    },
  },
  '/heat': {
    fallback: {
      title: "What's hot?",
      text: 'This board ranks what everyone is watching — blending on-chain flow, news, and social buzz into one score.',
      ask: 'How is the heat score worked out?',
    },
    load: async () => {
      const env = await getEnvelope<HeatScore[]>('/api/heat?limit=1', []);
      const top = env.data[0];
      if (!top) return null;
      return {
        title: "What's hot?",
        text: `${top.symbol} is the hottest name right now, with a heat score of ${Math.round(top.score)}. The score blends on-chain flow, news, and social buzz.`,
        ask: `Why is ${top.symbol} so hot right now?`,
      };
    },
  },
  '/perps': {
    // The order ticket is the content's right column and sits above her, so
    // narrower than this she'd be all but hidden behind it.
    minWidth: 1600,
    fallback: {
      title: 'Perps on Robinhood Chain',
      text: 'Long or short crypto and US stocks, priced by Chainlink and settled on chain in your own wallet. Pick a market on the board to start.',
      ask: 'How does a perps position work here?',
    },
    load: async () => {
      const env = await getEnvelope<PerpMarket[]>('/api/perps/markets', []);
      const priced = (symbol: string) =>
        env.data.find((m) => m.symbol === symbol && m.price != null);
      const btc = priced('BTC');
      const eth = priced('ETH');
      if (!btc || !eth) return null;
      const stocks = env.data.filter((m) => m.category === 'stocks' && m.status !== 'unavailable');
      const session = stocks.length
        ? stocks.some((m) => m.status === 'open')
          ? 'The US stock markets are open too.'
          : 'The stock markets are closed right now, so those wait for the next session.'
        : '';
      return {
        title: 'Perps pulse',
        text: `Chainlink has BTC at $${formatPrice(btc.price)} and ETH at $${formatPrice(eth.price)}. ${session}`.trim(),
        ask: 'How does a perps position work here?',
      };
    },
  },
  '/portfolio': {
    fallback: {
      title: 'Your portfolio',
      text: "This is your wallet, read straight from the chain. Connect it and I'll show your holdings, value over time, and PnL.",
      ask: 'How do I read my portfolio page?',
    },
  },
};

function pageFor(pathname: string | null): string | null {
  if (!pathname) return null;
  return Object.keys(PAGES).find((p) => pathname === p || pathname.startsWith(`${p}/`)) ?? null;
}

function subscribeWidth(onChange: () => void) {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}

function subscribeWide(onChange: () => void) {
  const mq = window.matchMedia(WIDE_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

function readLift(): number {
  try {
    const n = Number(window.localStorage.getItem(LIFT_KEY));
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function saveLift(lift: number) {
  try {
    window.localStorage.setItem(LIFT_KEY, String(lift));
  } catch {
    /* Position just isn't remembered next time. */
  }
}

/**
 * Clamp a lift so her head stays below the topbar and enough of her stays
 * on screen. `figTop` is where the figure's top edge sat at lift `from`.
 */
function clampLift(next: number, from: number, figTop: number): number {
  const max = from + (figTop - TOP_LIMIT);
  const min = from - (window.innerHeight - MIN_VISIBLE - figTop);
  return Math.round(Math.min(max, Math.max(min, next)));
}

/**
 * Robinchan peeking in from the right edge of the dashboard (Market, Heat,
 * Perps, Portfolio): the same Live2D model as `/robinchan`, leaning in from off
 * screen with a smile and a little nod (CSS), and dropping a one-line read
 * of the page in a bubble above her head.
 *
 * No body motion: every motion in this Zundamon build also drives the face
 * (wide white "shocked" eyes) and is authored `Loop: true`, so the wave
 * reads as panic and never stops.
 *
 * Mounted once in the dashboard shell, so moving between those pages keeps
 * the model loaded — she ducks out and peeks back in with a new line rather
 * than reloading. Decorative apart from the bubble, so the figure ignores
 * the pointer and never blocks the page under it. The × closes her note;
 * she stays, and a tap on her brings it back.
 *
 * Works alongside `<CompanionDock>`: where the dock exists (Heat, Perps,
 * Portfolio) "Ask me about it" opens its chat with the question seeded;
 * on Market, which has no dock, it goes to `/robinchan`. She ducks out
 * while the dock's chat panel is open, since it covers this corner.
 */
/** The box she and her note are placed in, per breakpoint. */
const FRAME =
  'pointer-events-none fixed right-0 h-[570px] w-[250px] min-[1600px]:h-[630px] min-[1600px]:w-[285px] min-[1800px]:h-[640px] min-[1800px]:w-[320px]';

/** Pages where `<CompanionDock>` renders its chat panel. */
const DOCKED = new Set(['/heat', '/perps', '/portfolio']);

export function PeekingCompanion() {
  const companion = useCompanion();
  const pathname = usePathname();
  const page = pageFor(pathname);
  const wide = useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => false,
  );
  const width = useSyncExternalStore(
    subscribeWidth,
    () => window.innerWidth,
    () => 0,
  );

  const handle = useRef<Live2DHandle | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [boot, setBoot] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  /** Which page she has currently peeked in on — lags `page` so she ducks out first. */
  const [shownFor, setShownFor] = useState<string | null>(null);
  const [bubbleFor, setBubbleFor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{ page: string; greeting: Greeting } | null>(null);
  const [hovered, setHovered] = useState(false);
  /** What she said when last tapped — the screen, read out — shown in place of the page's greeting. */
  const [look, setLook] = useState<{ page: string; turn: number; phase: 'looking' | 'speaking' | 'done'; text: string; ask: string } | null>(null);
  /** Bumped on every tap, page change and close, so a reply that lands late is dropped. */
  const lookTurn = useRef(0);
  /** Vertical position: px lifted above the default bottom-docked spot. */
  const [lift, setLift] = useState(() => (typeof window === 'undefined' ? 0 : readLift()));
  const [dragging, setDragging] = useState(false);
  /** 'side' when she's been lifted too high for the bubble to fit above her head. */
  const [placement, setPlacement] = useState<'above' | 'side'>('above');
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ y: number; lift: number; figTop: number; moved: boolean } | null>(null);

  const roomy = !page || width >= (PAGES[page]?.minWidth ?? 0);
  const active = Boolean(page && wide && roomy);

  // Hold the model back until the page itself has settled.
  useEffect(() => {
    if (!active || boot) return;
    const t = window.setTimeout(() => setBoot(true), 1200);
    return () => window.clearTimeout(t);
  }, [active, boot]);

  // Live data for the bubble, fetched once per page visit.
  useEffect(() => {
    if (!page || !active) return;
    const load = PAGES[page]?.load;
    if (!load) return;
    let cancelled = false;
    load()
      .then((greeting) => {
        if (!cancelled && greeting) setLoaded({ page, greeting });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [page, active]);

  // Peek in (after ducking out from the previous page), smile, then talk.
  useEffect(() => {
    if (!ready || !active || !page) return;
    const timers = [
      window.setTimeout(() => {
        setShownFor(page);
        handle.current?.setExpression('happy');
        // Look back toward the page content, up and to her left.
        const box = stageRef.current?.getBoundingClientRect();
        if (box) handle.current?.lookAt(0, box.height * 0.2);
      }, 450),
      window.setTimeout(() => setBubbleFor(page), 1300),
    ];
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [ready, active, page]);

  // A brief hello, not a banner: the bubble clears itself unless hovered —
  // or while she's still looking at the screen or reading it out.
  const reading = Boolean(look && look.page === page && look.phase !== 'done');
  useEffect(() => {
    if (!page || bubbleFor !== page || hovered || reading) return;
    const t = window.setTimeout(() => setBubbleFor(null), BUBBLE_MS);
    return () => window.clearTimeout(t);
  }, [bubbleFor, page, hovered, reading]);

  // A new page: she stops reading out the last one (its note is tied to that page and stays hidden).
  useEffect(() => {
    lookTurn.current += 1;
    handle.current?.stopSpeaking();
  }, [page]);

  // Eyes and head follow the cursor anywhere on the page, not just over
  // her — the canvas itself is click-through, so it never sees the pointer.
  useEffect(() => {
    if (!ready) return;
    let frame = 0;
    let last: { x: number; y: number } | null = null;
    const aim = () => {
      frame = 0;
      const canvas = stageRef.current?.querySelector('canvas');
      if (!canvas || !last) return;
      const r = canvas.getBoundingClientRect();
      handle.current?.lookAt(last.x - r.left, last.y - r.top);
    };
    const onMove = (e: PointerEvent) => {
      last = { x: e.clientX, y: e.clientY };
      if (!frame) frame = window.requestAnimationFrame(aim);
    };
    // Cursor left the window: look back toward the page content.
    const onLeave = () => {
      const box = stageRef.current?.getBoundingClientRect();
      if (box) handle.current?.lookAt(0, box.height * 0.2);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    return () => {
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [ready]);

  /** Bubble goes beside her head when there's no room left above it. */
  const updatePlacement = () => {
    const top = wrapRef.current?.getBoundingClientRect().top ?? Infinity;
    setPlacement(top < TOP_LIMIT - 8 ? 'side' : 'above');
  };

  // Re-clamp after a window resize (a shorter window can push her head
  // under the topbar) and re-pick the bubble side.
  useEffect(() => {
    if (!boot) return;
    const onResize = () => {
      const figTop = stageRef.current?.getBoundingClientRect().top;
      if (figTop != null) setLift((cur) => clampLift(cur, cur, figTop));
      window.requestAnimationFrame(updatePlacement);
    };
    const t = window.setTimeout(onResize, 0);
    window.addEventListener('resize', onResize);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('resize', onResize);
    };
  }, [boot]);

  const moveTo = (next: number) => {
    setLift(next);
    window.requestAnimationFrame(updatePlacement);
  };

  const onGrab = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const figTop = stageRef.current?.getBoundingClientRect().top ?? 0;
    drag.current = { y: e.clientY, lift, figTop, moved: false };
  };

  const onDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const dy = d.y - e.clientY;
    if (!d.moved && Math.abs(dy) < DRAG_SLOP) return;
    if (!d.moved) {
      d.moved = true;
      setDragging(true);
    }
    moveTo(clampLift(d.lift + dy, d.lift, d.figTop));
  };

  const onDrop = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved) {
      setDragging(false);
      saveLift(lift);
    } else {
      // A tap, not a drag: she reads the screen — or stops, if she's at it.
      void readScreen();
    }
  };

  /**
   * She looks at what's on screen — the page's live figures, looked up by
   * the server (/api/companion/look) — and says it in her own voice, the
   * bubble filling in as she speaks. A second tap while she's at it stops her.
   */
  const readScreen = async () => {
    if (!page) return;
    if (look && look.page === page && look.phase !== 'done') {
      stopReading();
      return;
    }
    const turn = ++lookTurn.current;
    let voiceOn = true;
    try {
      voiceOn = window.localStorage.getItem(VOICE_STORAGE_KEY) !== 'off';
    } catch {
      /* the default: she speaks */
    }
    // Inside the tap, before any await, or the browser won't let her speak later.
    if (voiceOn) unlockAudio();
    handle.current?.stopSpeaking();
    handle.current?.setExpression('focused');
    setBubbleFor(page);
    setLook({ page, turn, phase: 'looking', text: 'Let me take a look…', ask: '' });
    // A reply that lands after a newer tap, a page change or a close: this tap's note is over.
    const settle = () => setLook((cur) => (cur && cur.turn === turn && cur.phase !== 'done' ? { ...cur, phase: 'done' } : cur));

    let data: ChatResponseBody | ChatErrorBody | null = null;
    let ok = false;
    try {
      const res = await fetch('/api/companion/look', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ context: companion.context, voice: voiceOn }),
      });
      data = (await res.json().catch(() => null)) as ChatResponseBody | ChatErrorBody | null;
      ok = res.ok;
    } catch {
      /* below */
    }
    if (turn !== lookTurn.current) return settle();
    if (!ok || !data || 'error' in data) {
      const why = data && 'error' in data ? data.error.message : "I couldn't reach the server just now.";
      setLook({ page, turn, phase: 'done', text: why, ask: '' });
      return;
    }

    const reply = data;
    const ask = 'Tell me more about what’s on my screen.';
    handle.current?.setExpression(reply.mood);
    if (reply.voice && handle.current) {
      setLook({ page, turn, phase: 'speaking', text: '', ask });
      const reveal = revealer(reply.reply, reply.voice.alignment);
      try {
        await handle.current.speak(base64ToArrayBuffer(reply.voice.audio), (elapsed) => {
          if (turn === lookTurn.current) setLook((cur) => (cur ? { ...cur, text: reveal(elapsed) } : cur));
        });
      } catch {
        /* her voice couldn't play: the text shows in full below */
      }
    }
    if (turn !== lookTurn.current) return settle();
    setLook({ page, turn, phase: 'done', text: reply.reply, ask });
  };

  const stopReading = () => {
    lookTurn.current += 1;
    handle.current?.stopSpeaking();
    setLook((cur) => (cur ? { ...cur, phase: 'done' } : cur));
  };

  const onKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void readScreen();
      return;
    }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const figTop = stageRef.current?.getBoundingClientRect().top ?? 0;
    const next = clampLift(lift + (e.key === 'ArrowUp' ? KEY_STEP : -KEY_STEP), lift, figTop);
    moveTo(next);
    saveLift(next);
  };

  // The × closes her note (and stops her reading it), not her: a tap on her brings it back.
  const dismiss = () => {
    stopReading();
    setBubbleFor(null);
  };

  const onStatus = (status: StageStatus) => {
    if (status === 'ready') setReady(true);
    if (status === 'failed' || status === 'unsupported') setFailed(true);
  };

  if (!boot || failed) return null;

  const peeking = active && shownFor === page && !companion.open;
  const talking = peeking && bubbleFor === page;
  const pageGreeting = page && loaded?.page === page ? loaded.greeting : page ? PAGES[page]!.fallback : null;
  const greeting: Greeting | null =
    look && look.page === page
      ? {
          title: look.phase === 'looking' ? 'Looking…' : 'On your screen',
          text: look.text || '…',
          ask: look.ask || pageGreeting?.ask || 'What am I looking at?',
        }
      : pageGreeting;

  return (
    <>
      {/* Two layers in one frame: the figure under the page content that
        asks for it (Perps lifts its content to z-21, so the ticket always
        takes the click), her note above everything. Docked to the right
        edge; only the height moves when she's dragged. */}
      <div ref={wrapRef} className={cx(FRAME, 'z-20')} style={{ bottom: lift }}>
        {/* The figure: leaning in from past the right edge, feet below the
          fold. Sized per breakpoint; the canvas refits on resize. */}
        <div
          ref={stageRef}
          className="peek-figure absolute -bottom-[90px] right-0 h-[500px] w-[290px] min-[1600px]:-bottom-[100px] min-[1600px]:h-[560px] min-[1600px]:w-[325px] min-[1800px]:-bottom-[110px] min-[1800px]:h-[620px] min-[1800px]:w-[360px]"
          data-state={peeking ? 'in' : 'out'}
        >
          <Live2DCanvas handleRef={handle} onStatus={onStatus} className="h-full w-full" />
          {/* Grab handle over her head and body: press-and-drag moves her up
            or down the right edge, a plain tap toggles her note, arrow
            keys move her from the keyboard. Everything else about the
            figure stays click-through so it never blocks the page. */}
          {peeking ? (
            <button
              type="button"
              onPointerDown={onGrab}
              onPointerMove={onDrag}
              onPointerUp={onDrop}
              onPointerCancel={onDrop}
              onLostPointerCapture={onDrop}
              onKeyDown={onKey}
              aria-label="Robinchan: tap and she reads your screen out loud; drag or use the arrow keys to move her"
              className={cx(
                'pointer-events-auto absolute left-[6%] top-[4%] h-[52%] w-[52%] touch-none rounded-[40%]',
                dragging ? 'cursor-grabbing' : 'cursor-grab',
              )}
            />
          ) : null}
        </div>
      </div>

      {greeting ? (
        <div className={cx(FRAME, 'z-[22]')} style={{ bottom: lift }} aria-live="polite">
          <div
            className={cx(
              'peek-bubble card-glass absolute w-[218px] rounded-[20px] px-4 pb-4 pt-3.5 min-[1600px]:w-[236px] min-[1800px]:w-[252px]',
              // Above her head by default; beside it (to her left) when she's
              // been lifted too high for the bubble to fit under the topbar.
              placement === 'above'
                ? 'right-[10px] top-[8px] min-[1800px]:right-[16px]'
                : 'right-[150px] top-[180px] min-[1600px]:right-[168px] min-[1600px]:top-[190px] min-[1800px]:right-[190px] min-[1800px]:top-[150px]',
            )}
            data-state={talking ? 'in' : 'out'}
            data-placement={placement}
            role="status"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
          >
            <div className="mb-1.5 flex items-center justify-between gap-3">
              <span className="t-eyebrow text-accent-fg">{greeting.title}</span>
              <button
                type="button"
                onClick={dismiss}
                aria-label="Close Robinchan's note"
                className="-mr-1.5 flex h-7 w-7 items-center justify-center rounded-full text-text-3 transition-colors hover:bg-overlay/[0.06] hover:text-text"
              >
                <CloseIcon width={14} height={14} />
              </button>
            </div>
            <p className="text-[13px] leading-[1.5] text-text min-[1800px]:text-[13.5px]">
              {greeting.text}
            </p>
            {page && DOCKED.has(page) ? (
              <button
                type="button"
                onClick={() => companion.ask(greeting.ask)}
                className={ASK_LINK}
              >
                Ask me about it
                <ArrowRightIcon width={13} height={13} />
              </button>
            ) : (
              <Link href="/robinchan" className={ASK_LINK}>
                Ask me about it
                <ArrowRightIcon width={13} height={13} />
              </Link>
            )}
            {/* Tail pointing at her head: down, or right when beside her. */}
            <span aria-hidden className="peek-bubble-tail" />
          </div>
        </div>
      ) : null}
    </>
  );
}
