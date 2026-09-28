'use client';

import { useMemo, useState } from 'react';
import type { ApiEnvelope, GapBoard, GapRow, UsSession } from '@robinchan/shared';
import { POLL_MS, formatPct, formatUsdCompact } from '@robinchan/shared';

import { Avatar } from '@/components/Avatar';
import { useCompanion, usePageContext } from '@/components/companion/CompanionProvider';
import { MoonIcon, RefreshIcon } from '@/components/icons';
import { ShareButtons } from '@/components/ShareButton';
import { EmptyState, ErrorState, UpdatedAt } from '@/components/states';
import { PageHeader, Pill, PulseDot, Skeleton, cx } from '@/components/ui';
import { useApi } from '@/lib/useApi';
import { useNow } from '@/lib/usePoll';

import { GapDetail, GapHeaderRow, GapRowSkeleton, GapRowView } from './GapRows';

type Sort = 'gap' | 'liquidity' | 'volume';
type Side = 'all' | 'above' | 'below';

const SORTS: Array<{ id: Sort; label: string }> = [
  { id: 'gap', label: 'Widest gap' },
  { id: 'liquidity', label: 'Deepest pools' },
  { id: 'volume', label: '24h volume' },
];

const SIDES: Array<{ id: Side; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'above', label: 'Above their stock' },
  { id: 'below', label: 'Below their stock' },
];

/**
 * Gap: Robinhood's stock tokens trade on chain around the clock, the stocks
 * don't. The board sets each token's on-chain price against its stock's own
 * — live while Wall Street is open, its last close otherwise — so the
 * weekend's moves show up before Monday's open does.
 */
export function GapView({ initial }: { initial: ApiEnvelope<GapBoard | null> }) {
  const companion = useCompanion();
  const board = useApi<GapBoard | null>('/api/gap', { intervalMs: POLL_MS.gap, initial, keepPrevious: true });
  const [open, setOpen] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>('gap');
  const [side, setSide] = useState<Side>('all');

  usePageContext({ page: 'gap', symbol: open });

  const data = board.data ?? null;
  const live = data?.session.state === 'regular';
  const scale = useMemo(() => Math.max(1, ...(data?.rows ?? []).map((r) => Math.abs(r.gapPct ?? 0))), [data]);
  const rows = useMemo(() => {
    const list = (data?.rows ?? []).filter((r) => side === 'all' || (side === 'above' ? (r.gapPct ?? 0) > 0 : (r.gapPct ?? 0) < 0));
    const key = (r: GapRow) => (sort === 'gap' ? Math.abs(r.gapPct ?? -1) : sort === 'liquidity' ? r.liquidityUsd : r.volume24h);
    return [...list].sort((a, b) => key(b) - key(a));
  }, [data, sort, side]);

  return (
    <>
      <PageHeader
        eyebrow="Gap"
        title="Chain vs. Wall Street"
        lead="Robinhood's stock tokens trade on Robinhood Chain around the clock; the stocks don't. This board shows how far each token has drifted from its stock: live while Wall Street is open, against the last close once it shuts."
        aside={
          <div className="flex items-center gap-2">
            {data ? <ShareButtons text={shareText(data)} path="/gap" /> : null}
            <button
              type="button"
              onClick={board.reload}
              disabled={board.refreshing}
              aria-label="Refresh the board"
              className="flex h-10 w-10 items-center justify-center rounded-full border border-border text-text-2 transition-colors hover:border-text-3 hover:text-text disabled:opacity-50"
            >
              <RefreshIcon className={board.refreshing ? 'animate-spin' : ''} />
            </button>
          </div>
        }
      />

      {board.status === 'loading' ? (
        <HeroSkeleton />
      ) : data ? (
        <SessionHero board={data} />
      ) : null}

      <div className="mb-4 mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter">
          {SIDES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSide(s.id)}
              aria-pressed={side === s.id}
              className={cx(
                'inline-flex min-h-[36px] items-center rounded-full border px-3.5 text-[13px] transition-colors',
                side === s.id ? 'border-accent-fg/45 bg-accent/[0.08] text-text' : 'border-border text-text-2 hover:border-text-3 hover:text-text',
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 rounded-full border border-border p-1" role="group" aria-label="Sort by">
          {SORTS.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => setSort(o.id)}
              aria-pressed={sort === o.id}
              className={cx('min-h-[32px] rounded-full px-3 text-[12.5px] transition-colors', sort === o.id ? 'bg-surface-2 text-text' : 'text-text-3 hover:text-text')}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <section className="card overflow-hidden" aria-label="Gap board">
        <div className="flex h-[52px] items-center justify-between gap-3 border-b border-border-soft px-5">
          <h2 className="t-eyebrow">Stock tokens vs. their stocks</h2>
          <span className="flex items-center gap-2">
            {data?.source === 'sample' ? <Pill tone="muted">sample data · dev</Pill> : null}
            <UpdatedAt asOf={board.asOf} stale={board.stale} />
          </span>
        </div>
        <GapHeaderRow />

        {board.status === 'loading' ? (
          <div className="divide-y divide-border-soft">
            {Array.from({ length: 8 }, (_, i) => (
              <GapRowSkeleton key={i} />
            ))}
          </div>
        ) : board.status === 'error' ? (
          <ErrorState message="The Gap board couldn't load right now." onRetry={board.reload} />
        ) : !data ? (
          <EmptyState
            title="The board is being computed"
            body="Every two minutes Robinchan prices each stock token from its pools and sets it against its stock. The first run fills this in."
            action={
              <button type="button" onClick={board.reload} className="btn-ghost h-10 min-h-0 px-4 text-[13px]">
                Check again
              </button>
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title="Nothing on this side right now"
            body="No stock token sits on this side of its stock at the moment."
            action={
              <button type="button" onClick={() => setSide('all')} className="btn-ghost h-10 min-h-0 px-4 text-[13px]">
                Show all
              </button>
            }
          />
        ) : (
          <ul className={cx('divide-y divide-border-soft', board.refreshing && 'opacity-80')}>
            {rows.map((row, i) => (
              <li key={row.symbol}>
                <GapRowView
                  row={row}
                  rank={i + 1}
                  scale={scale}
                  live={live}
                  open={open === row.symbol}
                  stale={board.stale}
                  onToggle={() => setOpen((cur) => (cur === row.symbol ? null : row.symbol))}
                />
                {open === row.symbol ? (
                  <GapDetail
                    row={row}
                    live={live}
                    onAsk={() =>
                      companion.ask(`Why is ${row.symbol} ${(row.gapPct ?? 0) >= 0 ? 'above' : 'below'} its stock price on chain?`, {
                        page: 'gap',
                        symbol: row.symbol,
                      })
                    }
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="mt-4 space-y-2 text-[12px] leading-relaxed text-text-3">
        <p>
          On chain: each token&apos;s price across its pools on Robinhood Chain (DexScreener), weighted by liquidity, leaving
          out pools under $5K or more than 15% from the rest. Stock: the regular-session price from Yahoo Finance, with
          Robinhood Chain&apos;s Chainlink feed filling in when it can&apos;t be reached. A gap is what traders on chain are
          paying, not a forecast of the open, and never a recommendation.
        </p>
        {data?.unpriced.length ? <p>Too thin to price right now: {data.unpriced.join(', ')}.</p> : null}
      </div>
    </>
  );
}

function shareText(board: GapBoard): string {
  const w = board.summary.widest;
  if (!w) return 'Robinhood stock tokens vs. their stocks, live on Robinhood Chain. Gap board by @Rchanperps';
  const off = `${Math.abs(w.gapPct).toFixed(2)}% ${w.gapPct >= 0 ? 'above' : 'below'}`;
  return board.session.closed
    ? `Wall Street is closed, the chain isn't: $${w.symbol} trades ${off} its close on Robinhood Chain. Live Gap board by @Rchanperps`
    : `Robinhood stock tokens vs. their stocks: typically ${board.summary.typicalGapPct?.toFixed(2) ?? '0'}% apart, $${w.symbol} furthest off at ${formatPct(w.gapPct)}. Gap board by @Rchanperps`;
}

/* ------------------------------------------------------------------ */
/* The session card                                                    */
/* ------------------------------------------------------------------ */

function SessionHero({ board }: { board: GapBoard }) {
  const { session, summary } = board;
  const widest = summary.widest ? board.rows.find((r) => r.symbol === summary.widest?.symbol) : null;
  const total = summary.above + summary.below;
  return (
    <section
      className={cx(
        'card relative overflow-hidden p-5 sm:p-6',
        session.closed ? 'border-accent-fg/30 shadow-glow-soft' : '',
      )}
      aria-label="Wall Street right now"
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:items-center">
        <div>
          <span
            className={cx(
              'inline-flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-[11.5px] uppercase tracking-[0.08em]',
              session.closed ? 'border-accent-fg/40 text-accent-fg' : 'border-border text-text-2',
            )}
          >
            {session.closed ? <MoonIcon width={13} height={13} /> : <PulseDot />}
            {session.label}
          </span>
          <Countdown session={session} />
        </div>

        <dl className="grid grid-cols-2 gap-3">
          <Stat label="Stock tokens" value={String(summary.tracked)} sub={`${formatUsdCompact(summary.liquidityUsd)} in their pools`} />
          <Stat
            label="Typical gap"
            value={summary.typicalGapPct != null ? `${summary.typicalGapPct.toFixed(2)}%` : '––%'}
            sub="median, either way"
          />
          <div className="rounded-tile border border-border-soft bg-surface-2/50 px-3.5 py-3">
            <dt className="t-eyebrow mb-1.5">Above · below</dt>
            <dd className="font-mono text-[18px] text-text">
              <span className="text-up">{summary.above}</span>
              <span className="text-text-3"> · </span>
              <span className="text-down">{summary.below}</span>
            </dd>
            <dd className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
              <span className="bg-up" style={{ width: `${total ? (summary.above / total) * 100 : 0}%` }} />
              <span className="bg-down" style={{ width: `${total ? (summary.below / total) * 100 : 0}%` }} />
            </dd>
          </div>
          <Stat
            label="Widest gap"
            value={summary.widest ? `${summary.widest.symbol} ${formatPct(summary.widest.gapPct)}` : '––'}
            sub={widest?.name ?? '—'}
            tone={summary.widest ? (summary.widest.gapPct >= 0 ? 'up' : 'down') : undefined}
          />
        </dl>
      </div>

      <div className="mt-6 flex gap-3 border-t border-border-soft pt-5">
        <Avatar height={44} />
        <div className="min-w-0">
          <p className="t-eyebrow mb-1.5">Robinchan&apos;s read</p>
          <p className="rounded-[14px] rounded-tl-[4px] border border-accent-fg/20 bg-accent/[0.06] px-3.5 py-2.5 text-[13.5px] leading-relaxed text-text">
            {board.read}
          </p>
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'up' | 'down' }) {
  return (
    <div className="rounded-tile border border-border-soft bg-surface-2/50 px-3.5 py-3">
      <dt className="t-eyebrow mb-1.5">{label}</dt>
      <dd className={cx('font-mono text-[18px]', tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-text')}>{value}</dd>
      <dd className="mt-0.5 truncate text-[11.5px] text-text-3">{sub}</dd>
    </div>
  );
}

function Countdown({ session }: { session: UsSession }) {
  const now = useNow(15_000);
  const regular = session.state === 'regular';
  const target = Date.parse(regular && session.nextClose ? session.nextClose : session.nextOpen);
  const left = now == null ? null : Math.max(0, target - now);
  return (
    <div className="mt-4">
      <p className="text-[13px] text-text-2">{regular ? 'Wall Street closes in' : 'Wall Street opens in'}</p>
      <p className="t-stat mt-1" aria-live="off">
        {left == null ? '––' : duration(left)}
      </p>
      <p className="mt-2 font-mono text-[11.5px] text-text-3">
        {now == null
          ? ' '
          : `${new Date(target).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'long', hour: 'numeric', minute: '2-digit' })} New York · ${new Date(target).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })} your time`}
      </p>
    </div>
  );
}

function duration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  const d = Math.floor(min / 1_440);
  const h = Math.floor((min % 1_440) / 60);
  const m = min % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function HeroSkeleton() {
  return (
    <div className="card p-6" aria-hidden>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          <Skeleton className="h-6 w-40 rounded-full" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-12 w-56" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-[76px] w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
