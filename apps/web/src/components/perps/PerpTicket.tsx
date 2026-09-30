'use client';

import { useState } from 'react';
import type { PerpAccount, PerpActionRecord, PerpMarket, PerpOpenQuote, PerpSide } from '@robinchan/shared';
import {
  PERP_FEE_BPS,
  PERP_LIQUIDATION_THRESHOLD,
  formatNative,
  formatUsd,
  perpComingSoon,
  perpLiquidationPrice,
} from '@robinchan/shared';

import { SignButton } from '@/components/orders/OrderParts';
import { cx } from '@/components/ui';
import { ApiClientError, apiFetch } from '@/lib/api';
import { perpPath, usePerpNetwork } from '@/lib/perpNetwork';
import { useConfig } from '@/lib/config';
import { usePerpSigner } from '@/lib/usePerpSigner';

import { fundingLabel, leverageMarks, marketPrice } from './format';
import { PerpProgress } from './PerpProgress';

/**
 * The perps ticket (brief §8B), top to bottom: long/short, collateral with
 * 25/50/75/Max, leverage, the summary, the button.
 *
 * Until "Review" the summary is the page's own estimate, marked as such;
 * after it, every number is the server's quote — the one that's signed.
 * The checks here only put a message next to the right input early; the
 * server makes the same checks and decides.
 */
export function PerpTicket({
  market,
  account,
  onSettled,
}: {
  market: PerpMarket;
  account: PerpAccount | null;
  onSettled: (record: PerpActionRecord) => void;
}) {
  const signer = usePerpSigner({ onSettled });
  const { network } = usePerpNetwork();
  const collateralSymbol = useConfig().perpsCollateral;
  const [side, setSide] = useState<PerpSide>('long');
  const [collateral, setCollateral] = useState('');
  const [leverage, setLeverage] = useState(Math.min(5, market.maxLeverage));
  const [quote, setQuote] = useState<PerpOpenQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);

  /** Any edit invalidates the quote: it was for the old values. */
  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setQuote(null);
    setError(null);
  };

  if (market.status !== 'open') {
    return (
      <div className="card p-5">
        <p className="t-eyebrow mb-3">Order</p>
        <p className="t-h3 mb-2">
          {market.status === 'unavailable'
            ? perpComingSoon(market)
              ? `${market.symbol} is coming soon`
              : `${market.symbol} can't be traded yet`
            : market.status === 'halted'
              ? `${market.symbol} is close-only`
              : `${market.symbol} is closed right now`}
        </p>
        <p className="text-[13px] leading-relaxed text-text-2">{market.statusNote}</p>
        {market.status !== 'unavailable' ? (
          <p className="mt-3 text-[12px] leading-relaxed text-text-3">Open positions stay listed below; they can be closed once a fresh price comes in.</p>
        ) : null}
      </div>
    );
  }

  const num = Number(collateral);
  const valid = collateral.trim() !== '' && Number.isFinite(num) && num > 0;
  const size = valid ? num * leverage : 0;
  const feeRate = PERP_FEE_BPS / 10_000;
  const estFee = size * feeRate;
  const free = account?.free ?? 0;
  const walletUsdc = account?.walletUsdc ?? 0;
  const spendable = account?.venue === 'agri-perp' ? free + walletUsdc : free;
  const balanceError = valid && account && num + estFee > spendable + 1e-9
    ? `This needs about ${formatUsd(num + estFee)} with the fee; you have ${formatUsd(spendable)}${account.venue === 'agri-perp' ? ' in the vault and wallet' : ' free'}.`
    : null;
  const fieldError = error && (error.field === 'collateral' || error.field === 'leverage') ? error.message : null;
  const estLiq = valid && market.price
    ? perpLiquidationPrice({ side, entry: market.price, collateral: num, size, threshold: PERP_LIQUIDATION_THRESHOLD })
    : null;

  const setFraction = (f: number) => {
    const usable = spendable / (1 + feeRate * leverage);
    const v = Math.floor(usable * f * 100) / 100;
    edit(setCollateral)(v > 0 ? String(v) : '');
  };

  const requestQuote = async () => {
    if (!valid) return;
    setQuoting(true);
    setError(null);
    try {
      const { data } = await apiFetch<PerpOpenQuote>(perpPath('/api/perps/quote', network), {
        json: { action: 'open', symbol: market.symbol, side, collateral: num, leverage },
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
  const locked = busy || done;
  const marks = leverageMarks(market.maxLeverage);
  const onChain = account?.venue === 'agri-perp';

  const summary: Array<[string, string, 'emphasis' | 'muted' | 'danger' | null]> = quote
    ? [
        ['Size', formatUsd(quote.size), 'emphasis'],
        ['Mark price', marketPrice(quote.markPrice, market.unit), null],
        ['Fill no worse than', marketPrice(quote.acceptablePrice, market.unit), 'muted'],
        ['Liquidation price', marketPrice(quote.liquidationPrice, market.unit), 'danger'],
        [`Opening fee (${(quote.feeBps / 100).toFixed(2)}%)`, formatUsd(quote.fee), 'muted'],
        ['Funding', fundingLabel(quote.fundingRatePerHour), 'muted'],
        ...(onChain
          ? ([
              ['From wallet', quote.depositNeeded > 0 ? `${formatUsd(quote.depositNeeded)} ${collateralSymbol}` : 'none', 'muted'],
              ['Execution + network fee', formatNative(quote.executionFee + quote.estGas, quote.gasSymbol), 'muted'],
            ] as Array<[string, string, 'muted']>)
          : []),
      ]
    : [
        ['Size', valid ? formatUsd(size) : '—', 'emphasis'],
        ['Mark price', marketPrice(market.price, market.unit), null],
        ['Est. liquidation', estLiq != null ? marketPrice(estLiq, market.unit) : '—', 'danger'],
        [`Est. opening fee (${(PERP_FEE_BPS / 100).toFixed(2)}%)`, valid ? formatUsd(estFee) : '—', 'muted'],
        ['Funding', fundingLabel(market.fundingRatePerHour), 'muted'],
      ];

  return (
    <div className="card p-5">
      {/* 1. Long / Short — mint and salmon, as tints */}
      <div className="grid grid-cols-2 gap-1 rounded-full border border-border p-1" role="group" aria-label="Direction">
        {(['long', 'short'] as const).map((v) => (
          <button
            key={v}
            type="button"
            disabled={locked}
            onClick={() => edit(setSide)(v)}
            aria-pressed={side === v}
            className={cx(
              'min-h-[40px] rounded-full text-[14px] font-semibold transition-colors',
              side === v
                ? v === 'long'
                  ? 'bg-up/15 text-up ring-1 ring-up/40'
                  : 'bg-down/15 text-down ring-1 ring-down/40'
                : 'text-text-3 hover:text-text',
            )}
          >
            {v === 'long' ? 'Long ↑' : 'Short ↓'}
          </button>
        ))}
      </div>

      {/* 2. Collateral */}
      <div className="mt-4">
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          <label htmlFor="perp-collateral" className="text-[12.5px] text-text-2">
            Collateral
          </label>
          <span className="font-mono text-[11px] text-text-3">
            {account ? (onChain ? `${formatUsd(free)} vault · ${formatUsd(walletUsdc)} wallet` : `${formatUsd(free)} free`) : 'balance —'}
          </span>
        </div>
        <div
          className={cx(
            'flex items-center rounded-panel border bg-surface-2 px-3.5 focus-within:border-text-3',
            balanceError || fieldError ? 'border-down/60' : 'border-border',
          )}
        >
          <input
            id="perp-collateral"
            inputMode="decimal"
            autoComplete="off"
            disabled={locked}
            value={collateral}
            onChange={(e) => edit(setCollateral)(e.target.value.replace(/[^0-9.]/g, ''))}
            placeholder="0.00"
            aria-invalid={Boolean(balanceError || fieldError)}
            aria-describedby="perp-collateral-msg"
            className="h-12 min-w-0 flex-1 bg-transparent font-mono text-[18px] text-text placeholder:text-text-3 focus:outline-none"
          />
          <span className="font-mono text-[13px] text-text-3">{collateralSymbol}</span>
        </div>
        <div className="mt-2 grid grid-cols-4 gap-1.5">
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <button
              key={f}
              type="button"
              disabled={locked || !account || spendable <= 0}
              onClick={() => setFraction(f)}
              className="min-h-[32px] rounded-full border border-border font-mono text-[11.5px] text-text-2 transition-colors hover:border-text-3 hover:text-text disabled:opacity-40"
            >
              {f === 1 ? 'Max' : `${f * 100}%`}
            </button>
          ))}
        </div>
        <p id="perp-collateral-msg" className="min-h-[18px] pt-1.5 text-[12px] leading-snug text-down" aria-live="polite">
          {balanceError ?? fieldError ?? ''}
        </p>
      </div>

      {/* 3. Leverage */}
      <div className="mt-1">
        <div className="mb-1.5 flex items-baseline justify-between">
          <label htmlFor="perp-leverage" className="text-[12.5px] text-text-2">
            Leverage
          </label>
          <span className="font-mono text-[13px] text-accent-fg">{leverage}×</span>
        </div>
        <input
          id="perp-leverage"
          type="range"
          min={1}
          max={market.maxLeverage}
          step={1}
          value={leverage}
          disabled={locked}
          onChange={(e) => edit(setLeverage)(Number(e.target.value))}
          className="w-full accent-[rgb(var(--c-accent-fg))]"
          aria-valuetext={`${leverage} times`}
        />
        <div className="mt-1 flex justify-between font-mono text-[10.5px] text-text-3">
          {marks.map((mk) => (
            <button key={mk} type="button" disabled={locked} onClick={() => edit(setLeverage)(mk)} className="hover:text-text">
              {mk}×
            </button>
          ))}
        </div>
      </div>

      {/* 4. Summary — estimates until the quote, then the quote */}
      <div className="mt-4 border-t border-border-soft pt-4">
        <dl className="space-y-2">
          {summary.map(([label, value, tone]) => (
            <div key={label} className="flex items-baseline justify-between gap-4">
              <dt className={cx('text-[13px]', tone === 'muted' ? 'text-text-3' : 'text-text-2')}>{label}</dt>
              <dd
                className={cx(
                  'text-right font-mono',
                  tone === 'emphasis'
                    ? 'text-[15px] text-text'
                    : tone === 'danger'
                      ? 'text-[13px] text-down'
                      : tone === 'muted'
                        ? 'text-[12px] text-text-3'
                        : 'text-[13px] text-text',
                )}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
        <p className="pt-2 text-[11.5px] leading-snug text-text-3">
          {quote
            ? onChain
              ? market.category === 'rh'
              ? 'Your order fills at the first 15-minute average that starts after it lands, about 16 minutes on — or not at all if that price is past your limit.'
              : 'Your order fills at Chainlink’s next price after it lands — or not at all if that price is past your limit.'
              : 'Fills at the price when you sign, within the limit above.'
            : 'Estimates. The binding numbers come from the server’s quote, valid for 20 seconds.'}
        </p>
      </div>

      {/* 5. The button */}
      <div className="mt-4 space-y-3">
        {quote?.warnings.length ? (
          <ul className="space-y-1.5">
            {quote.warnings.map((w) => (
              <li key={w} className="text-[12px] leading-snug text-warning">
                {w}
              </li>
            ))}
          </ul>
        ) : null}
        {error && !fieldError ? (
          <p role="alert" className="text-[12.5px] leading-snug text-down">
            {error.message}
          </p>
        ) : null}

        {done ? null : quote ? (
          <SignButton
            quote={quote}
            side={side === 'long' ? 'buy' : 'sell'}
            label={`Open ${side} ${market.symbol}`}
            onSign={() => void signer.sign(quote)}
            onRefresh={() => void requestQuote()}
            disabled={busy}
            busyLabel={
              signer.phase === 'signing'
                ? signer.step && signer.step.total > 1
                  ? `Step ${signer.step.index + 1} of ${signer.step.total}…`
                  : 'Confirm in wallet…'
                : signer.phase === 'confirming'
                  ? 'Recording…'
                  : null
            }
          />
        ) : (
          <button
            type="button"
            onClick={() => void requestQuote()}
            disabled={!valid || Boolean(balanceError) || quoting || busy || !account}
            className={cx(
              'btn w-full text-sm font-semibold',
              side === 'long' ? 'bg-up/90 text-white hover:bg-up dark:text-bg' : 'bg-down/80 text-white hover:bg-down/90 dark:text-bg',
            )}
          >
            {quoting ? 'Getting a quote…' : `Review ${side} ${market.symbol}`}
          </button>
        )}

        <PerpProgress state={signer} kind="open" />

        {signer.phase === 'done' ? (
          <button
            type="button"
            onClick={() => {
              signer.reset();
              setQuote(null);
              setCollateral('');
            }}
            className="btn-ghost h-10 min-h-0 w-full text-[13px]"
          >
            New position
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
      <div className="mt-6 h-12 rounded-panel border border-border bg-surface-2" />
      <div className="mt-2 grid grid-cols-4 gap-1.5">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="h-8 rounded-full border border-border" />
        ))}
      </div>
      <div className="mt-6 h-2 rounded-full bg-surface-2" />
      <div className="mt-6 space-y-2.5 border-t border-border-soft pt-4">
        <span className="block h-3.5 w-full rounded bg-surface-2" />
        <span className="block h-3.5 w-4/5 rounded bg-surface-2" />
        <span className="block h-3.5 w-3/5 rounded bg-surface-2" />
      </div>
      <div className="mt-5 h-11 rounded-full bg-up/60" />
    </div>
  );
}
