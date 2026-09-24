'use client';

import type { ReactNode } from 'react';

import { useReveal } from '@/lib/useReveal';

import { cx } from './ui';

/**
 * Fade-and-rise wrapper for scroll-triggered entrances on the marketing page
 * (design.md §10). Dashboard pages don't use this — their content is a
 * working surface people return to, not a first impression, so nothing
 * there should make them wait for it to animate in.
 */
export function Reveal({
  children,
  delayMs = 0,
  className,
}: {
  children: ReactNode;
  /** Stagger against sibling `<Reveal>`s revealing in the same scroll step. */
  delayMs?: number;
  className?: string;
}) {
  const [ref, visible] = useReveal<HTMLDivElement>();

  return (
    <div
      ref={ref}
      className={cx('reveal', visible && 'reveal-in', className)}
      style={visible && delayMs ? { transitionDelay: `${delayMs}ms` } : undefined}
    >
      {children}
    </div>
  );
}
