'use client';

import { VideoBackdrop } from './VideoBackdrop';

/**
 * Backdrop behind the Live2D character on `/robinchan` (design.md §10.3) —
 * the two stage loops, with the viewer picking which one shows.
 *
 * Both loops stay mounted and decoded, and switching is a crossfade on
 * opacity rather than a `src` swap: at 960×540 two decodes are cheap, and
 * swapping sources would flash the poster (or black) mid-switch. Under
 * reduced motion the global rule in globals.css collapses the fade to an
 * instant cut, which is fine here — the switch is a user action, not an
 * ambient rotation.
 *
 * Shown untreated — no blur, darkening, or scrim — by design decision: the
 * stage is a picture frame for the character, and the footage is meant to
 * read as-is. Note the clips carry legible fake tickers next to a chat panel
 * quoting real prices; if that ever causes confusion, a light blur is the
 * fix — ~6px is enough to make the figures unreadable.
 */

export const STAGE_BACKGROUNDS = [
  { id: 'valley', label: 'Ticker valley', src: '/video/stage-1.mp4', poster: '/video/stage-1-poster.jpg' },
  { id: 'hall', label: 'Trading hall', src: '/video/stage-2.mp4', poster: '/video/stage-2-poster.jpg' },
] as const;

export type StageBackgroundId = (typeof STAGE_BACKGROUNDS)[number]['id'];

const FADE_MS = 900;

export function StageBackdrop({
  active,
  className = '',
}: {
  active: StageBackgroundId;
  className?: string;
}) {
  return (
    <div aria-hidden className={className}>
      {STAGE_BACKGROUNDS.map((bg) => (
        <VideoBackdrop
          key={bg.id}
          src={bg.src}
          poster={bg.poster}
          className="absolute inset-0"
          opacity={active === bg.id ? 1 : 0}
          filter="none"
          playbackRate={1}
          transitionMs={FADE_MS}
        />
      ))}
    </div>
  );
}
