'use client';

import type { ApiEnvelope, MarketIndex } from '@robinchan/shared';
import {
  INDEX_NAMES,
  INDEX_SYMBOLS,
  POLL_MS,
  direction,
  formatPct,
  formatPrice,
} from '@robinchan/shared';

import { Sparkline } from '@/components/Sparkline';
import { StaleBadge, cx } from '@/components/ui';
import { isUnset } from '@/lib/api';
import { usePoll } from '@/lib/usePoll';

/** Index strip: 5 cards + sparkline, polling every 15 seconds (brief §6). */
export function IndexStrip({ initial }: { initial: ApiEnvelope<MarketIndex[]> }) {
  const envelope = usePoll<MarketIndex[]>('/api/market/indices', initial, POLL_MS.indices);
  const rows = envelope.data;
  const stale = envelope.stale && !isUnset(envelope);

  return (
    <section aria-label="Key indices" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {rows.length === 0
        ? INDEX_SYMBOLS.map((symbol) => <IndexCardEmpty key={symbol} symbol={symbol} />)
        : rows
            .slice(0, 5)
            .map((index) => <IndexCard key={index.symbol} index={index} stale={stale} />)}
    </section>
  );
}

function IndexCard({ index, stale }: { index: MarketIndex; stale: boolean }) {
  const dir = direction(index.changePct);
  const tone = dir === 'up' ? 'text-up' : dir === 'down' ? 'text-down' : 'text-text-3';

  return (
    <article
      className={cx(
        'rounded-tile border border-border bg-surface px-4 py-3.5',
        stale && 'is-stale',
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] tracking-[0.08em] text-text-2">{index.symbol}</span>
        {stale ? <StaleBadge /> : null}
      </div>
      <p className="truncate text-[11px] text-text-3">{index.name}</p>
      <div className="mt-2.5 flex items-end justify-between gap-2">
        <div>
          <p className="font-mono text-[17px] leading-tight">{formatPrice(index.price)}</p>
          <p className={cx('mt-1 font-mono text-[12px]', tone)}>{formatPct(index.changePct)}</p>
        </div>
        <Sparkline points={index.spark} tone={dir} width={72} height={26} />
      </div>
    </article>
  );
}

function IndexCardEmpty({ symbol }: { symbol: string }) {
  return (
    <article className="rounded-tile border border-border bg-surface px-4 py-3.5">
      <span className="font-mono text-[11px] tracking-[0.08em] text-text-3">{symbol}</span>
      <p className="mt-2 truncate text-[11px] text-text-3">{INDEX_NAMES[symbol] ?? '—'}</p>
      <div className="mt-2.5 flex items-end justify-between gap-2">
        <div className="font-mono text-text-3">
          <p className="text-[17px] leading-tight">––––</p>
          <p className="mt-1 text-[12px]">––%</p>
        </div>
        <div className="h-[26px] w-[72px]" aria-hidden />
      </div>
    </article>
  );
}
