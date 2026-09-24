'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { OrderQuote, OrderRecord, SymbolInfo } from '@robinchan/shared';
import {
  LIMIT_DEVIATION_MAX,
  TIER_LABELS,
  formatPct,
  formatPriceSmart,
  formatQty,
  formatUsd,
  tierAtLeast,
} from '@robinchan/shared';

import { AckCheckbox, OrderProgress, QuoteSummary, SignButton } from '@/components/orders/OrderParts';
import { TierLockLabel } from '@/components/states';
import { cx } from '@/components/ui';
import { useSession } from '@/components/wallet/SessionProvider';
import { ApiClientError, apiFetch } from '@/lib/api';
import { useConfig } from '@/lib/config';
import { useOrderSigner } from '@/lib/useOrderSigner';

export type TicketBalances = {
  cash: number;
  cashSymbol: string;
  held: number;
  native: number;
  nativeSymbol: string;
};

/**
 * The order ticket (Trade §3–4), top to bottom: buy/sell, market/limit,
 * amount with 25/50/75/Max, limit price (limit only, pre-filled with the
 * market price), the summary, and the sign button.
 *
 * The form only fills in an order *intent*; the quote — every number that
 * reaches the wallet — comes back from the server, through the same
 * pipeline the chat uses. The checks here exist to put a message next to
 * the right input early; the server makes the same checks and decides.
 */
export function OrderTicket({
  info,
  price,
  balances,
  pendingOrder,
  onSettled,
}: {
  info: SymbolInfo;
  price: number | null;
  balances: TicketBalances | null;
  /** An order already on its way when the page loaded (tab closed mid-flight). */
  pendingOrder: OrderRecord | null;
  onSettled: (record: OrderRecord) => void;
}) {
  const cfg = useConfig();
  const s = useSession();
  const signer = useOrderSigner({
    onSettled: (record) => {
      // Watched it happen here — nothing for Robinchan to announce later.
      void apiFetch('/api/user/notifications/ack', { json: { ids: [record.id] } }).catch(() => undefined);
      onSettled(record);
    },
  });
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [type, setType] = useState<'market' | 'limit'>('market');
  const [qty, setQty] = useState('');
  const [limit, setLimit] = useState('');
  const [quote, setQuote] = useState<OrderQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [acked, setAcked] = useState(false);

  // Resume an order that was already pending when the page loaded.
  const { follow } = signer;
  useEffect(() => {
    if (pendingOrder) follow(pendingOrder);
  }, [pendingOrder, follow]);

  /** Any edit invalidates the quote: it was for the old values. */
  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setQuote(null);
    setError(null);
    setAcked(false);
  };

  if (!info.tradable) {
    return (
      <div className="card p-6">
        <p className="t-eyebrow mb-3">Order</p>
        <p className="t-h3 mb-2">{info.symbol} can&apos;t be ordered here</p>
        <p className="text-[13px] leading-relaxed text-text-2">{info.untradableReason}</p>
        <Link href="/trade?symbol=NVDA" className="btn-ghost mt-5 h-10 min-h-0 px-4 text-[13px]">
          Open a tokenized stock
        </Link>
      </div>
    );
  }

  const tier = s.tier?.tier ?? 'free';
  const limitLocked = !cfg.limitOrders ? 'venue' : !tierAtLeast(tier, 'tier3') ? 'tier' : null;

  const qtyNum = Number(qty);
  const qtyValid = qty.trim() !== '' && Number.isFinite(qtyNum) && qtyNum > 0;
  const limitNum = Number(limit);
  const limitValid = type === 'market' || (limit.trim() !== '' && Number.isFinite(limitNum) && limitNum > 0);
  const refPrice = type === 'limit' ? (limitValid ? limitNum : null) : price;

  let balanceError: string | null = null;
  if (qtyValid && balances && refPrice != null) {
    if (side === 'buy' && balances.cash < qtyNum * refPrice) {
      balanceError = `Not enough ${balances.cashSymbol}: this needs about ${formatUsd(qtyNum * refPrice)} and you have ${formatUsd(balances.cash)}.`;
    }
    if (side === 'sell' && balances.held < qtyNum) {
      balanceError = `You hold ${formatQty(balances.held)} ${info.symbol}.`;
    }
  }
  const serverQtyError = error?.field === 'qty' ? error.message : null;

  const deviation = type === 'limit' && limitValid && price ? (limitNum - price) / price : 0;
  const deviates = Math.abs(deviation) > LIMIT_DEVIATION_MAX || quote?.ack != null;

  const setFraction = (f: number) => {
    if (!balances || refPrice == null || refPrice <= 0) return;
    const units = side === 'buy' ? (balances.cash * f) / refPrice : balances.held * f;
    // Round down so "Max" never asks for more than the balance.
    const floored = Math.floor(units * 10_000) / 10_000;
    edit(setQty)(floored > 0 ? String(floored) : '');
  };

  const requestQuote = async () => {
    if (!qtyValid || !limitValid) return;
    setQuoting(true);
    setError(null);
    try {
      const { data } = await apiFetch<OrderQuote>('/api/order/quote', {
        json: {
          source: 'form',
          intent: { side, symbol: info.symbol, qty: qtyNum, orderType: type, limitPrice: type === 'limit' ? limitNum : null },
        },
      });
      setQuote(data);
    } catch (err) {
      setError(err instanceof ApiClientError ? err : new ApiClientError('INTERNAL', 'Something went wrong. Try again.', 0));
    } finally {
      setQuoting(false);
    }
  };

  const busy = signer.busy || signer.lockedElsewhere;
  const done = signer.phase === 'done' || signer.phase === 'pending';
  const inputsLocked = busy || done;

  return (
    <div className="card p-5">
      {/* 1. Buy / Sell — mint and salmon, not alarm red */}
      <div className="grid grid-cols-2 gap-1 rounded-full border border-border p-1" role="group" aria-label="Side">
        {(['buy', 'sell'] as const).map((v) => (
          <button
            key={v}
            type="button"
            disabled={inputsLocked}
            onClick={() => edit(setSide)(v)}
            aria-pressed={side === v}
            className={cx(
              'min-h-[40px] rounded-full text-[14px] font-semibold transition-colors',
              side === v
                ? v === 'buy'
                  ? 'bg-up/15 text-up ring-1 ring-up/40'
                  : 'bg-down/15 text-down ring-1 ring-down/40'
                : 'text-text-3 hover:text-text',
            )}
          >
            {v === 'buy' ? 'Buy' : 'Sell'}
          </button>
        ))}
      </div>

      {/* 2. Market / Limit */}
      <div className="mt-4 flex items-center gap-5 border-b border-border-soft" role="tablist" aria-label="Order type">
        {(['market', 'limit'] as const).map((v) => {
          const locked = v === 'limit' && limitLocked;
          return (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={type === v}
              disabled={inputsLocked || Boolean(locked)}
              onClick={() => {
                edit(setType)(v);
                if (v === 'limit' && price != null && !limit) setLimit(price < 1 ? price.toPrecision(4) : price.toFixed(2));
              }}
              title={
                locked === 'venue'
                  ? "Limit orders aren't available on this venue yet"
                  : locked === 'tier'
                    ? 'Limit orders open at Tier 3'
                    : undefined
              }
              className={cx(
                '-mb-px flex items-center gap-2 border-b-2 pb-2.5 text-[13.5px] transition-colors',
                type === v ? 'border-accent-fg text-text' : 'border-transparent text-text-3 hover:text-text',
                locked && 'cursor-not-allowed hover:text-text-3',
              )}
            >
              {v === 'market' ? 'Market' : 'Limit'}
              {locked === 'tier' ? <TierLockLabel tier="tier3" className="border-none bg-transparent px-0 py-0 text-[10px]" /> : null}
            </button>
          );
        })}
      </div>

      {/* 3. Amount */}
      <div className="mt-4">
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          <label htmlFor="ticket-qty" className="text-[12.5px] text-text-2">
            Amount
          </label>
          <span className="font-mono text-[11px] text-text-3">
            {balances
              ? side === 'buy'
                ? `${formatUsd(balances.cash)} ${balances.cashSymbol}`
                : `${formatQty(balances.held)} ${info.symbol} held`
              : 'balance —'}
          </span>
        </div>
        <div
          className={cx(
            'flex items-center rounded-panel border bg-surface-2 px-3.5 focus-within:border-text-3',
            balanceError || serverQtyError ? 'border-down/60' : 'border-border',
          )}
        >
          <input
            id="ticket-qty"
            inputMode="decimal"
            autoComplete="off"
            disabled={inputsLocked}
            value={qty}
            onChange={(e) => edit(setQty)(e.target.value.replace(/[^0-9.]/g, ''))}
            placeholder="0"
            aria-invalid={Boolean(balanceError || serverQtyError)}
            aria-describedby="ticket-qty-msg"
            className="h-12 min-w-0 flex-1 bg-transparent font-mono text-[18px] text-text placeholder:text-text-3 focus:outline-none"
          />
          <span className="font-mono text-[13px] text-text-3">{info.symbol}</span>
        </div>
        <div className="mt-2 grid grid-cols-4 gap-1.5">
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <button
              key={f}
              type="button"
              disabled={inputsLocked || !balances || refPrice == null}
              onClick={() => setFraction(f)}
              className="min-h-[32px] rounded-full border border-border font-mono text-[11.5px] text-text-2 transition-colors hover:border-text-3 hover:text-text disabled:opacity-40"
            >
              {f === 1 ? 'Max' : `${f * 100}%`}
            </button>
          ))}
        </div>
        <p id="ticket-qty-msg" className="min-h-[18px] pt-1.5 text-[12px] leading-snug text-down" aria-live="polite">
          {balanceError ?? serverQtyError ?? ''}
        </p>
      </div>

      {/* 4. Limit price — limit only */}
      {type === 'limit' ? (
        <div className="mt-1">
          <div className="mb-1.5 flex items-baseline justify-between gap-3">
            <label htmlFor="ticket-limit" className="text-[12.5px] text-text-2">
              Limit price
            </label>
            <span className="font-mono text-[11px] text-text-3">market {formatPriceSmart(price)}</span>
          </div>
          <div className={cx('flex items-center rounded-panel border bg-surface-2 px-3.5 focus-within:border-text-3', error?.field === 'limitPrice' ? 'border-down/60' : 'border-border')}>
            <span className="font-mono text-[13px] text-text-3">$</span>
            <input
              id="ticket-limit"
              inputMode="decimal"
              autoComplete="off"
              disabled={inputsLocked}
              value={limit}
              onChange={(e) => edit(setLimit)(e.target.value.replace(/[^0-9.]/g, ''))}
              className="h-11 min-w-0 flex-1 bg-transparent px-1.5 font-mono text-[15px] text-text focus:outline-none"
            />
          </div>
          {error?.field === 'limitPrice' ? <p className="pt-1.5 text-[12px] text-down">{error.message}</p> : null}
          {deviates ? (
            <div className="mt-2.5">
              <AckCheckbox
                message={
                  quote?.ack?.message ??
                  `Your limit is ${formatPct(Math.abs(deviation) * 100).slice(1)} ${deviation < 0 ? 'below' : 'above'} the market price.`
                }
                checked={acked}
                onChange={setAcked}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 5. Summary — from the server's quote only */}
      <div className="mt-4 border-t border-border-soft pt-4">
        {quote ? (
          <QuoteSummary quote={quote} />
        ) : (
          <dl className="space-y-2 text-[13px]">
            {[
              [side === 'buy' ? 'Est. total' : 'Est. proceeds', '—'],
              ['Est. network fee', '—'],
              ['Protocol fee', '—'],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4">
                <dt className="text-text-3">{k}</dt>
                <dd className="font-mono text-text-3">{v}</dd>
              </div>
            ))}
            <p className="pt-1 text-[11.5px] text-text-3">Totals come from the server&apos;s quote, valid for 30 seconds.</p>
          </dl>
        )}
      </div>

      {/* 6. The button */}
      <div className="mt-5 space-y-3">
        {error && error.field !== 'qty' && error.field !== 'limitPrice' ? (
          <p role="alert" className="text-[12.5px] leading-snug text-down">
            {error.code === 'TIER_REQUIRED' ? `${error.message} You're on ${TIER_LABELS[tier]}.` : error.message}
          </p>
        ) : null}

        {done ? null : quote ? (
          <SignButton
            quote={quote}
            side={side}
            onSign={() => void signer.sign(quote)}
            onRefresh={() => void requestQuote()}
            disabled={busy || (deviates && !acked)}
            busyLabel={signer.phase === 'signing' ? 'Confirm in wallet…' : signer.phase === 'confirming' ? 'Recording…' : null}
          />
        ) : (
          <button
            type="button"
            onClick={() => void requestQuote()}
            disabled={!qtyValid || !limitValid || Boolean(balanceError) || quoting || busy || price == null}
            className={cx('btn w-full text-sm font-semibold', side === 'buy' ? 'bg-up/90 text-white hover:bg-up dark:text-bg' : 'bg-down/80 text-white hover:bg-down/90 dark:text-bg')}
          >
            {quoting ? 'Getting a quote…' : `Review ${side} order`}
          </button>
        )}

        <OrderProgress state={signer} slow={signer.slow} onSpeedUp={signer.speedUp} onCancel={signer.cancelTx} />

        {signer.phase === 'done' ? (
          <button
            type="button"
            onClick={() => {
              signer.reset();
              setQuote(null);
              setQty('');
              setAcked(false);
            }}
            className="btn-ghost h-10 min-h-0 w-full text-[13px]"
          >
            New order
          </button>
        ) : null}
      </div>

      <p className="mt-4 text-center text-[11.5px] text-text-3">Robinchan builds the order. You sign it.</p>
    </div>
  );
}

/** The ticket's shape, for the blurred preview and the loading state. */
export function TicketPlaceholder() {
  return (
    <div className="card p-5">
      <div className="grid grid-cols-2 gap-1 rounded-full border border-border p-1">
        <span className="min-h-[40px] rounded-full bg-up/15" />
        <span className="min-h-[40px]" />
      </div>
      <div className="mt-4 flex gap-5 border-b border-border-soft pb-2.5">
        <span className="h-4 w-14 rounded bg-surface-2" />
        <span className="h-4 w-10 rounded bg-surface-2" />
      </div>
      <div className="mt-4 h-12 rounded-panel border border-border bg-surface-2" />
      <div className="mt-2 grid grid-cols-4 gap-1.5">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="h-8 rounded-full border border-border" />
        ))}
      </div>
      <div className="mt-6 space-y-2.5 border-t border-border-soft pt-4">
        <span className="block h-3.5 w-full rounded bg-surface-2" />
        <span className="block h-3.5 w-4/5 rounded bg-surface-2" />
        <span className="block h-3.5 w-3/5 rounded bg-surface-2" />
      </div>
      <div className="mt-5 h-11 rounded-full bg-up/60" />
      <span className="mx-auto mt-4 block h-3 w-48 rounded bg-surface-2" />
    </div>
  );
}
