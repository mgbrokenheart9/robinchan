'use client';

import Link from 'next/link';
import type { GapHistory, GapRow } from '@robinchan/shared';
import { direction, formatPct, formatUsd, formatUsdCompact } from '@robinchan/shared';

import { ChevronDownIcon, ExternalIcon } from '@/components/icons';
import { Sparkline } from '@/components/Sparkline';
import { ErrorState } from '@/components/states';
import { TickerLogo } from '@/components/TickerCard';
import { Skeleton, cx } from '@/components/ui';
import { useApi } from '@/lib/useApi';

import { GapChart } from './GapChart';

const EXPLORER = 'https://robinhoodchain.blockscout.com';
/** Below this much in its pools a token's price moves easily — its row says so. */
const THIN_LIQUIDITY_USD = 50_000;

export const GAP_GRID =
  'grid grid-cols-[minmax(0,1fr)_76px_20px] items-center gap-x-3 sm:grid-cols-[28px_minmax(130px,1fr)_minmax(110px,1fr)_76px_20px] lg:grid-cols-[28px_minmax(150px,1.3fr)_92px_92px_minmax(120px,1fr)_76px_88px_20px] lg:gap-x-4';

export function GapHeaderRow() {
  return (
    <div className={cx(GAP_GRID, 'border-b border-border-soft px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.1em] text-text-3 sm:px-5')} aria-hidden>
      <span className="hidden sm:block">#</span>
      <span>Stock token</span>
      <span className="hidden text-right lg:block">On chain</span>
      <span className="hidden text-right lg:block">Stock</span>
      <span className="hidden text-center sm:block">Below · above</span>
      <span className="text-right">Gap</span>
      <span className="hidden lg:block">24 hours</span>
      <span />
    </div>
  );
}

/**
 * A bar growing out of the centre line: right and green when the token
 * trades above its stock, left and red when below, as long as the gap
 * against the board's widest.
 */
export function GapBar({ gapPct, scale }: { gapPct: number | null; scale: number }) {
  const share = gapPct == null ? 0 : Math.min(1, Math.abs(gapPct) / scale) * 50;
  return (
    <span className="relative block h-2 w-full rounded-full bg-surface-2" aria-hidden>
      <span className="absolute inset-y-[-3px] left-1/2 w-px bg-text-3/50" />
      {gapPct != null && gapPct !== 0 ? (
        <span
          className={cx('absolute inset-y-0 rounded-full', gapPct > 0 ? 'left-1/2 bg-up' : 'right-1/2 bg-down')}
          style={{ width: `${Math.max(1.5, share)}%` }}
        />
      ) : null}
    </span>
  );
}

export function GapRowView({
  row,
  rank,
  scale,
  open,
  live,
  stale,
  onToggle,
}: {
  row: GapRow;
  rank: number;
  scale: number;
  open: boolean;
  /** Wall Street's regular session is on: the stock price is live, not a close. */
  live: boolean;
  stale: boolean;
  onToggle: () => void;
}) {
  const dir = direction(row.gapPct);
  const tone = dir === 'up' ? 'text-up' : dir === 'down' ? 'text-down' : 'text-text-3';
  const thin = row.liquidityUsd < THIN_LIQUIDITY_USD;
  const last = row.spark.at(-1);
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={`gap-detail-${row.symbol}`}
      className={cx(GAP_GRID, 'w-full px-4 py-3 text-left transition-colors hover:bg-surface-2 sm:px-5', open && 'bg-surface-2', stale && 'is-stale')}
    >
      <span className="hidden font-mono text-[13px] text-text-3 sm:block">{rank}</span>
      <span className="flex min-w-0 items-center gap-3">
        <TickerLogo symbol={row.symbol} size={30} />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="font-mono text-[14px] tracking-[0.04em] text-text">{row.symbol}</span>
            {thin ? (
              <span
                className="rounded-full border border-warning/40 px-1.5 py-px font-mono text-[9.5px] uppercase tracking-[0.08em] text-warning"
                title={`Only ${formatUsdCompact(row.liquidityUsd)} in its pools: a small trade moves its price`}
              >
                thin
              </span>
            ) : null}
          </span>
          <span className="block truncate text-[12px] text-text-3">{row.name}</span>
        </span>
      </span>
      <span className="hidden text-right font-mono text-[13px] text-text lg:block">{formatUsd(row.onchain)}</span>
      <span className="hidden text-right lg:block">
        <span className="block font-mono text-[13px] text-text-2">{formatUsd(row.reference)}</span>
        <span className="block font-mono text-[10px] uppercase tracking-[0.08em] text-text-3">{row.reference == null ? 'no price' : live ? 'live' : 'close'}</span>
      </span>
      <span className="hidden sm:block">
        <GapBar gapPct={row.gapPct} scale={scale} />
      </span>
      <span className={cx('text-right font-mono text-[14px]', tone)}>{formatPct(row.gapPct)}</span>
      <span className="hidden lg:block">
        <Sparkline points={row.spark} tone={direction(last ?? null)} width={88} height={26} />
      </span>
      <span className={cx('flex justify-end text-text-3 transition-transform', open && 'rotate-180')}>
        <ChevronDownIcon />
      </span>
    </button>
  );
}

export function GapRowSkeleton() {
  return (
    <div className={cx(GAP_GRID, 'px-4 py-3 sm:px-5')} aria-hidden>
      <Skeleton className="hidden h-3 w-4 sm:block" />
      <span className="flex items-center gap-3">
        <Skeleton className="h-[30px] w-[30px] rounded-full" />
        <span className="space-y-1.5">
          <Skeleton className="h-3.5 w-12" />
          <Skeleton className="h-3 w-20" />
        </span>
      </span>
      <Skeleton className="ml-auto hidden h-3.5 w-16 lg:block" />
      <Skeleton className="ml-auto hidden h-3.5 w-16 lg:block" />
      <Skeleton className="hidden h-2 w-full sm:block" />
      <Skeleton className="ml-auto h-3.5 w-12" />
      <Skeleton className="hidden h-6 w-20 lg:block" />
      <span />
    </div>
  );
}

const nyTime = (iso: string) =>
  `${new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} New York`;

const SOURCE_LABEL = { yahoo: 'Yahoo Finance', chainlink: 'Chainlink feed on Robinhood Chain', sample: 'sample data' } as const;

export function GapDetail({ row, live, onAsk }: { row: GapRow; live: boolean; onAsk: () => void }) {
  const closed = !live;
  const history = useApi<GapHistory>(`/api/gap/${encodeURIComponent(row.symbol)}`);
  const diff = row.onchain != null && row.reference != null ? row.onchain - row.reference : null;
  return (
    <div id={`gap-detail-${row.symbol}`} className="border-t border-border-soft bg-surface-2/40 px-4 py-5 sm:px-5">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <section aria-label="Gap over time">
          <p className="t-eyebrow mb-3">The gap, last 3 days</p>
          {history.status === 'error' ? (
            <ErrorState message="The chart couldn't load right now." onRetry={history.reload} className="py-6" />
          ) : history.data ? (
            <GapChart points={history.data.points} />
          ) : (
            <Skeleton className="h-[196px] w-full" />
          )}
        </section>

        <div className="space-y-5">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-[13px]">
            <div>
              <dt className="t-eyebrow mb-1">Token on chain</dt>
              <dd className="font-mono text-[15px] text-text">{formatUsd(row.onchain)}</dd>
              <dd className="text-[11.5px] text-text-3">
                {row.pools.length} pool{row.pools.length === 1 ? '' : 's'} · {formatUsdCompact(row.liquidityUsd)} deep
              </dd>
            </div>
            <div>
              <dt className="t-eyebrow mb-1">{closed ? 'Stock, last close' : 'Stock'}</dt>
              <dd className="font-mono text-[15px] text-text">{formatUsd(row.reference)}</dd>
              <dd className="text-[11.5px] text-text-3">
                {row.referenceSource ? SOURCE_LABEL[row.referenceSource] : 'no price'}
                {row.referenceAt ? ` · ${nyTime(row.referenceAt)}` : ''}
              </dd>
            </div>
            <div className="col-span-2 rounded-tile border border-border-soft bg-surface px-3.5 py-2.5">
              <dt className="sr-only">Gap</dt>
              <dd className="text-[13px] leading-relaxed text-text-2">
                {diff == null || row.gapPct == null ? (
                  'No gap to show until both prices are in.'
                ) : (
                  <>
                    On chain, one {row.symbol} token costs{' '}
                    <span className={cx('font-mono', diff >= 0 ? 'text-up' : 'text-down')}>
                      {diff >= 0 ? '+' : '−'}${Math.abs(diff).toFixed(2)} ({formatPct(row.gapPct)})
                    </span>{' '}
                    {diff >= 0 ? 'more' : 'less'} than a {row.name} share{closed ? ' at the last close' : ''}.
                  </>
                )}
              </dd>
            </div>
          </dl>

          {row.pools.length ? (
            <section aria-label="Pools">
              <p className="t-eyebrow mb-2">Deepest pools</p>
              <ul className="divide-y divide-border-soft overflow-hidden rounded-tile border border-border-soft bg-surface">
                {row.pools.map((p) => (
                  <li key={p.url}>
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-between gap-3 px-3.5 py-2 text-[12.5px] transition-colors hover:bg-surface-2"
                    >
                      <span className="min-w-0 truncate text-text-2">
                        <span className="capitalize text-text">{p.dex}</span>
                        {p.version ? ` ${p.version}` : ''} · {row.symbol}/{p.quote}
                      </span>
                      <span className="flex shrink-0 items-center gap-3 font-mono text-[12px]">
                        <span className="text-text-3">{formatUsdCompact(p.liquidityUsd)}</span>
                        <span className="text-text">{formatUsd(p.priceUsd)}</span>
                        <ExternalIcon className="text-text-3" width={12} height={12} />
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <div className="flex flex-wrap items-center gap-2.5">
            <button type="button" onClick={onAsk} className="btn-primary h-10 min-h-0 px-4 text-[13px]">
              Ask Robinchan
            </button>
            <Link href={`/check/${row.token}`} className="btn-ghost h-10 min-h-0 px-4 text-[13px]">
              Check the contract
            </Link>
            <a
              href={`${EXPLORER}/token/${row.token}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2 text-[12.5px] text-text-3 hover:text-text hover:underline"
            >
              Explorer
              <ExternalIcon width={12} height={12} />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
