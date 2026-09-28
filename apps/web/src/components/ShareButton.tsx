'use client';

import { useState } from 'react';

import { CheckIcon, CopyIcon } from '@/components/icons';
import { cx } from '@/components/ui';

/**
 * "Post on X" with the text ready, and a copy-link button beside it. The
 * link is this page's own address, read at click time, so it's right on
 * every deployment without configuration.
 */
export function ShareButtons({ text, path, className }: { text: string; path: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const url = () => `${window.location.origin}${path}`;

  const post = () => {
    const intent = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url())}`;
    window.open(intent, '_blank', 'noopener,noreferrer,width=600,height=520');
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* Clipboard refused: the address bar still has it. */
    }
  };

  return (
    <div className={cx('flex items-center gap-2', className)}>
      <button type="button" onClick={post} className="btn-ghost h-10 min-h-0 gap-2 px-4 text-[13px]">
        <svg viewBox="0 0 24 24" width={13} height={13} fill="currentColor" aria-hidden>
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
        Post
      </button>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copied ? 'Link copied' : 'Copy link'}
        title="Copy link"
        className={cx(
          'flex h-10 w-10 items-center justify-center rounded-full border border-border transition-colors hover:border-text-3',
          copied ? 'text-accent-fg' : 'text-text-2 hover:text-text',
        )}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  );
}
