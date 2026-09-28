'use client';

import { useEffect, useRef } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import type { ApiEnvelope, RecentCheck, TokenCheck } from '@robinchan/shared';
import { RCHAN_TOKEN, relativeTime, shortAddress } from '@robinchan/shared';

import { useCompanion, usePageContext } from '@/components/companion/CompanionProvider';
import {
  ArrowRightIcon,
  FindingDangerIcon,
  LiquidityIcon,
  SearchIcon,
  VerdictCautionIcon,
  VerdictOfficialIcon,
} from '@/components/icons';
import { ErrorState } from '@/components/states';
import { TickerLogo } from '@/components/TickerCard';
import { PageHeader, Skeleton, cx } from '@/components/ui';
import { safeUrl } from '@/lib/sanitize';
import { useApi } from '@/lib/useApi';
import { useNow } from '@/lib/usePoll';

import { CheckReport } from './CheckReport';
import { CheckSearch } from './CheckSearch';
import { TokenMarkFallback, VerdictPill } from './verdict';

/** A fresh check is reused this long; an older one shown on arrival is re-run. */
const REUSE_MS = 120_000;

/** Live examples, each showing a different thing the check catches. */
const EXAMPLES: Array<{ label: string; hint: string; address: string; fake?: true }> = [
  { label: 'TSLA', hint: 'official stock token', address: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d' },
  { label: 'NVDA', hint: 'a fake one', address: '0x5DD716Fe12275B69f04b26bEeca343843C8e3539', fake: true },
  { label: 'CASHCAT', hint: 'top memecoin', address: '0x020bfC650A365f8BB26819deAAbF3E21291018b4' },
  { label: 'RCHAN', hint: 'our token', address: RCHAN_TOKEN.address },
];

export function CheckView({ address, initial }: { address: string | null; initial: ApiEnvelope<TokenCheck | null> | null }) {
  usePageContext({ page: 'check', symbol: address });

  return (
    <>
      <PageHeader
        eyebrow="Token Check"
        title="Is this token what it says it is?"
        lead="Paste any token address on Robinhood Chain. Robinchan reads its contract and pools, spots fakes of real stock tokens, and simulates a buy and a sell to see if it can actually be sold. Facts, not advice."
      />
      <div className="mb-6">
        <CheckSearch key={address ?? 'empty'} initial={address ?? ''} />
      </div>
      {address ? <Result address={address} initial={initial} /> : <Landing />}
    </>
  );
}

function Result({ address, initial }: { address: string; initial: ApiEnvelope<TokenCheck | null> | null }) {
  const companion = useCompanion();
  const check = useApi<TokenCheck | null>(`/api/check/${address}`, { initial, keepPrevious: true });
  const { reload } = check;

  // Shown from an earlier check: run it again now, keeping the old one on screen meanwhile.
  const rechecked = useRef(false);
  useEffect(() => {
    if (rechecked.current || !initial?.data) return;
    rechecked.current = true;
    if (Date.now() - Date.parse(initial.data.checkedAt) > REUSE_MS) reload();
  }, [initial, reload]);

  if (check.status === 'error') {
    return (
      <div className="card">
        <ErrorState message={check.error?.message ?? "This token couldn't be checked right now."} onRetry={reload} />
      </div>
    );
  }
  if (!check.data) return <Checking />;
  const data = check.data;
  return (
    <CheckReport
      check={data}
      refreshing={check.refreshing}
      onRecheck={reload}
      onAsk={() =>
        companion.ask(
          data.token ? `What should I know about ${data.token.symbol}, from what you found?` : 'What did you find at this address?',
          { page: 'check', symbol: address },
        )
      }
    />
  );
}

function Checking() {
  const steps = ['Reading the contract', 'Looking up its pools', 'Simulating a buy and a sell'];
  return (
    <div className="card p-6" role="status" aria-live="polite">
      <div className="flex items-center gap-4">
        <Skeleton className="h-14 w-14 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-3.5 w-32" />
        </div>
        <Skeleton className="hidden h-14 w-40 rounded-panel sm:block" />
      </div>
      <ul className="mt-6 space-y-2.5">
        {steps.map((s, i) => (
          <li key={s} className="flex items-center gap-3 text-[13px] text-text-2">
            <span className="h-2 w-2 animate-pod-bounce rounded-full bg-accent" style={{ animationDelay: `${i * 0.18}s` }} aria-hidden />
            {s}…
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* No token yet                                                        */
/* ------------------------------------------------------------------ */

function Landing() {
  const recent = useApi<RecentCheck[]>('/api/check/recent', { intervalMs: 30_000 });
  return (
    <div className="space-y-6">
      <section aria-label="Try one">
        <p className="t-eyebrow mb-3">Try one</p>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {EXAMPLES.map((e) => (
            <Link
              key={e.address}
              href={`/check/${e.address}`}
              className="card group flex items-center gap-3 px-4 py-3.5 transition-colors hover:border-text-3"
            >
              {e.fake ? (
                <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-down/10 text-down ring-1 ring-down/30">
                  <FindingDangerIcon />
                </span>
              ) : (
                <TickerLogo symbol={e.label} size={32} />
              )}
              <span className="min-w-0 flex-1">
                <span className="block font-mono text-[13.5px] tracking-[0.04em] text-text">{e.label}</span>
                <span className="block truncate text-[12px] text-text-3">{e.hint}</span>
              </span>
              <ArrowRightIcon className="shrink-0 text-text-3 transition-transform group-hover:translate-x-0.5 group-hover:text-text" />
            </Link>
          ))}
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <section className="card overflow-hidden" aria-label="What Robinchan checks">
          <header className="flex h-[52px] items-center border-b border-border-soft px-5">
            <h2 className="t-eyebrow">What I look at</h2>
          </header>
          <ul className="divide-y divide-border-soft">
            {[
              {
                icon: <FindingDangerIcon className="text-down" />,
                title: 'Can it be sold?',
                body: 'I send some out of its biggest pool to a fresh wallet and back, on a copy of the chain. Blocked sells and hidden taxes show up right away.',
              },
              {
                icon: <VerdictOfficialIcon width={16} height={16} className="text-accent-fg" />,
                title: 'Is it the real one?',
                body: "Robinhood's stock tokens get copied. I know the real addresses for 40+ of them, and I flag look-alikes of $RCHAN, USDG and WETH too.",
              },
              {
                icon: <VerdictCautionIcon width={16} height={16} className="text-warning" />,
                title: 'Who controls it?',
                body: 'Owner, upgradeable proxy, and the switches in its code: minting, blacklists, pausing, tax changes, trading on/off.',
              },
              {
                icon: <LiquidityIcon width={16} height={16} className="text-info" />,
                title: 'Is there a real market?',
                body: 'Liquidity, age, buyers against sellers, and where the supply sits: pools, burned, the owner, the contract.',
              },
            ].map((item) => (
              <li key={item.title} className="flex gap-3.5 px-5 py-4">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-surface-2">{item.icon}</span>
                <span>
                  <span className="block text-[14px] font-medium text-text">{item.title}</span>
                  <span className="mt-0.5 block text-[13px] leading-relaxed text-text-2">{item.body}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="card overflow-hidden" aria-label="Recently checked">
          <header className="flex h-[52px] items-center border-b border-border-soft px-5">
            <h2 className="t-eyebrow">Recently checked</h2>
          </header>
          {recent.status === 'loading' ? (
            <div className="space-y-3 p-5" aria-hidden>
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : !recent.data?.length ? (
            <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
              <SearchIcon className="text-text-3" />
              <p className="max-w-[300px] text-[13px] leading-relaxed text-text-3">
                Nothing checked yet. Paste an address above, or try one of the examples.
              </p>
            </div>
          ) : (
            <RecentList items={recent.data} />
          )}
        </section>
      </div>
    </div>
  );
}

function RecentList({ items }: { items: RecentCheck[] }) {
  const now = useNow(30_000);
  return (
    <ul className="divide-y divide-border-soft">
      {items.map((r) => {
        const image = r.imageUrl ? safeUrl(r.imageUrl) : null;
        return (
          <li key={r.address}>
            <Link href={`/check/${r.address}`} className="flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-surface-2">
              {image ? (
                <Image src={image} alt="" aria-hidden width={28} height={28} className="h-7 w-7 shrink-0 rounded-full object-cover ring-1 ring-overlay/10" />
              ) : (
                <TokenMarkFallback symbol={r.symbol} official={r.verdict === 'official'} size={28} />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-[13px] tracking-[0.03em] text-text">{r.symbol}</span>
                <span className="block truncate text-[11.5px] text-text-3">
                  {r.name} · {shortAddress(r.address)}
                </span>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-1">
                <VerdictPill verdict={r.verdict} />
                <span className={cx('font-mono text-[10.5px] text-text-3')}>{now == null ? '' : relativeTime(r.at, now)}</span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
