'use client';

import type { MediaClip, NewsItem } from '@robinchan/shared';
import { formatDuration, relativeTime, sentimentBucket } from '@robinchan/shared';

import { ExternalIcon } from '@/components/icons';
import { SentimentDot, cx } from '@/components/ui';
import { safeUrl, sanitizeText } from '@/lib/sanitize';

const CAT_TONE: Record<NewsItem['cat'], string> = {
  SEC: 'border-border text-text',
  NEWS: 'border-border text-text-2',
  CHAIN: 'border-accent-fg/35 text-accent-fg',
  SOCIAL: 'border-border-soft text-text-3',
};

/**
 * One row of the news feed (brief §6): category badge, title clamped to two
 * lines, related tickers, relative time, and a sentiment dot.
 */
export function NewsCard({ item, now }: { item: NewsItem; now: number | null }) {
  const href = safeUrl(item.url);
  const title = sanitizeText(item.title);
  const tone = sentimentBucket(item.sentiment);

  const inner = (
    <>
      <div className="flex items-start gap-3">
        <SentimentDot tone={tone} />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-[14px] leading-[1.45] text-text">{title}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span
              className={cx(
                'rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em]',
                CAT_TONE[item.cat],
              )}
            >
              {item.cat}
            </span>
            {item.symbols.slice(0, 2).map((symbol) => (
              <span key={symbol} className="font-mono text-[11px] tracking-[0.04em] text-text-2">
                {symbol}
              </span>
            ))}
            <span className="font-mono text-[11px] text-text-3">
              {sanitizeText(item.source, 28)}
            </span>
            <span className="ml-auto font-mono text-[11px] text-text-3">
              {now == null ? '—' : relativeTime(item.publishedAt, now)}
            </span>
          </div>
        </div>
      </div>
    </>
  );

  if (!href) {
    return <article className="row-dense px-5 py-4">{inner}</article>;
  }

  return (
    <article className="row-dense transition-colors hover:bg-surface-2">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="block px-5 py-4"
        title={title}
      >
        {inner}
      </a>
    </article>
  );
}

/** "Highlights" clip card — a small variant of the same component. */
export function ClipCard({ clip, now }: { clip: MediaClip; now: number | null }) {
  const href = safeUrl(clip.url);
  const title = sanitizeText(clip.title, 90);

  return (
    <article className="row-dense border border-border-soft bg-surface-2 p-3.5 transition-colors hover:border-border">
      <a
        href={href ?? '#'}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="block"
        aria-disabled={href ? undefined : true}
      >
        <p className="line-clamp-2 text-[13px] leading-[1.4] text-text">{title}</p>
        <div className="mt-2.5 flex items-center gap-2 font-mono text-[11px] text-text-3">
          <span className="truncate">{sanitizeText(clip.channel, 24)}</span>
          {clip.durationSec > 0 ? (
            <>
              <span aria-hidden>·</span>
              <span>{formatDuration(clip.durationSec)}</span>
            </>
          ) : null}
          <span aria-hidden>·</span>
          <span>{now == null ? '—' : relativeTime(clip.publishedAt, now)}</span>
          <ExternalIcon className="ml-auto shrink-0 opacity-60" />
        </div>
      </a>
    </article>
  );
}
