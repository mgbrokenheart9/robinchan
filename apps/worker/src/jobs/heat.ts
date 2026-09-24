import type {
  HeatComponentsDetail,
  HeatNewsComponent,
  HeatOnchainComponent,
  HeatOnchainEvent,
  HeatSocialComponent,
  NewsItem,
} from '@robinchan/shared';
import { HEAT_SYMBOLS, explorerAddressUrl } from '@robinchan/shared';
import { chainConfig, isDev, socialHeatEnabled, tokenRegistry } from '@robinchan/core';
import { cacheKey, getCache, getDb, type HeatRow } from '@robinchan/store';

import { fetchTokenStats } from '../providers/dexscreener.js';
import { fixtureOnchain } from '../providers/fixtures.js';
import { log } from '../lib/log.js';

export const HEAT_TTL_SEC = 600;

/**
 * heat = 100 × ( w_o·s_o + w_n·s_n + w_s·s_s )   — brief §13
 *
 * Each component is normalized to 0..1 first, then multiplied by its weight.
 * Weights come from the environment so they can be tuned without a redeploy.
 *
 * What's stored per symbol isn't just the score but what drove it (Heat
 * §6): each component's inputs, a one-line note, the news ids that pushed
 * it, and notable on-chain events. That's what an opened row shows.
 */
function configuredWeights(): { onchain: number; news: number; social: number } {
  return {
    onchain: Number(process.env.HEAT_WEIGHT_ONCHAIN ?? 0.45),
    news: Number(process.env.HEAT_WEIGHT_NEWS ?? 0.35),
    social: Number(process.env.HEAT_WEIGHT_SOCIAL ?? 0.2),
  };
}

/**
 * An inactive component's weight goes to the active ones in proportion —
 * leaving it at zero would push every score down and make the board look
 * dead (brief §13). With social off that's 0.5625 / 0.4375.
 */
function activeWeights(active: { onchain: boolean; news: boolean; social: boolean }) {
  const w = configuredWeights();
  const total = (active.onchain ? w.onchain : 0) + (active.news ? w.news : 0) + (active.social ? w.social : 0);
  if (total <= 0) return { onchain: 0, news: 1, social: 0 };
  return {
    onchain: active.onchain ? w.onchain / total : 0,
    news: active.news ? w.news / total : 0,
    social: active.social ? w.social / total : 0,
  };
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/* ------------------------------------------------------------------ */
/* On-chain                                                            */
/* ------------------------------------------------------------------ */

type OnchainRaw = {
  volumeRatio: number | null;
  holderGrowth: number | null;
  liquidityHealth: number | null;
  source: string;
};

/**
 * Real pool stats where a token address is configured; the dev fixture in
 * `RC_ENV=dev`; otherwise nothing — and nothing means an inactive
 * component, never a fabricated number outside dev.
 */
async function onchainRaw(symbol: string): Promise<OnchainRaw | null> {
  const token = tokenRegistry().get(symbol);
  if (token) {
    try {
      const stats = await fetchTokenStats(token.address);
      return {
        volumeRatio: await volumeRatio(symbol, stats.volume24h),
        holderGrowth: null,
        liquidityHealth: stats.volume24h > 0 ? clamp01(stats.liquidityUsd / (stats.volume24h * 2)) : null,
        source: 'dexscreener',
      };
    } catch (err) {
      log.debug('heat', `${symbol} on-chain stats unavailable: ${(err as Error).message}`);
    }
  }
  if (isDev()) return { ...fixtureOnchain(symbol), source: 'fixture' };
  return null;
}

/**
 * 24h volume over the average of the previous days, from a rolling history
 * this job keeps itself (DexScreener only reports the current 24h). Null
 * until three days of history exist — a ratio against one day means nothing.
 */
async function volumeRatio(symbol: string, volume24h: number): Promise<number | null> {
  const key = cacheKey('onchain', `volhist:${symbol}`);
  const today = new Date().toISOString().slice(0, 10);
  const hist = (await getCache().get<Array<{ date: string; volume: number }>>(key)) ?? [];
  const next = [...hist.filter((h) => h.date !== today), { date: today, volume: volume24h }].slice(-21);
  await getCache().set(key, next, 30 * 86_400);
  const previous = next.filter((h) => h.date !== today).slice(-20);
  if (previous.length < 3) return null;
  const avg = previous.reduce((s, h) => s + h.volume, 0) / previous.length;
  return avg > 0 ? volume24h / avg : null;
}

function onchainComponent(raw: OnchainRaw | null): HeatOnchainComponent {
  if (!raw) {
    return { score: null, volumeRatio: null, holderGrowth: null, liquidityHealth: null, note: '', reason: 'tidak_ada_data' };
  }
  // Volume ratio, holder growth, liquidity health → one 0..1 number, over
  // whichever of the three are actually known.
  const parts: Array<[number, number]> = [];
  if (raw.volumeRatio != null) parts.push([clamp01(raw.volumeRatio / 2), 0.5]);
  if (raw.holderGrowth != null) parts.push([clamp01(raw.holderGrowth / 0.08), 0.25]);
  if (raw.liquidityHealth != null) parts.push([clamp01(raw.liquidityHealth), 0.25]);
  if (parts.length === 0) {
    return { score: null, volumeRatio: null, holderGrowth: null, liquidityHealth: null, note: '', reason: 'tidak_ada_data', source: raw.source };
  }
  const weight = parts.reduce((s, [, w]) => s + w, 0);
  const score = parts.reduce((s, [v, w]) => s + v * w, 0) / weight;

  // Round once, then write the note and the events from the same numbers.
  const volume = raw.volumeRatio == null ? null : Number(raw.volumeRatio.toFixed(1));
  const holders = raw.holderGrowth == null ? null : Number(raw.holderGrowth.toFixed(3));
  const liquidity = raw.liquidityHealth == null ? null : Number(raw.liquidityHealth.toFixed(2));
  const notes: string[] = [];
  if (volume != null) notes.push(`Volume ${volume.toFixed(1)}× the 20-day average`);
  if (holders != null) notes.push(`holders ${holders >= 0 ? '+' : ''}${(holders * 100).toFixed(1)}% on the day`);
  if (liquidity != null && volume == null) notes.push(`pool depth ${Math.round(liquidity * 100)}% of healthy`);
  return {
    score: Number(score.toFixed(4)),
    volumeRatio: volume,
    holderGrowth: holders,
    liquidityHealth: liquidity,
    note: notes.join(', '),
    source: raw.source,
  };
}

function onchainEvents(symbol: string, c: HeatOnchainComponent, at: string): HeatOnchainEvent[] {
  const events: HeatOnchainEvent[] = [];
  const hour = at.slice(0, 13);
  const token = tokenRegistry().get(symbol);
  const url = token ? explorerAddressUrl(chainConfig(), token.address) : null;
  if (c.volumeRatio != null && c.volumeRatio >= 1.8) {
    events.push({ id: `ev_${symbol}_vol_${hour}`, title: `${symbol} volume at ${c.volumeRatio.toFixed(1)}× its 20-day average`, at, url });
  }
  if (c.holderGrowth != null && c.holderGrowth >= 0.05) {
    events.push({ id: `ev_${symbol}_holders_${hour}`, title: `${symbol} holder count up ${(c.holderGrowth * 100).toFixed(1)}% in a day`, at, url });
  }
  return events;
}

/* ------------------------------------------------------------------ */
/* News & social                                                       */
/* ------------------------------------------------------------------ */

/** Count of news in the last 24 hours multiplied by average sentiment → 0..1. */
function newsComponent(matched: NewsItem[]): HeatNewsComponent {
  const count = matched.length;
  const avg = count > 0 ? matched.reduce((s, n) => s + n.sentiment, 0) / count : 0;
  const volume = clamp01(count / 8);
  // Sentiment −1..1 maps to intensity; negative news is still "hot".
  const intensity = clamp01(Math.abs(avg) * 0.6 + 0.4);
  // Drivers: the stories that pushed hardest — strong sentiment, recent.
  const now = Date.now();
  const drivers = [...matched]
    .sort((a, b) => weight(b, now) - weight(a, now))
    .slice(0, 3)
    .map((n) => n.id);
  const sign = avg > 0 ? '+' : avg < 0 ? '−' : '';
  return {
    score: Number(clamp01(volume * intensity).toFixed(4)),
    count24h: count,
    avgSentiment: Number(avg.toFixed(2)),
    drivers,
    note:
      count === 0
        ? 'No stories in the last 24 hours'
        : `${count} ${count === 1 ? 'story' : 'stories'} in 24h, average sentiment ${sign}${Math.abs(avg).toFixed(2)}`,
  };
}

function weight(n: NewsItem, now: number): number {
  const ageH = Math.max(0, (now - Date.parse(n.publishedAt)) / 3_600_000);
  return (0.3 + Math.abs(n.sentiment)) * Math.exp(-ageH / 12);
}

/**
 * Social listening is phase 3. Until an adapter exists, the component is
 * null with its reason — not zero, which would read as "nobody's talking"
 * (Heat §6) — whether or not the flag is on.
 */
function socialComponent(): HeatSocialComponent {
  return { score: null, reason: socialHeatEnabled() ? 'tidak_ada_data' : 'belum_aktif' };
}

/* ------------------------------------------------------------------ */

export async function runHeat(): Promise<void> {
  const db = getDb();
  const recent = await db.listNews({ limit: 300 });
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const computedAt = new Date().toISOString();

  const rows: HeatRow[] = [];
  for (const symbol of HEAT_SYMBOLS) {
    const matched = recent.filter((n) => n.symbols.includes(symbol) && Date.parse(n.publishedAt) > cutoff);
    const news = newsComponent(matched);
    const onchain = onchainComponent(await onchainRaw(symbol));
    const social = socialComponent();
    const weights = activeWeights({ onchain: onchain.score != null, news: true, social: social.score != null });

    const score =
      100 *
      (weights.onchain * (onchain.score ?? 0) + weights.news * news.score + weights.social * (social.score ?? 0));

    const components: HeatComponentsDetail = {
      onchain,
      news,
      social,
      weights: {
        onchain: Number(weights.onchain.toFixed(4)),
        news: Number(weights.news.toFixed(4)),
        social: Number(weights.social.toFixed(4)),
      },
      events: onchainEvents(symbol, onchain, computedAt),
    };
    rows.push({ symbol, score: Number(score.toFixed(1)), components, computedAt });
  }
  rows.sort((a, b) => b.score - a.score);

  await db.upsertHeat(rows);
  await getCache().set(cacheKey('heat', 'top'), rows, HEAT_TTL_SEC);
  const inactive = rows.filter((r) => r.components.onchain.score == null).length;
  log.info(
    'heat',
    `${rows.length} symbols computed (social ${socialHeatEnabled() ? 'flag on, no feed yet' : 'off'}${inactive ? `, on-chain missing for ${inactive}` : ''})`,
  );
}
