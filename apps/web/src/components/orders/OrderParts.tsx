'use client';

import { useEffect, useState } from 'react';
import type { OrderQuote, OrderRecord } from '@robinchan/shared';
import { QUOTE_WARN_SEC, formatNative, formatPriceSmart, formatQty, formatUsd } from '@robinchan/shared';

import { ExternalIcon } from '@/components/icons';
import { PulseDot, cx } from '@/components/ui';
import type { SignerState } from '@/lib/useOrderSigner';

/** Side badge, symbol and type — the top line of every order card. */
export function OrderHeader({
  side,
  symbol,
  orderType,
  right,
}: {
  side: 'buy' | 'sell';
  symbol: string;
  orderType: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2.5">
        <span
          className={cx(
            'rounded-full px-2.5 py-1 font-mono text-[11px] font-medium tracking-[0.08em]',
            side === 'buy' ? 'bg-up/15 text-up' : 'bg-down/15 text-down',
          )}
        >
          {side === 'buy' ? 'BUY' : 'SELL'}
        </span>
        <span className="font-mono text-[14px] tracking-[0.04em]">{symbol}</span>
        <span className="font-mono text-[12px] text-text-3">{orderType}</span>
      </div>
      {right}
    </div>
  );
}

/** Seconds left until `expiresAt`, from the UTC timestamp, on the client. */
export function useCountdown(expiresAt: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [expiresAt]);
  if (!expiresAt) return null;
  const seconds = Math.ceil((Date.parse(expiresAt) - now) / 1000);
  return Number.isFinite(seconds) ? Math.max(0, seconds) : null;
}

/**
 * The sign button, with the quote's countdown *in* it (Trade §4) — the
 * user is looking at the button when deciding, so that's where the time
 * belongs. The last ten seconds change color; at zero the button stops
 * signing and becomes "Refresh price".
 */
export function SignButton({
  quote,
  side,
  onSign,
  onRefresh,
  disabled,
  busyLabel,
  className,
}: {
  quote: OrderQuote | null;
  side: 'buy' | 'sell';
  onSign: () => void;
  onRefresh: () => void;
  disabled?: boolean;
  /** Replaces the label while signing / confirming. */
  busyLabel?: string | null;
  className?: string;
}) {
  const remaining = useCountdown(quote?.expiresAt ?? null);
  const expired = quote != null && remaining != null && remaining <= 0;
  const warn = remaining != null && remaining > 0 && remaining <= QUOTE_WARN_SEC;
  const fill = side === 'buy' ? 'bg-up/90 hover:bg-up text-white dark:text-bg' : 'bg-down/80 hover:bg-down/90 text-white dark:text-bg';

  if (expired) {
    return (
      <button type="button" onClick={onRefresh} disabled={disabled} className={cx('btn-ghost w-full text-sm', className)}>
        Refresh price
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onSign}
      disabled={disabled || !quote || Boolean(busyLabel)}
      className={cx(
        'btn w-full justify-between text-sm font-semibold transition-colors disabled:cursor-not-allowed',
        quote && !disabled ? fill : 'bg-surface-2 text-text-3',
        className,
      )}
    >
      <span>{busyLabel ?? 'Sign order'}</span>
      {quote && !busyLabel ? (
        <span
          className={cx(
            'inline-flex min-w-[3.2ch] items-center justify-end gap-1.5 font-mono text-[13px] tabular-nums',
            warn ? 'rounded-full bg-warning px-2 py-0.5 text-bg' : 'opacity-80',
          )}
          aria-label={`${remaining} seconds left on this price`}
        >
          {remaining ?? '--'}s
        </span>
      ) : null}
    </button>
  );
}

export function QuoteSummary({ quote }: { quote: OrderQuote }) {
  const { intent } = quote;
  const rows: Array<[string, string, 'muted' | 'emphasis' | null]> = [
    ['Quantity', `${formatQty(intent.qty)} ${intent.symbol}`, null],
    [intent.orderType === 'limit' ? 'Limit price' : 'Est. price', formatUsd(quote.estPrice), null],
    [intent.side === 'buy' ? 'Est. total' : 'Est. proceeds', formatUsd(quote.estTotal), 'emphasis'],
    ['Est. network fee', quote.estGas > 0 ? formatNative(quote.estGas, quote.gasSymbol) : 'none — signature only', 'muted'],
    [`Protocol fee (${(quote.feeBps / 100).toFixed(2)}%)`, formatUsd(quote.protocolFee), 'muted'],
  ];
  if (intent.orderType === 'market') {
    rows.push(['Max slippage', `${(quote.slippageBps / 100).toFixed(2)}%`, 'muted']);
  }
  return (
    <dl className="space-y-2">
      {rows.map(([label, value, tone]) => (
        <div key={label} className="flex items-baseline justify-between gap-4">
          <dt className={cx('text-[13px]', tone === 'muted' ? 'text-text-3' : 'text-text-2')}>{label}</dt>
          <dd
            className={cx(
              'text-right font-mono',
              tone === 'emphasis' ? 'text-[15px] text-text' : tone === 'muted' ? 'text-[12px] text-text-3' : 'text-[13px] text-text',
            )}
          >
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A warning that has to be ticked before signing — e.g. a limit far from market. */
export function AckCheckbox({
  message,
  checked,
  onChange,
}: {
  message: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer gap-2.5 rounded-row border border-warning/40 bg-warning/[0.08] px-3 py-2.5 text-[12.5px] leading-snug text-text">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[rgb(var(--c-warning))]"
      />
      <span>
        {message} I&apos;ve checked it and want this price.
      </span>
    </label>
  );
}

/**
 * What happened after signing: waiting on the chain (with the explorer link,
 * never just a spinner), done, or failed with the reason. Past two minutes
 * pending, speed-up and cancel are offered (Trade §4).
 */
export function OrderProgress({
  state,
  slow,
  onSpeedUp,
  onCancel,
}: {
  state: SignerState;
  slow: boolean;
  onSpeedUp: () => void;
  onCancel: () => void;
}) {
  const r: OrderRecord | null = state.record;
  if (state.phase === 'idle' && !state.error) return null;

  if (state.phase === 'signing' || state.phase === 'confirming') {
    return (
      <p className="flex items-center gap-2 text-[12.5px] text-text-2" role="status">
        <PulseDot />
        {state.phase === 'signing'
          ? state.step && state.step.total > 1
            ? `Step ${state.step.index + 1} of ${state.step.total}: ${state.step.label} — confirm in your wallet`
            : 'Confirm in your wallet…'
          : state.step
            ? `Waiting for “${state.step.label}” to confirm…`
            : 'Recording your signature…'}
      </p>
    );
  }

  if (state.error && state.phase !== 'pending') {
    return (
      <p role="alert" className="text-[12.5px] leading-snug text-down">
        {state.error}
      </p>
    );
  }

  if (!r) return null;

  const link = r.explorerUrl ? (
    <a href={r.explorerUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent-fg underline-offset-2 hover:underline">
      View on explorer
      <ExternalIcon />
    </a>
  ) : r.txHash ? (
    <span className="font-mono text-[11px] text-text-3">{r.txHash.slice(0, 10)}…{r.txHash.slice(-6)}</span>
  ) : null;

  if (state.phase === 'pending') {
    return (
      <div className="space-y-2 rounded-row border border-border bg-surface-2 px-3 py-2.5 text-[12.5px]" role="status">
        <p className="flex items-center gap-2 text-text">
          <PulseDot />
          Waiting for the network to confirm…
        </p>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-text-3">
          {link}
          <span>You can close this tab — the order is watched on the server.</span>
        </p>
        {slow ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-border-soft pt-2">
            <span className="text-text-2">Taking a while.</span>
            <button type="button" onClick={onSpeedUp} className="rounded-full border border-border px-3 py-1 text-[12px] hover:border-text-3">
              Speed up
            </button>
            <button type="button" onClick={onCancel} className="rounded-full border border-border px-3 py-1 text-[12px] hover:border-text-3">
              Cancel transaction
            </button>
          </div>
        ) : null}
        {state.error ? <p className="text-down">{state.error}</p> : null}
      </div>
    );
  }

  const tone =
    r.status === 'filled' || r.status === 'open' ? 'border-up/40 bg-up/[0.07]' : 'border-down/40 bg-down/[0.07]';
  return (
    <div className={cx('space-y-1.5 rounded-row border px-3 py-2.5 text-[12.5px] leading-snug', tone)} role="status">
      <p className="text-text">
        {r.status === 'filled'
          ? `Filled: ${r.side} ${formatQty(r.qty)} ${r.symbol} at ${formatPriceSmart(r.fillPrice)}.`
          : r.status === 'open'
            ? `Limit order placed: ${r.side} ${formatQty(r.qty)} ${r.symbol} at ${formatPriceSmart(r.limitPrice)}. It fills when the price gets there.`
            : r.status === 'cancelled'
              ? 'Cancelled. Nothing was filled.'
              : (r.error ?? 'The order did not go through.')}
      </p>
      {link ? <p className="text-text-3">{link}</p> : null}
    </div>
  );
}
