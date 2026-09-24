import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type {
  CalendarEvent,
  HeatComponentsDetail,
  NewsItem,
  OrderQuote,
  OrderSide,
  OrderSource,
  OrderStatus,
  OrderType,
} from '@robinchan/shared';
import { normalizeHeatComponents } from '@robinchan/shared';
import type { Pool, PoolClient } from 'pg';

import { JsonFile } from './jsonfile';
import { dataDir } from './paths';
import { closePgPool, databaseUrl, ensureSchema, getPgPool } from './pg';

export type HeatRow = {
  symbol: string;
  score: number;
  components: HeatComponentsDetail;
  computedAt: string;
};

export type NewsQuery = {
  limit: number;
  cat?: string;
  symbol?: string;
  pinnedOnly?: boolean;
};

export type UserRow = {
  id: string;
  /** Always lowercase (brief §10). */
  address: string;
  createdAt: string;
  lastSeenAt: string;
};

export type ChatRow = {
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
};

export type OrderRow = {
  id: string;
  userId: string;
  address: string;
  side: OrderSide;
  symbol: string;
  qty: number;
  orderType: OrderType;
  limitPrice: number | null;
  status: OrderStatus;
  source: OrderSource;
  venue: string;
  quotePrice: number | null;
  fillPrice: number | null;
  estTotal: number | null;
  fee: number | null;
  slippageBps: number | null;
  /** The quote exactly as issued, execution payload included. */
  quote: OrderQuote | null;
  txHash: string | null;
  txHashes: string[];
  signature: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  submittedAt: string | null;
  filledAt: string | null;
  notifiedAt: string | null;
  checkedAt: string | null;
  nonce: number | null;
};

export type OrderInsert = Omit<OrderRow, 'createdAt' | 'updatedAt'>;

export type OrderPatch = Partial<
  Pick<
    OrderRow,
    | 'status'
    | 'fillPrice'
    | 'txHash'
    | 'txHashes'
    | 'signature'
    | 'error'
    | 'expiresAt'
    | 'submittedAt'
    | 'filledAt'
    | 'notifiedAt'
    | 'checkedAt'
    | 'nonce'
  >
>;

export type OrderQuery = {
  userId?: string;
  statuses?: OrderStatus[];
  symbol?: string;
  /** Only terminal orders the user hasn't been told about yet. */
  unnotified?: boolean;
  limit: number;
};

export type HeatReadRow = {
  symbol: string;
  text: string;
  source: 'llm' | 'template';
  /** Fingerprint of what the read was written from; unchanged inputs skip regeneration. */
  inputsHash: string;
  computedAt: string;
};

export type SnapshotRow = {
  userId: string;
  /** YYYY-MM-DD, UTC. */
  date: string;
  totalValueUsd: number;
  holdings: Array<{ symbol: string; qty: number; price: number | null; value: number | null }>;
};

export type CostBasisRow = {
  symbol: string;
  avgPrice: number;
  updatedAt: string;
};

export interface Db {
  migrate(): Promise<void>;
  /** Returns the count of rows that were genuinely new after dedupe. */
  upsertNews(items: NewsItem[]): Promise<number>;
  listNews(query: NewsQuery): Promise<NewsItem[]>;
  getNewsByIds(ids: string[]): Promise<NewsItem[]>;
  upsertHeat(rows: HeatRow[]): Promise<void>;
  listHeat(limit: number): Promise<HeatRow[]>;
  upsertCalendar(events: CalendarEvent[]): Promise<void>;
  listCalendar(limit: number): Promise<CalendarEvent[]>;

  upsertUser(address: string): Promise<UserRow>;
  getUser(id: string): Promise<UserRow | null>;
  touchUser(id: string): Promise<void>;
  /** Users seen since `since` — the ones the daily portfolio snapshot covers. */
  listActiveUsers(since: Date): Promise<UserRow[]>;

  getWatchlist(userId: string): Promise<string[]>;
  setWatchlist(userId: string, symbols: string[]): Promise<string[]>;

  appendChat(userId: string, messages: Array<Pick<ChatRow, 'role' | 'content'>>): Promise<void>;
  listChat(userId: string, limit: number): Promise<ChatRow[]>;

  insertOrder(order: OrderInsert): Promise<OrderRow>;
  getOrder(id: string): Promise<OrderRow | null>;
  /**
   * Conditional update: applies only while the order is still in one of
   * `onlyIf` statuses, and returns null otherwise. This is what keeps the
   * web app and the worker from both acting on the same transition (e.g. a
   * cancel racing a fill).
   */
  updateOrder(id: string, patch: OrderPatch, onlyIf?: OrderStatus[]): Promise<OrderRow | null>;
  listOrders(query: OrderQuery): Promise<OrderRow[]>;

  upsertHeatRead(read: HeatReadRow): Promise<void>;
  getHeatRead(symbol: string): Promise<HeatReadRow | null>;
  listHeatReads(): Promise<HeatReadRow[]>;

  upsertSnapshot(snapshot: SnapshotRow): Promise<void>;
  listSnapshots(userId: string, sinceDate?: string): Promise<SnapshotRow[]>;

  setCostBasis(userId: string, symbol: string, avgPrice: number | null): Promise<void>;
  listCostBasis(userId: string): Promise<CostBasisRow[]>;

  /** chat_messages 30 days, news_items 90 days (brief §10). Orders are kept forever. */
  pruneRetention(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Providers often send the same story under a different id, so besides
 * `external_id` we store a hash of the normalized title and reject
 * duplicates within a 6-hour window (brief §10).
 */
const DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000;

const CHAT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const WATCHLIST_MAX = 50;
const TERMINAL: OrderStatus[] = ['filled', 'failed'];

export function titleHash(title: string): string {
  const normalized = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha1').update(normalized).digest('hex');
}

export function newId(): string {
  return randomUUID();
}

const iso = (v: unknown): string | null =>
  v == null ? null : new Date(v as string | Date).toISOString();
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

/* ------------------------------------------------------------------ */
/* Postgres — Vercel Postgres (Neon)                                   */
/* ------------------------------------------------------------------ */

const ORDER_COLUMNS: Array<[keyof OrderRow, string]> = [
  ['id', 'id'],
  ['userId', 'user_id'],
  ['address', 'address'],
  ['side', 'side'],
  ['symbol', 'symbol'],
  ['qty', 'qty'],
  ['orderType', 'order_type'],
  ['limitPrice', 'limit_price'],
  ['status', 'status'],
  ['source', 'source'],
  ['venue', 'venue'],
  ['quotePrice', 'quote_price'],
  ['fillPrice', 'fill_price'],
  ['estTotal', 'est_total'],
  ['fee', 'fee'],
  ['slippageBps', 'slippage_bps'],
  ['quote', 'quote'],
  ['txHash', 'tx_hash'],
  ['txHashes', 'tx_hashes'],
  ['signature', 'signature'],
  ['error', 'error'],
  ['expiresAt', 'expires_at'],
  ['submittedAt', 'submitted_at'],
  ['filledAt', 'filled_at'],
  ['notifiedAt', 'notified_at'],
  ['checkedAt', 'checked_at'],
  ['nonce', 'nonce'],
];
const ORDER_COLUMN = new Map(ORDER_COLUMNS);

function toDbValue(key: keyof OrderRow, value: unknown): unknown {
  if (key === 'quote') return value == null ? null : JSON.stringify(value);
  return value;
}

function rowToOrder(r: Record<string, unknown>): OrderRow {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    address: String(r.address ?? ''),
    side: r.side as OrderSide,
    symbol: String(r.symbol),
    qty: Number(r.qty),
    orderType: (r.order_type as OrderType) ?? 'market',
    limitPrice: numOrNull(r.limit_price),
    status: r.status as OrderStatus,
    source: (r.source as OrderSource) ?? 'form',
    venue: String(r.venue ?? 'paper'),
    quotePrice: numOrNull(r.quote_price),
    fillPrice: numOrNull(r.fill_price),
    estTotal: numOrNull(r.est_total),
    fee: numOrNull(r.fee),
    slippageBps: numOrNull(r.slippage_bps),
    quote: (r.quote as OrderQuote | null) ?? null,
    txHash: (r.tx_hash as string | null) ?? null,
    txHashes: (r.tx_hashes as string[] | null) ?? [],
    signature: (r.signature as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    createdAt: iso(r.created_at) as string,
    updatedAt: iso(r.updated_at ?? r.created_at) as string,
    expiresAt: iso(r.expires_at),
    submittedAt: iso(r.submitted_at),
    filledAt: iso(r.filled_at),
    notifiedAt: iso(r.notified_at),
    checkedAt: iso(r.checked_at),
    nonce: numOrNull(r.nonce),
  };
}

function rowToUser(r: Record<string, unknown>): UserRow {
  return {
    id: String(r.id),
    address: String(r.wallet_address),
    createdAt: iso(r.created_at) as string,
    lastSeenAt: iso(r.last_seen_at) as string,
  };
}

export class PgDb implements Db {
  constructor(private readonly pool: Pool) {}

  /** Every query waits for the schema, so a fresh database needs no manual step. */
  private async query(sql: string, params?: unknown[]) {
    await ensureSchema(this.pool);
    return this.pool.query(sql, params);
  }

  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    await ensureSchema(this.pool);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  async migrate(): Promise<void> {
    await ensureSchema(this.pool);
  }

  async upsertNews(items: NewsItem[]): Promise<number> {
    if (items.length === 0) return 0;
    return this.tx(async (client) => {
      let inserted = 0;
      for (const item of items) {
        const hash = titleHash(item.title);
        const dupe = await client.query(
          `select 1 from news_items
            where title_hash = $1
              and published_at > $2::timestamptz - interval '6 hours'
              and external_id <> $3
            limit 1`,
          [hash, item.publishedAt, item.id],
        );
        if (dupe.rowCount) continue;
        const res = await client.query(
          `insert into news_items
             (id, external_id, title_hash, cat, title, short, symbols, sentiment, url, source, pinned, published_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           on conflict (external_id) do update
             set sentiment = excluded.sentiment,
                 pinned = excluded.pinned,
                 title = excluded.title,
                 short = excluded.short
           returning (xmax = 0) as is_new`,
          [
            item.id,
            item.id,
            hash,
            item.cat,
            item.title,
            item.short,
            item.symbols,
            item.sentiment,
            item.url,
            item.source,
            item.pinned ?? false,
            item.publishedAt,
          ],
        );
        if (res.rows[0]?.is_new) inserted += 1;
      }
      return inserted;
    });
  }

  async listNews(query: NewsQuery): Promise<NewsItem[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.cat) {
      params.push(query.cat);
      where.push(`cat = $${params.length}`);
    }
    if (query.symbol) {
      params.push([query.symbol]);
      where.push(`symbols && $${params.length}`);
    }
    if (query.pinnedOnly) where.push('pinned = true');
    params.push(query.limit);
    const res = await this.query(
      `select * from news_items
        ${where.length ? `where ${where.join(' and ')}` : ''}
        order by published_at desc
        limit $${params.length}`,
      params,
    );
    return res.rows.map(rowToNews);
  }

  async getNewsByIds(ids: string[]): Promise<NewsItem[]> {
    if (ids.length === 0) return [];
    const res = await this.query('select * from news_items where id = any($1)', [ids]);
    return res.rows.map(rowToNews);
  }

  async upsertHeat(rows: HeatRow[]): Promise<void> {
    for (const row of rows) {
      await this.query(
        `insert into heat_scores (symbol, score, components, computed_at)
         values ($1,$2,$3,$4)
         on conflict (symbol) do update
           set score = excluded.score,
               components = excluded.components,
               computed_at = excluded.computed_at`,
        [row.symbol, row.score, JSON.stringify(row.components), row.computedAt],
      );
    }
  }

  async listHeat(limit: number): Promise<HeatRow[]> {
    const res = await this.query('select * from heat_scores order by score desc limit $1', [limit]);
    return res.rows.map((r: Record<string, unknown>) => ({
      symbol: String(r.symbol),
      score: Number(r.score),
      components: normalizeHeatComponents(r.components),
      computedAt: new Date(r.computed_at as string).toISOString(),
    }));
  }

  async upsertCalendar(events: CalendarEvent[]): Promise<void> {
    for (const e of events) {
      await this.query(
        `insert into calendar_events (id, date, title, subtitle, kind, symbol)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (id) do update
           set date = excluded.date, title = excluded.title,
               subtitle = excluded.subtitle, kind = excluded.kind, symbol = excluded.symbol`,
        [e.id, e.date, e.title, e.subtitle, e.kind, e.symbol],
      );
    }
  }

  async listCalendar(limit: number): Promise<CalendarEvent[]> {
    // `date` comes back as text: node-postgres would otherwise parse it as
    // local midnight, and `toISOString()` then shifts it a day back on any
    // machine east of UTC (e.g. WIB, UTC+7).
    const res = await this.query(
      `select id, to_char(date, 'YYYY-MM-DD') as date, title, subtitle, kind, symbol
         from calendar_events
        where date >= current_date
        order by date asc
        limit $1`,
      [limit],
    );
    return res.rows.map((r: Record<string, unknown>) => ({
      id: String(r.id),
      date: String(r.date),
      title: String(r.title),
      subtitle: String(r.subtitle ?? ''),
      kind: r.kind as CalendarEvent['kind'],
      symbol: (r.symbol as string | null) ?? null,
    }));
  }

  /* ---- users ---- */

  async upsertUser(address: string): Promise<UserRow> {
    const res = await this.query(
      `insert into users (wallet_address) values ($1)
       on conflict (wallet_address) do update set last_seen_at = now()
       returning *`,
      [address.toLowerCase()],
    );
    return rowToUser(res.rows[0]);
  }

  async getUser(id: string): Promise<UserRow | null> {
    const res = await this.query('select * from users where id = $1', [id]);
    return res.rows[0] ? rowToUser(res.rows[0]) : null;
  }

  async touchUser(id: string): Promise<void> {
    await this.query('update users set last_seen_at = now() where id = $1', [id]);
  }

  async listActiveUsers(since: Date): Promise<UserRow[]> {
    const res = await this.query('select * from users where last_seen_at >= $1', [since]);
    return res.rows.map(rowToUser);
  }

  /* ---- watchlist ---- */

  async getWatchlist(userId: string): Promise<string[]> {
    const res = await this.query(
      'select symbol from watchlists where user_id = $1 order by added_at asc',
      [userId],
    );
    return res.rows.map((r: { symbol: string }) => r.symbol);
  }

  async setWatchlist(userId: string, symbols: string[]): Promise<string[]> {
    const wanted = [...new Set(symbols.map((s) => s.toUpperCase()))].slice(0, WATCHLIST_MAX);
    await this.tx(async (client) => {
      await client.query('delete from watchlists where user_id = $1 and not (symbol = any($2))', [
        userId,
        wanted,
      ]);
      for (const symbol of wanted) {
        await client.query(
          'insert into watchlists (user_id, symbol) values ($1, $2) on conflict do nothing',
          [userId, symbol],
        );
      }
    });
    return this.getWatchlist(userId);
  }

  /* ---- chat ---- */

  async appendChat(
    userId: string,
    messages: Array<Pick<ChatRow, 'role' | 'content'>>,
  ): Promise<void> {
    // Consecutive inserts in one statement would share `now()`; stagger by a
    // millisecond so a user turn always sorts before its reply.
    const base = Date.now();
    for (const [i, m] of messages.entries()) {
      await this.query(
        'insert into chat_messages (user_id, role, content, created_at) values ($1, $2, $3, $4)',
        [userId, m.role, m.content, new Date(base + i)],
      );
    }
  }

  async listChat(userId: string, limit: number): Promise<ChatRow[]> {
    const res = await this.query(
      `select role, content, created_at from chat_messages
        where user_id = $1 and role in ('user', 'assistant')
        order by created_at desc limit $2`,
      [userId, limit],
    );
    return res.rows
      .map((r: Record<string, unknown>) => ({
        role: r.role as ChatRow['role'],
        content: String(r.content),
        createdAt: iso(r.created_at) as string,
      }))
      .reverse();
  }

  /* ---- orders ---- */

  async insertOrder(order: OrderInsert): Promise<OrderRow> {
    const cols = ORDER_COLUMNS.filter(([key]) => key in order);
    const res = await this.query(
      `insert into orders (${cols.map(([, col]) => col).join(', ')})
       values (${cols.map((_, i) => `$${i + 1}`).join(', ')})
       returning *`,
      cols.map(([key]) => toDbValue(key, order[key as keyof OrderInsert])),
    );
    return rowToOrder(res.rows[0]);
  }

  async getOrder(id: string): Promise<OrderRow | null> {
    if (!isUuid(id)) return null;
    const res = await this.query('select * from orders where id = $1', [id]);
    return res.rows[0] ? rowToOrder(res.rows[0]) : null;
  }

  async updateOrder(id: string, patch: OrderPatch, onlyIf?: OrderStatus[]): Promise<OrderRow | null> {
    if (!isUuid(id)) return null;
    const sets: string[] = ['updated_at = now()'];
    const params: unknown[] = [id];
    for (const [key, value] of Object.entries(patch) as Array<[keyof OrderRow, unknown]>) {
      const col = ORDER_COLUMN.get(key);
      if (!col || value === undefined) continue;
      params.push(toDbValue(key, value));
      sets.push(`${col} = $${params.length}`);
    }
    let guard = '';
    if (onlyIf?.length) {
      params.push(onlyIf);
      guard = ` and status = any($${params.length})`;
    }
    const res = await this.query(
      `update orders set ${sets.join(', ')} where id = $1${guard} returning *`,
      params,
    );
    return res.rows[0] ? rowToOrder(res.rows[0]) : null;
  }

  async listOrders(query: OrderQuery): Promise<OrderRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.userId) {
      params.push(query.userId);
      where.push(`user_id = $${params.length}`);
    }
    if (query.statuses?.length) {
      params.push(query.statuses);
      where.push(`status = any($${params.length})`);
    }
    if (query.symbol) {
      params.push(query.symbol);
      where.push(`symbol = $${params.length}`);
    }
    if (query.unnotified) {
      params.push(TERMINAL);
      where.push(`notified_at is null and status = any($${params.length})`);
    }
    params.push(query.limit);
    const res = await this.query(
      `select * from orders ${where.length ? `where ${where.join(' and ')}` : ''}
        order by created_at desc limit $${params.length}`,
      params,
    );
    return res.rows.map(rowToOrder);
  }

  /* ---- heat reads ---- */

  async upsertHeatRead(read: HeatReadRow): Promise<void> {
    await this.query(
      `insert into heat_reads (symbol, text, source, inputs_hash, computed_at)
       values ($1, $2, $3, $4, $5)
       on conflict (symbol) do update
         set text = excluded.text, source = excluded.source,
             inputs_hash = excluded.inputs_hash, computed_at = excluded.computed_at`,
      [read.symbol, read.text, read.source, read.inputsHash, read.computedAt],
    );
  }

  async getHeatRead(symbol: string): Promise<HeatReadRow | null> {
    const res = await this.query('select * from heat_reads where symbol = $1', [symbol]);
    return res.rows[0] ? rowToRead(res.rows[0]) : null;
  }

  async listHeatReads(): Promise<HeatReadRow[]> {
    const res = await this.query('select * from heat_reads order by symbol asc');
    return res.rows.map(rowToRead);
  }

  /* ---- snapshots ---- */

  async upsertSnapshot(s: SnapshotRow): Promise<void> {
    await this.query(
      `insert into portfolio_snapshots (user_id, date, total_value_usd, holdings)
       values ($1, $2, $3, $4)
       on conflict (user_id, date) do update
         set total_value_usd = excluded.total_value_usd, holdings = excluded.holdings`,
      [s.userId, s.date, s.totalValueUsd, JSON.stringify(s.holdings)],
    );
  }

  async listSnapshots(userId: string, sinceDate?: string): Promise<SnapshotRow[]> {
    const res = await this.query(
      `select user_id, to_char(date, 'YYYY-MM-DD') as date, total_value_usd, holdings
         from portfolio_snapshots
        where user_id = $1 ${sinceDate ? 'and date >= $2' : ''}
        order by date asc`,
      sinceDate ? [userId, sinceDate] : [userId],
    );
    return res.rows.map((r: Record<string, unknown>) => ({
      userId: String(r.user_id),
      date: String(r.date),
      totalValueUsd: Number(r.total_value_usd),
      holdings: (r.holdings as SnapshotRow['holdings']) ?? [],
    }));
  }

  /* ---- cost basis ---- */

  async setCostBasis(userId: string, symbol: string, avgPrice: number | null): Promise<void> {
    if (avgPrice == null) {
      await this.query('delete from cost_basis_overrides where user_id = $1 and symbol = $2', [
        userId,
        symbol,
      ]);
      return;
    }
    await this.query(
      `insert into cost_basis_overrides (user_id, symbol, avg_price, updated_at)
       values ($1, $2, $3, now())
       on conflict (user_id, symbol) do update
         set avg_price = excluded.avg_price, updated_at = now()`,
      [userId, symbol, avgPrice],
    );
  }

  async listCostBasis(userId: string): Promise<CostBasisRow[]> {
    const res = await this.query(
      'select symbol, avg_price, updated_at from cost_basis_overrides where user_id = $1',
      [userId],
    );
    return res.rows.map((r: Record<string, unknown>) => ({
      symbol: String(r.symbol),
      avgPrice: Number(r.avg_price),
      updatedAt: iso(r.updated_at) as string,
    }));
  }

  async pruneRetention(): Promise<void> {
    await this.query("delete from chat_messages where created_at < now() - interval '30 days'");
    await this.query("delete from news_items where published_at < now() - interval '90 days'");
    // The cache and rate-limit tables share this database now that Redis is
    // gone; clear what Redis used to expire on its own.
    await this.query('delete from kv_cache where expires_at < now()');
    await this.query("delete from rate_limits where reset_at < now() - interval '1 hour'");
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('select 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await closePgPool();
  }
}

function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

function rowToRead(r: Record<string, unknown>): HeatReadRow {
  return {
    symbol: String(r.symbol),
    text: String(r.text),
    source: (r.source as HeatReadRow['source']) ?? 'llm',
    inputsHash: String(r.inputs_hash ?? ''),
    computedAt: iso(r.computed_at) as string,
  };
}

function rowToNews(r: Record<string, unknown>): NewsItem {
  return {
    id: String(r.id),
    cat: r.cat as NewsItem['cat'],
    title: String(r.title),
    short: String(r.short),
    symbols: (r.symbols as string[]) ?? [],
    sentiment: Number(r.sentiment),
    url: String(r.url),
    source: String(r.source),
    pinned: Boolean(r.pinned),
    publishedAt: new Date(r.published_at as string).toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* File fallback — used when DATABASE_URL is empty                     */
/* ------------------------------------------------------------------ */

type StoredNews = NewsItem & { hash: string };

/** Market data — written by the worker, read by the API. */
type MarketShape = {
  news: StoredNews[];
  heat: HeatRow[];
  calendar: CalendarEvent[];
  heatReads: HeatReadRow[];
};

/** Per-user data — written by both processes. */
type UserShape = {
  users: UserRow[];
  watchlists: Array<{ userId: string; symbol: string; addedAt: string }>;
  chat: Array<ChatRow & { userId: string }>;
  orders: OrderRow[];
  snapshots: SnapshotRow[];
  costBasis: Array<CostBasisRow & { userId: string }>;
};

class FileDb implements Db {
  private readonly market: JsonFile<MarketShape>;
  private readonly user: JsonFile<UserShape>;

  constructor(dir: string) {
    this.market = new JsonFile(join(dir, 'db.json'), () => ({
      news: [],
      heat: [],
      calendar: [],
      heatReads: [],
    }));
    this.user = new JsonFile(join(dir, 'user-db.json'), () => ({
      users: [],
      watchlists: [],
      chat: [],
      orders: [],
      snapshots: [],
      costBasis: [],
    }));
  }

  private static strip(row: StoredNews): NewsItem {
    const { hash: _hash, ...rest } = row;
    return rest;
  }

  async migrate(): Promise<void> {
    this.market.mutate(() => undefined);
    this.user.mutate(() => undefined);
  }

  async upsertNews(items: NewsItem[]): Promise<number> {
    return this.market.mutate((data) => {
      let inserted = 0;
      for (const item of items) {
        const hash = titleHash(item.title);
        const published = Date.parse(item.publishedAt);
        const existingIdx = data.news.findIndex((n) => n.id === item.id);
        if (existingIdx >= 0) {
          data.news[existingIdx] = { ...item, hash };
          continue;
        }
        const dupe = data.news.some(
          (n) =>
            n.hash === hash && Math.abs(Date.parse(n.publishedAt) - published) < DEDUPE_WINDOW_MS,
        );
        if (dupe) continue;
        data.news.push({ ...item, hash });
        inserted += 1;
      }
      data.news.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
      data.news = data.news.slice(0, 500);
      return inserted;
    });
  }

  async listNews(query: NewsQuery): Promise<NewsItem[]> {
    return this.market
      .read()
      .news.filter((n) => (query.cat ? n.cat === query.cat : true))
      .filter((n) => (query.symbol ? n.symbols.includes(query.symbol) : true))
      .filter((n) => (query.pinnedOnly ? n.pinned === true : true))
      .slice(0, query.limit)
      .map(FileDb.strip);
  }

  async getNewsByIds(ids: string[]): Promise<NewsItem[]> {
    const wanted = new Set(ids);
    return this.market
      .read()
      .news.filter((n) => wanted.has(n.id))
      .map(FileDb.strip);
  }

  async upsertHeat(rows: HeatRow[]): Promise<void> {
    this.market.mutate((data) => {
      const bySymbol = new Map(data.heat.map((h) => [h.symbol, h]));
      for (const row of rows) bySymbol.set(row.symbol, row);
      data.heat = [...bySymbol.values()].sort((a, b) => b.score - a.score);
    });
  }

  async listHeat(limit: number): Promise<HeatRow[]> {
    return this.market
      .read()
      .heat.slice(0, limit)
      .map((row) => ({ ...row, components: normalizeHeatComponents(row.components) }));
  }

  async upsertCalendar(events: CalendarEvent[]): Promise<void> {
    this.market.mutate((data) => {
      const byId = new Map(data.calendar.map((e) => [e.id, e]));
      for (const e of events) byId.set(e.id, e);
      data.calendar = [...byId.values()].sort((a, b) => a.date.localeCompare(b.date));
    });
  }

  async listCalendar(limit: number): Promise<CalendarEvent[]> {
    const today = new Date().toISOString().slice(0, 10);
    return this.market
      .read()
      .calendar.filter((e) => e.date >= today)
      .slice(0, limit);
  }

  /* ---- users ---- */

  async upsertUser(address: string): Promise<UserRow> {
    const lower = address.toLowerCase();
    return this.user.mutate((data) => {
      const now = new Date().toISOString();
      const existing = data.users.find((u) => u.address === lower);
      if (existing) {
        existing.lastSeenAt = now;
        return { ...existing };
      }
      const row: UserRow = { id: newId(), address: lower, createdAt: now, lastSeenAt: now };
      data.users.push(row);
      return { ...row };
    });
  }

  async getUser(id: string): Promise<UserRow | null> {
    return this.user.read().users.find((u) => u.id === id) ?? null;
  }

  async touchUser(id: string): Promise<void> {
    this.user.mutate((data) => {
      const u = data.users.find((x) => x.id === id);
      if (u) u.lastSeenAt = new Date().toISOString();
    });
  }

  async listActiveUsers(since: Date): Promise<UserRow[]> {
    return this.user.read().users.filter((u) => Date.parse(u.lastSeenAt) >= since.getTime());
  }

  /* ---- watchlist ---- */

  async getWatchlist(userId: string): Promise<string[]> {
    return this.user
      .read()
      .watchlists.filter((w) => w.userId === userId)
      .sort((a, b) => a.addedAt.localeCompare(b.addedAt))
      .map((w) => w.symbol);
  }

  async setWatchlist(userId: string, symbols: string[]): Promise<string[]> {
    const wanted = [...new Set(symbols.map((s) => s.toUpperCase()))].slice(0, WATCHLIST_MAX);
    this.user.mutate((data) => {
      const kept = data.watchlists.filter((w) => w.userId !== userId || wanted.includes(w.symbol));
      const have = new Set(kept.filter((w) => w.userId === userId).map((w) => w.symbol));
      const now = Date.now();
      wanted.forEach((symbol, i) => {
        if (!have.has(symbol)) {
          kept.push({ userId, symbol, addedAt: new Date(now + i).toISOString() });
        }
      });
      data.watchlists = kept;
    });
    return this.getWatchlist(userId);
  }

  /* ---- chat ---- */

  async appendChat(
    userId: string,
    messages: Array<Pick<ChatRow, 'role' | 'content'>>,
  ): Promise<void> {
    this.user.mutate((data) => {
      const base = Date.now();
      messages.forEach((m, i) => {
        data.chat.push({ userId, ...m, createdAt: new Date(base + i).toISOString() });
      });
      const cutoff = Date.now() - CHAT_RETENTION_MS;
      data.chat = data.chat.filter((c) => Date.parse(c.createdAt) >= cutoff);
    });
  }

  async listChat(userId: string, limit: number): Promise<ChatRow[]> {
    return this.user
      .read()
      .chat.filter((c) => c.userId === userId)
      .slice(-limit)
      .map(({ role, content, createdAt }) => ({ role, content, createdAt }));
  }

  /* ---- orders ---- */

  async insertOrder(order: OrderInsert): Promise<OrderRow> {
    return this.user.mutate((data) => {
      const now = new Date().toISOString();
      const row: OrderRow = { ...order, createdAt: now, updatedAt: now };
      data.orders.push(row);
      return structuredClone(row);
    });
  }

  async getOrder(id: string): Promise<OrderRow | null> {
    const row = this.user.read().orders.find((o) => o.id === id);
    return row ? structuredClone(row) : null;
  }

  async updateOrder(id: string, patch: OrderPatch, onlyIf?: OrderStatus[]): Promise<OrderRow | null> {
    return this.user.mutate((data) => {
      const row = data.orders.find((o) => o.id === id);
      if (!row) return null;
      if (onlyIf?.length && !onlyIf.includes(row.status)) return null;
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) (row as Record<string, unknown>)[key] = value;
      }
      row.updatedAt = new Date().toISOString();
      return structuredClone(row);
    });
  }

  async listOrders(query: OrderQuery): Promise<OrderRow[]> {
    return this.user
      .read()
      .orders.filter((o) => (query.userId ? o.userId === query.userId : true))
      .filter((o) => (query.statuses?.length ? query.statuses.includes(o.status) : true))
      .filter((o) => (query.symbol ? o.symbol === query.symbol : true))
      .filter((o) => (query.unnotified ? o.notifiedAt == null && TERMINAL.includes(o.status) : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, query.limit)
      // The file's parsed rows are shared across reads; hand out copies.
      .map((o) => structuredClone(o));
  }

  /* ---- heat reads ---- */

  async upsertHeatRead(read: HeatReadRow): Promise<void> {
    this.market.mutate((data) => {
      data.heatReads = [...data.heatReads.filter((r) => r.symbol !== read.symbol), read];
    });
  }

  async getHeatRead(symbol: string): Promise<HeatReadRow | null> {
    return this.market.read().heatReads.find((r) => r.symbol === symbol) ?? null;
  }

  async listHeatReads(): Promise<HeatReadRow[]> {
    return [...this.market.read().heatReads].sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  /* ---- snapshots ---- */

  async upsertSnapshot(s: SnapshotRow): Promise<void> {
    this.user.mutate((data) => {
      data.snapshots = [
        ...data.snapshots.filter((x) => !(x.userId === s.userId && x.date === s.date)),
        s,
      ];
    });
  }

  async listSnapshots(userId: string, sinceDate?: string): Promise<SnapshotRow[]> {
    return this.user
      .read()
      .snapshots.filter((s) => s.userId === userId && (!sinceDate || s.date >= sinceDate))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /* ---- cost basis ---- */

  async setCostBasis(userId: string, symbol: string, avgPrice: number | null): Promise<void> {
    this.user.mutate((data) => {
      data.costBasis = data.costBasis.filter((c) => !(c.userId === userId && c.symbol === symbol));
      if (avgPrice != null) {
        data.costBasis.push({ userId, symbol, avgPrice, updatedAt: new Date().toISOString() });
      }
    });
  }

  async listCostBasis(userId: string): Promise<CostBasisRow[]> {
    return this.user
      .read()
      .costBasis.filter((c) => c.userId === userId)
      .map(({ symbol, avgPrice, updatedAt }) => ({ symbol, avgPrice, updatedAt }));
  }

  async pruneRetention(): Promise<void> {
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    this.market.mutate((data) => {
      data.news = data.news.filter((n) => Date.parse(n.publishedAt) > cutoff);
    });
    const chatCutoff = Date.now() - CHAT_RETENTION_MS;
    this.user.mutate((data) => {
      data.chat = data.chat.filter((c) => Date.parse(c.createdAt) >= chatCutoff);
    });
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}
}

let db: Db | null = null;

export function getDb(): Db {
  if (db) return db;
  const pool = getPgPool();
  db = pool ? new PgDb(pool) : new FileDb(dataDir());
  return db;
}

export function dbBackend(): 'postgres' | 'file' {
  return databaseUrl() ? 'postgres' : 'file';
}
