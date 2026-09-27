'use client';

import type { PerpVenueInfo } from '@robinchan/shared';
import { formatUsd, shortAddress } from '@robinchan/shared';

import { ExternalIcon } from '@/components/icons';
import { ErrorState, UpdatedAt } from '@/components/states';
import { Pill, Skeleton, cx } from '@/components/ui';
import { useApi } from '@/lib/useApi';

/**
 * Where the on-chain venue lives, for anyone to check: the network, the three
 * contracts, the settlement token, the pool, and the Chainlink feed behind
 * each market — every address linked to the explorer. Nothing here needs a
 * wallet, so it's outside the connect gate.
 */
export function VenueCard() {
  const venue = useApi<PerpVenueInfo>('/api/perps/venue', { intervalMs: 60_000 });

  if (venue.status === 'loading') {
    return (
      <section className="card p-5" aria-label="On-chain venue">
        <Skeleton className="mb-4 h-4 w-40" />
        <Skeleton className="h-24 w-full" />
      </section>
    );
  }
  if (venue.status === 'error' || !venue.data) {
    return (
      <section className="card">
        <ErrorState message="The venue's contracts couldn't load right now." onRetry={venue.reload} />
      </section>
    );
  }

  const v = venue.data;
  if (v.venue !== 'agri-perp' || !v.contracts) return null;
  const explorer = v.chain?.explorerUrl ?? null;
  const network = v.chain ? `${v.chain.name}${v.chain.mainnet ? ' mainnet' : ''} · chain ${v.chain.id}` : 'no network';

  const contracts: Array<{ name: string; role: string; address: string }> = [
    { name: 'AgriPerp', role: 'Positions, orders and liquidations', address: v.contracts.perp },
    { name: 'AgriVault', role: `Trader collateral and the liquidity pool, in ${v.collateral.symbol}`, address: v.contracts.vault },
    { name: 'AgriFeed', role: 'Reads each market’s Chainlink feed', address: v.contracts.feed },
  ];
  if (v.collateral.address) {
    contracts.push({ name: v.collateral.symbol, role: 'Settlement token', address: v.collateral.address });
  }

  return (
    <section className="card" aria-label="On-chain venue">
      <header className="flex min-h-[52px] flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border-soft px-5 py-3">
        <h2 className="t-eyebrow">Verify on chain</h2>
        <div className="flex items-center gap-2">
          <Pill tone={v.chain?.mainnet ? 'accent' : 'muted'}>{network}</Pill>
          <UpdatedAt asOf={venue.asOf} stale={venue.stale} />
        </div>
      </header>

      <div className={cx('space-y-5 px-5 py-4', venue.stale && 'is-stale')}>
        <p className="text-[13px] leading-relaxed text-text-2">
          Every position, deposit and fill happens in these contracts, priced by Chainlink Data Feeds. Nothing is custodied off chain: check any
          of it on {explorer ? 'the block explorer' : 'chain'}.
        </p>

        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {contracts.map((c) => (
            <div key={c.name} className="min-w-0">
              <dt className="flex items-baseline gap-2">
                <span className="font-display text-[14px] font-medium text-text">{c.name}</span>
                <span className="truncate text-[11.5px] text-text-3">{c.role}</span>
              </dt>
              <dd>
                <AddressLink explorer={explorer} address={c.address} />
              </dd>
            </div>
          ))}
        </dl>

        {v.pool || v.deployBlock ? (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-t border-border-soft pt-4 sm:grid-cols-3">
            {v.pool ? (
              <>
                <div>
                  <dt className="text-[11.5px] text-text-3">Pool ({v.collateral.symbol})</dt>
                  <dd className="font-mono text-[13px] text-text">{formatUsd(v.pool.balance)}</dd>
                </div>
                <div>
                  <dt className="text-[11.5px] text-text-3">Available to pay profits</dt>
                  <dd className="font-mono text-[13px] text-text">{formatUsd(v.pool.available)}</dd>
                </div>
              </>
            ) : null}
            {v.deployBlock ? (
              <div>
                <dt className="text-[11.5px] text-text-3">Deployed at block</dt>
                <dd className="font-mono text-[13px] text-text">
                  {explorer ? (
                    <a href={`${explorer}/block/${v.deployBlock}`} target="_blank" rel="noopener noreferrer" className="hover:underline">
                      {v.deployBlock.toLocaleString('en-US')}
                    </a>
                  ) : (
                    v.deployBlock.toLocaleString('en-US')
                  )}
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}

        {v.feeds.length ? (
          <div className="border-t border-border-soft pt-4">
            <p className="t-eyebrow mb-3">Chainlink price feeds</p>
            <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2 xl:grid-cols-3">
              {v.feeds.map((f) => (
                <li key={f.symbol} className="flex min-w-0 items-baseline justify-between gap-3">
                  {/* The feeds' own descriptions vary ("RHTSLA / USD", "Robinhood AAPL / USD"): the pair reads cleaner. */}
                  <span className="shrink-0 text-[13px] text-text" title={f.description}>
                    {f.symbol} / USD
                  </span>
                  <AddressLink explorer={explorer} address={f.feed} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function AddressLink({ explorer, address }: { explorer: string | null; address: string }) {
  if (!explorer) return <span className="font-mono text-[12.5px] text-text-2">{shortAddress(address)}</span>;
  return (
    <a
      href={`${explorer}/address/${address}`}
      target="_blank"
      rel="noopener noreferrer"
      title={address}
      className="inline-flex items-center gap-1 font-mono text-[12.5px] text-text-2 hover:text-text hover:underline"
    >
      {shortAddress(address)}
      <ExternalIcon />
    </a>
  );
}
