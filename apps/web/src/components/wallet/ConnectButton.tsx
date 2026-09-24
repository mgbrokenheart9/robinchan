'use client';

import { useEffect, useRef, useState } from 'react';
import { TIER_LABELS, shortAddress } from '@robinchan/shared';
import { useAccount, useConnect, useConnectors } from 'wagmi';

import { CloseIcon, WalletIcon } from '@/components/icons';
import { cx } from '@/components/ui';

import { useSession } from './SessionProvider';

/**
 * The topbar's wallet control. One button walks the whole way — connect,
 * switch network, sign in — and then becomes the signed-in address with
 * its tier. It keeps the 44px footprint the M1 placeholder reserved, so the
 * topbar never changes height.
 */
export function ConnectButton({ className }: { className?: string }) {
  const s = useSession();
  const { isConnected } = useAccount();
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const base = cx('btn-ghost h-11 px-4 text-sm', className);

  if (!s.chain) {
    return (
      <button type="button" disabled className={base} title="No chain is configured on the server yet">
        Wallet not set up
      </button>
    );
  }

  if (s.resolving) {
    return (
      <button type="button" disabled className={base} aria-busy="true">
        <span className="inline-block h-3 w-24 animate-breathe rounded bg-surface-2" />
      </button>
    );
  }

  if (s.signedIn && s.session) {
    return (
      <div ref={menuRef} className="relative">
        <button
          type="button"
          onClick={() => setMenu((v) => !v)}
          aria-expanded={menu}
          aria-haspopup="menu"
          className={cx(base, 'gap-2.5')}
        >
          <span className="h-2 w-2 rounded-full bg-up" aria-hidden />
          <span className="font-mono text-[13px]">{shortAddress(s.session.address)}</span>
          {s.tier ? (
            <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-text-2">
              {TIER_LABELS[s.tier.tier]}
            </span>
          ) : null}
        </button>
        {menu ? (
          <div
            role="menu"
            className="absolute right-0 top-[calc(100%+8px)] z-50 w-[260px] rounded-panel border border-border bg-surface p-2 shadow-[0_24px_60px_-30px_rgba(0,0,0,0.95)]"
          >
            <div className="px-3 py-2.5">
              <p className="t-eyebrow mb-1.5">Signed in</p>
              <p className="break-all font-mono text-[12px] text-text-2">{s.session.address}</p>
              {s.tier ? (
                <p className="mt-2 text-[12px] text-text-3">
                  {TIER_LABELS[s.tier.tier]}
                  {s.tier.source === 'unconfigured'
                    ? ' · tier thresholds not set yet'
                    : s.tier.source === 'dev-override'
                      ? ' · dev override'
                      : ` · ${Number(s.tier.balance).toLocaleString('en-US', { maximumFractionDigits: 2 })} $RCHAN`}
                </p>
              ) : null}
            </div>
            {!isConnected ? (
              <p className="px-3 pb-2 text-[12px] leading-snug text-text-3">
                Wallet not connected in this tab — it will be asked for when you sign.
              </p>
            ) : null}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(false);
                void s.signOut();
              }}
              className="flex min-h-[40px] w-full items-center rounded-[10px] px-3 text-left text-[13px] text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
            >
              Sign out and disconnect
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  if (isConnected && s.wrongChain) {
    return (
      <button type="button" onClick={() => void s.switchChain()} className={base}>
        Switch to {s.chain.name.replace(/ \(dev stand-in\)$/, '')}
      </button>
    );
  }

  if (isConnected) {
    return (
      <button type="button" onClick={() => void s.signIn()} disabled={s.signingIn} className={base}>
        {s.signingIn ? 'Check your wallet…' : s.mismatch ? `Sign in as ${shortAddress(s.address ?? '')}` : 'Sign in'}
      </button>
    );
  }

  return (
    <button type="button" onClick={s.openPicker} className={cx(base, 'gap-2')}>
      <WalletIcon />
      Connect wallet
    </button>
  );
}

/**
 * The wallet picker: every injected wallet the browser announced over
 * EIP-6963, in one list. Mounted once per shell.
 */
export function WalletPicker() {
  const s = useSession();
  const connectors = useConnectors();
  const { connectAsync, isPending, variables } = useConnect();
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (s.pickerOpen && !dialog.open) dialog.showModal();
    if (!s.pickerOpen && dialog.open) dialog.close();
  }, [s.pickerOpen]);

  // The generic "Injected" entry only matters when nothing announced itself.
  const named = connectors.filter((c) => c.type === 'injected' && c.id !== 'injected');
  const list = named.length ? named : connectors;
  const hasProvider = typeof window !== 'undefined' && Boolean((window as { ethereum?: unknown }).ethereum);

  return (
    <dialog
      ref={ref}
      onClose={s.closePicker}
      onClick={(e) => {
        if (e.target === e.currentTarget) s.closePicker();
      }}
      aria-labelledby="wallet-title"
      className="m-auto w-[min(calc(100%-32px),400px)] rounded-card border border-border bg-bg p-0 text-text backdrop:bg-black/70 backdrop:backdrop-blur-sm"
    >
      <div className="p-6">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <p className="t-eyebrow mb-2">Wallet</p>
            <h2 id="wallet-title" className="t-h3">
              Connect a wallet
            </h2>
            <p className="mt-2 text-[13px] leading-relaxed text-text-3">
              Then sign one message to prove it&apos;s yours. No transaction, no gas, and Robinchan never
              holds your keys.
            </p>
          </div>
          <button
            type="button"
            onClick={s.closePicker}
            aria-label="Close"
            className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-text-3 transition-colors hover:text-text"
          >
            <CloseIcon />
          </button>
        </div>

        {list.length === 0 || (!named.length && !hasProvider) ? (
          <p className="rounded-panel border border-border-soft bg-surface px-4 py-4 text-[13px] leading-relaxed text-text-2">
            No browser wallet found. Install one such as MetaMask or Rabby, then reload this page.
          </p>
        ) : (
          <ul className="space-y-2">
            {list.map((connector) => {
              const busy = isPending && variables?.connector === connector;
              return (
                <li key={connector.uid}>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={async () => {
                      setError(null);
                      s.markConnectIntent();
                      try {
                        await connectAsync({ connector, chainId: s.chain?.id });
                        s.closePicker();
                      } catch (err) {
                        const msg = err instanceof Error ? err.message : '';
                        setError(/rejected|denied/i.test(msg) ? 'Connection was declined in the wallet.' : "Couldn't connect to that wallet.");
                      }
                    }}
                    className="flex min-h-[52px] w-full items-center gap-3 rounded-panel border border-border bg-surface px-4 text-left transition-colors hover:border-text-3 disabled:opacity-60"
                  >
                    {connector.icon ? (
                      // eslint-disable-next-line @next/next/no-img-element -- wallet icons are data: URIs from the extension
                      <img src={connector.icon} alt="" className="h-7 w-7 rounded-[8px]" />
                    ) : (
                      <span className="flex h-7 w-7 items-center justify-center rounded-[8px] bg-surface-2 text-text-3">
                        <WalletIcon />
                      </span>
                    )}
                    <span className="flex-1 text-[14px]">{connector.name === 'Injected' ? 'Browser wallet' : connector.name}</span>
                    {busy ? <span className="font-mono text-[11px] text-text-3">opening…</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {error || s.error ? (
          <p role="alert" className="mt-4 text-[13px] text-down">
            {error ?? s.error}
          </p>
        ) : null}

        {s.chain?.devFallback ? (
          <p className="mt-5 text-[11px] leading-relaxed text-text-3">
            Dev build: no chain is configured yet, so this uses {s.chain.name}. Signing in is free on any network.
          </p>
        ) : null}
      </div>
    </dialog>
  );
}
