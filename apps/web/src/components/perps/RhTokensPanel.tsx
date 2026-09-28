'use client';

import type { RhToken, RhTokensBoard } from '@robinchan/shared';
import { formatUsdCompact } from '@robinchan/shared';

import { ExternalIcon, LiquidityIcon } from '@/components/icons';
import { TickerLogo } from '@/components/TickerCard';
import { ErrorState, UpdatedAt } from '@/components/states';
import { Skeleton, cx } from '@/components/ui';
import { useApi } from '@/lib/useApi';

import { marketPrice } from './format';

/**
 * The RH Tokens tab's pool depth (`/api/rh-tokens`): a token is listed only
 * while the pool its price comes from — the Uniswap V2 or V3 pool the 15-minute
 * average is read from — holds $500k. Each row shows how far it is, so a
 * dimmed chip above never looks like an oversight.
 */
export function RhTokensPanel({ onSymbol }: { onSymbol: (s: string) => void }) {
  const board = useApi<RhTokensBoard>('/api/rh-tokens', { intervalMs: 60_000 });
  const b = board.data;
  return (
    <section className="card overflow-hidden" aria-label="RH Tokens pool depth">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-soft px-4 py-3">
        <div className="min-w-0">
          <p className="t-eyebrow flex items-center gap-1.5">
            <LiquidityIcon className="text-text-3" />
            Pool depth
          </p>
          <p className="mt-1 text-[12.5px] leading-snug text-text-2">
            A token lists once the pool its price comes from holds {formatUsdCompact(b?.minLiquidityUsd ?? 500_000)}. Uniswap V2 and V3 pools keep a price
            record on chain to average; v4 pools don’t, and count toward the total, not the listing.
          </p>
        </div>
        <UpdatedAt asOf={b?.checkedAt ?? null} stale={board.stale} />
      </div>
      {board.status === 'loading' ? (
        <div className="space-y-2 px-4 py-3" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[44px] w-full" />
          ))}
        </div>
      ) : board.status === 'error' || !b ? (
        <ErrorState message="Pool depth couldn't load right now." onRetry={board.reload} className="py-6" />
      ) : (
        <ul className={cx('divide-y divide-border-soft', board.stale && 'is-stale')}>
          {b.tokens.map((t) => (
            <li key={t.symbol}>
              <TokenRow token={t} minLiquidityUsd={b.minLiquidityUsd} onClick={() => onSymbol(t.symbol)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TokenRow({ token: t, minLiquidityUsd, onClick }: { token: RhToken; minLiquidityUsd: number; onClick: () => void }) {
  const depth = t.oraclePool?.liquidityUsd ?? null;
  const share = depth == null ? 0 : Math.min(1, depth / minLiquidityUsd);
  const deepest = t.pools[0];
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)_auto]">
      <button type="button" onClick={onClick} className="flex min-w-0 items-center gap-2.5 text-left">
        <TickerLogo symbol={t.symbol} size={26} />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="font-mono text-[13px] tracking-[0.04em] text-text">{t.symbol}</span>
          <span className="truncate text-[11px] text-text-3">{t.name}</span>
        </span>
      </button>

      <div className="order-3 col-span-2 min-w-0 sm:order-none sm:col-span-1">
        {t.oraclePool ? (
          <>
            <div className="flex items-baseline justify-between gap-3 text-[11.5px]">
              <span className="truncate text-text-2">{t.oraclePool.label}</span>
              <span className="shrink-0 font-mono text-text-2">
                {depth == null ? '––' : formatUsdCompact(depth)} <span className="text-text-3">/ {formatUsdCompact(minLiquidityUsd)}</span>
              </span>
            </div>
            <div
              className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2"
              role="meter"
              aria-label={`${t.symbol} oracle pool depth`}
              aria-valuemin={0}
              aria-valuemax={minLiquidityUsd}
              aria-valuenow={depth ?? 0}
            >
              <div className={cx('h-full rounded-full', t.meetsLiquidity ? 'bg-up' : 'bg-warning')} style={{ width: `${share * 100}%` }} />
            </div>
          </>
        ) : (
          <p className="text-[11.5px] leading-snug text-text-3">
            {t.token ? 'No Uniswap V2 or V3 pool: nothing on chain to average.' : 'Not trading on Robinhood Chain.'}
          </p>
        )}
        {t.totalLiquidityUsd != null && t.pools.length ? (
          <p className="mt-1 text-[11px] text-text-3">
            {/* DexScreener lists 30 pools at most: past that, "30+". */}
            {formatUsdCompact(t.totalLiquidityUsd)} across {t.pools.length >= 30 ? '30+' : t.pools.length} {t.pools.length === 1 ? 'pool' : 'pools'}
            {deepest ? (
              <>
                {' · '}
                <a href={deepest.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:text-text-2">
                  deepest on {deepest.dex} {deepest.version ?? ''}
                  <ExternalIcon width={10} height={10} />
                </a>
              </>
            ) : null}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col items-end leading-tight">
        <span className="font-mono text-[12.5px] text-text">{marketPrice(t.twapPrice ?? t.spotPrice)}</span>
        <span className={cx('font-mono text-[10.5px] uppercase tracking-[0.08em]', t.status === 'open' ? 'text-up' : t.meetsLiquidity ? 'text-text-2' : 'text-text-3')}>
          {t.status === 'open' ? 'listed · twap' : t.meetsLiquidity ? 'deep enough' : t.oraclePool ? 'below floor' : 'coming soon'}
        </span>
      </div>
    </div>
  );
}
