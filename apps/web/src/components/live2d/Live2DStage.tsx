'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ChatOverlay } from '@/components/chat/ChatOverlay';
import {
  STAGE_BACKGROUNDS,
  StageBackdrop,
  type StageBackgroundId,
} from '@/components/effects/StageBackdrop';
import { PodIcon } from '@/components/icons';
import { playAudio, type Playback } from '@/lib/audio';

import type { Mood } from './expressions';
import type { Live2DHandle, StageStatus } from './Live2DCanvas';

/**
 * The SDK loads dynamically with `ssr: false` so other pages' bundles don't
 * carry it (brief §5).
 */
const Live2DCanvas = dynamic(() => import('./Live2DCanvas').then((m) => m.Live2DCanvas), {
  ssr: false,
  loading: () => null,
});

const BG_STORAGE_KEY = 'robinchan.stage-bg';

/**
 * Live2D stage (brief §5), full-screen: the video backdrop and the model
 * fill the viewport, and `<ChatOverlay>` floats every control on top. The
 * overlay is `pointer-events: none` apart from its own controls, so the
 * cursor still reaches the canvas and her head keeps following it.
 * Interaction is held until the model finishes loading, and a skeleton —
 * not a blank screen — shows while it waits.
 */
export function Live2DStage() {
  const handle = useRef<Live2DHandle | null>(null);
  const [status, setStatus] = useState<StageStatus>('loading');
  const [mood, setMood] = useState<Mood>('relaxed');
  const [bg, setBg] = useState<StageBackgroundId>('valley');

  // The picked background is a per-viewer convenience, so it lives in
  // localStorage — read after mount to keep SSR and first paint in sync, and
  // wrapped because storage can be blocked or throw.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(BG_STORAGE_KEY);
      if (STAGE_BACKGROUNDS.some((b) => b.id === saved)) setBg(saved as StageBackgroundId);
    } catch {
      /* Storage unavailable — keep the default. */
    }
  }, []);

  const pickBg = (next: StageBackgroundId) => {
    setBg(next);
    try {
      window.localStorage.setItem(BG_STORAGE_KEY, next);
    } catch {
      /* Not persisted; the choice still applies for this visit. */
    }
  };

  const ready = status === 'ready';
  const noWebGL = status === 'unsupported' || status === 'failed';

  // The model boots with no expression applied at all — `mood` defaults to
  // 'relaxed' as a UI label, but nothing has told the model to actually show
  // it yet. Apply it for real the moment the stage is ready, once.
  useEffect(() => {
    if (ready) handle.current?.setExpression(mood);
    // Only ever meant to fire on the ready transition, not on every mood change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // Without a model (no WebGL, or it failed to load) she still talks — the
  // clip plays on its own and the text follows it; there's just no mouth.
  const fallback = useRef<Playback | null>(null);

  const speak = useCallback(async (audio: ArrayBuffer, onProgress: (sec: number) => void) => {
    const live = handle.current;
    if (live) return live.speak(audio, onProgress);
    fallback.current?.stop();
    const playback = await playAudio(audio, (elapsed) => onProgress(elapsed));
    fallback.current = playback;
    await playback.done;
  }, []);

  const stopSpeaking = useCallback(() => {
    handle.current?.stopSpeaking();
    fallback.current?.stop();
    fallback.current = null;
  }, []);

  const pick = (next: Mood) => {
    // Re-clicking the mood that's already showing would still clear and
    // re-push the same expression (see Live2DCanvas's `setExpression`) —
    // harmless, but skip the no-op work.
    if (next === mood) return;
    setMood(next);
    handle.current?.setExpression(next);
  };

  return (
    <div className="relative h-full w-full">
      <StageBackdrop active={bg} className="absolute inset-0" />

      {/* Edge vignette only — the centre, where she stands, stays untreated
          (see StageBackdrop). It darkens the corners and the bottom strip
          that the floating glass controls sit on, so they read over any
          frame of the footage. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 75% 70% at 50% 42%, rgb(var(--c-bg) / 0) 55%, rgb(var(--c-bg) / 0.55) 100%), linear-gradient(to top, rgb(var(--c-bg) / 0.6) 0%, rgb(var(--c-bg) / 0) 24%)',
        }}
      />

      <div className="absolute inset-0">
        {noWebGL ? (
          <StaticFallback reason={status} />
        ) : (
          <Live2DCanvas handleRef={handle} onStatus={setStatus} className="h-full w-full" />
        )}
        {status === 'loading' ? <StageSkeleton /> : null}
      </div>

      <ChatOverlay
        status={status}
        mood={mood}
        onMood={pick}
        bg={bg}
        onBg={pickBg}
        speak={speak}
        stopSpeaking={stopSpeaking}
      />
    </div>
  );
}

/**
 * A skeleton that breathes in accent color, not gray — the stage should
 * already feel alive before the model arrives. Three dots arranged like an
 * edamame pod, not a generic spinner (design.md §5).
 */
function StageSkeleton() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-5">
      <div className="h-[168px] w-[120px] animate-breathe rounded-[60px] bg-accent/25" />
      <div className="flex items-end gap-1.5" role="status" aria-label="Loading model">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 animate-pod-bounce rounded-full bg-accent"
            style={{ animationDelay: `${i * 0.16}s` }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Fallback without WebGL (brief §5): a static character image, speak button
 * hidden.
 *
 * The `.moc3` file isn't an image, and the raw texture is just an atlas of
 * body-part cutouts, so nothing in the model package can be used as-is. Until
 * a proper static render of Zundamon is available separately, this slot gets
 * an honest placeholder — and its path stays in one place, swapped alongside
 * the model.
 */
function StaticFallback({ reason }: { reason: StageStatus }) {
  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
      <span className="flex h-[92px] w-[92px] items-center justify-center rounded-full border border-border bg-surface text-accent-fg">
        <PodIcon width={38} height={38} />
      </span>
      <p className="text-on-media max-w-[320px] text-[13px] leading-relaxed text-text-2">
        {reason === 'unsupported'
          ? "This browser doesn't provide WebGL, so the model can't be drawn."
          : "The model failed to load. The asset may be incomplete, or Cubism Core couldn't be fetched."}{' '}
        Chat and market data keep working as usual.
      </p>
    </div>
  );
}
