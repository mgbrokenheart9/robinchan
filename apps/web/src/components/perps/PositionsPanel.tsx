'use client';

import { Fragment, useState } from 'react';
import type { PerpActionRecord, PerpCancelQuote, PerpCloseQuote, PerpPosition, PerpWaitingOrder } from '@robinchan/shared';
import { formatPct, formatSignedUsd, formatUsd, perpMarket, relativeTime } from '@robinchan/shared';

import { ExternalIcon } from '@/components/icons';
import { SignButton } from '@/components/orders/OrderParts';
import { EmptyState, ErrorState } from '@/components/states';
import { Skeleton, cx } from '@/components/ui';
import { ApiClientError, apiFetch } from '@/lib/api';
import type { Resource } from '@/lib/useApi';
import { usePerpSigner } from '@/lib/usePerpSigner';
import { useNow } from '@/lib/usePoll';

import { marketPrice, pnlTone } from './format';
import { PerpProgress, releaseTime } from './PerpProgress';

type Tab = 'positions' | 'waiting' | 'history';

/**
 * Open positions, orders waiting for their price (on chain), and history —
 * tabs, not panels at once.
 */
export function PositionsPanel({
  positions,
  history,
  orders,
  onSymbol,
  onSettled,
  sample = false,
}: {
  positions: Resource<PerpPosition[]>;
  history: Resource<PerpPosition[]>;
  /** On chain only: orders still waiting for their Chainlink round. */
  orders?: Resource<PerpWaitingOrder[]>;
  onSymbol: (symbol: string) => void;
  onSettled: (record: PerpActionRecord) => void;
  sample?: boolean;
}) {
  const [tab, setTab] = useState<Tab>('positions');
  const open = positions.data?.length ?? 0;
  const waiting = orders?.data?.length ?? 0;
  const tabs: Array<[Tab, string]> = [['positions', `Positions${open ? ` · ${open}` : ''}`]];
  if (orders) tabs.push(['waiting', `Waiting${waiting ? ` · ${waiting}` : ''}`]);
  tabs.push(['history', 'History']);
  return (
    <section className="card overflow-hidden">
      <div className="flex items-center gap-6 border-b border-border-soft px-5" role="tablist" aria-label="Positions, waiting orders and history">
        {tabs.map(([id, label]) => (
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
      <div role="tabpanel">
        {tab === 'positions' ? (
          <OpenPositions positions={positions} onSymbol={onSymbol} onSettled={onSettled} sample={sample} />
        ) : tab === 'waiting' && orders ? (
          <WaitingOrders orders={orders} onSymbol={onSymbol} />
        ) : (
          <History history={history} onSymbol={onSymbol} />
        )}
      </div>
    </section>
  );
}

function TableSkeleton({ rows }: { rows: number }) {
  return (
    <div className="divide-y divide-border-soft" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="grid grid-cols-[1fr_auto] gap-3 px-5 py-3.5 sm:grid-cols-[150px_1fr_110px_110px_90px]">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="hidden h-4 w-20 sm:block" />
          <Skeleton className="hidden h-4 w-20 sm:block" />
          <Skeleton className="hidden h-4 w-14 sm:block" />
        </div>
      ))}
    </div>
  );
}

function MarketCell({ p, onSymbol }: { p: PerpPosition; onSymbol: (s: string) => void }) {
  return (
    <button type="button" onClick={() => onSymbol(p.symbol)} className="text-left">
      <span className="flex items-center gap-2">
        <span className={cx('rounded-full px-2 py-0.5 font-mono text-[10.5px] font-medium tracking-[0.08em]', p.side === 'long' ? 'bg-up/15 text-up' : 'bg-down/15 text-down')}>
          {p.side === 'long' ? 'LONG' : 'SHORT'}
        </span>
        <span className="font-mono text-[13px] text-text">{p.symbol}</span>
        <span className="font-mono text-[11px] text-text-3">{p.leverage}×</span>
      </span>
    </button>
  );
}

function OpenPositions({
  positions,
  onSymbol,
  onSettled,
  sample,
}: {
  positions: Resource<PerpPosition[]>;
  onSymbol: (s: string) => void;
  onSettled: (record: PerpActionRecord) => void;
  sample: boolean;
}) {
  const [closing, setClosing] = useState<string | null>(null);
  if (positions.status === 'loading') return <TableSkeleton rows={2} />;
  if (positions.status === 'error') return <ErrorState message="Your positions couldn't load right now." onRetry={positions.reload} />;
  const list = positions.data ?? [];
  if (list.length === 0) {
    return (
      <EmptyState
        title="No open positions"
        body="Positions you open show up here with their live PnL, funding and liquidation price, and can be closed from this list."
        className="py-10"
      />
    );
  }
  return (
    <div className={cx('overflow-x-auto', positions.stale && 'is-stale')}>
      <table className="w-full min-w-[760px] text-left">
        <thead>
          <tr className="border-b border-border-soft font-mono text-[10px] uppercase tracking-[0.1em] text-text-3">
            <th className="px-5 py-2.5 font-normal">Market</th>
            <th className="px-3 py-2.5 text-right font-normal">Size</th>
            <th className="px-3 py-2.5 text-right font-normal">Entry</th>
            <th className="px-3 py-2.5 text-right font-normal">Mark</th>
            <th className="px-3 py-2.5 text-right font-normal">Liq. price</th>
            <th className="px-3 py-2.5 text-right font-normal">PnL</th>
            <th className="px-5 py-2.5 text-right font-normal">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-soft">
          {list.map((p) => {
            const unit = perpMarket(p.symbol)?.unit ?? '';
            const net = p.equity == null ? null : p.equity - p.collateral;
            return (
              <Fragment key={p.id}>
                <tr className="align-top">
                  <td className="px-5 py-3">
                    <MarketCell p={p} onSymbol={onSymbol} />
                    <p className="mt-1 font-mono text-[11px] text-text-3">collateral {formatUsd(p.collateral)}</p>
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-[13px] text-text">{formatUsd(p.size)}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-[13px] text-text-2">{marketPrice(p.entryPrice, unit)}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-[13px] text-text">{marketPrice(p.markPrice, unit)}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-[13px] text-down">{marketPrice(p.liquidationPrice, unit)}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-[13px]">
                    <span className={pnlTone(net)}>{net == null ? '––' : formatSignedUsd(net)}</span>
                    <p className={cx('text-[11px]', pnlTone(net))}>{p.pnlPct == null ? 'no fresh price' : formatPct(p.pnlPct)}</p>
                    {p.fundingAccrued !== 0 ? (
                      <p className="text-[10.5px] text-text-3" title="Funding owed so far: positive is paid, negative received">
                        funding {formatSignedUsd(-p.fundingAccrued)}
                      </p>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap px-5 py-3 text-right">
                    {p.closing ? (
                      <span className="rounded-full border border-warning/40 px-2.5 py-1 font-mono text-[11px] text-warning">closing…</span>
                    ) : (
                      <button
                        type="button"
                        disabled={sample}
                        onClick={() => setClosing(closing === p.id ? null : p.id)}
                        aria-expanded={closing === p.id}
                        className="rounded-full border border-border px-3 py-1 text-[12px] text-text-2 transition-colors hover:border-text-3 hover:text-text"
                      >
                        {closing === p.id ? 'Hide' : 'Close'}
                      </button>
                    )}
                  </td>
                </tr>
                {closing === p.id ? (
                  <tr>
                    <td colSpan={7} className="bg-surface-2/60 px-5 py-4">
                      <ClosePanel
                        position={p}
                        onSettled={(r) => {
                          onSettled(r);
                          if (r.status === 'done') setClosing(null);
                        }}
                      />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Quote → sign, for one position, inline. Every figure is the server's close quote. */
function ClosePanel({ position: p, onSettled }: { position: PerpPosition; onSettled: (r: PerpActionRecord) => void }) {
  const signer = usePerpSigner({ onSettled });
  const [quote, setQuote] = useState<PerpCloseQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unit = perpMarket(p.symbol)?.unit ?? '';

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await apiFetch<PerpCloseQuote>('/api/perps/quote', { json: { action: 'close', positionId: p.id } });
      setQuote(data);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setLoading(false);
    }
  };

  const done = signer.phase === 'done' || signer.phase === 'pending';
  return (
    <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_280px] sm:items-end">
      <div>
        {quote ? (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
            {(
              [
                ['Close near', marketPrice(quote.markPrice, unit)],
                ['PnL', formatSignedUsd(quote.estPnl)],
                ['Funding', formatSignedUsd(-quote.estFunding)],
                [`Fee (${(quote.feeBps / 100).toFixed(2)}%)`, formatUsd(quote.fee)],
              ] as Array<[string, string]>
            ).map(([k, v]) => (
              <div key={k}>
                <dt className="text-[11.5px] text-text-3">{k}</dt>
                <dd className="font-mono text-[13px] text-text">{v}</dd>
              </div>
            ))}
            <div className="col-span-2 sm:col-span-4">
              <dt className="text-[11.5px] text-text-3">You receive (est.)</dt>
              <dd className="font-mono text-[18px] text-text">{formatUsd(quote.estPayout)}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-[13px] leading-relaxed text-text-2">
            Get a close quote for your {p.side} {p.symbol}: the payout at the current price, after PnL, funding and the closing fee.
          </p>
        )}
        {error ? (
          <p role="alert" className="mt-2 text-[12.5px] text-down">
            {error}
          </p>
        ) : null}
      </div>
      <div className="space-y-2">
        {done ? null : quote ? (
          <SignButton
            quote={quote}
            side={p.side === 'long' ? 'sell' : 'buy'}
            label={`Close ${p.symbol}`}
            onSign={() => void signer.sign(quote)}
            onRefresh={() => void load()}
            disabled={signer.busy || signer.lockedElsewhere}
            busyLabel={signer.phase === 'signing' ? 'Confirm in wallet…' : signer.phase === 'confirming' ? 'Recording…' : null}
          />
        ) : (
          <button type="button" onClick={() => void load()} disabled={loading} className="btn-ghost w-full text-sm">
            {loading ? 'Getting a quote…' : 'Get close quote'}
          </button>
        )}
        <PerpProgress state={signer} kind="close" />
      </div>
    </div>
  );
}

/**
 * On chain, an order fills at Chainlink's next price for its market — on a
 * quiet feed, hours away. Each waiting order can be asked back: it's then
 * released five minutes on, unless its price was already observed.
 */
function WaitingOrders({ orders, onSymbol }: { orders: Resource<PerpWaitingOrder[]>; onSymbol: (s: string) => void }) {
  const now = useNow(30_000);
  // Asks sent from this page, until the server has seen them on chain.
  const [asked, setAsked] = useState<Record<string, string>>({});
  if (orders.status === 'loading') return <TableSkeleton rows={1} />;
  if (orders.status === 'error') return <ErrorState message="Your waiting orders couldn't load right now." onRetry={orders.reload} />;
  const list = orders.data ?? [];
  if (list.length === 0) {
    return (
      <EmptyState
        title="Nothing waiting"
        body="An order fills at Chainlink's next price for its market — when the price moves 0.5%, or within a day. Until then it waits here, and you can take it back."
        className="py-10"
      />
    );
  }
  return (
    <ul className={cx('divide-y divide-border-soft', orders.stale && 'is-stale')}>
      {list.map((o) => {
        const askedAt = o.cancelRequestedAt ?? asked[o.id] ?? null;
        return (
          <li key={o.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
            <div className="min-w-0">
              <button type="button" onClick={() => onSymbol(o.symbol)} className="flex items-center gap-2 text-left">
                <span className={cx('rounded-full px-2 py-0.5 font-mono text-[10.5px] font-medium tracking-[0.08em]', o.side === 'long' ? 'bg-up/15 text-up' : 'bg-down/15 text-down')}>
                  {o.kind === 'open' ? (o.side === 'long' ? 'LONG' : 'SHORT') : 'CLOSE'}
                </span>
                <span className="font-mono text-[13px] text-text">{o.symbol}</span>
                <span className="font-mono text-[11px] text-text-3">
                  {o.leverage}× · {formatUsd(o.size)}
                </span>
              </button>
              <p className="mt-1 text-[12px] leading-snug text-text-3">
                {askedAt
                  ? `Asked back: released by ${releaseTime(askedAt)}, unless its price was already observed.`
                  : `Placed ${now == null ? '' : relativeTime(o.createdAt, now)} · fills at Chainlink’s next ${o.symbol} price, within ${marketPrice(o.acceptablePrice)}.`}
              </p>
            </div>
            {o.cancellable && !asked[o.id] ? (
              <TakeBack
                order={o}
                onAsked={() => {
                  setAsked((a) => ({ ...a, [o.id]: new Date().toISOString() }));
                  orders.reload();
                }}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Asking for a waiting order back: the server's cancel quote first, so the
 * row can say what it costs before the wallet opens — then the ask.
 */
function TakeBack({ order, onAsked }: { order: PerpWaitingOrder; onAsked: () => void }) {
  const signer = usePerpSigner();
  const [quote, setQuote] = useState<PerpCancelQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setError(null);
    setLoading(true);
    try {
      setQuote((await apiFetch<PerpCancelQuote>('/api/perps/cancel', { json: { actionId: order.id } })).data);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setLoading(false);
    }
  };
  const confirm = async () => {
    if (quote?.execution.kind !== 'transactions') return;
    if (await signer.sendPlain(quote.address, quote.execution.txs)) onAsked();
  };
  const busy = loading || signer.busy;
  const button = 'rounded-full border border-border px-3 py-1 text-[12px] text-text-2 transition-colors hover:border-text-3 hover:text-text disabled:opacity-60';
  return (
    <div className="max-w-[300px] text-right">
      {quote ? (
        <>
          <p className="mb-2 text-[12px] leading-snug text-text-2">
            {quote.openingFee > 0 ? `You get the collateral back; the ${formatUsd(quote.openingFee)} opening fee is kept. ` : ''}
            It’s released five minutes after you ask — unless its price is already on its way, and then it fills.
          </p>
          <span className="inline-flex gap-2">
            <button type="button" onClick={() => setQuote(null)} disabled={busy} className={button}>
              Keep it
            </button>
            <button type="button" onClick={() => void confirm()} disabled={busy || signer.lockedElsewhere} className={cx(button, 'border-down/50 text-down')}>
              {signer.phase === 'signing' ? 'Confirm in wallet…' : signer.phase === 'confirming' ? 'Confirming…' : 'Take it back'}
            </button>
          </span>
        </>
      ) : (
        <button type="button" onClick={() => void load()} disabled={busy} className={button}>
          {loading ? 'Checking…' : 'Take back'}
        </button>
      )}
      {error || signer.error ? (
        <p role="alert" className="mt-1 text-[12px] leading-snug text-down">
          {error ?? signer.error}
        </p>
      ) : null}
    </div>
  );
}

function History({ history, onSymbol }: { history: Resource<PerpPosition[]>; onSymbol: (s: string) => void }) {
  const now = useNow(30_000);
  if (history.status === 'loading') return <TableSkeleton rows={3} />;
  if (history.status === 'error') return <ErrorState message="Your history couldn't load right now." onRetry={history.reload} />;
  const list = history.data ?? [];
  if (list.length === 0) {
    return <EmptyState title="Nothing closed yet" body="Closed and liquidated positions are listed here with their result and explorer links." className="py-10" />;
  }
  return (
    <div className={cx('overflow-x-auto', history.stale && 'is-stale')}>
      <table className="w-full min-w-[720px] text-left">
        <thead>
          <tr className="border-b border-border-soft font-mono text-[10px] uppercase tracking-[0.1em] text-text-3">
            <th className="px-5 py-2.5 font-normal">Market</th>
            <th className="px-3 py-2.5 font-normal">Closed</th>
            <th className="px-3 py-2.5 text-right font-normal">Entry → exit</th>
            <th className="px-3 py-2.5 text-right font-normal">Result</th>
            <th className="px-3 py-2.5 text-right font-normal">Paid out</th>
            <th className="px-5 py-2.5 font-normal">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-soft">
          {list.map((p) => {
            const unit = perpMarket(p.symbol)?.unit ?? '';
            const link = p.explorerClose ?? p.explorerOpen;
            return (
              <tr key={p.id} className="align-top">
                <td className="px-5 py-3">
                  <MarketCell p={p} onSymbol={onSymbol} />
                  <p className="mt-1 font-mono text-[11px] text-text-3">
                    {formatUsd(p.size)} · collateral {formatUsd(p.collateral)}
                  </p>
                </td>
                <td className="whitespace-nowrap px-3 py-3 font-mono text-[12px] text-text-3" title={p.closedAt ? new Date(p.closedAt).toLocaleString() : undefined}>
                  {now == null || !p.closedAt ? '—' : relativeTime(p.closedAt, now)}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-[12.5px] text-text-2">
                  {marketPrice(p.entryPrice, unit)} → {marketPrice(p.exitPrice, unit)}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-[13px]">
                  <span className={pnlTone(p.realizedPnl)}>{formatSignedUsd(p.realizedPnl)}</span>
                  <p className={cx('text-[11px]', pnlTone(p.realizedPnl))}>{formatPct(p.pnlPct)}</p>
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-[13px] text-text">{formatUsd(p.payout)}</td>
                <td className="whitespace-nowrap px-5 py-3">
                  <span
                    className={cx(
                      'inline-flex rounded-full border px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-[0.08em]',
                      p.status === 'liquidated' ? 'border-down/40 text-down' : 'border-border text-text-3',
                    )}
                  >
                    {p.status}
                  </span>
                  {link ? (
                    <a href={link} target="_blank" rel="noopener noreferrer" className="ml-2 inline-flex items-center gap-1 text-[12px] text-accent-fg underline-offset-2 hover:underline">
                      Explorer
                      <ExternalIcon />
                    </a>
                  ) : p.venue === 'paper' ? (
                    <span className="ml-2 font-mono text-[11px] text-text-3" title="Paper venue: signed, settled on this server, nothing moved on chain">
                      paper
                    </span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
