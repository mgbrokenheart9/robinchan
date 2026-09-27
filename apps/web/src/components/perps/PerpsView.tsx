'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type {
  ApiEnvelope,
  CandleInterval,
  CandleSeries,
  PerpAccount,
  PerpCategory,
  PerpMarket,
  PerpPosition,
  PerpWaitingOrder,
} from '@robinchan/shared';
import { CANDLE_INTERVALS, formatPct, isMainnet, perpMarket } from '@robinchan/shared';

import type { PriceLineSpec } from '@/components/charts/CandleChart';
import { useCompanion, usePageContext } from '@/components/companion/CompanionProvider';
import { ConnectGate } from '@/components/states';
import { PageHeader, Pill } from '@/components/ui';
import { useSession } from '@/components/wallet/SessionProvider';
import { useConfig } from '@/lib/config';
import { useApi, type Resource } from '@/lib/useApi';

import { AccountCard, AccountSkeleton } from './AccountCard';
import { marketPrice } from './format';
import { MarketBoard, MarketHeader } from './MarketBoard';
import { PerpChart } from './PerpChart';
import { PerpTicket, TicketPlaceholder } from './PerpTicket';
import { PositionsPanel } from './PositionsPanel';
import { SAMPLE_ACCOUNT, SAMPLE_POSITIONS } from './sample';
import { VenueCard } from './VenueCard';

const POLL = { markets: 6_000, candles: 30_000, positions: 6_000, account: 15_000, orders: 15_000, history: 60_000 } as const;

/* The last chart interval comes back next visit — as on the old Trade page. */
const INTERVAL_KEY = 'robinchan.perps-interval';
const DEFAULT_INTERVAL: CandleInterval = '1H';
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
    /* applies for this visit */
  }
  for (const l of intervalListeners) l();
}

function subscribeInterval(listener: () => void): () => void {
  intervalListeners.add(listener);
  return () => intervalListeners.delete(listener);
}

function sampleResource<T>(data: T): Resource<T> {
  return { data, status: 'ready', stale: false, asOf: null, error: null, refreshing: false, reload: () => {}, set: () => {} };
}

/**
 * Perps (Agri Perps brief §1, §8) — replaces Trade. Pick a market (agri,
 * crypto, stocks), read its chart and terms, size a position on the ticket,
 * and follow it below with live PnL.
 *
 * Layout at 1112px: the market board full width; the market header, chart
 * and positions in the main column beside a 340px sticky column with the
 * ticket and the account. Below 1024px it stacks, ticket before the chart.
 */
export function PerpsView({
  initialSymbol,
  initialMarkets,
}: {
  initialSymbol: string;
  initialMarkets: ApiEnvelope<PerpMarket[]> | null;
}) {
  const s = useSession();
  const cfg = useConfig();
  const companion = useCompanion();
  const [symbol, setSymbol] = useState(initialSymbol);
  const [category, setCategory] = useState<PerpCategory>(perpMarket(initialSymbol)?.category ?? 'crypto');
  const interval = useSyncExternalStore(subscribeInterval, readInterval, () => DEFAULT_INTERVAL);

  usePageContext({ page: 'perps', symbol });

  const key = s.signedIn && s.session ? s.session.address.toLowerCase() : '';
  const markets = useApi<PerpMarket[]>('/api/perps/markets', { intervalMs: POLL.markets, initial: initialMarkets });
  const candles = useApi<CandleSeries>(`/api/perps/candles/${symbol}?interval=${interval}`, { intervalMs: POLL.candles, keepPrevious: true });
  const account = useApi<PerpAccount>(key ? `/api/perps/collateral?as=${key}` : null, { intervalMs: POLL.account });
  const positions = useApi<PerpPosition[]>(key ? `/api/perps/positions?as=${key}` : null, { intervalMs: POLL.positions });
  const history = useApi<PerpPosition[]>(key ? `/api/perps/history?limit=50&as=${key}` : null, { intervalMs: POLL.history });
  // On chain, orders wait for Chainlink's next price — hours on a quiet feed.
  const onChain = cfg.perpsVenue === 'agri-perp';
  const orders = useApi<PerpWaitingOrder[]>(key && onChain ? `/api/perps/orders?as=${key}` : null, { intervalMs: POLL.orders });

  const market = markets.data?.find((m) => m.symbol === symbol) ?? null;

  const pick = useCallback((next: string) => {
    setSymbol(next);
    const def = perpMarket(next);
    if (def) setCategory(def.category);
    // Keep the URL shareable without a server round trip.
    window.history.replaceState(null, '', `/perps?symbol=${encodeURIComponent(next)}`);
  }, []);

  const pickCategory = (c: PerpCategory) => {
    setCategory(c);
    const first = markets.data?.find((m) => m.category === c && m.status !== 'unavailable') ?? markets.data?.find((m) => m.category === c);
    if (first && perpMarket(symbol)?.category !== c) pick(first.symbol);
  };

  const { reload: reloadAccount } = account;
  const { reload: reloadPositions } = positions;
  const { reload: reloadHistory } = history;
  const { reload: reloadOrders } = orders;
  const refresh = useCallback(() => {
    reloadAccount();
    reloadPositions();
    reloadHistory();
    reloadOrders();
  }, [reloadAccount, reloadPositions, reloadHistory, reloadOrders]);

  // Entry and liquidation lines for positions on the market in view.
  const lines = useMemo<PriceLineSpec[]>(
    () =>
      (positions.data ?? [])
        .filter((p) => p.symbol === symbol)
        .flatMap((p) => [
          { id: `${p.id}:entry`, price: p.entryPrice, side: p.side === 'long' ? ('buy' as const) : ('sell' as const), label: `${p.side} ${p.leverage}×` },
          { id: `${p.id}:liq`, price: p.liquidationPrice, side: 'sell' as const, label: 'liq.' },
        ]),
    [positions.data, symbol],
  );

  // When the market changes, Robinchan reads one line of it — conditions,
  // never a suggestion — beside her avatar, clear of the ticket.
  const greeted = useRef<string | null>(null);
  useEffect(() => {
    if (!market || greeted.current === symbol) return;
    greeted.current = symbol;
    if (market.status === 'unavailable') {
      companion.say(`${market.symbol} (${market.localName}) can't be traded: Chainlink has no price feed for it on Robinhood Chain.`);
      return;
    }
    const move = market.change24hPct == null ? '' : `, ${formatPct(market.change24hPct)} over 24h`;
    const state = market.status === 'open' ? '' : market.status === 'closed' ? ' The market is closed right now.' : ' It is close-only right now.';
    companion.say(`${market.symbol} is at ${marketPrice(market.price, market.unit)}${move}.${state}`);
  }, [market, symbol, companion]);

  const venueLabel =
    cfg.perpsVenue === 'paper'
      ? 'paper venue · dev'
      : cfg.perpsVenue === 'agri-perp'
        ? isMainnet(cfg.chain)
          ? 'live on Robinhood Chain mainnet'
          : `on chain · ${cfg.chain?.name ?? 'AgriPerp'}`
        : 'venue not configured';

  return (
    <>
      <PageHeader
        eyebrow="Perps"
        title="Crypto and stock perpetuals"
        lead={`Long or short crypto (up to 20×) and US stocks (up to 5×) — priced by Chainlink on Robinhood Chain, settled in ${cfg.perpsCollateral}, signed in your own wallet. The agri markets are listed, but Chainlink has no feed for them yet.`}
        aside={<Pill tone={cfg.perpsVenue === 'agri-perp' ? 'accent' : 'muted'}>{venueLabel}</Pill>}
      />

      {/* Above the peeking Robinchan (z-20) wherever they meet: the ticket
          and the board always take the click, never her. */}
      <div className="relative z-[21] space-y-4">
        <MarketBoard markets={markets} category={category} symbol={symbol} onCategory={pickCategory} onSymbol={pick} />

        {/* One ticket, placed by the grid: after the header on a phone, a sticky column on desktop. */}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:grid-rows-[auto_auto_1fr]">
          <div className="min-w-0 lg:col-start-1 lg:row-start-1">
            <MarketHeader market={market} loading={markets.status === 'loading'} />
          </div>
          <aside className="min-w-0 lg:col-start-2 lg:row-span-3 lg:row-start-1" aria-label="Order ticket">
            <div className="lg:sticky lg:top-[calc(76px+24px)]">
              <TicketColumn market={market} account={account} address={s.session?.address ?? ''} onSettled={refresh} venueConfigured={Boolean(cfg.perpsVenue)} />
            </div>
          </aside>
          <div className="min-w-0 lg:col-start-1 lg:row-start-2">
            <PerpChart symbol={symbol} interval={interval} onInterval={writeInterval} candles={candles} lines={lines} />
          </div>
          <div className="min-w-0 lg:col-start-1 lg:row-start-3">
            <ConnectGate
              title="Connect to see your positions"
              body="Open positions with live PnL, funding and liquidation prices — and everything you've closed."
              sample={<PositionsPanel positions={sampleResource(SAMPLE_POSITIONS)} history={sampleResource<PerpPosition[]>([])} onSymbol={() => {}} onSettled={() => {}} sample />}
              skeleton={<PositionsPanel positions={sampleResource<PerpPosition[]>([])} history={sampleResource<PerpPosition[]>([])} onSymbol={() => {}} onSettled={() => {}} sample />}
            >
              <PositionsPanel positions={positions} history={history} orders={onChain ? orders : undefined} onSymbol={pick} onSettled={refresh} />
            </ConnectGate>
          </div>
        </div>

        {onChain ? <VenueCard /> : null}
      </div>
    </>
  );
}

function TicketColumn({
  market,
  account,
  address,
  onSettled,
  venueConfigured,
}: {
  market: PerpMarket | null;
  account: Resource<PerpAccount>;
  address: string;
  onSettled: () => void;
  venueConfigured: boolean;
}) {
  if (!venueConfigured) {
    return (
      <div className="card p-5">
        <p className="t-eyebrow mb-3">Order</p>
        <p className="t-h3 mb-2">Trading isn&apos;t set up here</p>
        <p className="text-[13px] leading-relaxed text-text-2">
          This server has no perps venue configured: prices and charts are live, but positions can&apos;t be opened.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <ConnectGate
        compact
        title="Connect to trade perps"
        body="Pick a side, collateral and leverage, see the quote, and sign it in your own wallet."
        sample={<TicketPlaceholder />}
        skeleton={<TicketPlaceholder />}
      >
        {market ? <PerpTicket key={`${market.symbol}:${address}`} market={market} account={account.data ?? null} onSettled={onSettled} /> : <TicketPlaceholder />}
      </ConnectGate>
      <ConnectGate compact title="Your account" body="Collateral, equity and unrealized PnL." sample={<AccountCard account={sampleResource(SAMPLE_ACCOUNT)} address="" onChanged={() => {}} />} skeleton={<AccountSkeleton />}>
        <AccountCard account={account} address={address} onChanged={onSettled} />
      </ConnectGate>
    </div>
  );
}
