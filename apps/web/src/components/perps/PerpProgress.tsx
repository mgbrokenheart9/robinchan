'use client';

import { PERP_CANCEL_DELAY_SEC, perpMarket } from '@robinchan/shared';

import { ExternalIcon } from '@/components/icons';
import { PulseDot, cx } from '@/components/ui';
import type { PerpSignerState } from '@/lib/usePerpSigner';

const DONE_TEXT: Record<'open' | 'close' | 'deposit' | 'withdraw', string> = {
  open: 'Position opened.',
  close: 'Position closed. The payout is in your free collateral.',
  deposit: 'Deposited.',
  withdraw: 'Withdrawn to your wallet.',
};

/**
 * What happened after signing: waiting on the wallet, on the chain, or (on
 * chain) on the order's execution at Chainlink's next price — with the
 * explorer link, never just a spinner — then done, or failed with the reason.
 */
/** When an asked-back order is released, in the viewer's clock. */
export function releaseTime(askedAt: string): string {
  return new Date(Date.parse(askedAt) + PERP_CANCEL_DELAY_SEC * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function PerpProgress({ state, kind }: { state: PerpSignerState; kind: 'open' | 'close' | 'deposit' | 'withdraw' }) {
  const r = state.record;
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

  if (state.error && state.phase !== 'pending' && state.phase !== 'done') {
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
    <span className="font-mono text-[11px] text-text-3">
      {r.txHash.slice(0, 10)}…{r.txHash.slice(-6)}
    </span>
  ) : null;

  if (state.phase === 'pending') {
    return (
      <div className="space-y-2 rounded-row border border-border bg-surface-2 px-3 py-2.5 text-[12.5px]" role="status">
        <p className="flex items-center gap-2 text-text">
          <PulseDot />
          {!r.awaitingExecution
            ? 'Waiting for the network to confirm…'
            : r.cancelRequestedAt
              ? `You asked for it back: it’s released by ${releaseTime(r.cancelRequestedAt)}, unless Chainlink had already observed its price — then it fills at it.`
              : r.symbol && perpMarket(r.symbol)?.twap
                ? `Request landed. It fills at the first 15-minute ${r.symbol} average that starts after it — about 16 minutes on.`
                : r.symbol && perpMarket(r.symbol)?.reported
                  ? `Request landed. It fills at the next ${r.symbol} price Robinchan posts — usually within minutes while the exchange trades.`
                  : `Request landed. It fills at Chainlink’s next ${r.symbol ?? ''} price — when the price moves 0.5%, or within a day.`}
        </p>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-text-3">
          {link}
          <span>
            {r.awaitingExecution && r.cancellable
              ? 'You can close this tab: it waits under Waiting, where you can also take it back.'
              : 'You can close this tab — the server keeps following it.'}
          </span>
        </p>
      </div>
    );
  }

  const ok = r.status === 'done';
  return (
    <div className={cx('space-y-1.5 rounded-row border px-3 py-2.5 text-[12.5px] leading-snug', ok ? 'border-up/40 bg-up/[0.07]' : 'border-down/40 bg-down/[0.07]')} role="status">
      <p className="text-text">{ok ? DONE_TEXT[kind] : (r.error ?? 'It did not go through. Nothing changed.')}</p>
      {ok && r.cancelRequestedAt ? (
        <p className="text-text-2">Chainlink had already observed the price when you asked for it back, so the order filled at it.</p>
      ) : null}
      {link ? <p className="text-text-3">{link}</p> : null}
    </div>
  );
}
