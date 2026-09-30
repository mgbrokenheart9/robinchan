'use client';

import type { PerpChainInfo, PerpNetwork } from '@robinchan/shared';
import { PERP_NETWORKS, PERP_NETWORK_DEFS } from '@robinchan/shared';

import { cx } from '@/components/ui';

/**
 * The network the Perps page trades on (Multichain brief): Robinhood Chain,
 * Base or Arbitrum. A network the server doesn't run yet is shown, greyed,
 * as coming soon — so it's clear where perps are headed.
 */
export function ChainSwitcher({
  value,
  chains,
  onChange,
}: {
  value: PerpNetwork;
  chains: PerpChainInfo[];
  onChange: (network: PerpNetwork) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Network" className="flex max-w-full items-center gap-1 overflow-x-auto rounded-full border border-border p-1 [scrollbar-width:none]">
      {PERP_NETWORKS.map((network) => {
        const def = PERP_NETWORK_DEFS[network];
        const chain = chains.find((c) => c.network === network);
        const active = value === network;
        const title = !chain
          ? `${def.name} perps are coming soon`
          : chain.venue
            ? `${chain.chainName}${chain.testnet ? ' (testnet)' : ''} · chain ${chain.chainId}`
            : `${chain.chainName}: prices are live, trading opens once the contracts are deployed`;
        return (
          <button
            key={network}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={!chain}
            title={title}
            onClick={() => onChange(network)}
            className={cx(
              'flex min-h-[32px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[12.5px] transition-colors',
              active ? 'bg-surface-2 text-text ring-1 ring-inset ring-border' : 'text-text-2 hover:text-text',
              !chain && 'cursor-not-allowed opacity-50 hover:text-text-2',
            )}
          >
            <span aria-hidden className="h-2 w-2 shrink-0 rounded-full ring-1 ring-overlay/30" style={{ background: def.color }} />
            {def.name}
            {chain?.testnet ? <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-text-3">test</span> : null}
            {!chain || !chain.venue ? <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-text-3">soon</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The wallet is on a chain perps don't run on: say so, and offer each one
 * they do — the wallet adds it if it doesn't know it.
 */
export function UnsupportedChainBanner({
  chainId,
  chains,
  onSwitch,
  error,
}: {
  chainId: number;
  chains: PerpChainInfo[];
  onSwitch: (chain: PerpChainInfo) => void;
  error: string | null;
}) {
  return (
    <div role="alert" className="card flex flex-wrap items-center justify-between gap-3 border-warning/40 bg-warning/[0.06] px-4 py-3">
      <p className="text-[13px] leading-snug text-text">
        Your wallet is on chain {chainId}, where Robinchan perps don&apos;t run. Switch to a supported network to trade.
        {error ? <span className="mt-1 block text-[12.5px] text-down">{error}</span> : null}
      </p>
      <div className="flex flex-wrap gap-2">
        {chains.map((c) => (
          <button key={c.network} type="button" onClick={() => onSwitch(c)} className="btn-ghost flex items-center gap-1.5 text-[12.5px]">
            <span aria-hidden className="h-2 w-2 rounded-full ring-1 ring-overlay/30" style={{ background: c.color }} />
            {c.name}
          </button>
        ))}
      </div>
    </div>
  );
}
