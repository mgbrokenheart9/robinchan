'use client';

import { useState } from 'react';
import type { PerpAccount, PerpCollateralQuote, TxRequest } from '@robinchan/shared';
import { formatSignedUsd, formatUsd } from '@robinchan/shared';

import { ErrorState, UpdatedAt } from '@/components/states';
import { Skeleton, cx } from '@/components/ui';
import { ApiClientError, apiFetch } from '@/lib/api';
import { perpPath, usePerpNetwork } from '@/lib/perpNetwork';
import type { Resource } from '@/lib/useApi';
import { usePerpSigner } from '@/lib/usePerpSigner';

import { pnlTone } from './format';
import { PerpProgress } from './PerpProgress';

type FaucetResult = { kind: 'paper'; account: PerpAccount } | { kind: 'transactions'; txs: TxRequest[]; amount: number };

/**
 * Collateral (brief §11 step 4): what's free, what backs positions, and the
 * account's equity. On chain, deposit and withdraw are wallet transactions;
 * on the paper venue there's nothing to deposit — test USDC comes from the
 * faucet, dev builds only.
 */
export function AccountCard({
  account,
  address,
  onChanged,
}: {
  account: Resource<PerpAccount>;
  address: string;
  onChanged: () => void;
}) {
  const signer = usePerpSigner({ onSettled: () => onChanged() });
  const { network } = usePerpNetwork();
  const [mode, setMode] = useState<'deposit' | 'withdraw' | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<'deposit' | 'withdraw'>('deposit');

  if (account.status === 'loading') return <AccountSkeleton />;
  if (account.status === 'error') {
    return (
      <section className="card">
        <ErrorState message="Your perps account couldn't load right now." onRetry={account.reload} />
      </section>
    );
  }
  const a = account.data as PerpAccount;
  const onChain = a.venue === 'agri-perp';

  const faucet = async () => {
    setBusy(true);
    setError(null);
    try {
      const { data } = await apiFetch<FaucetResult>(perpPath('/api/perps/faucet', network), { json: {} });
      if (data.kind === 'paper') account.set(data.account);
      else if (await signer.sendPlain(address, data.txs)) onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "The faucet didn't answer. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const move = async () => {
    const n = Number(amount);
    if (!mode || !Number.isFinite(n) || n <= 0) return;
    setBusy(true);
    setError(null);
    try {
      const { data } = await apiFetch<PerpCollateralQuote>(perpPath('/api/perps/collateral', network), { json: { kind: mode, amount: n } });
      setKind(mode);
      const record = await signer.sign(data);
      if (record) {
        setMode(null);
        setAmount('');
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const rows: Array<[string, React.ReactNode]> = [
    ['Free', formatUsd(a.free)],
    ['In positions', formatUsd(a.locked)],
    ['Unrealized', <span key="u" className={pnlTone(a.unrealizedPnl)}>{formatSignedUsd(a.unrealizedPnl)}</span>],
  ];
  if (onChain) rows.push(['In wallet', a.walletUsdc == null ? '––' : formatUsd(a.walletUsdc)]);

  return (
    <section className="card" aria-label="Perps account">
      <header className="flex h-[52px] items-center justify-between gap-3 border-b border-border-soft px-5">
        <h2 className="t-eyebrow">Account · {a.collateralSymbol}</h2>
        <UpdatedAt asOf={account.asOf} stale={account.stale} />
      </header>
      <div className={cx('px-5 py-4', account.stale && 'is-stale')}>
        <p className="t-eyebrow mb-2">Equity</p>
        <p className="font-mono text-[26px] leading-none tracking-[-0.02em] text-text">{formatUsd(a.equity)}</p>
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt className="text-[11.5px] text-text-3">{label}</dt>
              <dd className="font-mono text-[13px] text-text">{value}</dd>
            </div>
          ))}
        </dl>

        {onChain ? (
          <div className="mt-4 border-t border-border-soft pt-4">
            {mode ? (
              <div className="space-y-2">
                <label htmlFor="perp-move" className="text-[12.5px] text-text-2">
                  {mode === 'deposit' ? 'Deposit from your wallet' : 'Withdraw free collateral'}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="perp-move"
                    inputMode="decimal"
                    autoComplete="off"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                    placeholder="0.00"
                    className="h-10 min-w-0 flex-1 rounded-full border border-border bg-surface-2 px-4 font-mono text-[14px] text-text focus:border-text-3 focus:outline-none"
                  />
                  <button type="button" onClick={() => void move()} disabled={busy || signer.busy || !amount} className="btn-primary h-10 min-h-0 px-4 text-[13px]">
                    {busy ? '…' : mode === 'deposit' ? 'Deposit' : 'Withdraw'}
                  </button>
                </div>
                <button type="button" onClick={() => setMode(null)} className="text-[12px] text-text-3 hover:text-text">
                  Cancel
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setMode('deposit')} disabled={signer.busy} className="btn-ghost h-10 min-h-0 text-[13px]">
                  Deposit
                </button>
                <button type="button" onClick={() => setMode('withdraw')} disabled={signer.busy || a.free <= 0} className="btn-ghost h-10 min-h-0 text-[13px]">
                  Withdraw
                </button>
              </div>
            )}
          </div>
        ) : null}

        {a.canFaucet ? (
          <button type="button" onClick={() => void faucet()} disabled={busy || signer.busy} className="btn-ghost mt-4 h-10 min-h-0 w-full text-[13px]">
            {busy ? 'Adding…' : 'Get 10,000 test USDC'}
          </button>
        ) : null}

        <div className="mt-3 space-y-2">
          <PerpProgress state={signer} kind={kind} />
          {error ? (
            <p role="alert" className="text-[12.5px] leading-snug text-down">
              {error}
            </p>
          ) : null}
        </div>

        <p className="mt-4 text-[11.5px] leading-relaxed text-text-3">
          {onChain
            ? 'Collateral sits in the AgriVault contract. Only what isn’t backing a position can be withdrawn.'
            : 'Paper venue (development): positions and balances live on this server, not on chain. Prices are Chainlink’s.'}
        </p>
      </div>
    </section>
  );
}

export function AccountSkeleton() {
  return (
    <section className="card" aria-hidden>
      <div className="h-[52px] border-b border-border-soft" />
      <div className="space-y-3 px-5 py-4">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-[26px] w-36" />
        <div className="grid grid-cols-2 gap-3 pt-1">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-8 w-24" />
          ))}
        </div>
      </div>
    </section>
  );
}
