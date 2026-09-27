'use client';

import type { ReactNode } from 'react';
import { formatClock, relativeTime } from '@robinchan/shared';

import { LockIcon, RefreshIcon, WalletIcon } from '@/components/icons';
import { cx } from '@/components/ui';
import { useSession } from '@/components/wallet/SessionProvider';
import { useNow } from '@/lib/usePoll';

/**
 * The four states every data block on the dashboard pages handles
 * (Trade-Heat-Portfolio §2). Loading is each block's own skeleton, sized
 * like its content; these cover the other three, plus the tier lock and the
 * "no wallet yet" gate.
 */

/** Short message and a retry — no technical codes (§2). */
export function ErrorState({
  message = "This couldn't load right now.",
  onRetry,
  className,
}: {
  message?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div role="alert" className={cx('flex flex-col items-center justify-center gap-3 px-6 py-10 text-center', className)}>
      <p className="max-w-[380px] text-[13px] leading-relaxed text-text-2">{message}</p>
      {onRetry ? (
        <button type="button" onClick={onRetry} className="btn-ghost h-10 min-h-0 gap-2 px-4 text-[13px]">
          <RefreshIcon />
          Try again
        </button>
      ) : null}
    </div>
  );
}

/** Why it's empty, and one thing to do about it (§2). */
export function EmptyState({
  title,
  body,
  action,
  illustration,
  className,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
  illustration?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('flex flex-col items-center justify-center gap-3 px-6 py-12 text-center', className)}>
      {illustration}
      <p className="t-h3">{title}</p>
      {body ? <p className="max-w-[420px] text-[13px] leading-relaxed text-text-3">{body}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/**
 * "Updated …" for a block's header — and, when the data is stale, the same
 * pill the Market page uses so dimmed text is never the only signal.
 */
export function UpdatedAt({ asOf, stale, className }: { asOf: string | null; stale?: boolean; className?: string }) {
  const now = useNow(30_000);
  if (!asOf) return null;
  return (
    <span className={cx('inline-flex items-center gap-2 font-mono text-[11px] text-text-3', className)}>
      {stale ? (
        <span
          className="rounded-full border border-border-soft px-2 py-0.5 uppercase tracking-[0.12em]"
          title="Shown from the last successful update"
        >
          stale
        </span>
      ) : null}
      <span title={new Date(asOf).toLocaleString()}>
        {now == null ? formatClock(asOf) : `updated ${relativeTime(asOf, now)}`}
      </span>
    </span>
  );
}

export function TierLockLabel({ tier, className }: { tier: 'wallet' | 'tier1' | 'tier3'; className?: string }) {
  const label = tier === 'wallet' ? 'Connect wallet' : tier === 'tier1' ? 'Tier 1' : 'Tier 3';
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 font-mono text-[11px] text-text-2',
        className,
      )}
    >
      <LockIcon />
      {label}
    </span>
  );
}

/**
 * No wallet yet: the real layout, filled with sample data and blurred, with
 * the connect button in the middle — people should see what they get before
 * they connect (§2). The sample is inert and hidden from assistive tech.
 */
export function ConnectGate({
  title,
  body,
  sample,
  skeleton,
  compact = false,
  children,
}: {
  title: string;
  body: string;
  sample: ReactNode;
  /** Shown while the session is still being worked out — neither gate nor data yet. */
  skeleton: ReactNode;
  /** For a narrow column (the order ticket): the card fills it and sits centered. */
  compact?: boolean;
  children: ReactNode;
}) {
  const s = useSession();
  if (s.signedIn) return <>{children}</>;
  if (s.resolving) return <>{skeleton}</>;

  return (
    // The prompt card is absolutely placed over the sample: a short sample
    // (two sample positions) must still leave room for it, or it spills onto
    // whatever sits below the gate.
    <div className={cx('relative', !compact && 'min-h-[400px]')}>
      <div aria-hidden inert className="pointer-events-none select-none opacity-70 blur-[5px] saturate-50">
        {sample}
      </div>
      <div className={cx('absolute inset-0 flex justify-center', compact ? 'items-center px-3' : 'items-start pt-24')}>
        <div
          className={cx(
            'card text-center shadow-[0_32px_80px_-30px_rgba(0,0,0,0.6)]',
            compact ? 'w-full p-5' : 'w-[min(420px,calc(100%-32px))] p-7',
          )}
        >
          <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-border bg-surface-2 text-accent-fg">
            <WalletIcon width={22} height={22} />
          </span>
          <h2 className="t-h3 mb-2">{title}</h2>
          <p className="mb-6 text-[13px] leading-relaxed text-text-2">{body}</p>
          {!s.chain ? (
            <p className="text-[13px] text-text-3">Wallet features aren&apos;t configured on this server yet.</p>
          ) : s.address && s.wrongChain ? (
            <button type="button" onClick={() => void s.switchChain()} className="btn-primary text-sm">
              Switch network
            </button>
          ) : s.address ? (
            <button type="button" onClick={() => void s.signIn()} disabled={s.signingIn} className="btn-primary text-sm">
              {s.signingIn ? 'Check your wallet…' : 'Sign in with this wallet'}
            </button>
          ) : (
            <button type="button" onClick={s.openPicker} className="btn-primary gap-2 text-sm">
              <WalletIcon />
              Connect wallet
            </button>
          )}
          {s.error ? (
            <p role="alert" className="mt-4 text-[12.5px] text-down">
              {s.error}
            </p>
          ) : null}
          <p className="mt-5 text-[11px] leading-relaxed text-text-3">
            Read-only until you sign an order yourself. Robinchan never holds your keys.
          </p>
        </div>
      </div>
    </div>
  );
}
