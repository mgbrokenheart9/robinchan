import type { ReactNode } from 'react';

import { LockIcon } from '@/components/icons';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/* ------------------------------------------------------------------ */

export function Card({
  children,
  className,
  as: Tag = 'section',
}: {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'div' | 'article' | 'aside';
}) {
  return <Tag className={cx('card', className)}>{children}</Tag>;
}

/**
 * Card header: eyebrow on the left, a free slot on the right. Used on almost
 * every card so row heights stay consistent across pages.
 */
export function CardHead({
  title,
  aside,
  className,
}: {
  title: string;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cx(
        'flex h-[52px] items-center justify-between gap-3 border-b border-border-soft px-5',
        className,
      )}
    >
      <h2 className="t-eyebrow">{title}</h2>
      {aside ? <div className="flex items-center gap-2">{aside}</div> : null}
    </header>
  );
}

/* ------------------------------------------------------------------ */

export function Pill({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'muted' | 'pink';
  className?: string;
}) {
  const tones = {
    neutral: 'border-border text-text-2',
    accent: 'border-accent-fg/40 text-accent-fg',
    muted: 'border-border-soft text-text-3',
    pink: 'border-companion-pink/35 text-companion-pink',
  } as const;
  return <span className={cx('pill font-mono', tones[tone], className)}>{children}</span>;
}

/** Pulsing accent dot for live indicators (design.md §2). */
export function PulseDot({ className }: { className?: string }) {
  return (
    <span className={cx('relative inline-flex h-1.5 w-1.5', className)}>
      <span className="absolute inset-0 animate-pulse-dot rounded-full bg-accent" />
    </span>
  );
}

export function SentimentDot({ tone }: { tone: 'pos' | 'neg' | 'neu' }) {
  const styles = {
    // Glow only on the positive side — red is kept clinical (design.md §6).
    pos: 'bg-up shadow-[0_0_8px_rgb(var(--c-up)/0.55)]',
    neg: 'bg-down',
    neu: 'bg-text-3',
  } as const;
  const labels = {
    pos: 'positive sentiment',
    neg: 'negative sentiment',
    neu: 'neutral sentiment',
  };
  return (
    <span
      className={cx('inline-block h-2 w-2 shrink-0 rounded-full', styles[tone])}
      role="img"
      aria-label={labels[tone]}
    />
  );
}

export function StatusDot({ state }: { state: 'ok' | 'idle' | 'down' }) {
  const styles = {
    ok: 'bg-up shadow-[0_0_7px_rgb(var(--c-up)/0.5)]',
    idle: 'bg-text-3',
    down: 'bg-down',
  } as const;
  return <span className={cx('inline-block h-2 w-2 shrink-0 rounded-full', styles[state])} />;
}

/**
 * Stale-data marker. Built as a pill rather than just dimmed text, so it
 * stays legible (design.md §6).
 */
export function StaleBadge({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full border border-border-soft px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-text-3',
        className,
      )}
      title="The worker hasn't refreshed this data yet"
    >
      stale
    </span>
  );
}

export function SoonBadge() {
  return (
    <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-text-3">
      Soon
    </span>
  );
}

export function LockedBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 font-mono text-[11px] text-text-3">
      <LockIcon />
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ */

/** Dashed placeholder, shown before price data has hydrated. */
export function DashLine({ width = '3ch' }: { width?: string }) {
  return (
    <span className="font-mono text-text-3" style={{ width }} aria-hidden>
      ––––
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <span className={cx('block animate-breathe rounded bg-surface-2', className)} />;
}

/* ------------------------------------------------------------------ */

export function PageHeader({
  eyebrow,
  title,
  lead,
  aside,
}: {
  eyebrow: string;
  title: string;
  lead: string;
  aside?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-6 pb-8">
      <div className="max-w-[620px]">
        <p className="t-eyebrow mb-3">{eyebrow}</p>
        <h1 className="t-h2 mb-2">{title}</h1>
        <p className="t-body">{lead}</p>
      </div>
      {aside}
    </header>
  );
}
