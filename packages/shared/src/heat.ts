import type { HeatComponents, HeatComponentsDetail, HeatInactiveReason } from './types';

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Reads `heat_scores.components` whatever shape it was written in. Rows from
 * before the detail format stored three bare numbers; those still render
 * (score only, no notes or drivers) until the worker's next 5-minute run
 * rewrites them.
 */
export function normalizeHeatComponents(raw: unknown): HeatComponentsDetail {
  const r = (raw ?? {}) as Record<string, unknown>;
  const onchainRaw = r.onchain;
  const newsRaw = r.news;
  const socialRaw = r.social;

  const onchain: HeatComponentsDetail['onchain'] =
    onchainRaw && typeof onchainRaw === 'object'
      ? {
          score: num((onchainRaw as Record<string, unknown>).score),
          volumeRatio: num((onchainRaw as Record<string, unknown>).volumeRatio),
          holderGrowth: num((onchainRaw as Record<string, unknown>).holderGrowth),
          liquidityHealth: num((onchainRaw as Record<string, unknown>).liquidityHealth),
          note: String((onchainRaw as Record<string, unknown>).note ?? ''),
          reason: (onchainRaw as Record<string, unknown>).reason as HeatInactiveReason | undefined,
          source: (onchainRaw as Record<string, unknown>).source as string | undefined,
        }
      : {
          score: num(onchainRaw),
          volumeRatio: null,
          holderGrowth: null,
          liquidityHealth: null,
          note: '',
        };

  const news: HeatComponentsDetail['news'] =
    newsRaw && typeof newsRaw === 'object'
      ? {
          score: num((newsRaw as Record<string, unknown>).score) ?? 0,
          count24h: num((newsRaw as Record<string, unknown>).count24h) ?? 0,
          avgSentiment: num((newsRaw as Record<string, unknown>).avgSentiment) ?? 0,
          drivers: Array.isArray((newsRaw as Record<string, unknown>).drivers)
            ? ((newsRaw as Record<string, unknown>).drivers as unknown[]).map(String)
            : [],
          note: String((newsRaw as Record<string, unknown>).note ?? ''),
        }
      : { score: num(newsRaw) ?? 0, count24h: 0, avgSentiment: 0, drivers: [], note: '' };

  let social: HeatComponentsDetail['social'];
  if (socialRaw && typeof socialRaw === 'object') {
    const s = socialRaw as Record<string, unknown>;
    const score = num(s.score);
    social =
      score == null
        ? { score: null, reason: (s.reason as HeatInactiveReason) ?? 'belum_aktif' }
        : { score, mentionGrowth: num(s.mentionGrowth) ?? 0, note: String(s.note ?? '') };
  } else {
    const score = num(socialRaw);
    social = score == null ? { score: null, reason: 'belum_aktif' } : { score, mentionGrowth: 0, note: '' };
  }

  const w = (r.weights ?? {}) as Record<string, unknown>;
  return {
    onchain,
    news,
    social,
    weights: {
      onchain: num(w.onchain) ?? 0.5625,
      news: num(w.news) ?? 0.4375,
      social: num(w.social) ?? 0,
    },
    events: Array.isArray(r.events)
      ? (r.events as Array<Record<string, unknown>>).map((e) => ({
          id: String(e.id ?? ''),
          title: String(e.title ?? ''),
          at: String(e.at ?? ''),
          url: typeof e.url === 'string' ? e.url : null,
        }))
      : [],
  };
}

export function summarizeComponents(detail: HeatComponentsDetail): HeatComponents {
  return {
    onchain: detail.onchain.score,
    news: detail.news.score,
    social: detail.social.score,
  };
}
