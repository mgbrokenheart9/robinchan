'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Looping video backdrop, treated so UI stays legible on top of it.
 *
 * The source footage is bright, high-detail, and pale sage-green — close to
 * the inverse of this product's near-black surface. Dropped in raw it would
 * destroy every piece of text placed over it, so nothing here uses the video
 * as-is: `filter` crushes brightness and saturation on the element itself,
 * and `scrim` paints a gradient on top for the areas that need to go fully
 * to background color.
 *
 * `filter` applies to the poster image too, not just the decoded frames, so
 * the treatment is identical before and after the video loads and there's no
 * bright flash on a slow connection.
 *
 * **Reduced motion is a hard requirement, not a nicety.** brief §7 and
 * design.md §8 say all decorative motion stops, and a looping video is
 * decorative motion — the global CSS `prefers-reduced-motion` rule in
 * globals.css only neutralizes CSS animations and transitions, so it does
 * nothing to a playing `<video>`. This has to be handled in JS: the element
 * renders without `autoPlay`, and playback only ever starts if the user
 * hasn't asked for reduced motion. They get the poster frame, treated
 * identically, as a still image.
 */
export function VideoBackdrop({
  src,
  poster,
  /** CSS `filter` applied to the video element (and its poster). */
  filter,
  /** Gradient/solid painted over the video to protect specific regions. */
  scrim,
  /** Slows playback; these loops read calmer well under 1. */
  playbackRate = 0.6,
  className = '',
  opacity = 1,
  /** Crossfade duration for `opacity`. Omitted means no transition. */
  transitionMs,
}: {
  src: string;
  poster: string;
  filter: string;
  scrim?: string;
  playbackRate?: number;
  className?: string;
  opacity?: number;
  transitionMs?: number;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [allowMotion, setAllowMotion] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');

    const apply = () => {
      const video = ref.current;
      if (!video) return;

      if (query.matches) {
        video.pause();
        setAllowMotion(false);
        return;
      }

      setAllowMotion(true);
      video.playbackRate = playbackRate;
      /* Autoplay can still be refused (battery saver, iOS low-power mode).
         That's a non-event — the poster frame is already the fallback, so
         the rejection is swallowed rather than logged as an error. */
      void video.play().catch(() => undefined);
    };

    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, [playbackRate]);

  return (
    <div
      aria-hidden
      className={`pointer-events-none overflow-hidden ${className}`}
      style={{
        opacity,
        /* Written as a real transition rather than a Tailwind duration class
           so the caller can pass an arbitrary crossfade length. The global
           `prefers-reduced-motion` rule in globals.css still overrides the
           duration, since that rule targets `transition-duration` on every
           element regardless of where it was set. */
        ...(transitionMs ? { transition: `opacity ${transitionMs}ms ease-in-out` } : null),
      }}
    >
      {/* Inner wrapper owns the positioning context so the scrim lands
          correctly no matter what `className` the caller passes. */}
      <div className="relative h-full w-full">
        <video
          ref={ref}
          src={src}
          poster={poster}
          muted
          loop
          playsInline
          /* No `autoPlay`: playback is started from the effect above, and
             only when reduced motion is off. */
          preload="metadata"
          className="h-full w-full object-cover"
          style={{ filter }}
        />
        {scrim ? <div className="absolute inset-0" style={{ background: scrim }} /> : null}
        {/* Marks the state for anyone debugging why a backdrop is static. */}
        {!allowMotion ? <span hidden data-reduced-motion="true" /> : null}
      </div>
    </div>
  );
}
