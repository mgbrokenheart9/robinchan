/**
 * Expression map (brief §5): `happy`, `focused`, `alert`, `relaxed`.
 *
 * The names on the left are the product contract — used by UI buttons and
 * later triggered by LLM replies in M3. The names on the right are entries
 * inside the currently installed asset's `model3.json`. This separation is
 * what lets the model be swapped via `NEXT_PUBLIC_LIVE2D_MODEL_URL` without
 * touching page code.
 */
export const MOODS = ['happy', 'focused', 'alert', 'relaxed'] as const;

export type Mood = (typeof MOODS)[number];

export const MOOD_TO_EXPRESSION: Record<Mood, string> = {
  happy: 'exp_smile',
  focused: 'exp_03',
  alert: 'exp_surprise',
  // Not `exp_sleep`: that file selects the same `ParamEyeType4` eye shape as
  // `exp_03` (focused), so the two ended up looking almost identical —
  // `exp_relaxed` is a small custom expression added alongside the asset
  // (apps/web/public/live2d/zundamon/expressions/exp_relaxed.exp3.json)
  // that softens the brows and half-closes the eyes without touching any
  // eye-shape toggle another mood already uses.
  relaxed: 'exp_relaxed',
};

export const MOOD_LABEL: Record<Mood, string> = {
  happy: 'Happy',
  focused: 'Focused',
  alert: 'Alert',
  relaxed: 'Relaxed',
};

/**
 * Subtle shift in stage-frame glow color/intensity per expression
 * (design.md §5). Deliberately small — this is an ambient detail, not a
 * signal.
 */
export const MOOD_GLOW: Record<Mood, string> = {
  happy: '0 0 34px rgba(212, 244, 80, 0.20)',
  focused: '0 0 22px rgba(212, 244, 80, 0.12)',
  alert: '0 0 30px rgba(255, 182, 193, 0.16)',
  relaxed: '0 0 18px rgba(212, 244, 80, 0.07)',
};

export const MODEL_URL =
  process.env.NEXT_PUBLIC_LIVE2D_MODEL_URL ?? '/live2d/zundamon/zundamon.model3.json';

/** Cubism Core isn't published on npm; Live2D's official CDN is the only path. */
export const CUBISM_CORE_URL =
  'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js';
