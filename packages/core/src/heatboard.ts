import type {
  HeatAccess,
  HeatBoard,
  HeatBoardRow,
  HeatComponentLine,
  HeatDetail,
  HeatFilter,
  HeatLockedRow,
  HeatSort,
  HeatTrigger,
  SymbolKind,
  TierId,
} from '@robinchan/shared';
import {
  HEAT_PAGE_SIZE,
  HEAT_VISIBLE,
  SYMBOL_NAMES,
  normalizeHeatComponents,
  roundToTen,
  summarizeComponents,
  symbolInfo,
  tierAtLeast,
} from '@robinchan/shared';
import { cacheKey, getCache, getDb, type HeatRow } from '@robinchan/store';

import { recentCloses, volume24hUsd } from './candles';
import { heatReadsEnabled } from './env';
import { getPrices } from './prices';

/**
 * The full heat board and one row's detail, filtered by what the viewer may
 * see *before* anything leaves the server (Trade-Heat-Portfolio §9): a
 * locked row is a placeholder with a tier label, not real data hidden with
 * CSS.
 *
 * | viewer          | rows     | score        | open a row | triggers + read + watchlist |
 * | no wallet       | top 5    | rounded ×10  | no         | no                          |
 * | wallet (free)   | top 15   | full         | components | no                          |
 * | Tier 1 and up   | all      | full         | everything | yes                         |
 */
export type HeatViewer = { access: HeatAccess; userId: string | null };

export class HeatAccessError extends Error {
  constructor(
    message: string,
    readonly requiredTier: 'wallet' | 'tier1',
    readonly status = 403,
  ) {
    super(message);
    this.name = 'HeatAccessError';
  }
}

export function heatAccessFor(session: { tier: TierId } | null): HeatAccess {
  if (!session) return 'anon';
  return tierAtLeast(session.tier, 'tier1') ? 'tier1' : 'wallet';
}

function visibleLimit(access: HeatAccess): number | null {
  if (access === 'anon') return HEAT_VISIBLE.anon;
  if (access === 'wallet') return HEAT_VISIBLE.wallet;
  return null;
}

type UniverseRow = {
  row: HeatRow;
  rank: number;
  kind: SymbolKind;
  price: number | null;
  changePct: number | null;
  volume24h: number | null;
  spark: number[];
};

/** Every scored symbol, ranked by heat, with its market numbers attached. */
async function loadUniverse(): Promise<{ rows: UniverseRow[]; computedAt: string | null }> {
  const cached = await getCache().get<HeatRow[]>(cacheKey('heat', 'top')).catch(() => null);
  const rows = cached?.length ? cached : await getDb().listHeat(200);
  const ranked = [...rows].sort((a, b) => b.score - a.score);
  const prices = await getPrices(ranked.map((r) => r.symbol));

  const out = await Promise.all(
    ranked.map(async (row, i): Promise<UniverseRow> => {
      const live = prices.get(row.symbol);
      const [spark, volume24h] = await Promise.all([
        // Seven days of 4-hour closes.
        recentCloses(row.symbol, '4H', 42).catch(() => []),
        volume24hUsd(row.symbol).catch(() => null),
      ]);
      return {
        // Rows written before the detail format still carry bare numbers.
        row: { ...row, components: normalizeHeatComponents(row.components) },
        rank: i + 1,
        kind: symbolInfo(row.symbol)?.kind ?? 'stock',
        price: live?.price ?? null,
        changePct: live?.changePct ?? null,
        volume24h,
        spark,
      };
    }),
  );
  return { rows: out, computedAt: ranked[0]?.computedAt ?? null };
}

export async function buildHeatBoard(
  viewer: HeatViewer,
  opts: { filter: HeatFilter; sort: HeatSort; page: number },
): Promise<HeatBoard> {
  const { access } = viewer;
  if (opts.filter === 'watchlist' && access !== 'tier1') {
    throw new HeatAccessError('The watchlist filter opens at Tier 1.', 'tier1');
  }

  const { rows, computedAt } = await loadUniverse();
  const limit = visibleLimit(access);
  const watchlist = viewer.userId && access === 'tier1' ? new Set(await getDb().getWatchlist(viewer.userId)) : new Set<string>();

  const inFilter = (u: UniverseRow) =>
    opts.filter === 'all' ||
    (opts.filter === 'stocks' && u.kind === 'stock') ||
    (opts.filter === 'chain' && u.kind === 'token') ||
    (opts.filter === 'watchlist' && watchlist.has(u.row.symbol));

  // The visible set is always "the N hottest", whatever the sort — filters
  // and sorting then apply inside it, and everything else is locked.
  const visible = rows.filter((u) => (limit == null || u.rank <= limit) && inFilter(u));
  const lockedCount = rows.filter((u) => limit != null && u.rank > limit && inFilter(u)).length;

  const sorted = [...visible].sort((a, b) => {
    if (opts.sort === 'change') return Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0);
    if (opts.sort === 'volume') return (b.volume24h ?? -1) - (a.volume24h ?? -1);
    return a.rank - b.rank;
  });

  const shown: HeatBoardRow[] = sorted.map((u) => ({
    locked: false,
    rank: u.rank,
    symbol: u.row.symbol,
    name: SYMBOL_NAMES[u.row.symbol] ?? u.row.symbol,
    kind: u.kind,
    score: access === 'anon' ? roundToTen(u.row.score) : Number(u.row.score.toFixed(1)),
    rounded: access === 'anon',
    components: access === 'anon' ? null : summarizeComponents(u.row.components),
    price: u.price,
    changePct: u.changePct,
    volume24h: u.volume24h,
    spark: u.spark,
    expandable: access !== 'anon',
    watchlisted: watchlist.has(u.row.symbol),
  }));
  const locked: HeatLockedRow[] = Array.from({ length: lockedCount }, () => ({
    locked: true,
    requiredTier: access === 'anon' ? 'wallet' : 'tier1',
  }));

  const all = [...shown, ...locked];
  const pages = Math.max(1, Math.ceil(all.length / HEAT_PAGE_SIZE));
  const page = Math.min(Math.max(1, opts.page), pages);
  return {
    rows: all.slice((page - 1) * HEAT_PAGE_SIZE, page * HEAT_PAGE_SIZE),
    page,
    pageSize: HEAT_PAGE_SIZE,
    total: all.length,
    pages,
    filter: opts.filter,
    sort: opts.sort,
    access: {
      level: access,
      visibleLimit: limit,
      canExpand: access !== 'anon',
      canSeeTriggers: access === 'tier1',
      canWatchlist: access === 'tier1',
      next: access === 'anon' ? 'wallet' : access === 'wallet' ? 'tier1' : null,
    },
    computedAt,
  };
}

const LABELS: Record<HeatComponentLine['key'], string> = {
  onchain: 'On-chain',
  news: 'News',
  social: 'Social',
};

export type HeatDetailResult = {
  detail: HeatDetail;
  /** Tier 1 opened a row with no cached read — generate one in the background. */
  readMissing: boolean;
};

export async function buildHeatDetail(viewer: HeatViewer, symbol: string): Promise<HeatDetailResult> {
  const { access } = viewer;
  if (access === 'anon') throw new HeatAccessError('Connect a wallet to open a row.', 'wallet');

  const { rows } = await loadUniverse();
  const u = rows.find((r) => r.row.symbol === symbol.toUpperCase());
  if (!u) throw new HeatAccessError('That symbol is not on the heat board.', 'wallet', 404);
  const limit = visibleLimit(access);
  if (limit != null && u.rank > limit) {
    throw new HeatAccessError('This row opens at Tier 1.', 'tier1');
  }

  const c = u.row.components;
  const components: HeatComponentLine[] = [
    {
      key: 'onchain',
      label: LABELS.onchain,
      score: c.onchain.score,
      weight: c.weights.onchain,
      note: c.onchain.score == null ? 'No on-chain data for this symbol yet.' : c.onchain.note,
      inactive: c.onchain.score == null ? (c.onchain.reason ?? 'tidak_ada_data') : null,
    },
    {
      key: 'news',
      label: LABELS.news,
      score: c.news.score,
      weight: c.weights.news,
      note: c.news.note,
      inactive: null,
    },
    {
      key: 'social',
      label: LABELS.social,
      score: c.social.score,
      weight: c.weights.social,
      note: c.social.score == null ? "Social listening isn't active yet." : c.social.note,
      inactive: c.social.score == null ? c.social.reason : null,
    },
  ];

  let triggers: HeatTrigger[] | null = null;
  let read: HeatDetail['read'] = null;
  let readMissing = false;
  if (access === 'tier1') {
    const news = await getDb().getNewsByIds(c.news.drivers.slice(0, 3));
    const byId = new Map(news.map((n) => [n.id, n]));
    const newsTriggers: HeatTrigger[] = c.news.drivers
      .map((id) => byId.get(id))
      .filter((n) => n != null)
      .map((n) => ({
        id: n.id,
        kind: 'news',
        title: n.title,
        at: n.publishedAt,
        url: n.url,
        source: n.source,
        sentiment: n.sentiment,
      }));
    const eventTriggers: HeatTrigger[] = c.events.map((e) => ({
      id: e.id,
      kind: 'onchain',
      title: e.title,
      at: e.at,
      url: e.url,
      source: 'on-chain',
      sentiment: null,
    }));
    // Two to three of what pushed the score most: the top news drivers,
    // with an on-chain event taking the last slot when there is one.
    triggers = [...newsTriggers.slice(0, eventTriggers.length ? 2 : 3), ...eventTriggers.slice(0, 1)];

    if (heatReadsEnabled()) {
      const stored = await getDb().getHeatRead(u.row.symbol);
      if (stored) read = { text: stored.text, computedAt: stored.computedAt, source: stored.source };
      else readMissing = true;
    }
  }

  return {
    detail: {
      symbol: u.row.symbol,
      name: SYMBOL_NAMES[u.row.symbol] ?? u.row.symbol,
      rank: u.rank,
      score: Number(u.row.score.toFixed(1)),
      computedAt: u.row.computedAt,
      components,
      triggers,
      read,
      readLocked: access !== 'tier1' || !heatReadsEnabled(),
      access,
    },
    readMissing,
  };
}

/** The same universe, for the worker's read job and on-demand reads. */
export async function heatUniverseForReads(): Promise<
  Array<{ row: HeatRow; rank: number; changePct: number | null }>
> {
  const { rows } = await loadUniverse();
  return rows.map((u) => ({ row: u.row, rank: u.rank, changePct: u.changePct }));
}
