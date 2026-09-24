import type { ReactNode } from 'react';

import { cx } from '@/components/ui';

/**
 * A row that scrolls on its own (brief §7).
 *
 * Its contents are duplicated twice inside the track, then `translateX` is
 * animated from 0 to −50% so the loop is seamless. Uses CSS `animation`
 * rather than `requestAnimationFrame` — cheaper, and it stops on its own when
 * the tab isn't active. `prefers-reduced-motion` is honored via the global
 * rule in globals.css.
 *
 * Gap between cards is applied as `padding-right` on each copy, not as `gap`
 * on the track. With `gap`, the track width becomes 2W + gap while −50%
 * shifts it by W + gap/2, and the seam ends up off by half a gap.
 */
export function Marquee({
  children,
  speed = 40,
  direction = 'left',
  gap = 12,
  className,
  ariaLabel,
}: {
  children: ReactNode;
  /** Seconds per full loop. */
  speed?: number;
  direction?: 'left' | 'right';
  gap?: number;
  className?: string;
  ariaLabel: string;
}) {
  const half = (
    <div className="flex shrink-0 items-center" style={{ gap: `${gap}px`, paddingRight: gap }}>
      {children}
    </div>
  );

  return (
    <div
      className={cx('mask-edges group relative overflow-hidden', className)}
      role="group"
      aria-label={ariaLabel}
    >
      <div
        className="flex w-max will-change-transform group-hover:[animation-play-state:paused]"
        style={{
          animationName: direction === 'left' ? 'marquee-left' : 'marquee-right',
          animationDuration: `${speed}s`,
          animationTimingFunction: 'linear',
          animationIterationCount: 'infinite',
        }}
      >
        {half}
        {/* The second copy closes the seam at the −50% mark. */}
        <div aria-hidden className="flex shrink-0">
          {half}
        </div>
      </div>
    </div>
  );
}
