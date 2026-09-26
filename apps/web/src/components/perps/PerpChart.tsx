'use client';

import type { CandleInterval, CandleSeries } from '@robinchan/shared';
import { CANDLE_INTERVALS } from '@robinchan/shared';

import { CandleChart, type PriceLineSpec } from '@/components/charts/CandleChart';
import { ChartAttribution } from '@/components/charts/ValueChart';
import { EmptyState, ErrorState, UpdatedAt } from '@/components/states';
import { Skeleton, cx } from '@/components/ui';
import type { Resource } from '@/lib/useApi';

/**
 * Chart bars built by the worker from the Chainlink price (brief §11).
 * Agri series are back-adjusted at each futures roll, so the history lines
 * up with the contract traded now. Open positions on this market draw their
 * entry and liquidation prices as dashed lines.
 */
export function PerpChart({
  symbol,
  interval,
  onInterval,
  candles,
  lines,
}: {
  symbol: string;
  interval: CandleInterval;
  onInterval: (i: CandleInterval) => void;
  candles: Resource<CandleSeries>;
  lines: PriceLineSpec[];
}) {
  const bars = candles.data?.candles ?? [];
  return (
    <section className="card overflow-hidden" aria-label={`${symbol} chart`}>
      <div className="flex h-[52px] items-center justify-between gap-3 border-b border-border-soft px-4">
        <div className="flex items-center gap-1" role="group" aria-label="Interval">
          {CANDLE_INTERVALS.map((i) => (
            <button
              key={i}
              type="button"
              onClick={() => onInterval(i)}
              aria-pressed={interval === i}
              className={cx(
                'min-h-[30px] rounded-full px-2 font-mono text-[12px] transition-colors sm:px-2.5',
                interval === i ? 'bg-surface-2 text-text' : 'text-text-3 hover:text-text',
              )}
            >
              {i}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          {candles.data?.source === 'fixture' ? (
            <span
              className="whitespace-nowrap rounded-full border border-warning/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-warning"
              title="RC_ENV=dev with Robinhood Chain out of reach: generated bars"
            >
              sample<span className="hidden sm:inline"> data</span>
            </span>
          ) : null}
          <UpdatedAt asOf={candles.asOf} stale={candles.stale} className="hidden sm:inline-flex" />
        </div>
      </div>
      <div className={cx('relative px-2 pt-2', candles.stale && 'opacity-70')}>
        {candles.status === 'loading' ? (
          <Skeleton className="h-[380px] w-full" />
        ) : candles.status === 'error' ? (
          <ErrorState message="The chart couldn't load right now." onRetry={candles.reload} className="h-[380px]" />
        ) : bars.length === 0 ? (
          <EmptyState
            className="h-[380px]"
            title={`No ${interval} bars for ${symbol} yet`}
            body="Bars are built from Chainlink's prices as they arrive; a market that's been closed since launch has none yet."
            action={
              interval !== '1D' ? (
                <button type="button" onClick={() => onInterval('1D')} className="btn-ghost h-10 min-h-0 px-4 text-[13px]">
                  Show daily
                </button>
              ) : undefined
            }
          />
        ) : (
          <CandleChart candles={bars} fitKey={`${symbol}:${interval}`} lines={lines} height={380} />
        )}
      </div>
      <div className="flex items-center justify-between gap-3 px-4 py-2.5">
        <span className="font-mono text-[10.5px] text-text-3">
          {lines.length ? 'Your entry and liquidation prices are the dashed lines' : 'Prices: Chainlink on Robinhood Chain'}
        </span>
        <ChartAttribution />
      </div>
    </section>
  );
}
