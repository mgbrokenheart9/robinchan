'use client';

import { useState } from 'react';
import Link from 'next/link';
import type {
  CompanionRead,
  OrderRecord,
  PortfolioHistory,
  PortfolioRange,
  PortfolioSummary,
} from '@robinchan/shared';
import { POLL_MS, formatNative, formatPct, formatSignedUsd, formatUsd } from '@robinchan/shared';

import { Avatar } from '@/components/Avatar';
import { ChartAttribution, ValueChart } from '@/components/charts/ValueChart';
import { usePageContext } from '@/components/companion/CompanionProvider';
import { OrderTable } from '@/components/orders/OrderHistory';
import { ConnectGate, EmptyState, ErrorState, UpdatedAt } from '@/components/states';
import { CardHead, PageHeader, Skeleton, cx } from '@/components/ui';
import { useSession } from '@/components/wallet/SessionProvider';
import { useApi, type Resource } from '@/lib/useApi';

import { HoldingsSkeleton, HoldingsTable, UnsupportedList } from './Holdings';
import { SAMPLE_HISTORY, SAMPLE_PORTFOLIO } from './sample';

const RANGES: Array<{ id: PortfolioRange; label: string }> = [
  { id: '24h', label: '24H' },
  { id: '7d', label: '7D' },
  { id: '30d', label: '30D' },
  { id: 'all', label: 'All' },
];

/**
 * Portfolio (Trade-Heat-Portfolio §7–8): what the wallet holds, what it's
 * worth, and the orders behind it. Read-only — nothing on this page writes
 * to the chain.
 */
export function PortfolioView() {
  usePageContext({ page: 'portfolio' });
  return (
    <>
      <PageHeader
        eyebrow="Portfolio"
        title="Your wallet, read from the chain"
        lead="Balances come straight from the chain. Profit and loss only counts what Robinchan knows you paid — a purchase price is never guessed."
      />
      <ConnectGate
        title="Connect to see your portfolio"
        body="Holdings, value over time, profit and loss where the purchase price is known, and every order placed through Robinchan."
        sample={<PortfolioBody summary={sampleResource(SAMPLE_PORTFOLIO)} sample />}
        skeleton={<PortfolioSkeleton />}
      >
        <Connected />
      </ConnectGate>
    </>
  );
}

function sampleResource<T>(data: T): Resource<T> {
  return { data, status: 'ready', stale: false, asOf: null, error: null, refreshing: false, reload: () => {}, set: () => {} };
}

function Connected() {
  const s = useSession();
  const key = s.session?.address.toLowerCase() ?? '';
  const summary = useApi<PortfolioSummary>(`/api/portfolio?as=${key}`, { intervalMs: POLL_MS.portfolio });

  if (summary.status === 'loading') return <PortfolioSkeleton />;
  if (summary.status === 'error') {
    return (
      <div className="card">
        <ErrorState
          message={
            summary.error?.code === 'NOT_CONFIGURED'
              ? "Wallet balances can't be read yet: no chain connection is configured on this server."
              : "Your portfolio couldn't load right now."
          }
          onRetry={summary.reload}
        />
      </div>
    );
  }
  const p = summary.data as PortfolioSummary;
  const nothing = p.holdings.length + p.dust.length + p.unsupported.length === 0;
  if (nothing) {
    return (
      <div className="card">
        <EmptyState
          illustration={<EmptyWallet />}
          title={p.discovery === 'registry' ? 'No listed tokens in this wallet' : 'This wallet is empty'}
          body={
            p.discovery === 'registry'
              ? `None of the tokens Robinchan lists are here; other tokens aren't shown without a token indexer. Gas balance: ${formatNative(p.native.qty, p.native.symbol)}.`
              : 'No tokens here yet. Look around the market first — whatever you buy through Robinchan shows up here with its purchase price.'
          }
          action={
            <Link href="/market" className="btn-primary text-sm">
              Go to Market
            </Link>
          }
        />
      </div>
    );
  }
  return <PortfolioBody summary={summary} addressKey={key} />;
}

function PortfolioBody({
  summary,
  addressKey = '',
  sample = false,
}: {
  summary: Resource<PortfolioSummary>;
  addressKey?: string;
  sample?: boolean;
}) {
  const p = summary.data as PortfolioSummary;
  const [range, setRange] = useState<PortfolioRange>('24h');
  const history = useApi<PortfolioHistory>(sample ? null : `/api/portfolio/history?range=${range}&as=${addressKey}`, {
    keepPrevious: true,
  });
  const orders = useApi<OrderRecord[]>(sample ? null : `/api/orders?status=history&limit=100&as=${addressKey}`, {
    intervalMs: POLL_MS.portfolio,
  });
  const read = useApi<CompanionRead | null>(sample ? null : `/api/portfolio/read?as=${addressKey}`);

  const chartPoints = sample ? SAMPLE_HISTORY : (history.data?.points ?? []);
  const stale = summary.stale;

  return (
    <div className="space-y-4">
      {p.source === 'fixture' && !sample ? (
        <p className="rounded-panel border border-warning/40 bg-warning/[0.07] px-4 py-2.5 text-[12.5px] leading-relaxed text-text-2">
          Dev build: no token contracts are configured, so this is a sample wallet derived from your address.
          Paper-venue orders you place move it the way a real swap would.
        </p>
      ) : null}

      <StatTiles p={p} stale={stale} />

      <section className="card">
        <CardHead
          title="Value"
          aside={
            <div className="flex items-center gap-1 rounded-full border border-border p-0.5" role="group" aria-label="Range">
              {RANGES.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setRange(r.id)}
                  aria-pressed={range === r.id}
                  className={cx(
                    'min-h-[28px] rounded-full px-2.5 font-mono text-[11px] transition-colors',
                    range === r.id ? 'bg-surface-2 text-text' : 'text-text-3 hover:text-text',
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
          }
        />
        <div className="px-3 pb-3 pt-2">
          {history.status === 'error' && !sample ? (
            <ErrorState message="The value history couldn't load." onRetry={history.reload} className="h-[260px] py-0" />
          ) : history.status === 'loading' && !sample ? (
            <Skeleton className="h-[260px] w-full" />
          ) : (
            <div className={cx(history.refreshing && 'opacity-70')}>
              <ValueChart points={chartPoints} />
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-soft px-5 py-3">
          <p className="text-[12px] leading-relaxed text-text-3">
            {sample
              ? 'Daily snapshots, starting the day you connect.'
              : history.data?.basis === 'prices'
                ? "Last 24 hours, rebuilt from hourly prices at today's quantities."
                : history.data
                  ? `Daily snapshots since ${formatDay(history.data.trackedSince)} — the day this wallet was first connected. Nothing before that is back-filled.`
                  : ''}
          </p>
          <ChartAttribution />
        </div>
      </section>

      <section className="card overflow-hidden">
        <CardHead title="Holdings" aside={<UpdatedAt asOf={summary.asOf ?? p.asOf} stale={stale} />} />
        {summary.status === 'loading' ? (
          <HoldingsSkeleton />
        ) : (
          <div className={cx(stale && 'is-stale')}>
            <HoldingsTable summary={p} onUpdated={summary.set} interactive={!sample} />
            <UnsupportedList items={p.unsupported} />
          </div>
        )}
        <div className="space-y-1 border-t border-border-soft px-5 py-3 text-[12px] leading-relaxed text-text-3">
          <p>
            Gas balance: {formatNative(p.native.qty, p.native.symbol)} — not included in the totals, there&apos;s no
            price feed for it yet.
          </p>
          {p.discovery === 'registry' ? (
            <p>Only tokens Robinchan lists were read; other tokens in this wallet aren&apos;t shown without a token indexer.</p>
          ) : null}
        </div>
      </section>

      <section className="card overflow-hidden">
        <CardHead title="Order history" aside={<span className="font-mono text-[11px] text-text-3">via Robinchan</span>} />
        <OrderTable
          orders={sample ? sampleResource<OrderRecord[]>([]) : orders}
          emptyTitle="No orders yet"
          emptyBody="Orders you sign through Robinchan — from the Trade page or the chat — are listed here with their explorer links."
        />
      </section>

      {!sample ? <ReadCard read={read} /> : null}
    </div>
  );
}

function StatTiles({ p, stale }: { p: PortfolioSummary; stale: boolean }) {
  const changeTone = p.change24h > 0 ? 'text-up' : p.change24h < 0 ? 'text-down' : 'text-text-3';
  const pnlTone = p.unrealizedPnl == null ? 'text-text-3' : p.unrealizedPnl >= 0 ? 'text-up' : 'text-down';
  const assets = p.holdings.length + p.dust.length + p.unsupported.length;
  return (
    <div className={cx('grid gap-3 sm:grid-cols-3', stale && 'is-stale')}>
      <Tile label="Total value" value={formatUsd(p.totalValue)} sub={`${assets} ${assets === 1 ? 'asset' : 'assets'}`} />
      <Tile
        label="24h change"
        value={formatSignedUsd(p.change24h)}
        sub={<span className={changeTone}>{formatPct(p.change24hPct)}</span>}
      />
      <Tile
        label="Unrealized PnL"
        value={p.unrealizedPnl == null ? '––' : formatSignedUsd(p.unrealizedPnl)}
        sub={<span className={pnlTone}>{p.unrealizedPnl == null ? 'no known purchase prices' : formatPct(p.unrealizedPnlPct)}</span>}
        note={
          p.excludedFromPnl || p.partialInPnl
            ? [
                p.excludedFromPnl ? `Excludes ${p.excludedFromPnl} ${p.excludedFromPnl === 1 ? 'asset' : 'assets'} without a purchase price` : null,
                p.partialInPnl ? `${p.partialInPnl} counted in part` : null,
              ]
                .filter(Boolean)
                .join(' · ')
            : null
        }
      />
    </div>
  );
}

/** Big number in mono, small label above, change below in mint or salmon — no arrows, no colored fill (§7). */
function Tile({ label, value, sub, note }: { label: string; value: string; sub: React.ReactNode; note?: string | null }) {
  return (
    <div className="card px-5 py-4">
      <p className="t-eyebrow mb-2.5">{label}</p>
      <p className="font-mono text-[26px] leading-none tracking-[-0.02em] text-text">{value}</p>
      <p className="mt-2 font-mono text-[12.5px]">{sub}</p>
      {note ? <p className="mt-2 text-[11.5px] leading-snug text-text-3">{note}</p> : null}
    </div>
  );
}

/** One paragraph in her voice: describes the portfolio, never advises (§7). */
function ReadCard({ read }: { read: Resource<CompanionRead | null> }) {
  if (read.status === 'ready' && read.data == null) return null;
  return (
    <section className="card">
      <CardHead title="Robinchan's read" aside={read.data ? <UpdatedAt asOf={read.data.computedAt} /> : null} />
      <div className="flex gap-4 px-5 py-4">
        <Avatar height={56} />
        {read.status === 'loading' ? (
          <div className="flex-1 space-y-2 pt-1">
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-11/12" />
            <Skeleton className="h-3.5 w-2/3" />
          </div>
        ) : read.status === 'error' ? (
          <ErrorState message="Her read couldn't load right now." onRetry={read.reload} className="flex-1 items-start py-2 text-left" />
        ) : (
          <div className="flex-1">
            <p className="text-[14px] leading-relaxed text-text">{read.data?.text}</p>
            <p className="mt-2 text-[11px] text-text-3">A description of what you hold — not advice about what to do with it.</p>
          </div>
        )}
      </div>
    </section>
  );
}

function PortfolioSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <div className="grid gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="card px-5 py-4">
            <Skeleton className="mb-3 h-3 w-20" />
            <Skeleton className="h-[26px] w-36" />
            <Skeleton className="mt-2.5 h-3 w-16" />
          </div>
        ))}
      </div>
      <div className="card">
        <div className="h-[52px] border-b border-border-soft" />
        <div className="p-3">
          <Skeleton className="h-[260px] w-full" />
        </div>
      </div>
      <div className="card overflow-hidden">
        <div className="h-[52px] border-b border-border-soft" />
        <HoldingsSkeleton />
      </div>
    </div>
  );
}

function EmptyWallet() {
  return (
    <svg width="88" height="72" viewBox="0 0 88 72" fill="none" aria-hidden className="mb-2 text-accent-fg">
      <rect x="6" y="16" width="76" height="50" rx="12" stroke="currentColor" strokeWidth="2" opacity="0.8" />
      <path d="M14 16l38-12 8 12" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" opacity="0.5" />
      <rect x="56" y="34" width="26" height="14" rx="7" stroke="currentColor" strokeWidth="2" />
      <circle cx="64" cy="41" r="2.5" fill="currentColor" />
    </svg>
  );
}

function formatDay(date: string | null): string {
  if (!date) return 'today';
  const d = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
