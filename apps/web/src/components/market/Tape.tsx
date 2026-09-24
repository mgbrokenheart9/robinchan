'use client';

import type { ApiEnvelope, NewsItem } from '@robinchan/shared';
import { POLL_MS, sentimentBucket } from '@robinchan/shared';

import { Marquee } from '@/components/Marquee';
import { SentimentDot } from '@/components/ui';
import { sanitizeText } from '@/lib/sanitize';
import { usePoll } from '@/lib/usePoll';

/**
 * Tape (brief §6): a single-row marquee, 52px tall, with a TAPE label pinned
 * to the left. Its content is the backend's `short` field, not the full title.
 */
export function Tape({ initial }: { initial: ApiEnvelope<NewsItem[]> }) {
  const envelope = usePoll<NewsItem[]>('/api/news?limit=12&pinned=true', initial, POLL_MS.news);
  const items = envelope.data;

  return (
    <section className="flex h-[52px] items-stretch overflow-hidden rounded-panel border border-border bg-surface">
      <div className="flex shrink-0 items-center border-r border-border-soft px-4">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-accent-fg">Tape</span>
      </div>

      {items.length === 0 ? (
        <div className="flex items-center px-4 font-mono text-[12px] text-text-3">
          waiting for headlines…
        </div>
      ) : (
        <Marquee
          ariaLabel="Latest headlines"
          speed={58}
          direction="left"
          gap={0}
          className="flex-1"
        >
          {[0, 1].flatMap((pass) =>
            items.map((item) => (
              <span
                key={`${pass}-${item.id}`}
                className="flex h-[52px] shrink-0 items-center gap-2.5 whitespace-nowrap px-5 text-[13px] text-text-2"
              >
                <SentimentDot tone={sentimentBucket(item.sentiment)} />
                {sanitizeText(item.short, 70)}
                <span className="text-text-3" aria-hidden>
                  /
                </span>
              </span>
            )),
          )}
        </Marquee>
      )}
    </section>
  );
}
