'use client';

import { useState } from 'react';
import type { ApiEnvelope, HeatBoard, HeatDetail, HeatFilter, HeatSort } from '@robinchan/shared';
import { HEAT_PAGE_SIZE, POLL_MS, formatClock } from '@robinchan/shared';

import { useCompanion, usePageContext } from '@/components/companion/CompanionProvider';
import { ChevronLeftIcon, ChevronRightIcon, RefreshIcon } from '@/components/icons';
import { EmptyState, ErrorState, TierLockLabel, UpdatedAt } from '@/components/states';
import { PageHeader, cx } from '@/components/ui';
import { useSession } from '@/components/wallet/SessionProvider';
import { ApiClientError, apiFetch } from '@/lib/api';
import { useConfig } from '@/lib/config';
import { useApi } from '@/lib/useApi';

import { HeatDetailPanel, HeatHeaderRow, HeatRow, HeatRowSkeleton, LockedRow } from './HeatRows';

const FILTERS: Array<{ id: HeatFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'stocks', label: 'Tokenized stocks' },
  { id: 'chain', label: 'RH Chain tokens' },
  { id: 'watchlist', label: 'Watchlist' },
];

const SORTS: Array<{ id: HeatSort; label: string }> = [
  { id: 'score', label: 'Heat score' },
  { id: 'change', label: 'Price change' },
  { id: 'volume', label: 'Volume' },
];

/**
 * Heat (Trade-Heat-Portfolio §5–6). Home shows the top five; this is the
 * whole board and, more to the point, *why* each symbol is where it is —
 * a score alone isn't what brings people back, the explanation is.
 *
 * Everything shown is already cut to the viewer's level by the server;
 * this component only draws what arrives, locked rows included.
 */
export function HeatView({ initial }: { initial: ApiEnvelope<HeatBoard | null> }) {
  const s = useSession();
  const { perps } = useConfig();
  const companion = useCompanion();
  const [filter, setFilter] = useState<HeatFilter>('all');
  const [sort, setSort] = useState<HeatSort>('score');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);

  // The viewer is part of the key: signing in re-fetches at the new level.
  const viewer = s.signedIn && s.session ? `&as=${s.session.address.toLowerCase()}` : '';
  const board = useApi<HeatBoard>(`/api/heat/full?filter=${filter}&sort=${sort}&page=${page}${viewer}`, {
    intervalMs: POLL_MS.heat,
    initial: initial.data ? (initial as ApiEnvelope<HeatBoard>) : null,
    keepPrevious: true,
  });
  const detail = useApi<HeatDetail>(open ? `/api/heat/${encodeURIComponent(open)}${viewer ? `?as=${s.session?.address.toLowerCase()}` : ''}` : null);

  // Robinchan knows which row is open (§2).
  usePageContext({ page: 'heat', symbol: open });

  const data = board.data;
  const access = data?.access;
  const rows = data?.rows ?? [];

  const toggleWatch = async (symbol: string, on: boolean) => {
    setWatchError(null);
    try {
      const { data: list } = await apiFetch<string[]>('/api/user/watchlist');
      const next = on ? [...new Set([...list, symbol])] : list.filter((x) => x !== symbol);
      await apiFetch<string[]>('/api/user/watchlist', { method: 'PUT', json: { symbols: next } });
      board.reload();
    } catch (err) {
      setWatchError(err instanceof ApiClientError ? err.message : "Couldn't update the watchlist.");
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Heat"
        title="What's hot, and why"
        lead="Each symbol's heat combines on-chain activity and news, and every row opens to show what pushed it there. A reading of market conditions — not a recommendation."
        aside={
          <div className="flex items-center gap-3">
            <span className="font-mono text-[11px] text-text-3">
              {data?.computedAt ? `computed ${formatClock(data.computedAt)} · every 5 min` : 'waiting for the first run'}
            </span>
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

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter">
          {FILTERS.map((f) => {
            const locked = f.id === 'watchlist' && access && !access.canWatchlist;
            return (
              <button
                key={f.id}
                type="button"
                disabled={Boolean(locked)}
                onClick={() => {
                  setFilter(f.id);
                  setPage(1);
                  setOpen(null);
                }}
                aria-pressed={filter === f.id}
                title={locked ? 'The watchlist filter opens at Tier 1' : undefined}
                className={cx(
                  'inline-flex min-h-[36px] items-center gap-2 rounded-full border px-3.5 text-[13px] transition-colors',
                  filter === f.id
                    ? 'border-accent-fg/45 bg-accent/[0.08] text-text'
                    : 'border-border text-text-2 hover:border-text-3 hover:text-text',
                  locked && 'cursor-not-allowed opacity-60 hover:border-border hover:text-text-2',
                )}
              >
                {f.label}
                {locked ? <TierLockLabel tier="tier1" className="border-none bg-transparent px-0 py-0" /> : null}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-1 rounded-full border border-border p-1" role="group" aria-label="Sort by">
          {SORTS.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => {
                setSort(o.id);
                setPage(1);
              }}
              aria-pressed={sort === o.id}
              className={cx(
                'min-h-[32px] rounded-full px-3 text-[12.5px] transition-colors',
                sort === o.id ? 'bg-surface-2 text-text' : 'text-text-3 hover:text-text',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {access && access.next ? <AccessBanner level={access.level} /> : null}

      <section className="card overflow-hidden" aria-label="Heat board">
        <div className="flex h-[52px] items-center justify-between gap-3 border-b border-border-soft px-5">
          <h2 className="t-eyebrow">Ranked board</h2>
          <UpdatedAt asOf={board.asOf} stale={board.stale} />
        </div>
        <HeatHeaderRow />

        {board.status === 'loading' ? (
          <div className="divide-y divide-border-soft">
            {Array.from({ length: 8 }, (_, i) => (
              <HeatRowSkeleton key={i} />
            ))}
          </div>
        ) : board.status === 'error' ? (
          <ErrorState message="The heat board couldn't load right now." onRetry={board.reload} />
        ) : rows.length === 0 ? (
          filter === 'watchlist' ? (
            <EmptyState
              title="Your watchlist is empty"
              body="Open any row on the full board and press Watch to follow it here."
              action={
                <button type="button" onClick={() => setFilter('all')} className="btn-ghost h-10 min-h-0 px-4 text-[13px]">
                  Show all symbols
                </button>
              }
            />
          ) : (
            <EmptyState
              title={data?.computedAt ? 'Nothing in this filter yet' : 'The board is being computed'}
              body={
                data?.computedAt
                  ? 'No symbol of this kind is on the board right now.'
                  : 'Heat is recalculated every five minutes from on-chain activity and news. The first run fills this in.'
              }
              action={
                <button type="button" onClick={data?.computedAt ? () => setFilter('all') : board.reload} className="btn-ghost h-10 min-h-0 px-4 text-[13px]">
                  {data?.computedAt ? 'Show all symbols' : 'Check again'}
                </button>
              }
            />
          )
        ) : (
          <ul className={cx('divide-y divide-border-soft', board.refreshing && 'opacity-80')}>
            {rows.map((row, i) =>
              row.locked ? (
                <li key={`locked-${i}`}>
                  <LockedRow requiredTier={row.requiredTier} />
                </li>
              ) : (
                <li key={row.symbol}>
                  <HeatRow
                    row={row}
                    open={open === row.symbol}
                    stale={board.stale}
                    showVolume={sort === 'volume'}
                    onToggle={() => setOpen((cur) => (cur === row.symbol ? null : row.symbol))}
                  />
                  {open === row.symbol ? (
                    <HeatDetailPanel
                      symbol={row.symbol}
                      detail={detail}
                      perps={perps}
                      canWatchlist={Boolean(access?.canWatchlist)}
                      watchlisted={row.watchlisted}
                      onToggleWatch={() => void toggleWatch(row.symbol, !row.watchlisted)}
                      onAsk={() =>
                        companion.ask(`Why is ${row.symbol} where it is on the heat board?`, {
                          page: 'heat',
                          symbol: row.symbol,
                        })
                      }
                    />
                  ) : null}
                </li>
              ),
            )}
          </ul>
        )}

        {watchError ? (
          <p role="alert" className="border-t border-border-soft px-5 py-3 text-[12.5px] text-down">
            {watchError}
          </p>
        ) : null}

        {data && data.pages > 1 ? (
          <nav className="flex items-center justify-between border-t border-border-soft px-5 py-3" aria-label="Pages">
            <span className="font-mono text-[12px] text-text-3">
              {(data.page - 1) * HEAT_PAGE_SIZE + 1}–{Math.min(data.total, data.page * HEAT_PAGE_SIZE)} of {data.total}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={data.page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                aria-label="Previous page"
                className="flex h-9 w-9 items-center justify-center rounded-full border border-border text-text-2 disabled:opacity-40"
              >
                <ChevronLeftIcon />
              </button>
              <span className="font-mono text-[12px] text-text-2">
                {data.page} / {data.pages}
              </span>
              <button
                type="button"
                disabled={data.page >= data.pages}
                onClick={() => setPage((p) => p + 1)}
                aria-label="Next page"
                className="flex h-9 w-9 items-center justify-center rounded-full border border-border text-text-2 disabled:opacity-40"
              >
                <ChevronRightIcon />
              </button>
            </div>
          </nav>
        ) : null}
      </section>

      <p className="mt-4 text-[12px] leading-relaxed text-text-3">
        Heat = on-chain activity and 24h news, weighted and scaled to 0–100. Social listening isn&apos;t active
        yet; its weight is shared between the other two, and it&apos;s shown as not active rather than as zero.
      </p>
    </>
  );
}

function AccessBanner({ level }: { level: HeatBoard['access']['level'] }) {
  const s = useSession();
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-panel border border-border bg-surface px-5 py-3.5">
      <p className="text-[13px] leading-relaxed text-text-2">
        {level === 'anon'
          ? 'Showing the top 5, scores rounded to 10. Connect a wallet to see the top 15 with full scores and what drives each one.'
          : 'Tier 1 opens the whole board, the stories and on-chain events behind each score, Robinchan’s read, and the watchlist filter.'}
      </p>
      {level === 'anon' && s.chain ? (
        <button type="button" onClick={s.address ? () => void s.signIn() : s.openPicker} className="btn-primary h-10 min-h-0 px-4 text-[13px]">
          {s.address ? 'Sign in' : 'Connect wallet'}
        </button>
      ) : (
        <TierLockLabel tier="tier1" />
      )}
    </div>
  );
}
