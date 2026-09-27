'use client';

import { useSyncExternalStore, type ReactNode } from 'react';
import type { CandleInterval, CandleSeries } from '@robinchan/shared';
import { CANDLE_INTERVALS } from '@robinchan/shared';

import { CandleChart, type ChartMode, type PriceLineSpec } from '@/components/charts/CandleChart';
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
  const mode = useSyncExternalStore(subscribeMode, readMode, () => 'area' as const);
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
          <ModeToggle mode={mode} onMode={writeMode} />
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
          <CandleChart candles={bars} fitKey={`${symbol}:${interval}`} lines={lines} interval={interval} mode={mode} height={380} />
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

/* The chart style comes back next visit, like the interval; the stepped line is the default. */
const MODE_KEY = 'robinchan.perps-chart-mode';
let memoryMode: ChartMode | null = null;
const modeListeners = new Set<() => void>();

function readMode(): ChartMode {
  if (memoryMode) return memoryMode;
  try {
    const saved = window.localStorage.getItem(MODE_KEY);
    if (saved === 'area' || saved === 'candles') return saved;
  } catch {
    /* storage unavailable */
  }
  return 'area';
}

function writeMode(next: ChartMode): void {
  memoryMode = next;
  try {
    window.localStorage.setItem(MODE_KEY, next);
  } catch {
    /* applies for this visit */
  }
  for (const l of modeListeners) l();
}

function subscribeMode(listener: () => void): () => void {
  modeListeners.add(listener);
  return () => modeListeners.delete(listener);
}

function ModeToggle({ mode, onMode }: { mode: ChartMode; onMode: (m: ChartMode) => void }) {
  const options: Array<{ id: ChartMode; label: string; icon: ReactNode }> = [
    {
      id: 'area',
      label: 'Line',
      icon: (
        <path d="M2 11h3V7h3v2h3V4h3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      ),
    },
    {
      id: 'candles',
      label: 'Candles',
      icon: (
        <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <path d="M4.5 2.5v11M11.5 1.5v9" />
          <rect x="3" y="5" width="3" height="5" rx="0.6" fill="currentColor" />
          <rect x="10" y="3.5" width="3" height="4.5" rx="0.6" fill="none" />
        </g>
      ),
    },
  ];
  return (
    <div className="flex items-center rounded-full bg-surface-2 p-0.5" role="group" aria-label="Chart style">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onMode(o.id)}
          aria-pressed={mode === o.id}
          aria-label={o.label}
          title={o.label}
          className={cx(
            'grid h-[26px] w-[30px] place-items-center rounded-full transition-colors',
            mode === o.id ? 'bg-surface text-text shadow-sm' : 'text-text-3 hover:text-text',
          )}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            {o.icon}
          </svg>
        </button>
      ))}
    </div>
  );
}
