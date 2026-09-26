'use client';

import Link from 'next/link';
import type { HeatBoardRow, HeatComponentLine, HeatComponents, HeatDetail } from '@robinchan/shared';
import { direction, formatPct, formatPriceSmart, formatUsdCompact, perpMarket, relativeTime, sentimentBucket } from '@robinchan/shared';

import { Avatar } from '@/components/Avatar';
import { ChevronDownIcon, ExternalIcon, StarIcon } from '@/components/icons';
import { Sparkline } from '@/components/Sparkline';
import { ErrorState, TierLockLabel } from '@/components/states';
import { SentimentDot, Skeleton, cx } from '@/components/ui';
import type { Resource } from '@/lib/useApi';
import { safeUrl, sanitizeText } from '@/lib/sanitize';

/**
 * One heat-board row: rank, symbol, heat bar, score, the three component
 * mini-bars, price and a 7-day sparkline (Heat §5). The mini-bars are the
 * point: they show at a glance whether something is hot on volume or on
 * chatter, which mean very different things.
 */
export const ROW_GRID =
  'grid grid-cols-[28px_minmax(0,1fr)_44px_20px] items-center gap-x-3 sm:grid-cols-[32px_minmax(120px,170px)_minmax(0,1fr)_44px_72px_20px] lg:grid-cols-[32px_170px_minmax(0,1fr)_44px_72px_104px_96px_20px] lg:gap-x-4';

export function HeatHeaderRow() {
  return (
    <div
      className={cx(ROW_GRID, 'border-b border-border-soft px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.1em] text-text-3 sm:px-5')}
      aria-hidden
    >
      <span>#</span>
      <span>Symbol</span>
      <span className="hidden sm:block">Heat</span>
      <span className="text-right">Score</span>
      <span className="hidden sm:block">Drivers</span>
      <span className="hidden text-right lg:block">Price · 24h</span>
      <span className="hidden lg:block">7 days</span>
      <span />
    </div>
  );
}

export function HeatRow({
  row,
  open,
  onToggle,
  stale,
  showVolume,
}: {
  row: HeatBoardRow;
  open: boolean;
  onToggle: () => void;
  stale: boolean;
  /** Sorted by volume: show it under the price instead of the 24h change. */
  showVolume?: boolean;
}) {
  const dir = direction(row.changePct);
  const tone = dir === 'up' ? 'text-up' : dir === 'down' ? 'text-down' : 'text-text-3';
  const Tag = row.expandable ? 'button' : 'div';
  return (
    <Tag
      {...(row.expandable
        ? { type: 'button' as const, onClick: onToggle, 'aria-expanded': open, 'aria-controls': `heat-detail-${row.symbol}` }
        : {})}
      className={cx(
        ROW_GRID,
        'w-full px-4 py-3 text-left sm:px-5',
        row.expandable && 'transition-colors hover:bg-surface-2',
        open && 'bg-surface-2',
        stale && 'is-stale',
      )}
    >
      <span className="font-mono text-[13px] text-text-3">{row.rank}</span>
      <span className="min-w-0">
        <span className="flex items-center gap-1.5">
          <span className="font-mono text-[14px] tracking-[0.04em] text-text">{row.symbol}</span>
          {row.watchlisted ? <StarIcon width={12} height={12} className="fill-current text-warning" /> : null}
        </span>
        <span className="block truncate text-[12px] text-text-3">{row.name}</span>
      </span>
      <span className="hidden sm:block">
        <HeatBar score={row.score} />
      </span>
      <span className="text-right font-mono text-[14px] text-text" title={row.rounded ? 'Rounded to the nearest 10 without a wallet' : undefined}>
        {row.rounded ? `~${row.score}` : Math.round(row.score)}
      </span>
      <span className="hidden sm:block">
        <MiniBars components={row.components} />
      </span>
      <span className="hidden text-right lg:block">
        <span className="block font-mono text-[13px] text-text">{formatPriceSmart(row.price)}</span>
        {showVolume ? (
          <span className="block font-mono text-[12px] text-text-2" title="24h volume">
            vol {formatUsdCompact(row.volume24h)}
          </span>
        ) : (
          <span className={cx('block font-mono text-[12px]', tone)}>{formatPct(row.changePct)}</span>
        )}
      </span>
      <span className="hidden lg:block">
        {/* Colored by the week's own direction, not today's change. */}
        <Sparkline
          points={row.spark}
          tone={direction(row.spark.length > 1 ? (row.spark.at(-1) as number) - (row.spark[0] as number) : null)}
          width={96}
          height={28}
        />
      </span>
      <span className={cx('flex justify-end text-text-3 transition-transform', open && 'rotate-180')}>
        {row.expandable ? <ChevronDownIcon /> : null}
      </span>
    </Tag>
  );
}

/** Horizontal heat bar, mint, as wide as the score (Heat §5). */
export function HeatBar({ score }: { score: number }) {
  return (
    <span className="block h-2 w-full overflow-hidden rounded-full bg-surface-2" role="img" aria-label={`Heat ${Math.round(score)} of 100`}>
      <span className="block h-full rounded-full bg-up" style={{ width: `${Math.max(2, Math.min(100, score))}%` }} />
    </span>
  );
}

const COMPONENT_LABEL = { onchain: 'On-chain', news: 'News', social: 'Social' } as const;

/**
 * Three stacked mini-bars. An inactive component is a grey dashed track
 * labelled as such — never an empty bar that would read as "no activity".
 */
export function MiniBars({ components }: { components: HeatComponents | null }) {
  if (!components) {
    return (
      <span className="flex h-[22px] items-center" title="Component detail opens with a wallet">
        <span className="h-[18px] w-full rounded-[4px] bg-surface-2 blur-[1px]" aria-hidden />
        <span className="sr-only">Component detail opens with a wallet</span>
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-[3px]" role="img" aria-label={miniLabel(components)}>
      {(['onchain', 'news', 'social'] as const).map((key) => {
        const v = components[key];
        return (
          <span key={key} className="flex items-center gap-1.5" title={`${COMPONENT_LABEL[key]}: ${v == null ? 'not active' : Math.round(v * 100)}`}>
            <span className="w-3 font-mono text-[8px] uppercase text-text-3">{key[0]}</span>
            <span className={cx('h-1 flex-1 overflow-hidden rounded-full', v == null ? 'border border-dashed border-text-3/50' : 'bg-surface-2')}>
              {v != null ? <span className="block h-full rounded-full bg-accent-fg" style={{ width: `${Math.max(3, v * 100)}%` }} /> : null}
            </span>
          </span>
        );
      })}
    </span>
  );
}

function miniLabel(c: HeatComponents): string {
  const part = (label: string, v: number | null) => `${label} ${v == null ? 'not active' : Math.round(v * 100)}`;
  return [part('on-chain', c.onchain), part('news', c.news), part('social', c.social)].join(', ');
}

/** A row this viewer can't see: no data at all, only its shape and the tier that opens it. */
export function LockedRow({ requiredTier }: { requiredTier: 'wallet' | 'tier1' }) {
  return (
    <div className={cx(ROW_GRID, 'relative px-4 py-3 sm:px-5')}>
      <span aria-hidden className="h-3 w-4 rounded bg-surface-2 blur-[2px]" />
      <span aria-hidden className="space-y-1.5 blur-[3px]">
        <span className="block h-3 w-14 rounded bg-text-3/40" />
        <span className="block h-2.5 w-24 rounded bg-text-3/25" />
      </span>
      <span aria-hidden className="hidden h-2 w-3/5 rounded-full bg-up/40 blur-[3px] sm:block" />
      <span className="col-span-2 flex justify-end sm:col-span-1 lg:col-span-5">
        <TierLockLabel tier={requiredTier} />
      </span>
    </div>
  );
}

export function HeatRowSkeleton() {
  return (
    <div className={cx(ROW_GRID, 'px-4 py-3 sm:px-5')} aria-hidden>
      <Skeleton className="h-3 w-4" />
      <span className="space-y-1.5">
        <Skeleton className="h-3.5 w-14" />
        <Skeleton className="h-3 w-24" />
      </span>
      <Skeleton className="hidden h-2 w-full sm:block" />
      <Skeleton className="ml-auto h-3.5 w-7" />
      <span className="hidden space-y-[3px] sm:block">
        <Skeleton className="h-1 w-full" />
        <Skeleton className="h-1 w-full" />
        <Skeleton className="h-1 w-full" />
      </span>
      <span className="hidden space-y-1 lg:block">
        <Skeleton className="ml-auto h-3.5 w-16" />
        <Skeleton className="ml-auto h-3 w-12" />
      </span>
      <Skeleton className="hidden h-7 w-24 lg:block" />
      <span />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Opened row                                                          */
/* ------------------------------------------------------------------ */

export function HeatDetailPanel({
  symbol,
  detail,
  perps,
  canWatchlist,
  watchlisted,
  onToggleWatch,
  onAsk,
}: {
  symbol: string;
  detail: Resource<HeatDetail>;
  /** The Perps page is live (`FEATURE_PERPS`). */
  perps: boolean;
  canWatchlist: boolean;
  watchlisted: boolean;
  onToggleWatch: () => void;
  onAsk: () => void;
}) {
  const d = detail.data;
  return (
    <div id={`heat-detail-${symbol}`} className="border-t border-border-soft bg-surface-2/60 px-4 py-5 sm:px-5">
      {detail.status === 'error' ? (
        <ErrorState message={detail.error?.message ?? "This row's detail couldn't load."} onRetry={detail.reload} className="py-6" />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <section aria-label="Why it's here" className="space-y-4">
            <p className="t-eyebrow">What drives the score</p>
            {d ? (
              d.components.map((c) => <ComponentLine key={c.key} line={c} />)
            ) : (
              <>
                <ComponentLineSkeleton />
                <ComponentLineSkeleton />
                <ComponentLineSkeleton />
              </>
            )}
          </section>

          <div className="space-y-5">
            <section aria-label="Triggers">
              <p className="t-eyebrow mb-3">Triggers</p>
              {!d ? (
                <div className="space-y-2.5">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-4/5" />
                </div>
              ) : d.triggers == null ? (
                <div className="flex flex-wrap items-center gap-3">
                  <span aria-hidden className="h-3 w-48 rounded bg-text-3/25 blur-[3px]" />
                  <TierLockLabel tier="tier1" />
                </div>
              ) : d.triggers.length === 0 ? (
                <p className="text-[13px] text-text-3">No single story or on-chain event stands out behind this score.</p>
              ) : (
                <ul className="space-y-2.5">
                  {d.triggers.map((t) => (
                    <TriggerItem key={t.id} trigger={t} />
                  ))}
                </ul>
              )}
            </section>

            {d && (d.read || d.readLocked) ? (
              <section aria-label="Robinchan's read">
                <p className="t-eyebrow mb-3">Robinchan&apos;s read</p>
                {d.read ? (
                  <div className="flex gap-3">
                    <Avatar height={40} />
                    <p className="rounded-[14px] rounded-tl-[4px] border border-accent-fg/20 bg-accent/[0.06] px-3.5 py-2.5 text-[13.5px] leading-relaxed text-text">
                      {d.read.text}
                    </p>
                  </div>
                ) : d.access !== 'tier1' ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <span aria-hidden className="h-3 w-56 rounded bg-text-3/25 blur-[3px]" />
                    <TierLockLabel tier="tier1" />
                  </div>
                ) : null}
              </section>
            ) : null}

            <div className="flex flex-wrap items-center gap-2.5 pt-1">
              <button type="button" onClick={onAsk} className="btn-primary h-10 min-h-0 px-4 text-[13px]">
                Ask Robinchan
              </button>
              {perpMarket(symbol) ? (
                perps ? (
                  <Link href={`/perps?symbol=${encodeURIComponent(symbol)}`} className="btn-ghost h-10 min-h-0 px-4 text-[13px]">
                    Open in Perps
                  </Link>
                ) : (
                  <span className="btn-ghost h-10 min-h-0 cursor-not-allowed px-4 text-[13px] opacity-60" title="Perps aren't live yet">
                    Open in Perps
                  </span>
                )
              ) : null}
              {canWatchlist ? (
                <button
                  type="button"
                  onClick={onToggleWatch}
                  aria-pressed={watchlisted}
                  className="btn-ghost h-10 min-h-0 gap-2 px-4 text-[13px]"
                >
                  <StarIcon width={14} height={14} className={watchlisted ? 'fill-current text-warning' : ''} />
                  {watchlisted ? 'On watchlist' : 'Watch'}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ComponentLine({ line }: { line: HeatComponentLine }) {
  const inactive = line.score == null;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-[13px] text-text">
          {line.label}
          {!inactive ? <span className="ml-2 font-mono text-[11px] text-text-3">weight {Math.round(line.weight * 100)}%</span> : null}
        </span>
        <span className={cx('font-mono text-[13px]', inactive ? 'text-text-3' : 'text-text')}>
          {inactive ? (line.inactive === 'belum_aktif' ? 'not active yet' : 'no data') : `${Math.round((line.score as number) * 100)}/100`}
        </span>
      </div>
      <span className={cx('block h-2 overflow-hidden rounded-full', inactive ? 'border border-dashed border-text-3/50 bg-transparent' : 'bg-surface-2')}>
        {!inactive ? (
          <span className="block h-full rounded-full bg-accent-fg" style={{ width: `${Math.max(2, (line.score as number) * 100)}%` }} />
        ) : null}
      </span>
      <p className="mt-1.5 text-[12.5px] leading-snug text-text-2">{line.note || '—'}</p>
    </div>
  );
}

function ComponentLineSkeleton() {
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between">
        <Skeleton className="h-3.5 w-20" />
        <Skeleton className="h-3.5 w-12" />
      </div>
      <Skeleton className="h-2 w-full" />
      <Skeleton className="h-3 w-3/4" />
    </div>
  );
}

function TriggerItem({ trigger }: { trigger: NonNullable<HeatDetail['triggers']>[number] }) {
  const href = trigger.url ? safeUrl(trigger.url) : null;
  const title = sanitizeText(trigger.title, 140);
  return (
    <li className="flex gap-2.5">
      {trigger.kind === 'news' ? (
        <SentimentDot tone={sentimentBucket(trigger.sentiment)} />
      ) : (
        <span className="mt-1 inline-block h-2 w-2 shrink-0 rounded-sm bg-info" aria-label="on-chain event" role="img" />
      )}
      <div className="min-w-0">
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="group inline text-[13px] leading-snug text-text hover:underline">
            {title}
            <ExternalIcon className="ml-1 inline opacity-60" />
          </a>
        ) : (
          <p className="text-[13px] leading-snug text-text">{title}</p>
        )}
        <p className="mt-0.5 font-mono text-[11px] text-text-3">
          {trigger.kind === 'news' ? sanitizeText(trigger.source, 28) : 'on-chain'} · {relativeTime(trigger.at)}
        </p>
      </div>
    </li>
  );
}
