'use client';

import { useState } from 'react';
import Image from 'next/image';
import type { CheckCapability, CheckFinding, CheckSimLeg, TokenCheck } from '@robinchan/shared';
import { CHECK_VERDICT_LABEL, direction, formatPct, formatPriceSmart, formatUsdCompact, relativeTime, shortAddress } from '@robinchan/shared';

import { Avatar } from '@/components/Avatar';
import { CheckIcon, CopyIcon, ExternalIcon, RefreshIcon } from '@/components/icons';
import { ShareButtons } from '@/components/ShareButton';
import { cx } from '@/components/ui';
import { safeUrl } from '@/lib/sanitize';
import { useNow } from '@/lib/usePoll';

import { SEVERITY_STYLE, TokenMarkFallback, VERDICT_STYLE } from './verdict';

const EXPLORER = 'https://robinhoodchain.blockscout.com';

const CAPABILITY_LABEL: Record<CheckCapability, string> = {
  mint: 'Mint',
  blacklist: 'Blacklist',
  pause: 'Pause',
  fees: 'Change tax',
  limits: 'Wallet limits',
  trading: 'Trading switch',
  roles: 'Admin roles',
};

export function CheckReport({
  check,
  refreshing,
  onRecheck,
  onAsk,
}: {
  check: TokenCheck;
  refreshing: boolean;
  onRecheck: () => void;
  onAsk: () => void;
}) {
  const style = VERDICT_STYLE[check.verdict];
  const VerdictIcon = style.icon;
  const symbol = check.token?.symbol ?? '';
  return (
    <div className={cx('space-y-4 transition-opacity', refreshing && 'opacity-70')}>
      <section className={cx('card overflow-hidden', style.ring)} aria-label="Verdict">
        <div className="flex flex-wrap items-start justify-between gap-5 p-5 sm:p-6">
          <div className="flex min-w-0 items-center gap-4">
            <TokenMark check={check} />
            <div className="min-w-0">
              <h2 className="truncate font-display text-[22px] font-semibold leading-tight text-text">
                {check.token?.name ?? 'Not a token'}
              </h2>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-text-2">
                {check.token ? <span className="font-mono tracking-[0.04em] text-text">${symbol}</span> : null}
                <CopyAddress address={check.address} />
              </p>
              <p className="mt-1.5 flex flex-wrap gap-3 text-[12px]">
                <a href={`${EXPLORER}/token/${check.address}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-text-3 hover:text-text hover:underline">
                  Blockscout <ExternalIcon width={11} height={11} />
                </a>
                {check.token ? (
                  <a href={`https://dexscreener.com/robinhood/${check.address}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-text-3 hover:text-text hover:underline">
                    DexScreener <ExternalIcon width={11} height={11} />
                  </a>
                ) : null}
              </p>
            </div>
          </div>

          <div className={cx('flex items-center gap-3 rounded-panel border px-4 py-3', style.ring, style.wash)}>
            <VerdictIcon className={cx('shrink-0', style.text)} width={30} height={30} />
            <div>
              <p className={cx('font-display text-[20px] font-semibold leading-none', style.text)}>{CHECK_VERDICT_LABEL[check.verdict]}</p>
              <p className="mt-1 text-[12px] text-text-2">{style.blurb}</p>
            </div>
          </div>
        </div>

        <div className="flex gap-3 border-t border-border-soft px-5 py-4 sm:px-6">
          <Avatar height={44} />
          <div className="min-w-0 flex-1">
            <p className="rounded-[14px] rounded-tl-[4px] border border-accent-fg/20 bg-accent/[0.06] px-3.5 py-2.5 text-[14px] leading-relaxed text-text">
              {check.headline}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button type="button" onClick={onAsk} className="btn-primary h-10 min-h-0 px-4 text-[13px]">
                Ask Robinchan
              </button>
              {check.token ? <ShareButtons text={shareText(check)} path={`/check/${check.address}`} /> : null}
              <CheckedAt at={check.checkedAt} refreshing={refreshing} onRecheck={onRecheck} />
            </div>
          </div>
        </div>
      </section>

      {check.findings.length ? <Findings findings={check.findings} /> : null}

      {check.token ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <SellTest check={check} />
          <ContractCard check={check} />
          <MarketCard check={check} />
          <SupplyCard check={check} />
        </div>
      ) : null}

      <p className="text-[12px] leading-relaxed text-text-3">
        Read from Robinhood Chain and DexScreener at the time of the check, with the trade simulated on a copy of the latest
        block: nothing is signed or sent. A token can change after it&apos;s checked, and a clean result says nothing about
        where its price goes. Facts, not advice.
      </p>
    </div>
  );
}

function shareText(check: TokenCheck): string {
  const sym = check.token ? `$${check.token.symbol}` : 'this token';
  const top = check.findings.find((f) => f.severity === 'danger') ?? check.findings.find((f) => f.severity === 'warn');
  const why = check.verdict === 'danger' || check.verdict === 'caution' ? (top ? ` (${top.title.toLowerCase()})` : '') : '';
  return `Token Check on ${sym}: ${CHECK_VERDICT_LABEL[check.verdict]}${why}. Check any Robinhood Chain token with @Rchanperps`;
}

function TokenMark({ check }: { check: TokenCheck }) {
  const image = check.market?.imageUrl ? safeUrl(check.market.imageUrl) : null;
  if (image) {
    return (
      <Image
        src={image}
        alt=""
        aria-hidden
        width={56}
        height={56}
        className="h-14 w-14 shrink-0 rounded-full object-cover ring-1 ring-overlay/10"
      />
    );
  }
  return <TokenMarkFallback symbol={check.known?.symbol ?? check.token?.symbol ?? '?'} official={Boolean(check.known)} size={56} />;
}

function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(address);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        } catch {
          /* The address stays on screen to select. */
        }
      }}
      title={`Copy ${address}`}
      aria-label={copied ? 'Address copied' : `Copy the address, ${address}`}
      className="group inline-flex items-center gap-1.5 font-mono text-[12.5px] text-text-2 transition-colors hover:text-accent-fg"
    >
      {shortAddress(address)}
      <span className={copied ? 'text-accent-fg' : 'text-text-3 group-hover:text-accent-fg'}>{copied ? <CheckIcon /> : <CopyIcon />}</span>
    </button>
  );
}

function CheckedAt({ at, refreshing, onRecheck }: { at: string; refreshing: boolean; onRecheck: () => void }) {
  const now = useNow(30_000);
  return (
    <span className="ml-auto inline-flex items-center gap-2 font-mono text-[11px] text-text-3">
      checked {now == null ? '' : relativeTime(at, now)}
      <button
        type="button"
        onClick={onRecheck}
        disabled={refreshing}
        aria-label="Check again"
        title="Check again"
        className="flex h-8 w-8 items-center justify-center rounded-full border border-border text-text-2 transition-colors hover:border-text-3 hover:text-text disabled:opacity-50"
      >
        <RefreshIcon className={refreshing ? 'animate-spin' : ''} />
      </button>
    </span>
  );
}

/* ------------------------------------------------------------------ */

function Findings({ findings }: { findings: CheckFinding[] }) {
  const count = (s: CheckFinding['severity']) => findings.filter((f) => f.severity === s).length;
  const tally = [
    [count('danger'), 'red flag', 'text-down'],
    [count('warn'), 'caution', 'text-warning'],
    [count('good'), 'good sign', 'text-up'],
  ] as const;
  return (
    <section className="card overflow-hidden" aria-label="What Robinchan found">
      <header className="flex h-[52px] items-center justify-between gap-3 border-b border-border-soft px-5">
        <h2 className="t-eyebrow">What I found</h2>
        <span className="hidden gap-3 font-mono text-[11px] sm:flex">
          {tally
            .filter(([n]) => n > 0)
            .map(([n, label, tone]) => (
              <span key={label} className={tone}>
                {n} {label}
                {n === 1 ? '' : 's'}
              </span>
            ))}
        </span>
      </header>
      <ul className="divide-y divide-border-soft">
        {findings.map((f) => {
          const s = SEVERITY_STYLE[f.severity];
          const Icon = s.icon;
          return (
            <li key={f.id} className="flex gap-3 px-5 py-3.5">
              <Icon className={cx('mt-0.5 shrink-0', s.text)} aria-label={s.label} role="img" />
              <div className="min-w-0">
                <p className="text-[14px] font-medium text-text">{f.title}</p>
                <p className="mt-0.5 text-[13px] leading-relaxed text-text-2">{f.detail}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Panel({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="card overflow-hidden">
      <header className="flex h-[52px] items-center justify-between gap-3 border-b border-border-soft px-5">
        <h2 className="t-eyebrow">{title}</h2>
        {aside}
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-[13px]">
      <dt className="text-text-3">{label}</dt>
      <dd className="min-w-0 text-right text-text">{children}</dd>
    </div>
  );
}

function Leg({ label, leg }: { label: string; leg: CheckSimLeg | null }) {
  if (!leg) {
    return (
      <div className="rounded-tile border border-border-soft bg-surface-2/50 px-3.5 py-3">
        <p className="t-eyebrow mb-1.5">{label}</p>
        <p className="font-mono text-[15px] text-text-3">not run</p>
      </div>
    );
  }
  const taxed = (leg.taxPct ?? 0) >= 0.5;
  return (
    <div className={cx('rounded-tile border px-3.5 py-3', leg.ok ? (taxed ? 'border-warning/40' : 'border-up/35') : 'border-down/45 bg-down/[0.05]')}>
      <p className="t-eyebrow mb-1.5">{label}</p>
      <p className={cx('font-mono text-[15px]', leg.ok ? (taxed ? 'text-warning' : 'text-up') : 'text-down')}>
        {leg.ok ? (taxed ? `${(leg.taxPct ?? 0).toFixed(1)}% tax` : 'Went through') : 'Failed'}
      </p>
      <p className="mt-0.5 truncate text-[11.5px] text-text-3" title={leg.error ?? undefined}>
        {leg.ok ? (taxed ? 'the rest arrived' : 'no tax taken') : (leg.error ?? 'reverted')}
      </p>
    </div>
  );
}

function SellTest({ check }: { check: TokenCheck }) {
  const sim = check.simulation;
  return (
    <Panel
      title="Sell test"
      aside={
        <span className={cx('font-mono text-[11px]', sim.status === 'passed' ? 'text-up' : sim.status === 'failed' ? 'text-down' : 'text-text-3')}>
          {sim.status === 'passed' ? 'passed' : sim.status === 'failed' ? 'failed' : 'skipped'}
        </span>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Leg label="Buy" leg={sim.buy} />
        <Leg label="Sell" leg={sim.sell} />
      </div>
      <p className="mt-3 text-[12.5px] leading-relaxed text-text-2">
        {sim.via ? (
          <>
            Tokens sent out of its <span className="text-text">{sim.via}</span> pool to a fresh wallet, then sent back.{' '}
          </>
        ) : null}
        {sim.note}
      </p>
    </Panel>
  );
}

function ContractCard({ check }: { check: TokenCheck }) {
  const c = check.contract;
  if (!c) return <Panel title="Contract">{<p className="text-[13px] text-text-3">The contract couldn&apos;t be read.</p>}</Panel>;
  return (
    <Panel
      title="Contract"
      aside={
        <span className="font-mono text-[11px] text-text-3">
          {c.codeSize < 1024 ? `${c.codeSize} bytes` : `${(c.codeSize / 1024).toFixed(1)} KB`} of code
        </span>
      }
    >
      <dl>
        <Line label="Owner">
          {c.ownerState === 'renounced' ? (
            <span className="text-up">Renounced</span>
          ) : c.ownerState === 'none' ? (
            <span className="text-text-2">No owner function</span>
          ) : c.owner ? (
            <a href={`${EXPLORER}/address/${c.owner}`} target="_blank" rel="noopener noreferrer" className="font-mono text-[12.5px] hover:underline">
              {shortAddress(c.owner)}
            </a>
          ) : (
            'Active'
          )}
        </Line>
        <Line label="Code">
          {c.upgradeable ? (
            <span className="text-warning">Upgradeable{c.proxy ? ` (${c.proxy === 'eip1967' ? 'EIP-1967 proxy' : c.proxy === 'beacon' ? 'beacon proxy' : 'proxy'})` : ''}</span>
          ) : c.proxy === 'clone' ? (
            'Fixed clone'
          ) : (
            'Fixed'
          )}
        </Line>
        {c.implementation ? (
          <Line label="Logic">
            <a href={`${EXPLORER}/address/${c.implementation}`} target="_blank" rel="noopener noreferrer" className="font-mono text-[12.5px] hover:underline">
              {shortAddress(c.implementation)}
            </a>
          </Line>
        ) : null}
      </dl>
      <p className="t-eyebrow mb-2 mt-3">Admin powers in the code</p>
      {c.capabilities.length ? (
        <div className="flex flex-wrap gap-1.5">
          {c.capabilities.map((cap) => (
            <span
              key={cap}
              className={cx(
                'rounded-full border px-2.5 py-1 font-mono text-[11px]',
                check.known ? 'border-border text-text-2' : 'border-warning/40 text-warning',
              )}
            >
              {CAPABILITY_LABEL[cap]}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-[13px] text-up">None found</p>
      )}
    </Panel>
  );
}

function MarketCard({ check }: { check: TokenCheck }) {
  const m = check.market;
  if (!m || !m.pools.length) {
    return (
      <Panel title="Market">
        <p className="text-[13px] text-text-3">{m ? 'No trading pools listed on Robinhood Chain.' : "DexScreener didn't answer this time."}</p>
      </Panel>
    );
  }
  const trades = m.buys24h + m.sells24h;
  const dir = direction(m.change24hPct);
  return (
    <Panel
      title="Market"
      aside={
        m.change24hPct != null ? (
          <span className={cx('font-mono text-[11px]', dir === 'up' ? 'text-up' : dir === 'down' ? 'text-down' : 'text-text-3')}>{formatPct(m.change24hPct)} 24h</span>
        ) : null
      }
    >
      <dl>
        <Line label="Price">
          <span className="font-mono">${formatPriceSmart(m.priceUsd)}</span>
        </Line>
        <Line label="Liquidity">
          <span className="font-mono">{formatUsdCompact(m.liquidityUsd)}</span>
        </Line>
        <Line label="Volume, 24h">
          <span className="font-mono">{formatUsdCompact(m.volume24h)}</span>
        </Line>
        {m.marketCap ?? m.fdv ? (
          <Line label={m.marketCap ? 'Market cap' : 'FDV'}>
            <span className="font-mono">{formatUsdCompact(m.marketCap ?? m.fdv)}</span>
          </Line>
        ) : null}
        {m.firstPoolAt ? (
          <Line label="First pool">
            <FirstPool at={m.firstPoolAt} />
          </Line>
        ) : null}
      </dl>
      <div className="mt-3">
        <div className="mb-1.5 flex justify-between font-mono text-[11px]">
          <span className="text-up">{m.buys24h.toLocaleString('en-US')} buys</span>
          <span className="text-down">{m.sells24h.toLocaleString('en-US')} sells</span>
        </div>
        <div className="flex h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
          <span className="bg-up" style={{ width: `${trades ? (m.buys24h / trades) * 100 : 0}%` }} />
          <span className="bg-down" style={{ width: `${trades ? (m.sells24h / trades) * 100 : 0}%` }} />
        </div>
      </div>
      <ul className="mt-4 divide-y divide-border-soft overflow-hidden rounded-tile border border-border-soft">
        {m.pools.slice(0, 4).map((p) => (
          <li key={p.pair}>
            <a href={p.url} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between gap-3 px-3 py-2 text-[12.5px] transition-colors hover:bg-surface-2">
              <span className="min-w-0 truncate text-text-2">
                <span className="capitalize text-text">{p.dex}</span>
                {p.version ? ` ${p.version}` : ''} · {check.token?.symbol}/{p.quote}
              </span>
              <span className="flex shrink-0 items-center gap-2 font-mono text-[12px] text-text-3">
                {formatUsdCompact(p.liquidityUsd)}
                <ExternalIcon width={11} height={11} />
              </span>
            </a>
          </li>
        ))}
      </ul>
      {m.links.length ? (
        <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
          {m.links.map((l) => {
            const href = safeUrl(l.url);
            return href ? (
              <a key={l.url} href={href} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 text-text-3 hover:text-text hover:underline">
                {l.label}
                <ExternalIcon width={11} height={11} />
              </a>
            ) : null;
          })}
        </p>
      ) : null}
    </Panel>
  );
}

function FirstPool({ at }: { at: string }) {
  const now = useNow(60_000);
  return (
    <span title={new Date(at).toUTCString()}>
      {now == null ? new Date(at).toISOString().slice(0, 10) : relativeTime(at, now)}
    </span>
  );
}

const SUPPLY_PARTS = [
  { key: 'inPoolsPct', label: 'In pools', tone: 'bg-info' },
  { key: 'burnedPct', label: 'Burned', tone: 'bg-text-3' },
  { key: 'ownerPct', label: 'Owner', tone: 'bg-warning' },
  { key: 'contractPct', label: 'The contract', tone: 'bg-companion-pink' },
  { key: 'restPct', label: 'Everyone else', tone: 'bg-up' },
] as const;

function SupplyCard({ check }: { check: TokenCheck }) {
  const s = check.supply;
  const total = check.token?.totalSupply;
  return (
    <Panel title="Supply" aside={total != null ? <span className="font-mono text-[11px] text-text-3">{formatCompactNumber(total)} total</span> : null}>
      {!s ? (
        <p className="text-[13px] text-text-3">The supply couldn&apos;t be read.</p>
      ) : (
        <>
          <div className="flex h-3 overflow-hidden rounded-full bg-surface-2" role="img" aria-label="Where the supply sits">
            {SUPPLY_PARTS.map(({ key, tone }) => {
              const v = s[key] ?? 0;
              return v > 0 ? <span key={key} className={tone} style={{ width: `${Math.max(0.6, v)}%` }} /> : null;
            })}
          </div>
          <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5">
            {SUPPLY_PARTS.map(({ key, label, tone }) => {
              const v = s[key];
              if (v == null) return null;
              return (
                <li key={key} className="flex items-center justify-between gap-2 text-[12.5px]">
                  <span className="flex items-center gap-2 text-text-2">
                    <span className={cx('h-2 w-2 rounded-full', tone)} aria-hidden />
                    {label}
                  </span>
                  <span className="font-mono text-text">{v < 0.01 && v > 0 ? '<0.01' : v.toFixed(v >= 10 ? 1 : 2)}%</span>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-[12px] leading-relaxed text-text-3">
            &ldquo;Everyone else&rdquo; is every wallet that isn&apos;t a pool, a burn address, the owner or the contract. Without an
            indexer, single big holders inside it aren&apos;t broken out.
          </p>
        </>
      )}
    </Panel>
  );
}

function formatCompactNumber(n: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n);
}
