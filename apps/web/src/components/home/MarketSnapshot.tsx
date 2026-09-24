'use client';

import Link from 'next/link';
import type { ApiEnvelope, Ticker } from '@robinchan/shared';
import { POLL_MS, WATCHED_SYMBOLS, formatClock } from '@robinchan/shared';

import { ArrowRightIcon } from '@/components/icons';
import { TickerRow, TickerRowEmpty } from '@/components/TickerCard';
import { CardHead, StaleBadge, cx } from '@/components/ui';
import { isUnset } from '@/lib/api';
import { usePoll } from '@/lib/usePoll';

/**
 * "Market now" panel — 412×384px to the right of the hero (brief §4), and
 * floating to the left of the character on `/robinchan`.
 *
 * Its height is locked so the layout doesn't jump when data arrives: five
 * placeholder rows are the same height as five populated ones.
 */
export function MarketSnapshot({
  initial,
  className,
}: {
  initial: ApiEnvelope<Ticker[]>;
  className?: string;
}) {
  const envelope = usePoll<Ticker[]>('/api/market/snapshot', initial, POLL_MS.snapshot);
  const rows = envelope.data;
  const empty = rows.length === 0;
  const placeholders = WATCHED_SYMBOLS.slice(0, 5);

  /* `shadow-glow-soft` is dropped here: it's a utility, so it wins the
     cascade against `.card-glass`'s own box-shadow and would take the inset
     top highlight with it. This panel sits over the hero's fiber field — the
     one spot on the page where the blur has real content to refract — so it
     needs that highlight more than it needed the glow. */
  return (
    <section className={cx('card-glass flex h-[384px] w-full flex-col', className)}>
      <CardHead
        title="Market now"
        aside={
          <>
            {envelope.stale && !isUnset(envelope) ? <StaleBadge /> : null}
            <span className="font-mono text-[11px] text-text-3">
              {isUnset(envelope) ? '--:--:--' : formatClock(envelope.asOf)}
            </span>
          </>
        }
      />

      <div className="flex-1 divide-y divide-border-soft overflow-hidden">
        {empty
          ? placeholders.map((symbol) => <TickerRowEmpty key={symbol} symbol={symbol} />)
          : rows
              .slice(0, 5)
              .map((ticker) => (
                <TickerRow key={ticker.symbol} ticker={ticker} stale={envelope.stale} />
              ))}
      </div>

      <div className="border-t border-border-soft p-3">
        <Link href="/market" className="btn-glass w-full text-sm" aria-label="Open the Market page">
          View full market
          <ArrowRightIcon />
        </Link>
      </div>
    </section>
  );
}
