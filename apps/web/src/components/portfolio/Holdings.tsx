'use client';

import { useState } from 'react';
import type { Holding, PortfolioSummary } from '@robinchan/shared';
import { formatPct, formatPriceSmart, formatQty, formatSignedUsd, formatUsd } from '@robinchan/shared';

import { ChevronDownIcon } from '@/components/icons';
import { Skeleton, cx } from '@/components/ui';
import { ApiClientError, apiFetch } from '@/lib/api';

/**
 * Holdings (Portfolio §7): largest first, anything under a dollar folded
 * into one "Other" row, and tokens Robinchan doesn't support listed on
 * their own below (open decision #6's suggested answer: show everything,
 * keep the unsupported apart).
 *
 * A purchase price is never guessed (§8). Unknown stays "—", with a small
 * input to type your own; bought partly elsewhere is marked as such.
 */
const GRID =
  'grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-3 md:grid-cols-[minmax(140px,1.4fr)_0.8fr_1fr_0.9fr_1fr_1.1fr_1fr] md:gap-x-4';

export function HoldingsHeader() {
  return (
    <div className={cx(GRID, 'border-b border-border-soft px-5 py-2.5 font-mono text-[10px] uppercase tracking-[0.1em] text-text-3')} aria-hidden>
      <span>Symbol</span>
      <span className="hidden text-right md:block">Qty</span>
      <span className="hidden text-right md:block">Avg price</span>
      <span className="hidden text-right md:block">Price</span>
      <span className="text-right">Value</span>
      <span className="text-right">PnL</span>
      <span className="hidden md:block">Allocation</span>
    </div>
  );
}

export function HoldingsTable({
  summary,
  onUpdated,
  interactive = true,
}: {
  summary: PortfolioSummary;
  onUpdated?: (next: PortfolioSummary) => void;
  /** False for the blurred sample shown before a wallet is connected. */
  interactive?: boolean;
}) {
  const [otherOpen, setOtherOpen] = useState(false);
  const dustValue = summary.dust.reduce((s, h) => s + (h.value ?? 0), 0);

  return (
    <div>
      <HoldingsHeader />
      <ul className="divide-y divide-border-soft">
        {summary.holdings.map((h) => (
          <li key={h.symbol}>
            <HoldingRow holding={h} onUpdated={onUpdated} interactive={interactive} />
          </li>
        ))}
        {summary.dust.length > 0 ? (
          <li>
            <button
              type="button"
              onClick={() => setOtherOpen((v) => !v)}
              aria-expanded={otherOpen}
              className={cx(GRID, 'w-full px-5 py-3 text-left transition-colors hover:bg-surface-2')}
            >
              <span className="flex items-center gap-2">
                <span className={cx('text-text-3 transition-transform', otherOpen && 'rotate-180')}>
                  <ChevronDownIcon />
                </span>
                <span>
                  <span className="block text-[13.5px] text-text">Other</span>
                  <span className="block text-[12px] text-text-3">
                    {summary.dust.length} {summary.dust.length === 1 ? 'asset' : 'assets'} under $1
                  </span>
                </span>
              </span>
              <span className="hidden md:block" />
              <span className="hidden md:block" />
              <span className="hidden md:block" />
              <span className="text-right font-mono text-[13px] text-text-2">{formatUsd(dustValue)}</span>
              <span className="text-right font-mono text-[12px] text-text-3">—</span>
              <span className="hidden md:block" />
            </button>
            {otherOpen ? (
              <ul className="divide-y divide-border-soft bg-surface-2/50">
                {summary.dust.map((h) => (
                  <li key={h.symbol}>
                    <HoldingRow holding={h} onUpdated={onUpdated} interactive={interactive} compact />
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function HoldingRow({
  holding: h,
  onUpdated,
  interactive,
  compact,
}: {
  holding: Holding;
  onUpdated?: (next: PortfolioSummary) => void;
  interactive: boolean;
  compact?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const pnlTone = h.pnl == null ? 'text-text-3' : h.pnl >= 0 ? 'text-up' : 'text-down';
  const canEnter = interactive && h.costBasis !== 'cash' && h.costBasis !== 'known' && h.price != null;

  return (
    <div className={cx(GRID, 'px-5', compact ? 'py-2.5' : 'py-3')}>
      <span className="min-w-0">
        <span className="block font-mono text-[14px] tracking-[0.04em] text-text">{h.symbol}</span>
        <span className="block truncate text-[12px] text-text-3">{h.name}</span>
        <span className="block font-mono text-[11px] text-text-3 md:hidden">
          {formatQty(h.qty)} × {formatPriceSmart(h.price)}
        </span>
      </span>
      <span className="hidden text-right font-mono text-[13px] text-text md:block">{formatQty(h.qty)}</span>
      <span className="hidden text-right md:block">
        <AvgPriceCell holding={h} canEnter={canEnter} onEdit={() => setEditing(true)} />
      </span>
      <span className="hidden text-right font-mono text-[13px] text-text md:block">
        {h.price == null ? <span className="text-text-3" title="No price feed for this token">—</span> : formatPriceSmart(h.price)}
      </span>
      <span className="text-right font-mono text-[13px] text-text">{h.value == null ? '—' : formatUsd(h.value)}</span>
      <span className="text-right">
        {h.costBasis === 'cash' ? (
          <span className="font-mono text-[12px] text-text-3" title="The settlement stablecoin — held at par, no PnL">
            cash
          </span>
        ) : h.pnl == null ? (
          <span className="font-mono text-[12px] text-text-3" title="Purchase price unknown — left out of PnL">
            —
          </span>
        ) : (
          <>
            <span className={cx('block font-mono text-[13px]', pnlTone)}>{formatSignedUsd(h.pnl)}</span>
            <span className={cx('block font-mono text-[11px]', pnlTone)}>
              {formatPct(h.pnlPct)}
              {h.costBasis === 'partial' ? <span className="text-text-3"> · on {formatQty(h.knownQty)}</span> : null}
            </span>
          </>
        )}
      </span>
      <span className="hidden md:block">
        <Allocation value={h.allocation} />
      </span>
      {editing ? (
        <div className="col-span-full pt-3">
          <CostBasisEditor holding={h} onDone={() => setEditing(false)} onUpdated={onUpdated} />
        </div>
      ) : null}
    </div>
  );
}

function AvgPriceCell({ holding: h, canEnter, onEdit }: { holding: Holding; canEnter: boolean; onEdit: () => void }) {
  if (h.costBasis === 'cash') return <span className="font-mono text-[12px] text-text-3">—</span>;
  if (h.costBasis === 'unknown') {
    return canEnter ? (
      <button type="button" onClick={onEdit} className="text-[12px] text-accent-fg underline-offset-2 hover:underline" title="Purchase price unknown — we never guess it">
        Add price
      </button>
    ) : (
      <span className="font-mono text-[12px] text-text-3" title="Purchase price unknown">
        —
      </span>
    );
  }
  return (
    <span className="inline-flex flex-col items-end">
      <span className="font-mono text-[13px] text-text">{formatPriceSmart(h.avgCost)}</span>
      {h.costBasis === 'partial' ? (
        <span className="flex items-center gap-1.5">
          <span
            className="rounded-full border border-warning/40 px-1.5 font-mono text-[9.5px] uppercase tracking-[0.08em] text-warning"
            title={`Covers the ${formatQty(h.knownQty)} of ${formatQty(h.qty)} units bought through Robinchan`}
          >
            partial
          </span>
          {canEnter ? (
            <button type="button" onClick={onEdit} className="text-[11px] text-accent-fg hover:underline">
              add rest
            </button>
          ) : null}
        </span>
      ) : h.costBasis === 'manual' ? (
        <button type="button" onClick={onEdit} disabled={!canEnter} className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-text-3 hover:text-text" title="Entered by you">
          manual · edit
        </button>
      ) : null}
    </span>
  );
}

function Allocation({ value }: { value: number | null }) {
  if (value == null) return <span className="font-mono text-[12px] text-text-3">—</span>;
  const pct = value * 100;
  return (
    <span className="relative block overflow-hidden rounded-row py-1 pl-2">
      <span aria-hidden className="absolute inset-y-0 left-0 rounded-row bg-accent/25" style={{ width: `${Math.min(100, pct)}%` }} />
      <span className="relative font-mono text-[12.5px] text-text">{pct < 0.1 ? '<0.1' : pct.toFixed(1)}%</span>
    </span>
  );
}

/** The user's own purchase price for an asset we don't know the cost of (§8). */
function CostBasisEditor({
  holding: h,
  onDone,
  onUpdated,
}: {
  holding: Holding;
  onDone: () => void;
  onUpdated?: (next: PortfolioSummary) => void;
}) {
  const [value, setValue] = useState(h.manualAvgCost != null ? String(h.manualAvgCost) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (avgPrice: number | null) => {
    setSaving(true);
    setError(null);
    try {
      const { data } = await apiFetch<PortfolioSummary>('/api/portfolio/cost-basis', {
        method: 'PUT',
        json: { symbol: h.symbol, avgPrice },
      });
      onUpdated?.(data);
      onDone();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't save that price.");
    } finally {
      setSaving(false);
    }
  };

  const parsed = Number(value);
  const valid = value.trim() !== '' && Number.isFinite(parsed) && parsed > 0;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void save(parsed);
      }}
      className="flex flex-wrap items-center gap-2 rounded-row border border-border bg-surface-2 px-3 py-2.5"
    >
      <label htmlFor={`cb-${h.symbol}`} className="text-[12.5px] text-text-2">
        {h.costBasis === 'partial' ? `Average price you paid for the ${formatQty(h.qty - h.knownQty)} ${h.symbol} bought elsewhere` : `Average price you paid per ${h.symbol}`}
      </label>
      <span className="flex items-center rounded-full border border-border bg-surface px-3">
        <span className="font-mono text-[13px] text-text-3">$</span>
        <input
          id={`cb-${h.symbol}`}
          inputMode="decimal"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value.replace(/[^0-9.]/g, ''))}
          className="h-9 w-28 bg-transparent px-1.5 font-mono text-[13px] text-text focus:outline-none"
          placeholder="0.00"
        />
      </span>
      <button type="submit" disabled={!valid || saving} className="btn-primary h-9 min-h-0 px-4 text-[12.5px]">
        {saving ? 'Saving…' : 'Save'}
      </button>
      {h.manualAvgCost != null ? (
        <button type="button" onClick={() => void save(null)} disabled={saving} className="h-9 rounded-full px-3 text-[12.5px] text-text-3 hover:text-down">
          Remove
        </button>
      ) : null}
      <button type="button" onClick={onDone} className="h-9 rounded-full px-3 text-[12.5px] text-text-3 hover:text-text">
        Cancel
      </button>
      {error ? (
        <p role="alert" className="w-full text-[12px] text-down">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export function UnsupportedList({ items }: { items: Holding[] }) {
  if (items.length === 0) return null;
  return (
    <div className="border-t border-border-soft">
      <div className="px-5 pb-2 pt-4">
        <p className="t-eyebrow mb-1.5">Not supported by Robinchan · {items.length}</p>
        <p className="text-[12px] leading-relaxed text-text-3">
          Tokens Robinchan doesn&apos;t list. They&apos;re shown so nothing in your wallet goes missing, but
          they can&apos;t be traded here and are only valued when the explorer reports a price.
        </p>
      </div>
      <ul className="divide-y divide-border-soft">
        {items.map((h) => (
          <li key={`${h.symbol}-${h.tokenAddress ?? ''}`} className={cx(GRID, 'px-5 py-2.5 opacity-80')}>
            <span className="min-w-0">
              <span className="block font-mono text-[13px] text-text">{h.symbol}</span>
              <span className="block truncate text-[12px] text-text-3">{h.name}</span>
            </span>
            <span className="hidden text-right font-mono text-[12.5px] text-text-2 md:block">{formatQty(h.qty)}</span>
            <span className="hidden md:block" />
            <span className="hidden text-right font-mono text-[12.5px] text-text-3 md:block">{h.price == null ? 'no price' : formatPriceSmart(h.price)}</span>
            <span className="text-right font-mono text-[12.5px] text-text-2">{h.value == null ? '—' : formatUsd(h.value)}</span>
            <span className="text-right font-mono text-[12px] text-text-3">—</span>
            <span className="hidden md:block" />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HoldingsSkeleton() {
  return (
    <div aria-hidden>
      <HoldingsHeader />
      <div className="divide-y divide-border-soft">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className={cx(GRID, 'px-5 py-3')}>
            <span className="space-y-1.5">
              <Skeleton className="h-3.5 w-14" />
              <Skeleton className="h-3 w-24" />
            </span>
            <Skeleton className="ml-auto hidden h-3.5 w-12 md:block" />
            <Skeleton className="ml-auto hidden h-3.5 w-16 md:block" />
            <Skeleton className="ml-auto hidden h-3.5 w-16 md:block" />
            <Skeleton className="ml-auto h-3.5 w-20" />
            <Skeleton className="ml-auto h-3.5 w-16" />
            <Skeleton className="hidden h-5 w-full md:block" />
          </div>
        ))}
      </div>
    </div>
  );
}
