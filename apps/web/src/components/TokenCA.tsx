'use client';

import { useState } from 'react';
import Image from 'next/image';
import { RCHAN_TOKEN, shortAddress } from '@robinchan/shared';

import { CheckIcon, CopyIcon, ExternalIcon } from '@/components/icons';
import { cx } from '@/components/ui';

const EXPLORER = 'https://robinhoodchain.blockscout.com';

/**
 * $RCHAN's contract address, copyable, with where to check it: the token
 * on Blockscout and its pair on DexScreener. `hero` sits under the landing
 * page's calls to action; `compact` fits the dashboard sidebar.
 */
export function TokenCA({ variant = 'hero', className }: { variant?: 'hero' | 'compact'; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(RCHAN_TOKEN.address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* Clipboard refused: the address is still on screen to select. */
    }
  };

  const links = [
    { label: 'Blockscout', href: `${EXPLORER}/token/${RCHAN_TOKEN.address}` },
    { label: 'DexScreener', href: `https://dexscreener.com/robinhood/${RCHAN_TOKEN.address}` },
  ];

  const address = (
    <button
      type="button"
      onClick={() => void copy()}
      title={`Copy ${RCHAN_TOKEN.address}`}
      aria-label={copied ? 'Contract address copied' : `Copy the $RCHAN contract address, ${RCHAN_TOKEN.address}`}
      className="group inline-flex min-w-0 items-center gap-1.5 font-mono text-text transition-colors hover:text-accent-fg"
    >
      <span className="truncate">{variant === 'hero' ? RCHAN_TOKEN.address : shortAddress(RCHAN_TOKEN.address)}</span>
      <span className={cx('shrink-0', copied ? 'text-accent-fg' : 'text-text-3 group-hover:text-accent-fg')}>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </span>
    </button>
  );

  if (variant === 'compact') {
    return (
      <div className={cx('rounded-tile border border-border bg-surface-2/60 px-3.5 py-3', className)}>
        <div className="mb-1.5 flex items-center gap-2">
          <Image src="/img/logo.jpg" alt="" width={20} height={20} className="rounded-full ring-1 ring-overlay/10" />
          <span className="font-mono text-[12px] tracking-[0.04em] text-text">${RCHAN_TOKEN.symbol}</span>
          <span className="t-eyebrow ml-auto">CA</span>
        </div>
        <div className="text-[12.5px]">{address}</div>
        <div className="mt-1.5 flex gap-3 text-[11.5px]">
          {links.map((l) => (
            <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-text-3 hover:text-text hover:underline">
              {l.label}
              <ExternalIcon width={11} height={11} />
            </a>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cx(
        'card-glass inline-flex max-w-full flex-wrap items-center gap-x-4 gap-y-2 rounded-[20px] px-4 py-3 text-[13px]',
        className,
      )}
    >
      <span className="flex items-center gap-2">
        <Image src="/img/logo.jpg" alt="" width={24} height={24} className="rounded-full ring-1 ring-overlay/10" />
        <span className="font-mono tracking-[0.04em] text-text">${RCHAN_TOKEN.symbol}</span>
        <span className="t-eyebrow">CA</span>
      </span>
      <span className="min-w-0 max-w-full">{address}</span>
      <span className="flex gap-3 text-[12px]">
        {links.map((l) => (
          <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-text-2 hover:text-text hover:underline">
            {l.label}
            <ExternalIcon width={12} height={12} />
          </a>
        ))}
      </span>
    </div>
  );
}
