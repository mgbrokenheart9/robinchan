import type { MediaChannel, MediaClip } from '@robinchan/shared';
import { cacheKey, getCache } from '@robinchan/store';

import { callProvider, fetchJson } from './adapter.js';
import { log } from '../lib/log.js';

/**
 * 24-hour streams sometimes get swapped out by their owners, so `videoId`
 * must never be hardcoded on the frontend (brief §6). The worker resolves
 * it from a channelId via the YouTube Data API.
 *
 * Without `YOUTUBE_API_KEY`, `videoId` is deliberately left empty so the
 * frontend falls back to a static poster + "Open on YouTube" button — a
 * fallback path the brief actually requires, not a fake id that would fail
 * to load silently.
 *
 * Quota budget (the free tier is 10,000 units/day). `search.list` costs 100
 * units a call, everything else used here costs 1 — so search is the one
 * thing to ration:
 *
 * - Live: every run re-checks the known stream ids plus each channel's
 *   latest uploads in ONE `videos.list` call (1 unit) after one
 *   `playlistItems.list` per channel (1 unit each). That keeps a found
 *   stream confirmed and catches newly started ones cheaply. `search` is
 *   only the fallback for a channel with no confirmed stream — 24/7 streams
 *   started months ago never show up in the recent uploads — and runs at
 *   most once per channel every `SEARCH_EVERY_MS`, without retries.
 * - Clips: recent uploads via `playlistItems` + `videos.list` for duration.
 *
 * Worst case ≈ 5 units × 144 runs + 4 × 12 searches × 100 ≈ 5.5k units/day.
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
    channelId: 'UC7TghOL755nBk7HelHoi9LQ',
    handle: 'CoinDesk',
  },
];

const API = 'https://www.googleapis.com/youtube/v3';

/** Minimum gap between `search.list` live lookups for one channel. */
const SEARCH_EVERY_MS = 2 * 60 * 60_000;
/** After a 429/403 from search, leave it alone this long. */
const SEARCH_BACKOFF_MS = 6 * 60 * 60_000;
/** Live-discovery state survives worker restarts via the cache. */
const LIVE_STATE_KEY = cacheKey('media', 'yt-live-state');
const LIVE_STATE_TTL_SEC = 24 * 3600;

type LiveState = Record<string, { videoId: string; nextSearchAt: number }>;

type PlaylistItemsResponse = {
  items?: Array<{ contentDetails?: { videoId?: string } }>;
};

type VideosResponse = {
  items?: Array<{
    id: string;
    snippet?: {
      title?: string;
      channelId?: string;
      channelTitle?: string;
      publishedAt?: string;
      liveBroadcastContent?: 'live' | 'upcoming' | 'none';
    };
    contentDetails?: { duration?: string };
  }>;
};

type SearchResponse = {
  items?: Array<{ id?: { videoId?: string } }>;
};

function channelUrl(handle: string): string {
  return `https://www.youtube.com/@${handle}/streams`;
}

/** A channel's uploads playlist is its id with the `UC` prefix swapped for `UU`. */
function uploadsPlaylist(channelId: string): string {
  return `UU${channelId.slice(2)}`;
}

async function recentUploads(channelId: string, key: string, max: number): Promise<string[]> {
  const body = await fetchJson<PlaylistItemsResponse>(
    `${API}/playlistItems?part=contentDetails&playlistId=${uploadsPlaylist(channelId)}&maxResults=${max}&key=${key}`,
  );
  return (body.items ?? []).flatMap((i) => (i.contentDetails?.videoId ? [i.contentDetails.videoId] : []));
}

/** One `videos.list` call covers up to 50 ids for 1 unit. */
async function videoDetails(ids: string[], key: string): Promise<NonNullable<VideosResponse['items']>> {
  const unique = [...new Set(ids)].slice(0, 50);
  if (unique.length === 0) return [];
  const body = await fetchJson<VideosResponse>(
    `${API}/videos?part=snippet,contentDetails&id=${unique.join(',')}&key=${key}`,
  );
  return body.items ?? [];
}

/** ISO-8601 duration (`PT1H2M3S`) to seconds; 0 for live/unknown (`P0D`). */
function durationSec(iso: string | undefined): number {
  const m = iso?.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  const [, d, h, min, s] = m.map((v) => Number(v ?? 0));
  return (d ?? 0) * 86_400 + (h ?? 0) * 3600 + (min ?? 0) * 60 + (s ?? 0);
}

export async function fetchChannels(): Promise<MediaChannel[]> {
  const apiKey = process.env.YOUTUBE_API_KEY || undefined;

  const offline: MediaChannel[] = CHANNELS.map((c) => ({
    id: c.id,
    label: c.label,
    videoId: '',
    live: false,
    url: channelUrl(c.handle),
    channelId: c.channelId,
  }));

  const cache = getCache();
  const state: LiveState = (await cache.get<LiveState>(LIVE_STATE_KEY)) ?? {};

  let liveByChannel: Map<string, string>;
  try {
    liveByChannel = await callProvider({ id: 'youtube', configured: Boolean(apiKey) }, async () => {
      const key = apiKey as string;
      const uploads = await Promise.all(CHANNELS.map((c) => recentUploads(c.channelId, key, 5)));
      const known = CHANNELS.flatMap((c) => (state[c.id]?.videoId ? [state[c.id]!.videoId] : []));
      const details = await videoDetails([...known, ...uploads.flat()], key);
      const found = new Map<string, string>();
      for (const v of details) {
        const channelId = v.snippet?.channelId;
        if (v.snippet?.liveBroadcastContent === 'live' && channelId && !found.has(channelId)) {
          found.set(channelId, v.id);
        }
      }
      return found;
    });
  } catch {
    // The channel list still comes back; only the active stream ids are missing.
    return offline;
  }

  // Search fallback for channels still without a confirmed stream —
  // rationed, sequential, and never retried (each attempt is 100 units).
  const now = Date.now();
  for (const c of CHANNELS) {
    if (liveByChannel.has(c.channelId)) continue;
    if ((state[c.id]?.nextSearchAt ?? 0) > now) continue;
    try {
      const body = await fetchJson<SearchResponse>(
        `${API}/search?part=id&channelId=${c.channelId}&eventType=live&type=video&maxResults=1&key=${apiKey}`,
      );
      const videoId = body.items?.[0]?.id?.videoId;
      if (videoId) liveByChannel.set(c.channelId, videoId);
      state[c.id] = { videoId: videoId ?? '', nextSearchAt: now + SEARCH_EVERY_MS };
    } catch (err) {
      const message = (err as Error).message;
      const limited = /HTTP (403|429)/.test(message);
      state[c.id] = {
        videoId: '',
        nextSearchAt: now + (limited ? SEARCH_BACKOFF_MS : SEARCH_EVERY_MS),
      };
      log.debug('media', `live search for ${c.id} failed (${message})`);
    }
  }

  const channels = CHANNELS.map((c) => {
    const videoId = liveByChannel.get(c.channelId) ?? '';
    state[c.id] = { videoId, nextSearchAt: state[c.id]?.nextSearchAt ?? 0 };
    return {
      id: c.id,
      label: c.label,
      videoId,
      live: Boolean(videoId),
      url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : channelUrl(c.handle),
      channelId: c.channelId,
    };
  });
  await cache.set(LIVE_STATE_KEY, state, LIVE_STATE_TTL_SEC);
  return channels;
}

export async function fetchClips(): Promise<MediaClip[]> {
  const apiKey = process.env.YOUTUBE_API_KEY || undefined;
  return callProvider({ id: 'youtube', configured: Boolean(apiKey) }, async () => {
    const key = apiKey as string;
    const uploads = await Promise.all(CHANNELS.map((c) => recentUploads(c.channelId, key, 3)));
    const details = await videoDetails(uploads.flat(), key);
    const labelOf = new Map(CHANNELS.map((c) => [c.channelId, c.label]));

    const clips: MediaClip[] = details
      // Live and scheduled streams belong to the broadcast panel, not here.
      .filter((v) => (v.snippet?.liveBroadcastContent ?? 'none') === 'none')
      .map((v) => ({
        id: `yt_${v.id}`,
        title: v.snippet?.title ?? 'Untitled',
        channel: labelOf.get(v.snippet?.channelId ?? '') ?? v.snippet?.channelTitle ?? 'YouTube',
        videoId: v.id,
        durationSec: durationSec(v.contentDetails?.duration),
        publishedAt: v.snippet?.publishedAt ?? new Date().toISOString(),
        url: `https://www.youtube.com/watch?v=${v.id}`,
      }))
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));

    if (clips.length === 0) throw new Error('no clips read');
    // Newest clip from each channel first, then fill by date — otherwise the
    // most prolific uploader (Bloomberg) takes every slot.
    const seen = new Set<string>();
    const lead = clips.filter((c) => !seen.has(c.channel) && seen.add(c.channel));
    const rest = clips.filter((c) => !lead.includes(c));
    return [...lead, ...rest]
      .slice(0, 4)
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  });
}

export const CHANNEL_LIST = CHANNELS;
