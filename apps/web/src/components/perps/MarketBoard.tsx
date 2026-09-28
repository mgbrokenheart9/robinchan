'use client';

import type { PerpCategory, PerpMarket } from '@robinchan/shared';
import { direction, formatPct, formatUsdCompact, perpComingSoon } from '@robinchan/shared';

import { AgriIcon, ClockIcon, CryptoIcon, LockIcon, StocksIcon } from '@/components/icons';
import { TickerLogo, hasTickerLogo } from '@/components/TickerCard';
import { ErrorState, UpdatedAt } from '@/components/states';
import { PulseDot, Skeleton, cx } from '@/components/ui';
import type { Resource } from '@/lib/useApi';

import { STATUS_LABEL, fundingLabel, marketPrice, openInterest } from './format';

const CATEGORIES: Array<{ id: PerpCategory; label: string; Icon: typeof AgriIcon }> = [
  { id: 'agri', label: 'Agri', Icon: AgriIcon },
  { id: 'crypto', label: 'Crypto', Icon: CryptoIcon },
  { id: 'stocks', label: 'Stocks', Icon: StocksIcon },
];

/**
 * The market selector (brief §8A): three categories, then every market in
 * the chosen one as a pill with its price and 24h change. Markets without an
 * oracle are listed too — dimmed, with the reason one click away — so it's
 * clear corn or palm oil weren't forgotten, just not priceable yet.
 */
export function MarketBoard({
  markets,
  category,
  symbol,
  onCategory,
  onSymbol,
}: {
  markets: Resource<PerpMarket[]>;
  category: PerpCategory;
  symbol: string;
  onCategory: (c: PerpCategory) => void;
  onSymbol: (s: string) => void;
}) {
  const all = markets.data ?? [];
  const inCategory = all.filter((m) => m.category === category);
  return (
    <section className="card overflow-hidden" aria-label="Markets">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-soft px-4 py-3">
        <div className="flex items-center gap-1 rounded-full border border-border p-1" role="tablist" aria-label="Market category">
          {CATEGORIES.map(({ id, label, Icon }) => {
            const live = all.filter((m) => m.category === id && m.status !== 'unavailable').length;
            const total = all.filter((m) => m.category === id).length;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={category === id}
                onClick={() => onCategory(id)}
                className={cx(
                  'flex min-h-[34px] items-center gap-1.5 rounded-full px-3.5 text-[13px] transition-colors',
                  category === id ? 'bg-accent text-accent-ink' : 'text-text-2 hover:text-text',
                )}
              >
                <Icon />
                {label}
                {total ? (
                  <span className={cx('font-mono text-[10.5px]', category === id ? 'text-accent-ink/70' : 'text-text-3')}>
                    {live === 0 && id === 'agri' ? 'soon' : live < total ? `${live}/${total}` : total}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden font-mono text-[10.5px] uppercase tracking-[0.1em] text-text-3 sm:inline">Prices · Chainlink</span>
          <UpdatedAt asOf={markets.asOf} stale={markets.stale} />
        </div>
      </div>

      {markets.status === 'loading' ? (
        <div className="flex gap-2 overflow-hidden px-4 py-3" aria-hidden>
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-[52px] w-[150px] shrink-0 rounded-full" />
          ))}
        </div>
      ) : markets.status === 'error' ? (
        <ErrorState message="The market list couldn't load right now." onRetry={markets.reload} className="py-6" />
      ) : (
        <ul className={cx('flex gap-2 overflow-x-auto px-4 py-3', markets.stale && 'is-stale')} aria-label={`${category} markets`}>
          {inCategory.map((m) => (
            <li key={m.symbol} className="shrink-0">
              <MarketChip market={m} active={m.symbol === symbol} onClick={() => onSymbol(m.symbol)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MarketChip({ market: m, active, onClick }: { market: PerpMarket; active: boolean; onClick: () => void }) {
  const unavailable = m.status === 'unavailable';
  const dir = direction(m.change24hPct);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={m.statusNote ?? m.name}
      className={cx(
        'flex min-h-[52px] items-center gap-3 rounded-full border px-4 text-left transition-colors',
        active ? 'border-accent-fg/50 bg-accent/[0.08] shadow-glow-soft' : 'border-border hover:border-text-3',
        unavailable && !active && 'opacity-60',
      )}
    >
      {/* Real marks only: commodities have none, so no stand-in either. */}
      {hasTickerLogo(m.symbol) ? <TickerLogo symbol={m.symbol} size={26} /> : null}
      <span className="flex flex-col leading-tight">
        <span className="font-mono text-[13px] tracking-[0.04em] text-text">{m.symbol}</span>
        <span className="text-[11px] text-text-3">{m.name}</span>
      </span>
      {unavailable ? (
        <span className="flex items-center gap-1 font-mono text-[10.5px] uppercase tracking-[0.08em] text-text-3">
          {perpComingSoon(m) ? <ClockIcon width={11} height={11} /> : <LockIcon width={11} height={11} />}
          {perpComingSoon(m) ? 'coming soon' : 'no oracle'}
        </span>
      ) : (
        <span className="flex flex-col items-end leading-tight">
          <span className="font-mono text-[12.5px] text-text">{marketPrice(m.price)}</span>
          <span className={cx('font-mono text-[11px]', dir === 'up' ? 'text-up' : dir === 'down' ? 'text-down' : 'text-text-3')}>
            {m.status === 'closed' ? 'closed' : m.change24hPct == null ? '––' : formatPct(m.change24hPct)}
          </span>
        </span>
      )}
    </button>
  );
}

/** The selected market: price, change, status, and the terms a trader needs before sizing. */
export function MarketHeader({ market, loading }: { market: PerpMarket | null; loading: boolean }) {
  if (loading || !market) {
    return (
      <div className="card px-5 py-4" aria-hidden>
        <Skeleton className="mb-3 h-4 w-48" />
        <Skeleton className="h-[34px] w-56" />
        <div className="mt-4 flex gap-6">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-8 w-24" />
          ))}
        </div>
      </div>
    );
  }
  const m = market;
  const dir = direction(m.change24hPct);
  const oi = openInterest(m);
  const longShare = oi > 0 ? (m.openInterest.long / oi) * 100 : 50;
  const stats: Array<[string, React.ReactNode, string?]> = [
    ['Funding', fundingLabel(m.fundingRatePerHour), 'Positive: longs pay shorts, per hour of holding. Set per market.'],
    [
      'Open interest',
      oi > 0 ? (
        <span className="flex items-center gap-2">
          {formatUsdCompact(oi)}
          <span className="relative block h-1.5 w-14 overflow-hidden rounded-full bg-down/40" title={`${longShare.toFixed(0)}% long`}>
            <span className="absolute inset-y-0 left-0 bg-up" style={{ width: `${longShare}%` }} />
          </span>
        </span>
      ) : (
        '$0'
      ),
    ],
    ['Leverage', `up to ${m.maxLeverage}×`],
    ['Hours', m.hours],
  ];
  if (m.contract) {
    stats.push([
      'Feed',
      m.contract,
      m.category === 'agri'
        ? 'Posted by Robinchan from Yahoo Finance quotes, about 10 minutes behind the exchange: you trust Robinchan for this price. Orders fill at the first price quoted after them.'
        : 'A new price lands when it moves 0.5%, or once a day; orders fill at the next one.',
    ]);
  }

  return (
    <header className="card px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {hasTickerLogo(m.symbol) ? <TickerLogo symbol={m.symbol} size={28} /> : null}
        <h2 className="font-mono text-[15px] tracking-[0.04em] text-text">{m.symbol}/USD</h2>
        <span className="text-[13.5px] text-text-2">{m.name}</span>
        <StatusPill market={m} />
        {m.source === 'fixture' ? (
          <span
            className="rounded-full border border-warning/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-warning"
            title="RC_ENV=dev with Robinhood Chain out of reach: generated prices"
          >
            sample prices
          </span>
        ) : null}
      </div>

      {m.status === 'unavailable' ? (
        <p className="mt-3 max-w-[640px] text-[13px] leading-relaxed text-text-2">{m.statusNote}</p>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <p className={cx('font-mono text-[34px] leading-none tracking-[-0.02em] text-text', m.status === 'closed' && 'text-text-2')}>
              {marketPrice(m.price)}
              {m.unit ? <span className="ml-1 text-[15px] text-text-3">{m.unit}</span> : null}
            </p>
            <p className={cx('font-mono text-[14px]', dir === 'up' ? 'text-up' : dir === 'down' ? 'text-down' : 'text-text-3')}>
              {formatPct(m.change24hPct)} <span className="text-text-3">24h</span>
            </p>
          </div>
          {m.statusNote ? (
            <p className="mt-2 flex items-start gap-1.5 text-[12.5px] leading-snug text-text-2">
              <ClockIcon className="mt-0.5 shrink-0 text-text-3" />
              {m.statusNote}
            </p>
          ) : null}
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-border-soft pt-3 sm:flex sm:flex-wrap">
            {stats.map(([label, value, hint]) => (
              <div key={label} title={hint}>
                <dt className="t-eyebrow mb-1.5">{label}</dt>
                <dd className="font-mono text-[12.5px] text-text">{value}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </header>
  );
}

function StatusPill({ market: m }: { market: PerpMarket }) {
  const tone =
    m.status === 'open'
      ? 'border-up/40 text-up'
      : m.status === 'halted'
        ? 'border-warning/40 text-warning'
        : 'border-border text-text-3';
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-[0.08em]', tone)}>
      {m.status === 'open' ? <PulseDot className="[&>span]:bg-up" /> : null}
      {perpComingSoon(m) ? 'Coming soon' : STATUS_LABEL[m.status]}
    </span>
  );
}
