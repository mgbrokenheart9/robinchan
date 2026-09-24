'use client';

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';

import { playAudio, type Playback } from '@/lib/audio';

import { CUBISM_CORE_URL, MODEL_URL, MOOD_TO_EXPRESSION, type Mood } from './expressions';

export type Live2DHandle = {
  setExpression: (mood: Mood) => void;
  /**
   * Plays the clip with lip-sync. `onProgress` gets the seconds elapsed on
   * the audio clock each frame — the chat uses it to reveal text in step.
   */
  speak: (audio: AudioBuffer | ArrayBuffer, onProgress?: (elapsedSec: number) => void) => Promise<void>;
  /** Cuts off whatever she's saying and closes her mouth. */
  stopSpeaking: () => void;
  /** Points her head and eyes at a spot in canvas coordinates. */
  lookAt: (x: number, y: number) => void;
};

export type StageStatus = 'loading' | 'ready' | 'unsupported' | 'failed';

/** Lip-sync tuning against measured ElevenLabs loudness (RMS p50 ≈ 0.02, peak ≈ 0.06). */
const MOUTH_GAIN = 14;
const MOUTH_GATE = 0.006;

/**
 * Live2D canvas wrapper (brief §7).
 *
 * Its contract is `setExpression()`, `speak(audio, onProgress)` and
 * `stopSpeaking()`. Lip-sync is driven by the TTS audio's amplitude (brief
 * §5); when TTS is off `speak` is never called and her mouth stays idle — no
 * fake mouth animation running without sound.
 * All the heavy imports (`pixi.js`, `pixi-live2d-display`) happen inside the
 * effect, so other pages' bundles don't carry them — this component is
 * itself also loaded via `next/dynamic` with `ssr: false` from `Live2DStage`.
 */
export function Live2DCanvas({
  handleRef,
  onStatus,
  className,
}: {
  handleRef?: Ref<Live2DHandle | null>;
  onStatus?: (status: StageStatus) => void;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const modelRef = useRef<Live2DModelLike | null>(null);
  const playbackRef = useRef<Playback | null>(null);
  /** Mouth opening (0..1) applied on every model update while she speaks. */
  const mouthRef = useRef(0);
  const [, setReady] = useState(false);

  useImperativeHandle(
    handleRef,
    () => ({
      setExpression(mood: Mood) {
        const model = modelRef.current;
        if (!model) return;
        // Cubism expressions crossfade by weight rather than hard-swapping:
        // the outgoing one fades out over its own FadeOutTime while the
        // incoming one fades in, both applied every frame in the meantime.
        // Clearing the queue first — instead of letting `expression()` push
        // the next one on top of whatever's still fading out — guarantees
        // only ever one expression is blending at a time, so switching back
        // to a mood already seen this session can never end up reading as
        // "stuck" on whichever one had the larger parameter deltas.
        const expressionManager = model.internalModel?.motionManager?.expressionManager;
        expressionManager?.stopAllExpressions?.();
        model.expression?.(MOOD_TO_EXPRESSION[mood]);
      },
      async speak(audio, onProgress) {
        playbackRef.current?.stop();
        const playback = await playAudio(audio, (elapsed, level) => {
          // ElevenLabs speech sits around 0.02–0.06 RMS, so it needs real
          // gain to reach a visibly open mouth. The gate keeps breaths and
          // pauses closed; opening fast and closing a little slower reads as
          // syllables rather than flicker.
          const target = level < MOUTH_GATE ? 0 : Math.min(1, level * MOUTH_GAIN);
          const rate = target > mouthRef.current ? 0.65 : 0.35;
          mouthRef.current += (target - mouthRef.current) * rate;
          onProgress?.(elapsed);
        });
        playbackRef.current = playback;
        await playback.done;
        if (playbackRef.current === playback) playbackRef.current = null;
        mouthRef.current = 0;
      },
      stopSpeaking() {
        playbackRef.current?.stop();
        playbackRef.current = null;
        mouthRef.current = 0;
      },
      lookAt(x: number, y: number) {
        modelRef.current?.focus?.(x, y);
      },
    }),
    [],
  );

  useEffect(() => {
    let disposed = false;
    let app: PixiAppLike | null = null;

    const boot = async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      // WebGL fallback: if the context isn't available, don't even try to
      // load the SDK — the page shows a static image and hides the speak
      // button (brief §5).
      if (!hasWebGL()) {
        onStatus?.('unsupported');
        return;
      }

      try {
        await loadCubismCore();
        const PIXI = await import('pixi.js');
        const { Live2DModel } = await import('pixi-live2d-display/cubism4');

        // PixiJS's ShaderSystem code-generates its uniform-sync functions via
        // `new Function(...)` for speed, and throws in its constructor if
        // that's blocked — which our CSP does in production (brief §15: no
        // `unsafe-eval`). `@pixi/unsafe-eval` is PixiJS's own patch for
        // exactly this: it swaps that codegen for a slower but CSP-safe
        // fallback path. Must run before the `Application`/`Renderer` is
        // constructed, since that's what wires up `ShaderSystem`.
        const { install: installUnsafeEvalPatch } = await import('@pixi/unsafe-eval');
        installUnsafeEvalPatch({ ShaderSystem: PIXI.ShaderSystem });

        // pixi-live2d-display uses PIXI's global ticker to auto-update.
        Live2DModel.registerTicker(PIXI.Ticker);

        if (disposed) return;

        app = new PIXI.Application({
          view: canvas,
          autoStart: true,
          backgroundAlpha: 0,
          antialias: true,
          resolution: Math.min(window.devicePixelRatio || 1, 2),
          autoDensity: true,
          resizeTo: canvas.parentElement ?? undefined,
        }) as unknown as PixiAppLike;

        const model = (await Live2DModel.from(MODEL_URL, {
          autoInteract: false,
          autoUpdate: true,
        })) as unknown as Live2DModelLike;

        if (disposed) {
          model.destroy?.();
          return;
        }

        app.stage.addChild(model as never);
        modelRef.current = model;

        // Lip-sync is written right before the core model updates, inside
        // the SDK's own frame. Cubism restores parameters to their
        // post-motion state every frame, so a value set from outside that
        // loop (a separate rAF) can be wiped before it's ever drawn.
        const applyMouth = () => {
          if (mouthRef.current > 0) {
            model.internalModel?.coreModel?.setParameterValueById?.(
              'ParamMouthOpenY',
              mouthRef.current,
            );
          }
        };
        model.internalModel?.on?.('beforeModelUpdate', applyMouth);
        fit(model, app);

        // Refit whenever the stage box changes size, not on window `resize`:
        // PIXI's `resizeTo` defers its own resize to the next frame, so a
        // window listener here would fit against the previous canvas size.
        // Resizing PIXI first keeps `app.screen` current, and observing the
        // element also catches size changes that aren't window resizes
        // (a stage that mounts at 0×0 inside a hidden pane, for one).
        const parent = canvas.parentElement;
        const observer = new ResizeObserver(() => {
          if (disposed || !app) return;
          app.resize?.();
          fit(model, app);
        });
        if (parent) observer.observe(parent);

        // Track the cursor only while it's over the stage — head movement
        // that follows the cursor across the whole page feels twitchy.
        const onPointerMove = (e: PointerEvent) => {
          const rect = canvas.getBoundingClientRect();
          model.focus?.(e.clientX - rect.left, e.clientY - rect.top);
        };
        const onPointerLeave = () => model.focus?.(-1000, -1000);
        parent?.addEventListener('pointermove', onPointerMove);
        parent?.addEventListener('pointerleave', onPointerLeave);

        // Drawable opacities (which `fit` uses to skip hidden poses) only
        // reflect the model's real state after it has updated at least once,
        // so fit again a couple of frames in — and hold the skeleton up
        // until then, so the refit never shows as a jump.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (disposed) return;
            fit(model, app as PixiAppLike);
            setReady(true);
            onStatus?.('ready');
          }),
        );

        cleanupRef.current = () => {
          observer.disconnect();
          parent?.removeEventListener('pointermove', onPointerMove);
          parent?.removeEventListener('pointerleave', onPointerLeave);
        };
      } catch (err) {
        if (disposed) return;
        console.error('[live2d] failed to load model', err);
        onStatus?.('failed');
      }
    };

    const cleanupRef = { current: null as null | (() => void) };
    void boot();

    return () => {
      disposed = true;
      cleanupRef.current?.();
      playbackRef.current?.stop();
      playbackRef.current = null;
      modelRef.current?.destroy?.();
      modelRef.current = null;
      app?.destroy?.(false, { children: true });
    };
    // Deliberately runs once: the model only reloads via a component remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <canvas ref={canvasRef} className={className} aria-hidden />;
}

/* ------------------------------------------------------------------ */

type PixiAppLike = {
  stage: { addChild: (child: never) => void };
  screen: { width: number; height: number };
  resize?: () => void;
  destroy?: (removeView: boolean, options: { children: boolean }) => void;
};

type Live2DModelLike = {
  width: number;
  height: number;
  scale: { set: (value: number) => void };
  anchor?: { set: (x: number, y: number) => void };
  position: { set: (x: number, y: number) => void };
  expression?: (name: string) => void;
  focus?: (x: number, y: number) => void;
  destroy?: () => void;
  internalModel?: {
    on?: (event: 'beforeModelUpdate', listener: () => void) => void;
    localTransform?: { a: number; d: number; tx: number; ty: number };
    getDrawableBounds?: (
      index: number,
    ) => { x: number; y: number; width: number; height: number };
    coreModel?: {
      setParameterValueById?: (id: string, value: number) => void;
      getDrawableCount?: () => number;
      getDrawableOpacity?: (index: number) => number;
    };
    motionManager?: {
      expressionManager?: {
        stopAllExpressions?: () => void;
      };
    };
  };
};

type Box = { left: number; top: number; right: number; bottom: number };

/**
 * The box the figure's *visible artwork* occupies, in the model's local
 * (unscaled) coordinates.
 *
 * `model.width`/`height` can't be used for this: they come from the
 * model's Live2D canvas, which the author sized for framing, not to the art —
 * on this Zundamon build it ends above her knees, so fitting to it cropped
 * her legs off. Instead this unions the bounds of every drawable mesh that
 * is actually showing (opacity > 0 skips alternate hand/arm poses parked
 * invisible), then maps them through `localTransform` into the same space
 * the model's position and pivot work in.
 */
function artBounds(model: Live2DModelLike): Box | null {
  const im = model.internalModel;
  const core = im?.coreModel;
  const t = im?.localTransform;
  const count = core?.getDrawableCount?.() ?? 0;
  if (!im?.getDrawableBounds || !t || !count) return null;

  const box: Box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (let i = 0; i < count; i++) {
    if ((core?.getDrawableOpacity?.(i) ?? 1) <= 0) continue;
    const b = im.getDrawableBounds(i);
    if (!b.width || !b.height) continue;
    box.left = Math.min(box.left, b.x);
    box.top = Math.min(box.top, b.y);
    box.right = Math.max(box.right, b.x + b.width);
    box.bottom = Math.max(box.bottom, b.y + b.height);
  }
  if (!Number.isFinite(box.left)) return null;

  return {
    left: box.left * t.a + t.tx,
    right: box.right * t.a + t.tx,
    top: box.top * t.d + t.ty,
    bottom: box.bottom * t.d + t.ty,
  };
}

/**
 * The Zundamon model is shown full-body — head to shoes, the whole figure
 * inside the canvas — standing on the stage backdrop rather than cropped.
 *
 * Framed on the measured artwork (`artBounds`), contained like
 * `object-fit: contain` would if we could use it on a WebGL canvas: height
 * binds on the full-screen stage in landscape, width binds on a portrait
 * phone. Local bounds don't change
 * with the model's scale, so repeated fits on resize don't compound.
 */
function fit(model: Live2DModelLike, app: PixiAppLike): void {
  const { width, height } = app.screen;
  const box =
    artBounds(model) ??
    (model.width && model.height
      ? { left: 0, top: 0, right: model.width, bottom: model.height }
      : null);
  if (!box) return;

  const artW = box.right - box.left;
  const artH = box.bottom - box.top;
  /* 5% headroom above her, 3% under her feet — she stands near the floor of
     the frame rather than floating in the middle of it. */
  const scale = Math.min((height * 0.92) / artH, (width * 0.9) / artW);

  model.scale.set(scale);
  model.anchor?.set(0, 0);
  model.position.set(
    width / 2 - ((box.left + box.right) / 2) * scale,
    height * 0.97 - box.bottom * scale,
  );
}

function hasWebGL(): boolean {
  try {
    const probe = document.createElement('canvas');
    return Boolean(
      probe.getContext('webgl2') ??
      probe.getContext('webgl') ??
      probe.getContext('experimental-webgl'),
    );
  } catch {
    return false;
  }
}

let corePromise: Promise<void> | null = null;

function loadCubismCore(): Promise<void> {
  if (typeof window !== 'undefined' && 'Live2DCubismCore' in window) return Promise.resolve();
  if (corePromise) return corePromise;

  corePromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = CUBISM_CORE_URL;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Cubism Core failed to load'));
    document.head.appendChild(script);
  });
  return corePromise;
}
