import type { MediaChannel, MediaClip } from '@robinchan/shared';

import { callProvider, fetchJson } from './adapter.js';

/**
 * 24-hour streams sometimes get swapped out by their owners, so `videoId`
 * must never be hardcoded on the frontend (brief §6). The worker resolves
 * it from a channelId via the YouTube Data API.
 *
 * Without `YOUTUBE_API_KEY`, `videoId` is deliberately left empty so the
 * frontend falls back to a static poster + "Open on YouTube" button — a
 * fallback path the brief actually requires, not a fake id that would fail
 * to load silently.
 */
const CHANNELS: Array<{
  id: string;
  label: string;
  channelId: string;
  handle: string;
}> = [
  {
    id: 'bloomberg',
    label: 'Bloomberg TV',
    channelId: 'UCIALMKvObZNtJ6AmdCLP7Lg',
    handle: 'markets',
  },
  {
    id: 'yahoo-finance',
    label: 'Yahoo Finance',
    channelId: 'UCEAZeUIeJs0IjQiqTCdVSIg',
    handle: 'YahooFinance',
  },
  {
    id: 'reuters',
    label: 'Reuters',
    channelId: 'UChqUTb7kYRX8-EiaN3XFrSQ',
    handle: 'Reuters',
  },
  {
    id: 'coindesk',
    label: 'CoinDesk',
    channelId: 'UCTsAnDtd6pIqW-B32C5Gwyw',
    handle: 'CoinDesk',
  },
];

const SEARCH = 'https://www.googleapis.com/youtube/v3/search';

type SearchResponse = {
  items?: Array<{
    id?: { videoId?: string };
    snippet?: { title?: string; channelTitle?: string; publishedAt?: string };
  }>;
};

function channelUrl(handle: string): string {
  return `https://www.youtube.com/@${handle}/streams`;
}

export async function fetchChannels(): Promise<MediaChannel[]> {
  const apiKey = process.env.YOUTUBE_API_KEY || undefined;

  const offline: MediaChannel[] = CHANNELS.map((c) => ({
    id: c.id,
    label: c.label,
    videoId: '',
    live: false,
    url: channelUrl(c.handle),
  }));

  try {
    return await callProvider({ id: 'youtube', configured: Boolean(apiKey) }, async () => {
      const resolved: MediaChannel[] = [];
      for (const c of CHANNELS) {
        const body = await fetchJson<SearchResponse>(
          `${SEARCH}?part=snippet&channelId=${c.channelId}&eventType=live&type=video&maxResults=1&key=${apiKey}`,
        );
        const videoId = body.items?.[0]?.id?.videoId ?? '';
        resolved.push({
          id: c.id,
          label: c.label,
          videoId,
          live: Boolean(videoId),
          url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : channelUrl(c.handle),
        });
      }
      return resolved;
    });
  } catch {
    // The channel list still comes back; only the active stream id is missing.
    return offline;
  }
}

export async function fetchClips(): Promise<MediaClip[]> {
  const apiKey = process.env.YOUTUBE_API_KEY || undefined;
  return callProvider({ id: 'youtube', configured: Boolean(apiKey) }, async () => {
    const out: MediaClip[] = [];
    for (const c of CHANNELS.slice(0, 3)) {
      const body = await fetchJson<SearchResponse>(
        `${SEARCH}?part=snippet&channelId=${c.channelId}&order=date&type=video&maxResults=2&key=${apiKey}`,
      );
      for (const item of body.items ?? []) {
        const videoId = item.id?.videoId;
        if (!videoId) continue;
        out.push({
          id: `yt_${videoId}`,
          title: item.snippet?.title ?? 'Untitled',
          channel: item.snippet?.channelTitle ?? c.label,
          videoId,
          // Duration needs a separate videos.list call; not worth it in phase 1.
          durationSec: 0,
          publishedAt: item.snippet?.publishedAt ?? new Date().toISOString(),
          url: `https://www.youtube.com/watch?v=${videoId}`,
        });
      }
    }
    if (out.length === 0) throw new Error('no clips read');
    return out.slice(0, 4);
  });
}

export const CHANNEL_LIST = CHANNELS;
