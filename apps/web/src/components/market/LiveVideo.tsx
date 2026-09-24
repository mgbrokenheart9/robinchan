'use client';

import { useEffect, useRef, useState } from 'react';
import type { ApiEnvelope, MediaChannel } from '@robinchan/shared';

import { ExternalIcon } from '@/components/icons';
import { CardHead, PulseDot, cx } from '@/components/ui';
import { safeUrl, sanitizeText } from '@/lib/sanitize';
import { usePoll } from '@/lib/usePoll';

/**
 * Live video broadcast (brief §6).
 *
 * - 16:9 slot inside a card, 352px tall
 * - The iframe only mounts once the card enters the viewport, plus `loading="lazy"`
 * - Starts muted; autoplay with sound would be blocked by the browser anyway
 * - Channel tabs swap `videoId` without a page reload
 * - If `videoId` isn't available yet or the iframe fails, show a poster +
 *   button to YouTube — `videoId` comes from the API, never hardcoded here
 */
export function LiveVideo({ initial }: { initial: ApiEnvelope<MediaChannel[]> }) {
  const envelope = usePoll<MediaChannel[]>('/api/media/channels', initial, 10 * 60_000);
  const channels = envelope.data;

  const [activeId, setActiveId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [visible, setVisible] = useState(false);
  const cardRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const node = cardRef.current;
    if (!node || visible) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);

  const active = channels.find((c) => c.id === activeId) ?? channels[0] ?? null;

  useEffect(() => {
    setFailed(false);
  }, [active?.videoId]);

  return (
    <section ref={cardRef} className="card overflow-hidden">
      <CardHead
        title="Live broadcast"
        aside={
          active?.live ? (
            <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-accent-fg">
              <PulseDot />
              LIVE
            </span>
          ) : (
            <span className="font-mono text-[11px] text-text-3">no active stream</span>
          )
        }
      />

      <div className="flex h-[352px] items-center justify-center bg-black">
        {active && active.videoId && visible && !failed ? (
          <iframe
            key={active.videoId}
            // youtube-nocookie + mute=1: autoplay with sound would be blocked anyway.
            src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(active.videoId)}?autoplay=1&mute=1&playsinline=1&rel=0`}
            title={`Live broadcast: ${sanitizeText(active.label, 40)}`}
            loading="lazy"
            allow="accelerometer; autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
            onError={() => setFailed(true)}
            className="aspect-video h-full w-auto max-w-full border-0"
          />
        ) : (
          <Poster channel={active} />
        )}
      </div>

      <div
        className="flex flex-wrap gap-2 border-t border-border-soft p-3"
        role="tablist"
        aria-label="Choose a channel"
      >
        {channels.length === 0 ? (
          <span className="px-2 py-1 font-mono text-[11px] text-text-3">
            channel list hasn&apos;t loaded yet
          </span>
        ) : (
          channels.map((channel) => {
            const isActive = channel.id === active?.id;
            return (
              <button
                key={channel.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActiveId(channel.id)}
                className={cx(
                  'inline-flex min-h-[36px] items-center gap-2 rounded-full border px-3.5 text-[13px] transition-colors',
                  isActive
                    ? 'border-accent-fg/45 bg-accent/[0.07] text-text'
                    : 'border-border text-text-2 hover:border-text-3 hover:text-text',
                )}
              >
                {channel.live ? <PulseDot /> : null}
                {sanitizeText(channel.label, 24)}
              </button>
            );
          })
        )}
      </div>
    </section>
  );
}

function Poster({ channel }: { channel: MediaChannel | null }) {
  const href = channel ? safeUrl(channel.url) : null;

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-surface-2 px-6 text-center">
      <p className="font-mono text-[12px] uppercase tracking-[0.12em] text-text-3">
        stream couldn&apos;t load
      </p>
      <p className="max-w-[360px] text-[13px] leading-relaxed text-text-3">
        The provider hasn&apos;t confirmed an active stream id yet. The channel can still be opened
        directly.
      </p>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-ghost h-10 text-[13px]"
        >
          Open on YouTube
          <ExternalIcon />
        </a>
      ) : null}
    </div>
  );
}
