/**
 * Blob field behind the landing page's glass panels (design.md §10.2).
 *
 * This layer exists to be refracted, and its shape is dictated by how
 * `backdrop-filter` actually behaves. Two earlier attempts failed for
 * instructive reasons, both recorded here so they don't get reintroduced:
 *
 * 1. **Faint smooth gradients.** Blur only visibly alters high-frequency
 *    detail; a blurred smooth gradient is the same smooth gradient. At 4–7%
 *    opacity they also moved the background by under 20 RGB values. The
 *    filter ran and produced nothing.
 * 2. **A fine rule grid.** Correct in principle — it gave the blur real
 *    edges to destroy — but it reads as a visible design motif in its own
 *    right, and a 1px line at 5% white has nowhere near the luminance range
 *    to survive being seen through a darkened pane.
 *
 * What actually works is what every reference glassmorphism composition
 * does: **large, bright, saturated shapes that cross the panel's edge.** The
 * effect is a comparison, not a texture — the eye reads "glass" because the
 * same blob is crisp and vivid just outside the border and soft and muted
 * just inside it. Without shapes spanning that boundary there is nothing to
 * compare and the panel is only a tinted rectangle.
 *
 * Consequences for the numbers below:
 *
 * - **Blobs are bright.** Cores run near-white in each brand hue. They have
 *   to survive `.card-glass` darkening them by ~45% and still read as color.
 * - **Blobs are only lightly blurred (14–26px).** They need soft edges to
 *   look like out-of-focus 3D forms, but pre-blurring them heavily would
 *   recreate failure #1: if a shape is already maximally soft, the panel's
 *   own 40px blur has nothing left to take away. The *difference* between
 *   the blob's own blur and the panel's is the entire effect.
 * - **They are large and numerous.** Coverage has to hold for every glass
 *   section down a very tall page; a panel that happens to land on empty
 *   backdrop falls back to looking flat.
 *
 * Painted as real elements rather than CSS gradients because the reference
 * form is a rotated capsule, which a radial gradient can't describe. Nothing
 * here animates, so the blur is a one-time paint cost that the compositor
 * caches rather than a per-frame one.
 */

type Blob = {
  /** Percentages down the content column, so coverage scales with height. */
  top: string;
  left: string;
  w: number;
  h: number;
  rot: number;
  /** Bright core → deeper edge, which is what gives these dimensionality. */
  from: string;
  to: string;
  blur: number;
  opacity: number;
};

const BLOBS: Blob[] = [
  // — stat band —
  {
    top: '1%',
    left: '2%',
    w: 460,
    h: 230,
    rot: -16,
    from: '#EEFBC4',
    to: '#9DBF1C',
    blur: 22,
    opacity: 0.55,
  },
  {
    top: '4%',
    left: '62%',
    w: 380,
    h: 190,
    rot: 24,
    from: '#FFE0B8',
    to: '#C8761F',
    blur: 24,
    opacity: 0.4,
  },
  // — marquee / how it works —
  {
    top: '20%',
    left: '-6%',
    w: 420,
    h: 210,
    rot: 12,
    from: '#FFD9E0',
    to: '#D9788C',
    blur: 26,
    opacity: 0.38,
  },
  {
    top: '28%',
    left: '70%',
    w: 500,
    h: 240,
    rot: -20,
    from: '#EEFBC4',
    to: '#8AA814',
    blur: 20,
    opacity: 0.5,
  },
  {
    top: '38%',
    left: '18%',
    w: 560,
    h: 260,
    rot: 8,
    from: '#F3FCD6',
    to: '#A3C521',
    blur: 18,
    opacity: 0.42,
  },
  /* — decisions —
     Held deliberately dimmer than the rest. `<FeatureCards>` is the one
     block on the page with body copy sitting directly on the background
     rather than on a glass panel, so there is no darkened pane here to
     protect contrast. Blobs at the 0.4–0.5 used elsewhere put small
     `text-text-3` copy on a near-white core. */
  {
    top: '52%',
    left: '64%',
    w: 420,
    h: 210,
    rot: 30,
    from: '#FFE4C0',
    to: '#C87A22',
    blur: 28,
    opacity: 0.2,
  },
  {
    top: '60%',
    left: '-4%',
    w: 480,
    h: 230,
    rot: -12,
    from: '#EEFBC4',
    to: '#9DBF1C',
    blur: 28,
    opacity: 0.22,
  },
  // — capital flow —
  {
    top: '72%',
    left: '40%',
    w: 540,
    h: 250,
    rot: 16,
    from: '#FFDCE4',
    to: '#D4788C',
    blur: 24,
    opacity: 0.36,
  },
  // — closing CTA —
  {
    top: '86%',
    left: '8%',
    w: 500,
    h: 240,
    rot: -24,
    from: '#F3FCD6',
    to: '#9DBF1C',
    blur: 20,
    opacity: 0.5,
  },
  {
    top: '92%',
    left: '66%',
    w: 420,
    h: 200,
    rot: 14,
    from: '#FFE0B8',
    to: '#C8761F',
    blur: 22,
    opacity: 0.38,
  },
];

export function AmbientField() {
  return (
    /* The top mask fades the field in under the hero seam. Without it the
       stat-band blobs sit right at the wrapper's `overflow-hidden` edge and
       get sliced flat — a hard horizontal line of color directly below the
       hero's fade to black. */
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      style={{
        maskImage: 'linear-gradient(to bottom, transparent 0, #000 280px)',
        WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, #000 280px)',
      }}
    >
      {BLOBS.map((b, i) => (
        <div
          key={i}
          className="absolute rounded-full"
          style={{
            top: b.top,
            left: b.left,
            width: b.w,
            height: b.h,
            opacity: b.opacity,
            filter: `blur(${b.blur}px)`,
            transform: `rotate(${b.rot}deg)`,
            background: `linear-gradient(135deg, ${b.from} 0%, ${b.to} 100%)`,
          }}
        />
      ))}
    </div>
  );
}
