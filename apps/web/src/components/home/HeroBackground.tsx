'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';

/** Hosted on R2 rather than in `/public` — a 6MB loop has no business in the deploy bundle. */
const VIDEO =
  'https://pub-c928cd1d1bb64d078d179ddfd5b29169.r2.dev/Camera_dollys_forward_slowly_1080p_20260924101957.mp4';
/** The clip's standby frame. */
const POSTER = '/img/hero-standby.jpg';

/**
 * Scrim over the footage (`--hero-scrim` in globals.css, per theme). On dark
 * it's a heavy near-black wash under white copy. On light it's kept thin so
 * the footage stays vivid — the ink copy leans on `.text-on-media`'s light
 * halo instead of a white sheet. Either way it's strongest where the words
 * sit: weighted to the left column (headline, lead, CTAs), lighter over the
 * upper right where
 * the `MarketSnapshot` glass panel wants something to refract, then closed
 * down to the page colour so the hero runs into the next section with no
 * edge. Pairs with the top mask on `<AmbientField>`.
 */
const SCRIM = 'var(--hero-scrim)';

/**
 * Hero's full-bleed backdrop (design.md §10, §10.3), the same way the Sluice
 * hero does it:
 *
 * - The standby image is first paint. The video sits on top of it at zero
 *   opacity and only fades in once it actually has frames, so there's no
 *   black flash while 6MB streams in.
 * - The whole layer eases in once on load (scale + blur settling).
 * - Some mobile browsers hold autoplay back until a gesture, so playback is
 *   asked for again on the first touch or click.
 * - Reduced motion never starts the video (brief §7, design.md §8); the
 *   standby image stands in.
 * - On a phone held upright a 16:9 clip would crop to a sliver, so it's
 *   bottom-anchored instead, feathered into a blurred copy of the same frame.
 *
 * Decorative only, so it's hidden from assistive tech.
 */
export function HeroBackground() {
  const video = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.pause();
      return;
    }

    const reveal = () => setReady(true);
    if (el.readyState >= 3) reveal();
    else el.addEventListener('loadeddata', reveal, { once: true });

    // Autoplay refusals (battery saver, iOS low-power mode) are a non-event:
    // the standby image is already showing.
    const kick = () => void el.play().catch(() => undefined);
    kick();
    window.addEventListener('touchstart', kick, { once: true, passive: true });
    window.addEventListener('click', kick, { once: true });

    return () => {
      el.removeEventListener('loadeddata', reveal);
      window.removeEventListener('touchstart', kick);
      window.removeEventListener('click', kick);
    };
  }, []);

  return (
    <div aria-hidden className="hero-media pointer-events-none absolute inset-0 -z-10">
      {/* Portrait phones only: fills the space above the bottom-anchored clip. */}
      <div className="hero-media-blur">
        <Image src={POSTER} alt="" fill sizes="100vw" className="object-cover" />
      </div>

      <div className="hero-media-frame">
        <Image
          src={POSTER}
          alt=""
          fill
          priority
          sizes="100vw"
          className="object-cover [object-position:center_60%]"
        />
        <video
          ref={video}
          className={ready ? 'is-ready' : undefined}
          src={VIDEO}
          muted
          loop
          playsInline
          preload="auto"
          autoPlay
        />
      </div>

      <div className="absolute inset-0" style={{ background: SCRIM }} />
    </div>
  );
}
