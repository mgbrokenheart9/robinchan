'use client';

import type { OrderRecord } from '@robinchan/shared';
import { formatPriceSmart, formatQty, formatUsd, relativeTime } from '@robinchan/shared';

import { ExternalIcon } from '@/components/icons';
import { EmptyState, ErrorState } from '@/components/states';
import { Skeleton, cx } from '@/components/ui';
import type { Resource } from '@/lib/useApi';
import { useNow } from '@/lib/usePoll';

/**
 * Orders as a table — the Trade page's "History" and "Open orders" tabs,
 * and the full version on Portfolio. Every settled row links to the
 * explorer; a failure says why in words.
 */
const STATUS_LABEL: Record<OrderRecord['status'], string> = {
  quoted: 'quoted',
  expired: 'expired',
  pending: 'pending',
  open: 'open',
  filled: 'filled',
  failed: 'failed',
  cancelled: 'cancelled',
};

const STATUS_TONE: Record<OrderRecord['status'], string> = {
  quoted: 'text-text-3 border-border',
  expired: 'text-text-3 border-border',
  pending: 'text-warning border-warning/40',
  open: 'text-info border-info/40',
  filled: 'text-up border-up/40',
  failed: 'text-down border-down/40',
  cancelled: 'text-text-3 border-border',
};

export function OrderTable({
  orders,
  emptyTitle,
  emptyBody,
  emptyAction,
  onCancel,
  cancelling,
  rows = 5,
}: {
  orders: Resource<OrderRecord[]>;
  emptyTitle: string;
  emptyBody: string;
  emptyAction?: React.ReactNode;
  /** Open limit orders get a cancel button (Trade §3). */
  onCancel?: (order: OrderRecord) => void;
  cancelling?: string | null;
  rows?: number;
}) {
  const now = useNow(30_000);

  if (orders.status === 'loading') {
    return (
      <div className="divide-y divide-border-soft" aria-hidden>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="grid grid-cols-[1fr_auto] gap-3 px-5 py-3.5 sm:grid-cols-[120px_1fr_120px_110px_90px]">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="hidden h-4 w-20 sm:block" />
            <Skeleton className="hidden h-4 w-16 sm:block" />
            <Skeleton className="hidden h-4 w-14 sm:block" />
          </div>
        ))}
      </div>
    );
  }
  if (orders.status === 'error') {
    return <ErrorState message="Orders couldn't load right now." onRetry={orders.reload} />;
  }
  const list = orders.data ?? [];
  if (list.length === 0) {
    return <EmptyState title={emptyTitle} body={emptyBody} action={emptyAction} className="py-10" />;
  }

  return (
    <div className={cx('overflow-x-auto', orders.stale && 'is-stale')}>
      <table className="w-full min-w-[640px] text-left">
        <thead>
          <tr className="border-b border-border-soft font-mono text-[10px] uppercase tracking-[0.1em] text-text-3">
            <th className="px-5 py-2.5 font-normal">When</th>
            <th className="px-3 py-2.5 font-normal">Order</th>
            <th className="px-3 py-2.5 text-right font-normal">Price</th>
            <th className="px-3 py-2.5 text-right font-normal">Total</th>
            <th className="px-3 py-2.5 font-normal">Status</th>
            <th className="px-5 py-2.5 text-right font-normal">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-soft">
          {list.map((o) => (
            <tr key={o.id} className="align-top">
              <td className="whitespace-nowrap px-5 py-3 font-mono text-[12px] text-text-3" title={new Date(o.createdAt).toLocaleString()}>
                {now == null ? '—' : relativeTime(o.filledAt ?? o.submittedAt ?? o.createdAt, now)}
              </td>
              <td className="px-3 py-3">
                <p className="text-[13px] text-text">
                  <span className={o.side === 'buy' ? 'text-up' : 'text-down'}>{o.side === 'buy' ? 'Buy' : 'Sell'}</span>{' '}
                  <span className="font-mono">{formatQty(o.qty)}</span> <span className="font-mono">{o.symbol}</span>
                  <span className="ml-1.5 font-mono text-[11px] text-text-3">
                    {o.orderType}
                    {o.source === 'chat' ? ' · via chat' : ''}
                  </span>
                </p>
                {o.error && (o.status === 'failed' || o.status === 'expired' || o.status === 'cancelled') ? (
                  <p className="mt-1 max-w-[360px] text-[12px] leading-snug text-text-3">{o.error}</p>
                ) : null}
              </td>
              <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-[13px] text-text">
                {o.status === 'filled'
                  ? formatPriceSmart(o.fillPrice)
                  : o.limitPrice != null
                    ? `${o.side === 'buy' ? '≤' : '≥'} ${formatPriceSmart(o.limitPrice)}`
                    : formatPriceSmart(o.quotePrice)}
              </td>
              <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-[13px] text-text-2">
                {o.status === 'filled' && o.fillPrice != null ? formatUsd(o.qty * o.fillPrice) : formatUsd(o.estTotal)}
              </td>
              <td className="px-3 py-3">
                <span className={cx('inline-flex rounded-full border px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-[0.08em]', STATUS_TONE[o.status])}>
                  {STATUS_LABEL[o.status]}
                </span>
              </td>
              <td className="whitespace-nowrap px-5 py-3 text-right">
                {onCancel && o.status === 'open' ? (
                  <button
                    type="button"
                    onClick={() => onCancel(o)}
                    disabled={cancelling === o.id}
                    className="rounded-full border border-border px-3 py-1 text-[12px] text-text-2 transition-colors hover:border-down/50 hover:text-down disabled:opacity-50"
                  >
                    {cancelling === o.id ? 'Cancelling…' : 'Cancel'}
                  </button>
                ) : o.explorerUrl ? (
                  <a
                    href={o.explorerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[12px] text-accent-fg underline-offset-2 hover:underline"
                  >
                    Explorer
                    <ExternalIcon />
                  </a>
                ) : o.txHash ? (
                  <span className="font-mono text-[11px] text-text-3" title={o.txHash}>
                    {o.txHash.slice(0, 8)}…
                  </span>
                ) : o.venue === 'paper' && o.status === 'filled' ? (
                  <span className="font-mono text-[11px] text-text-3" title="Paper venue: signed, filled against the live price, nothing moved on chain">
                    paper
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
