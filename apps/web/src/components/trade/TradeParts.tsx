'use client';

import { useState } from 'react';
import type { CandleInterval, CandleSeries, Holding, OrderRecord, SymbolInfo, Ticker } from '@robinchan/shared';
import {
  CANDLE_INTERVALS,
  SYMBOLS,
  direction,
  formatPct,
  formatPriceSmart,
  formatQty,
  formatSignedUsd,
  formatUsd,
} from '@robinchan/shared';

import { CandleChart, type PriceLineSpec } from '@/components/charts/CandleChart';
import { ChartAttribution } from '@/components/charts/ValueChart';
import { StarIcon } from '@/components/icons';
import { OrderTable } from '@/components/orders/OrderHistory';
import { EmptyState, ErrorState, TierLockLabel, UpdatedAt } from '@/components/states';
import { Skeleton, cx } from '@/components/ui';
import type { Resource } from '@/lib/useApi';

/* ------------------------------------------------------------------ */
/* Symbol header                                                       */
/* ------------------------------------------------------------------ */

export function SymbolHeader({
  info,
  quote,
  onSymbol,
  watch,
}: {
  info: SymbolInfo;
  quote: Resource<Ticker>;
  onSymbol: (symbol: string) => void;
  watch: { can: boolean; on: boolean; toggle: () => void; signedIn: boolean };
}) {
  const t = quote.data;
  const dir = direction(t?.changePct);
  const tone = dir === 'up' ? 'text-up' : dir === 'down' ? 'text-down' : 'text-text-3';
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <div className="mb-2 flex flex-wrap items-center gap-2.5">
          <label htmlFor="trade-symbol" className="sr-only">
            Symbol
          </label>
          <select
            id="trade-symbol"
            value={info.symbol}
            onChange={(e) => onSymbol(e.target.value)}
            className="h-10 cursor-pointer rounded-full border border-border bg-surface pl-4 pr-9 font-mono text-[15px] tracking-[0.04em] text-text transition-colors hover:border-text-3 focus:outline-none"
          >
            {(['stock', 'token', 'index'] as const).map((kind) => (
              <optgroup key={kind} label={kind === 'stock' ? 'Tokenized stocks' : kind === 'token' ? 'RH Chain tokens' : 'Indices (chart only)'}>
                {SYMBOLS.filter((s) => s.kind === kind).map((s) => (
                  <option key={s.symbol} value={s.symbol}>
                    {s.symbol}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <span className="truncate text-[14px] text-text-2">{info.name}</span>
          {watch.signedIn ? (
            watch.can ? (
              <button
                type="button"
                onClick={watch.toggle}
                aria-pressed={watch.on}
                className="flex h-10 items-center gap-1.5 rounded-full border border-border px-3 text-[12.5px] text-text-2 transition-colors hover:border-text-3 hover:text-text"
              >
                <StarIcon width={14} height={14} className={watch.on ? 'fill-current text-warning' : ''} />
                {watch.on ? 'Watching' : 'Watchlist'}
              </button>
            ) : (
              <span className="flex h-10 items-center gap-2 rounded-full border border-border px-3 text-[12.5px] text-text-3" title="The watchlist opens at Tier 1">
                <StarIcon width={14} height={14} />
                <TierLockLabel tier="tier1" className="border-none bg-transparent px-0 py-0" />
              </span>
            )
          ) : null}
        </div>
        {quote.status === 'loading' ? (
          <div className="space-y-2" aria-hidden>
            <Skeleton className="h-[38px] w-48" />
            <Skeleton className="h-4 w-28" />
          </div>
        ) : quote.status === 'error' ? (
          <p className="text-[13px] text-text-3">
            No live price for {info.symbol} right now.{' '}
            <button type="button" onClick={quote.reload} className="text-accent-fg underline-offset-2 hover:underline">
              Try again
            </button>
          </p>
        ) : (
          <div className={cx(quote.stale && 'is-stale')}>
            <p className="font-mono text-[34px] leading-none tracking-[-0.02em] text-text">{formatPriceSmart(t?.price)}</p>
            <p className={cx('mt-2 font-mono text-[14px]', tone)}>
              {formatPct(t?.changePct)} <span className="text-text-3">24h</span>
            </p>
          </div>
        )}
      </div>
      <UpdatedAt asOf={quote.asOf} stale={quote.stale} />
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* Chart card                                                          */
/* ------------------------------------------------------------------ */

export function ChartCard({
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
            <span className="whitespace-nowrap rounded-full border border-warning/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-warning" title="RC_ENV=dev without a candle provider: generated bars">
              sample<span className="hidden sm:inline"> data</span>
            </span>
          ) : null}
          <UpdatedAt asOf={candles.asOf} stale={candles.stale} className="hidden sm:inline-flex" />
        </div>
      </div>
      <div className={cx('relative px-2 pt-2', candles.stale && 'opacity-70')}>
        {candles.status === 'loading' ? (
          <Skeleton className="h-[420px] w-full" />
        ) : candles.status === 'error' ? (
          <ErrorState message="The chart couldn't load right now." onRetry={candles.reload} className="h-[420px]" />
        ) : bars.length === 0 ? (
          <EmptyState
            className="h-[420px]"
            title={`No ${interval} bars for ${symbol} yet`}
            body="The data provider hasn't delivered bars at this interval. The daily chart usually has the most history."
            action={
              interval !== '1D' ? (
                <button type="button" onClick={() => onInterval('1D')} className="btn-ghost h-10 min-h-0 px-4 text-[13px]">
                  Show daily
                </button>
              ) : undefined
            }
          />
        ) : (
          <CandleChart candles={bars} fitKey={`${symbol}:${interval}`} lines={lines} />
        )}
      </div>
      <div className="flex items-center justify-between gap-3 px-4 py-2.5">
        <span className="font-mono text-[10.5px] text-text-3">
          {lines.length ? `${lines.length} open limit ${lines.length === 1 ? 'order' : 'orders'} drawn as dashed lines` : ''}
        </span>
        <ChartAttribution />
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Bottom tabs                                                         */
/* ------------------------------------------------------------------ */

type Tab = 'open' | 'history' | 'position';

/** Open orders · History · Position — three tabs, not three panels at once (Trade §3). */
export function TradeTabs({
  symbol,
  openOrders,
  history,
  holding,
  holdingStatus,
  onCancel,
  cancelling,
  cancelError,
}: {
  symbol: string;
  openOrders: Resource<OrderRecord[]>;
  history: Resource<OrderRecord[]>;
  holding: Holding | null;
  holdingStatus: Resource<unknown>['status'];
  onCancel: (o: OrderRecord) => void;
  cancelling: string | null;
  cancelError: string | null;
}) {
  const [tab, setTab] = useState<Tab>('open');
  const openCount = openOrders.data?.length ?? 0;
  return (
    <section className="card overflow-hidden">
      <div className="flex items-center gap-6 border-b border-border-soft px-5" role="tablist" aria-label="Orders and position">
        {(
          [
            ['open', `Open orders${openCount ? ` · ${openCount}` : ''}`],
            ['history', 'History'],
            ['position', 'Position'],
          ] as Array<[Tab, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cx(
              '-mb-px border-b-2 py-3.5 text-[13.5px] transition-colors',
              tab === id ? 'border-accent-fg text-text' : 'border-transparent text-text-3 hover:text-text',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {cancelError ? (
        <p role="alert" className="border-b border-border-soft px-5 py-2.5 text-[12.5px] text-down">
          {cancelError}
        </p>
      ) : null}
      <div role="tabpanel">
        {tab === 'open' ? (
          <OrderTable
            orders={openOrders}
            rows={2}
            onCancel={onCancel}
            cancelling={cancelling}
            emptyTitle={`No open ${symbol} orders`}
            emptyBody="Limit orders you place wait here until their price comes, and can be cancelled any time before."
          />
        ) : tab === 'history' ? (
          <OrderTable
            orders={history}
            rows={3}
            emptyTitle={`No ${symbol} orders yet`}
            emptyBody="Filled, failed and expired orders for this symbol show up here, each with its explorer link."
          />
        ) : (
          <Position symbol={symbol} holding={holding} status={holdingStatus} />
        )}
      </div>
    </section>
  );
}

function Position({ symbol, holding, status }: { symbol: string; holding: Holding | null; status: Resource<unknown>['status'] }) {
  if (status === 'loading') {
    return (
      <div className="grid grid-cols-2 gap-4 px-5 py-5 sm:grid-cols-4" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-5 w-24" />
          </div>
        ))}
      </div>
    );
  }
  if (status === 'error') return <ErrorState message="Your position couldn't load right now." />;
  if (!holding) {
    return <EmptyState title={`You don't hold ${symbol}`} body="Once you do, its size, cost and profit or loss show up here." className="py-10" />;
  }
  const pnlTone = holding.pnl == null ? 'text-text-3' : holding.pnl >= 0 ? 'text-up' : 'text-down';
  const cells: Array<[string, React.ReactNode]> = [
    ['Holding', `${formatQty(holding.qty)} ${symbol}`],
    ['Value', formatUsd(holding.value)],
    [
      'Avg price',
      holding.avgCost == null ? (
        <span className="text-text-3" title="Bought outside Robinchan — purchase price unknown">
          unknown
        </span>
      ) : (
        <>
          {formatPriceSmart(holding.avgCost)}
          {holding.costBasis === 'partial' ? <span className="ml-1.5 text-[11px] text-warning">partial</span> : null}
        </>
      ),
    ],
    [
      'Unrealized PnL',
      holding.pnl == null ? (
        <span className="text-text-3">—</span>
      ) : (
        <span className={pnlTone}>
          {formatSignedUsd(holding.pnl)} ({formatPct(holding.pnlPct)})
        </span>
      ),
    ],
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-5 px-5 py-5 sm:grid-cols-4">
      {cells.map(([label, value]) => (
        <div key={label}>
          <dt className="t-eyebrow mb-2">{label}</dt>
          <dd className="font-mono text-[15px] text-text">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
