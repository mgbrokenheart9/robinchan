'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';

/**
 * Served from `/public`, not R2: some Indonesian ISPs DNS-block `*.r2.dev`,
 * which left those visitors on the standby image forever. Remuxed with
 * `+faststart` (moov first, audio dropped) so playback starts without
 * fetching the tail of the file first.
 */
const VIDEO = '/video/hero.mp4';
/** The clip's standby frame. */
const POSTER = '/img/hero-standby.png';

/**
 * Hero's full-bleed backdrop (design.md §10, §10.3), the same way the Sluice
 * hero does it:
 *
 * - The standby image is first paint. The video sits on top of it at zero
 *   opacity and only fades in once it actually has frames, so there's no
 *   black flash while 6MB streams in.
 * - Shown without a scrim so the footage reads as-is; the copy relies on
 *   `.text-on-media`'s halo for legibility.
 * - The whole layer fades in once on load, with no zoom.
 * - Some mobile browsers hold autoplay back until a gesture, so playback is
 *   asked for again on the first touch or click.
 * - Reduced motion never starts the video (brief §7, design.md §8); the
 *   standby image stands in.
 * - The frame keeps the footage's own 16:9 instead of covering the hero, so
 *   nothing is zoomed or cropped; the blurred copy fills the rest. On a phone
 *   held upright it's bottom-anchored instead, for the same reason.
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
      {/* Fills whatever the 16:9 frame doesn't: below it on desktop, above the
          bottom-anchored clip on portrait phones. */}
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
          className="object-cover"
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
    </div>
  );
}
