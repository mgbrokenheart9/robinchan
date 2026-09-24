'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type {
  CandleInterval,
  CandleSeries,
  HeatBoard,
  OrderRecord,
  PortfolioSummary,
  Ticker,
} from '@robinchan/shared';
import { CANDLE_INTERVALS, POLL_MS, formatPct, formatPriceSmart, symbolInfo, tierAtLeast } from '@robinchan/shared';

import { useCompanion, usePageContext } from '@/components/companion/CompanionProvider';
import { ConnectGate } from '@/components/states';
import { useSession } from '@/components/wallet/SessionProvider';
import { ApiClientError, apiFetch } from '@/lib/api';
import { useApi } from '@/lib/useApi';

import { OrderTicket, TicketPlaceholder, type TicketBalances } from './OrderTicket';
import { ChartCard, SymbolHeader, TradeTabs } from './TradeParts';

const INTERVAL_KEY = 'robinchan.chart-interval';
const DEFAULT_INTERVAL: CandleInterval = '1H';

/**
 * The last chart interval a user picked comes back next visit (Trade §3):
 * kept in localStorage, read through `useSyncExternalStore` so the server
 * render (default) and the client render (stored) reconcile cleanly. The
 * in-memory copy keeps the choice working when storage is blocked.
 */
let memoryInterval: CandleInterval | null = null;
const intervalListeners = new Set<() => void>();

function readInterval(): CandleInterval {
  if (memoryInterval) return memoryInterval;
  try {
    const saved = window.localStorage.getItem(INTERVAL_KEY);
    if (saved && (CANDLE_INTERVALS as readonly string[]).includes(saved)) return saved as CandleInterval;
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_INTERVAL;
}

function writeInterval(next: CandleInterval): void {
  memoryInterval = next;
  try {
    window.localStorage.setItem(INTERVAL_KEY, next);
  } catch {
    /* not persisted; applies for this visit */
  }
  for (const l of intervalListeners) l();
}

function subscribeInterval(listener: () => void): () => void {
  intervalListeners.add(listener);
  return () => intervalListeners.delete(listener);
}

/**
 * Trade (Trade-Heat-Portfolio §3–4): for people who want to look at the
 * chart before they order. The chat is quicker for someone who knows what
 * they want; this is for checking first. Both fill in the same order object
 * and send it down the same pipeline.
 *
 * Layout at 1112px: symbol header full width; chart 736px beside the
 * 360px sticky ticket; the order/position tabs full width below.
 */
export function TradeView({ initialSymbol }: { initialSymbol: string }) {
  const s = useSession();
  const companion = useCompanion();
  const [symbol, setSymbol] = useState(initialSymbol);
  const interval = useSyncExternalStore(subscribeInterval, readInterval, () => DEFAULT_INTERVAL);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const info = symbolInfo(symbol) ?? (symbolInfo('NVDA') as NonNullable<ReturnType<typeof symbolInfo>>);

  usePageContext({ page: 'trade', symbol });

  const pickInterval = writeInterval;

  const pickSymbol = (next: string) => {
    setSymbol(next);
    // Keep the URL shareable without a server round trip.
    window.history.replaceState(null, '', `/trade?symbol=${encodeURIComponent(next)}`);
  };

  const as = s.signedIn && s.session ? `as=${s.session.address.toLowerCase()}` : '';
  const quote = useApi<Ticker>(`/api/market/quote/${symbol}`, { intervalMs: POLL_MS.quote });
  const candles = useApi<CandleSeries>(`/api/market/candles/${symbol}?interval=${interval}`, {
    intervalMs: POLL_MS.candles,
    keepPrevious: true,
  });
  const portfolio = useApi<PortfolioSummary>(s.signedIn ? `/api/portfolio?${as}` : null, { intervalMs: POLL_MS.portfolio });
  const openOrders = useApi<OrderRecord[]>(s.signedIn ? `/api/orders?status=open&symbol=${symbol}&${as}` : null, {
    intervalMs: POLL_MS.orders,
  });
  const history = useApi<OrderRecord[]>(s.signedIn ? `/api/orders?status=history&symbol=${symbol}&${as}` : null, {
    intervalMs: POLL_MS.orders * 3,
  });
  const pending = useApi<OrderRecord[]>(s.signedIn ? `/api/orders?status=pending&${as}` : null);
  const watchlist = useApi<string[]>(s.signedIn ? `/api/user/watchlist?${as}` : null);

  const p = portfolio.data;
  const holding = p ? ([...p.holdings, ...p.dust].find((h) => h.symbol === symbol) ?? null) : null;
  const balances: TicketBalances | null = p
    ? {
        cash: [...p.holdings, ...p.dust].find((h) => h.costBasis === 'cash')?.qty ?? 0,
        cashSymbol: [...p.holdings, ...p.dust].find((h) => h.costBasis === 'cash')?.symbol ?? 'USDC',
        held: holding?.qty ?? 0,
        native: p.native.qty,
        nativeSymbol: p.native.symbol,
      }
    : null;

  // Resting limit orders, drawn on the chart (Trade §3).
  const lines = useMemo(
    () =>
      (openOrders.data ?? [])
        .filter((o) => o.limitPrice != null)
        .map((o) => ({
          id: o.id,
          price: o.limitPrice as number,
          side: o.side,
          label: `${o.side === 'buy' ? 'Buy' : 'Sell'} ${o.qty}`,
        })),
    [openOrders.data],
  );

  const { reload: reloadPortfolio } = portfolio;
  const { reload: reloadOpen } = openOrders;
  const { reload: reloadHistory } = history;
  const { reload: reloadPending } = pending;
  const refreshAfterOrder = useCallback(() => {
    reloadPortfolio();
    reloadOpen();
    reloadHistory();
    reloadPending();
  }, [reloadPortfolio, reloadOpen, reloadHistory, reloadPending]);

  const cancel = async (o: OrderRecord) => {
    setCancelling(o.id);
    setCancelError(null);
    try {
      await apiFetch(`/api/orders/${o.id}/cancel`, { json: {} });
    } catch (err) {
      setCancelError(err instanceof ApiClientError ? err.message : "Couldn't cancel that order.");
    } finally {
      setCancelling(null);
      openOrders.reload();
      history.reload();
    }
  };

  const watchOn = (watchlist.data ?? []).includes(symbol);
  const toggleWatch = async () => {
    const list = watchlist.data ?? [];
    const next = watchOn ? list.filter((x) => x !== symbol) : [...list, symbol];
    try {
      const { data } = await apiFetch<string[]>('/api/user/watchlist', { method: 'PUT', json: { symbols: next } });
      watchlist.set(data);
    } catch {
      watchlist.reload();
    }
  };

  // When the symbol changes, Robinchan says one line about it — a reading
  // of conditions, never a suggestion — and keeps out of the ticket's way.
  const greeted = useRef<string | null>(null);
  const live = quote.data;
  useEffect(() => {
    if (!live || live.symbol !== symbol || greeted.current === symbol) return;
    greeted.current = symbol;
    let cancelled = false;
    void apiFetch<HeatBoard>(`/api/heat/full?${as}`)
      .then(({ data }) => data.rows.find((r) => !r.locked && r.symbol === symbol))
      .catch(() => undefined)
      .then((row) => {
        if (cancelled) return;
        const move = Math.abs(live.changePct) < 0.05 ? 'flat' : `${live.changePct > 0 ? 'up' : 'down'} ${formatPct(Math.abs(live.changePct)).slice(1)}`;
        const heat = row && !row.locked ? `, #${row.rank} on the heat board` : '';
        companion.say(`${symbol} is ${move} today at ${formatPriceSmart(live.price)}${heat}.`);
      });
    return () => {
      cancelled = true;
    };
  }, [live, symbol, as, companion]);

  return (
    <>
      <SymbolHeader
        info={info}
        quote={quote}
        onSymbol={pickSymbol}
        watch={{
          can: tierAtLeast(s.tier?.tier ?? 'free', 'tier1'),
          on: watchOn,
          toggle: () => void toggleWatch(),
          signedIn: s.signedIn,
        }}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0">
          <ChartCard symbol={symbol} interval={interval} onInterval={pickInterval} candles={candles} lines={lines} />
        </div>
        <aside className="lg:sticky lg:top-[calc(76px+24px)] lg:self-start" aria-label="Order ticket">
          <ConnectGate
            compact
            title="Connect to trade"
            body="Build a market or limit order, see the quote, and sign it in your own wallet."
            sample={<TicketPlaceholder />}
            skeleton={<TicketPlaceholder />}
          >
            <OrderTicket
              key={`${symbol}:${s.session?.address ?? ''}`}
              info={info}
              price={quote.data?.symbol === symbol ? quote.data.price : null}
              balances={balances}
              pendingOrder={pending.data?.[0] ?? null}
              onSettled={refreshAfterOrder}
            />
          </ConnectGate>
        </aside>
      </div>

      <div className="mt-4">
        {s.signedIn ? (
          <TradeTabs
            symbol={symbol}
            openOrders={openOrders}
            history={history}
            holding={holding}
            holdingStatus={portfolio.status}
            onCancel={(o) => void cancel(o)}
            cancelling={cancelling}
            cancelError={cancelError}
          />
        ) : (
          <div className="card px-5 py-8 text-center text-[13px] text-text-3">
            Your open orders, history and position for {symbol} show here once a wallet is connected.
          </div>
        )}
      </div>
    </>
  );
}
