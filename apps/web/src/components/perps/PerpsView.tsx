'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type {
  ApiEnvelope,
  CandleInterval,
  CandleSeries,
  PerpAccount,
  PerpCategory,
  PerpChainInfo,
  PerpMarket,
  PerpNetwork,
  PerpPosition,
  PerpWaitingOrder,
} from '@robinchan/shared';
import { CANDLE_INTERVALS, PERP_NETWORK_DEFS, PRIMARY_PERP_NETWORK, formatPct, isMainnet, perpComingSoon, perpMarket } from '@robinchan/shared';
import { useAccount, useConfig as useWagmiConfig, useSwitchChain } from 'wagmi';
import { watchAccount } from 'wagmi/actions';

import type { PriceLineSpec } from '@/components/charts/CandleChart';
import { useCompanion, usePageContext } from '@/components/companion/CompanionProvider';
import { ConnectGate } from '@/components/states';
import { PageHeader, Pill } from '@/components/ui';
import { useSession } from '@/components/wallet/SessionProvider';
import { useConfig } from '@/lib/config';
import { PerpNetworkProvider, perpPath, type PerpNetworkState } from '@/lib/perpNetwork';
import { useApi, type Resource } from '@/lib/useApi';
import { walletErrorText } from '@/lib/walletError';

import { AccountCard, AccountSkeleton } from './AccountCard';
import { ChainSwitcher, UnsupportedChainBanner } from './ChainSwitcher';
import { marketPrice } from './format';
import { MarketBoard, MarketHeader } from './MarketBoard';
import { PerpChart } from './PerpChart';
import { PerpTicket, TicketPlaceholder } from './PerpTicket';
import { PositionsPanel } from './PositionsPanel';
import { RhTokensPanel } from './RhTokensPanel';
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

/** The categories a network has; the rest, with where to find them (Multichain brief). */
function categoriesElsewhere(network: PerpNetwork): Partial<Record<PerpCategory, string>> {
  if (network === PRIMARY_PERP_NETWORK) return { commodities: 'Gold, silver and oil trade on Base and Arbitrum' };
  const onRh = 'Available on RH Chain only';
  return { crypto: onRh, stocks: onRh, rh: onRh };
}

/** A network's first category: agri everywhere but where it opens on crypto. */
const firstCategory = (network: PerpNetwork): PerpCategory => (network === PRIMARY_PERP_NETWORK ? 'crypto' : 'agri');

/** The page's address: the market, and the network when it isn't the primary. */
function pageUrl(symbol: string, network: PerpNetwork): string {
  const chain = network === PRIMARY_PERP_NETWORK ? '' : `&chain=${network}`;
  return `/perps?symbol=${encodeURIComponent(symbol)}${chain}`;
}

/**
 * Perps (Agri Perps brief §1, §8) — replaces Trade. Pick a network (RH Chain,
 * Base, Arbitrum), a market, read its chart and terms, size a position on
 * the ticket, and follow it below with live PnL.
 *
 * Layout at 1112px: the market board full width; the market header, chart
 * and positions in the main column beside a 340px sticky column with the
 * ticket and the account. Below 1024px it stacks, ticket before the chart.
 */
export function PerpsView({
  initialSymbol,
  initialNetwork = PRIMARY_PERP_NETWORK,
  initialMarkets,
}: {
  initialSymbol: string;
  initialNetwork?: PerpNetwork;
  initialMarkets: ApiEnvelope<PerpMarket[]> | null;
}) {
  const s = useSession();
  const cfg = useConfig();
  const companion = useCompanion();
  const { chainId: walletChainId, isConnected } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const wagmiConfig = useWagmiConfig();
  const [network, setNetworkState] = useState<PerpNetwork>(initialNetwork);
  const [chosen, setSymbol] = useState(initialSymbol);
  const [category, setCategory] = useState<PerpCategory>(perpMarket(initialSymbol, initialNetwork)?.category ?? firstCategory(initialNetwork));
  const [switchError, setSwitchError] = useState<string | null>(null);
  const interval = useSyncExternalStore(subscribeInterval, readInterval, () => DEFAULT_INTERVAL);

  const chains = cfg.perpChains;
  const chain: PerpChainInfo | null = chains.find((c) => c.network === network) ?? null;
  const networkName = PERP_NETWORK_DEFS[network].name;
  const p = useCallback((path: string) => perpPath(path, network), [network]);

  const key = s.signedIn && s.session ? s.session.address.toLowerCase() : '';
  const markets = useApi<PerpMarket[]>(p('/api/perps/markets'), {
    intervalMs: POLL.markets,
    initial: network === initialNetwork ? initialMarkets : null,
  });
  // A market this network doesn't list (the network changed under it): its first open one in the category, or any.
  const listed = markets.data;
  const symbol =
    !listed?.length || listed.some((m) => m.symbol === chosen)
      ? chosen
      : (listed.find((m) => m.category === category && m.status !== 'unavailable') ?? listed.find((m) => m.status !== 'unavailable') ?? listed[0])!.symbol;
  usePageContext({ page: 'perps', symbol });
  const agriLive = Boolean(markets.data?.some((m) => m.category === 'agri' && m.status !== 'unavailable'));
  const rhLive = Boolean(markets.data?.some((m) => m.category === 'rh' && m.status !== 'unavailable'));
  const candles = useApi<CandleSeries>(p(`/api/perps/candles/${symbol}?interval=${interval}`), { intervalMs: POLL.candles, keepPrevious: true });
  const account = useApi<PerpAccount>(key ? p(`/api/perps/collateral?as=${key}`) : null, { intervalMs: POLL.account });
  const positions = useApi<PerpPosition[]>(key ? p(`/api/perps/positions?as=${key}`) : null, { intervalMs: POLL.positions });
  const history = useApi<PerpPosition[]>(key ? p(`/api/perps/history?limit=50&as=${key}`) : null, { intervalMs: POLL.history });
  // On chain, orders wait for their next price — hours on a quiet feed.
  const venue = chain?.venue ?? (network === PRIMARY_PERP_NETWORK ? cfg.perpsVenue : null);
  const onChain = venue === 'agri-perp';
  const orders = useApi<PerpWaitingOrder[]>(key && onChain ? p(`/api/perps/orders?as=${key}`) : null, { intervalMs: POLL.orders });

  const market = markets.data?.find((m) => m.symbol === symbol) ?? null;
  const elsewhere = useMemo(() => categoriesElsewhere(network), [network]);

  const pick = useCallback(
    (next: string) => {
      setSymbol(next);
      const def = perpMarket(next, network);
      if (def) setCategory(def.category);
      // Keep the URL shareable without a server round trip.
      window.history.replaceState(null, '', pageUrl(next, network));
    },
    [network],
  );

  const pickCategory = (c: PerpCategory) => {
    setCategory(c);
    const first = markets.data?.find((m) => m.category === c && m.status !== 'unavailable') ?? markets.data?.find((m) => m.category === c);
    if (first && market?.category !== c) pick(first.symbol);
  };

  // The wallet goes to the network's chain too, when it's connected: the
  // ticket signs there. Declined, the page still shows the network — the
  // ticket asks again when it signs.
  const walletTo = useCallback(
    async (target: PerpChainInfo) => {
      setSwitchError(null);
      if (!isConnected || walletChainId === target.chainId) return;
      try {
        await switchChainAsync({ chainId: target.chainId });
      } catch (err) {
        setSwitchError(walletErrorText(err, target.chainName) ?? `The wallet didn’t switch to ${target.chainName}.`);
      }
    },
    [isConnected, walletChainId, switchChainAsync],
  );

  const setNetwork = useCallback(
    (next: PerpNetwork, opts: { moveWallet?: boolean } = { moveWallet: true }) => {
      if (next === network) return;
      setNetworkState(next);
      const nextChain = chains.find((c) => c.network === next);
      if (opts.moveWallet && nextChain) void walletTo(nextChain);
      // The market in view may not be listed there: the page lands on the network's first once its list loads.
      if (categoriesElsewhere(next)[category]) setCategory(firstCategory(next));
      window.history.replaceState(null, '', pageUrl(symbol, next));
    },
    [network, chains, walletTo, category, symbol],
  );

  // Auto-detect (Multichain brief): the wallet moves to a chain perps run
  // on — on connecting, or switched in the wallet — and the page follows.
  // Only on a change: the network in the address wins on arrival.
  const followWallet = useRef<(chainId: number | undefined) => void>(() => {});
  useEffect(() => {
    followWallet.current = (chainId) => {
      const match = chains.find((c) => c.chainId === chainId);
      if (match && match.network !== network) setNetwork(match.network, { moveWallet: false });
    };
  });
  useEffect(
    () =>
      watchAccount(wagmiConfig, {
        onChange(account, previous) {
          if (account.chainId !== previous.chainId) followWallet.current(account.chainId);
        },
      }),
    [wagmiConfig],
  );

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
        .filter((pos) => pos.symbol === symbol)
        .flatMap((pos) => [
          { id: `${pos.id}:entry`, price: pos.entryPrice, side: pos.side === 'long' ? ('buy' as const) : ('sell' as const), label: `${pos.side} ${pos.leverage}×` },
          { id: `${pos.id}:liq`, price: pos.liquidationPrice, side: 'sell' as const, label: 'liq.' },
        ]),
    [positions.data, symbol],
  );

  // When the market changes, Robinchan reads one line of it — conditions,
  // never a suggestion — beside her avatar, clear of the ticket.
  const greeted = useRef<string | null>(null);
  useEffect(() => {
    if (!market || greeted.current === `${network}:${symbol}`) return;
    greeted.current = `${network}:${symbol}`;
    const where = chain?.chainName ?? PERP_NETWORK_DEFS[network].mainnet.name;
    if (market.status === 'unavailable') {
      companion.say(
        market.category === 'rh'
          ? `${market.symbol} (${market.name}) is coming soon: it opens once its 15-minute price feed from its own pool is live on Robinhood Chain.`
          : perpComingSoon(market)
            ? `${market.symbol} (${market.name}) is coming soon: it opens once a live price feed for it is on ${where}.`
            : `${market.symbol} (${market.name}) can't be traded: Chainlink has no price feed for it on ${where}.`,
      );
      return;
    }
    const move = market.change24hPct == null ? '' : `, ${formatPct(market.change24hPct)} over 24h`;
    const state = market.status === 'open' ? '' : market.status === 'closed' ? ' The market is closed right now.' : ' It is close-only right now.';
    companion.say(`${market.symbol} is at ${marketPrice(market.price, market.unit)}${move}.${state}`);
  }, [market, symbol, network, chain, companion]);

  const venueLabel =
    venue === 'paper'
      ? 'paper venue · dev'
      : venue === 'agri-perp'
        ? network === PRIMARY_PERP_NETWORK
          ? isMainnet(cfg.chain)
            ? 'live on Robinhood Chain mainnet'
            : `on chain · ${cfg.chain?.name ?? 'AgriPerp'}`
          : chain && !chain.testnet
            ? `live on ${chain.chainName}`
            : `on chain · ${chain?.chainName ?? networkName}`
        : network === PRIMARY_PERP_NETWORK
          ? 'venue not configured'
          : `coming soon on ${networkName}`;

  // Connected to a chain nothing here runs on (not the app's own, not a perps network's).
  const unsupported =
    isConnected && walletChainId != null && walletChainId !== cfg.chain?.id && !chains.some((c) => c.chainId === walletChainId) ? walletChainId : null;

  const title = network === PRIMARY_PERP_NETWORK ? 'Crypto and stock perpetuals' : `Agri and commodity perpetuals on ${networkName}`;
  const lead =
    network === PRIMARY_PERP_NETWORK
      ? `Long or short crypto (up to 20×) and US stocks (up to 5×) — priced by Chainlink on Robinhood Chain, settled in ${cfg.perpsCollateral}, signed in your own wallet. ${
          agriLive
            ? 'Agri futures (up to 5×) are priced by Robinchan from Yahoo Finance quotes, about 10 minutes behind the exchange.'
            : 'Agri markets are coming soon.'
        } ${
          rhLive
            ? 'RH Tokens (up to 5×) are priced by their own pool’s 15-minute average.'
            : 'RH Tokens — PONS, CASHCAT and DELTA, up to 5× — are coming soon, priced by their own pool’s 15-minute average.'
        }`
      : `Long or short ${network === 'arbitrum' ? 'gold, silver and WTI oil' : 'gold and silver'} — priced by Chainlink on ${networkName} — and corn, soybeans, wheat and coffee, priced by Robinchan from Yahoo Finance quotes about 10 minutes behind the exchange. Up to 5×, $50k a position, settled in ${
          chain?.collateralSymbol ?? 'USDC'
        }, signed in your own wallet. ${agriLive ? '' : 'The agri markets open once their feeds are live here.'} RH Tokens and the stock markets stay on RH Chain.`;

  const networkState = useMemo<PerpNetworkState>(
    () => ({ network, chain, chains, setNetwork: (n) => setNetwork(n) }),
    [network, chain, chains, setNetwork],
  );

  return (
    <PerpNetworkProvider value={networkState}>
      <PageHeader
        eyebrow="Perps"
        title={title}
        lead={lead}
        aside={
          <div className="flex flex-col items-start gap-2 sm:items-end">
            {chains.length > 1 || network !== PRIMARY_PERP_NETWORK ? (
              <ChainSwitcher value={network} chains={chains} onChange={(n) => setNetwork(n)} />
            ) : null}
            <Pill tone={venue === 'agri-perp' ? 'accent' : 'muted'}>{venueLabel}</Pill>
          </div>
        }
      />

      {/* Above the peeking Robinchan (z-20) wherever they meet: the ticket
          and the board always take the click, never her. */}
      <div className="relative z-[21] space-y-4">
        {unsupported != null ? (
          <UnsupportedChainBanner
            chainId={unsupported}
            chains={chains}
            error={switchError}
            onSwitch={(c) => {
              setNetwork(c.network, { moveWallet: false });
              void walletTo(c);
            }}
          />
        ) : switchError ? (
          <p role="alert" className="text-[12.5px] text-down">
            {switchError}
          </p>
        ) : null}
        <MarketBoard markets={markets} category={category} symbol={symbol} onCategory={pickCategory} onSymbol={pick} elsewhere={elsewhere} />
        {category === 'rh' && network === PRIMARY_PERP_NETWORK ? <RhTokensPanel onSymbol={pick} /> : null}

        {/* One ticket, placed by the grid: after the header on a phone, a sticky column on desktop. */}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:grid-rows-[auto_auto_1fr]">
          <div className="min-w-0 lg:col-start-1 lg:row-start-1">
            <MarketHeader market={market} loading={markets.status === 'loading'} />
          </div>
          <aside className="min-w-0 lg:col-start-2 lg:row-span-3 lg:row-start-1" aria-label="Order ticket">
            <div className="lg:sticky lg:top-[calc(76px+24px)]">
              <TicketColumn
                key={network}
                market={market}
                account={account}
                address={s.session?.address ?? ''}
                onSettled={refresh}
                venueConfigured={Boolean(venue)}
                networkName={network === PRIMARY_PERP_NETWORK ? null : networkName}
              />
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

        {onChain ? <VenueCard key={network} /> : null}
      </div>
    </PerpNetworkProvider>
  );
}

function TicketColumn({
  market,
  account,
  address,
  onSettled,
  venueConfigured,
  networkName,
}: {
  market: PerpMarket | null;
  account: Resource<PerpAccount>;
  address: string;
  onSettled: () => void;
  venueConfigured: boolean;
  /** A network other than the primary, by name. */
  networkName: string | null;
}) {
  if (!venueConfigured) {
    return (
      <div className="card p-5">
        <p className="t-eyebrow mb-3">Order</p>
        {networkName ? (
          <>
            <p className="t-h3 mb-2">{networkName} perps are coming soon</p>
            <p className="text-[13px] leading-relaxed text-text-2">
              Prices and charts are live; positions open once the contracts are deployed on {networkName}. RH Chain trades now.
            </p>
          </>
        ) : (
          <>
            <p className="t-h3 mb-2">Trading isn&apos;t set up here</p>
            <p className="text-[13px] leading-relaxed text-text-2">
              This server has no perps venue configured: prices and charts are live, but positions can&apos;t be opened.
            </p>
          </>
        )}
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
