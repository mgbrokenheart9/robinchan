import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type {
  PerpActionKind,
  PerpActionStatus,
  PerpCategory,
  PerpPositionStatus,
  PerpSide,
  PerpVenueId,
} from '@robinchan/shared';
import type { Pool, PoolClient } from 'pg';

import { JsonFile } from './jsonfile';
import { dataDir } from './paths';
import { ensureSchema, getPgPool } from './pg';

/**
 * Storage for perps (Agri Perps brief §7), kept apart from `db.ts`: its own
 * interface, a Postgres implementation, and the `.data/` file fallback.
 *
 * Money moves on the paper venue (a position opening against the virtual
 * balance, a close paying out) are single atomic operations here — a
 * transaction in Postgres, the cross-process file lock in the fallback — and
 * every status change is conditional on the status it expects, so a user's
 * close and the keeper's liquidation can't both settle one position.
 */

export type PerpPositionRow = {
  id: string;
  userId: string | null;
  address: string;
  venue: PerpVenueId;
  chainId: number | null;
  /** uint256 as a decimal string. */
  chainPositionId: string | null;
  symbol: string;
  category: PerpCategory;
  side: PerpSide;
  collateral: number;
  size: number;
  leverage: number;
  entryPrice: number;
  entryIndex: number;
  entryFunding: number;
  reserve: number;
  fee: number;
  status: PerpPositionStatus;
  exitPrice: number | null;
  exitIndex: number | null;
  realizedPnl: number | null;
  fundingPaid: number | null;
  payout: number | null;
  liquidationReward: number | null;
  txOpen: string | null;
  txClose: string | null;
  openedAt: string;
  closedAt: string | null;
  updatedAt: string;
};

export type PerpPositionInsert = Omit<PerpPositionRow, 'id' | 'updatedAt'> & { id?: string };

export type PerpPositionPatch = Partial<
  Pick<
    PerpPositionRow,
    | 'status'
    | 'exitPrice'
    | 'exitIndex'
    | 'realizedPnl'
    | 'fundingPaid'
    | 'payout'
    | 'liquidationReward'
    | 'txClose'
    | 'closedAt'
    | 'userId'
  >
>;

/**
 * Which chain's rows (Multichain brief): those with this chain id, and — for
 * the primary network — the ones from before rows carried one (paper, and
 * actions recorded before chain ids were).
 */
export type PerpChainScope = { chainId: number | null; legacy: boolean };

export type PerpPositionQuery = {
  chain?: PerpChainScope;
  userId?: string;
  address?: string;
  venue?: PerpVenueId;
  statuses?: PerpPositionStatus[];
  symbol?: string;
  /** `closed` sorts by close time (history), `opened` by open time. */
  orderBy?: 'opened' | 'closed';
  limit: number;
  offset?: number;
};

export type PerpActionRow = {
  id: string;
  userId: string;
  address: string;
  kind: PerpActionKind;
  venue: PerpVenueId;
  symbol: string | null;
  positionId: string | null;
  amount: number | null;
  status: PerpActionStatus;
  /** The quote exactly as issued. */
  quote: unknown;
  /** The chain the action's transactions go to; null on paper, and for actions from before it was recorded (Robinhood Chain's). */
  chainId?: number | null;
  /** On chain: the AgriPerp order id the request created (decimal string). */
  chainOrderId: string | null;
  /** On chain: when the trader asked for the order back (the chain's time), as the worker saw it. */
  cancelRequestedAt?: string | null;
  txHash: string | null;
  txHashes: string[];
  signature: string | null;
  error: string | null;
  expiresAt: string | null;
  checkedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PerpActionInsert = Omit<PerpActionRow, 'createdAt' | 'updatedAt'>;

export type PerpActionPatch = Partial<
  Pick<
    PerpActionRow,
    'status' | 'positionId' | 'chainOrderId' | 'cancelRequestedAt' | 'txHash' | 'txHashes' | 'signature' | 'error' | 'checkedAt' | 'expiresAt'
  >
>;

export type PerpMarketStateRow = {
  symbol: string;
  /** The price feed the market reads (a Chainlink proxy). */
  feedId: string;
  /** Cumulative roll adjustment; 1 = none yet. */
  rollFactor: number;
  /** Funding per hour, fraction of size; positive = longs pay. */
  fundingRate: number;
  /** Cumulative funding per unit of size as of `fundingUpdatedAt`. */
  fundingIndex: number;
  fundingUpdatedAt: string;
  rolledAt: string | null;
  updatedAt: string;
};

export interface PerpStore {
  listMarketStates(): Promise<PerpMarketStateRow[]>;
  upsertMarketState(row: Omit<PerpMarketStateRow, 'updatedAt'>): Promise<void>;
  recordFunding(symbol: string, rate: number): Promise<void>;

  insertPosition(row: PerpPositionInsert): Promise<PerpPositionRow>;
  /** On-chain positions, keyed by chain + position id: inserted once, never duplicated. */
  upsertChainPosition(row: PerpPositionInsert & { chainId: number; chainPositionId: string }): Promise<PerpPositionRow>;
  getPosition(id: string): Promise<PerpPositionRow | null>;
  getChainPosition(chainId: number, chainPositionId: string): Promise<PerpPositionRow | null>;
  /** Conditional: applies only while the position is in one of `onlyIf`. */
  updatePosition(id: string, patch: PerpPositionPatch, onlyIf?: PerpPositionStatus[]): Promise<PerpPositionRow | null>;
  listPositions(query: PerpPositionQuery): Promise<PerpPositionRow[]>;
  /** Open interest per symbol and side, USD notional. */
  openInterest(venue: PerpVenueId, chain?: PerpChainScope): Promise<Array<{ symbol: string; side: PerpSide; size: number }>>;
  /** Notional opened since `since`, per symbol. */
  volumeSince(venue: PerpVenueId, since: Date, chain?: PerpChainScope): Promise<Array<{ symbol: string; size: number }>>;

  insertAction(row: PerpActionInsert): Promise<PerpActionRow>;
  getAction(id: string): Promise<PerpActionRow | null>;
  updateAction(id: string, patch: PerpActionPatch, onlyIf?: PerpActionStatus[]): Promise<PerpActionRow | null>;
  listActions(query: {
    chain?: PerpChainScope;
    userId?: string;
    statuses?: PerpActionStatus[];
    kinds?: PerpActionKind[];
    limit: number;
  }): Promise<PerpActionRow[]>;

  /** Paper venue: the virtual USDC not backing a position. */
  getPaperAccount(userId: string): Promise<{ free: number; faucetTotal: number }>;
  /** Adds test USDC while the account's faucet total stays within `cap`; the new free balance, or null past the cap. */
  paperFaucet(userId: string, amount: number, cap: number): Promise<number | null>;
  /**
   * One step: take `debit` (collateral + fee) from the free balance, insert
   * the position, and mark the signed action done. `insufficient` when the
   * balance is short, `conflict` when the action isn't waiting any more.
   */
  paperOpen(input: {
    actionId: string;
    signature: string;
    debit: number;
    position: PerpPositionInsert;
  }): Promise<PerpPositionRow | 'insufficient' | 'conflict'>;
  /**
   * One step: move an open position to closed or liquidated, credit the
   * payout to its owner's free balance, and (for a user's close) mark the
   * signed action done. Null when the position was no longer open.
   */
  paperSettle(input: {
    positionId: string;
    patch: PerpPositionPatch & { status: 'closed' | 'liquidated' };
    payout: number;
    action?: { id: string; signature: string };
  }): Promise<PerpPositionRow | null>;
}

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string | Date).toISOString());
const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const isUuid = (id: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
/** USDC has 6 decimals; float sums beyond that are noise. */
const usdc = (v: number): number => Math.round(v * 1e6) / 1e6;

/** A chain scope as a SQL condition, its parameter pushed onto `params`. */
function chainSql(scope: PerpChainScope, params: unknown[]): string {
  params.push(scope.chainId);
  const eq = `chain_id = $${params.length}`;
  return scope.legacy ? `(${eq} or chain_id is null)` : eq;
}

/** Whether a row's chain id is in scope (the file store's copy of chainSql). */
export function inChainScope(scope: PerpChainScope | undefined, chainId: number | null | undefined): boolean {
  if (!scope) return true;
  if (chainId == null) return scope.legacy;
  return chainId === scope.chainId;
}

/* ------------------------------------------------------------------ */
/* Postgres                                                            */
/* ------------------------------------------------------------------ */

const POSITION_COLUMNS: Array<[keyof PerpPositionRow, string]> = [
  ['id', 'id'],
  ['userId', 'user_id'],
  ['address', 'address'],
  ['venue', 'venue'],
  ['chainId', 'chain_id'],
  ['chainPositionId', 'chain_position_id'],
  ['symbol', 'symbol'],
  ['category', 'category'],
  ['side', 'side'],
  ['collateral', 'collateral'],
  ['size', 'size'],
  ['leverage', 'leverage'],
  ['entryPrice', 'entry_price'],
  ['entryIndex', 'entry_index'],
  ['entryFunding', 'entry_funding'],
  ['reserve', 'reserve'],
  ['fee', 'fee'],
  ['status', 'status'],
  ['exitPrice', 'exit_price'],
  ['exitIndex', 'exit_index'],
  ['realizedPnl', 'realized_pnl'],
  ['fundingPaid', 'funding_paid'],
  ['payout', 'payout'],
  ['liquidationReward', 'liquidation_reward'],
  ['txOpen', 'tx_open'],
  ['txClose', 'tx_close'],
  ['openedAt', 'opened_at'],
  ['closedAt', 'closed_at'],
];
const POSITION_COLUMN = new Map(POSITION_COLUMNS);

const ACTION_COLUMNS: Array<[keyof PerpActionRow, string]> = [
  ['id', 'id'],
  ['userId', 'user_id'],
  ['address', 'address'],
  ['kind', 'kind'],
  ['venue', 'venue'],
  ['symbol', 'symbol'],
  ['positionId', 'position_id'],
  ['amount', 'amount'],
  ['status', 'status'],
  ['quote', 'quote'],
  ['chainId', 'chain_id'],
  ['chainOrderId', 'chain_order_id'],
  ['cancelRequestedAt', 'cancel_requested_at'],
  ['txHash', 'tx_hash'],
  ['txHashes', 'tx_hashes'],
  ['signature', 'signature'],
  ['error', 'error'],
  ['expiresAt', 'expires_at'],
  ['checkedAt', 'checked_at'],
];
const ACTION_COLUMN = new Map(ACTION_COLUMNS);

function rowToPosition(r: Record<string, unknown>): PerpPositionRow {
  return {
    id: String(r.id),
    userId: (r.user_id as string | null) ?? null,
    address: String(r.address),
    venue: r.venue as PerpVenueId,
    chainId: numOrNull(r.chain_id),
    chainPositionId: r.chain_position_id == null ? null : String(r.chain_position_id),
    symbol: String(r.symbol),
    category: r.category as PerpCategory,
    side: r.side as PerpSide,
    collateral: num(r.collateral),
    size: num(r.size),
    leverage: num(r.leverage),
    entryPrice: num(r.entry_price),
    entryIndex: num(r.entry_index),
    entryFunding: num(r.entry_funding),
    reserve: num(r.reserve),
    fee: num(r.fee),
    status: r.status as PerpPositionStatus,
    exitPrice: numOrNull(r.exit_price),
    exitIndex: numOrNull(r.exit_index),
    realizedPnl: numOrNull(r.realized_pnl),
    fundingPaid: numOrNull(r.funding_paid),
    payout: numOrNull(r.payout),
    liquidationReward: numOrNull(r.liquidation_reward),
    txOpen: (r.tx_open as string | null) ?? null,
    txClose: (r.tx_close as string | null) ?? null,
    openedAt: iso(r.opened_at) as string,
    closedAt: iso(r.closed_at),
    updatedAt: iso(r.updated_at ?? r.opened_at) as string,
  };
}

function rowToAction(r: Record<string, unknown>): PerpActionRow {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    address: String(r.address),
    kind: r.kind as PerpActionKind,
    venue: r.venue as PerpVenueId,
    symbol: (r.symbol as string | null) ?? null,
    positionId: (r.position_id as string | null) ?? null,
    amount: numOrNull(r.amount),
    status: r.status as PerpActionStatus,
    quote: r.quote ?? null,
    chainId: numOrNull(r.chain_id),
    chainOrderId: r.chain_order_id == null ? null : String(r.chain_order_id),
    cancelRequestedAt: iso(r.cancel_requested_at),
    txHash: (r.tx_hash as string | null) ?? null,
    txHashes: (r.tx_hashes as string[] | null) ?? [],
    signature: (r.signature as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    expiresAt: iso(r.expires_at),
    checkedAt: iso(r.checked_at),
    createdAt: iso(r.created_at) as string,
    updatedAt: iso(r.updated_at ?? r.created_at) as string,
  };
}

function rowToMarket(r: Record<string, unknown>): PerpMarketStateRow {
  return {
    symbol: String(r.symbol),
    feedId: String(r.feed_id),
    rollFactor: num(r.roll_factor),
    fundingRate: num(r.funding_rate),
    fundingIndex: num(r.funding_index),
    fundingUpdatedAt: iso(r.funding_updated_at) as string,
    rolledAt: iso(r.rolled_at),
    updatedAt: iso(r.updated_at) as string,
  };
}

type Queryable = Pick<Pool, 'query'> | PoolClient;

export class PgPerpStore implements PerpStore {
  constructor(private readonly pool: Pool) {}

  private async query(sql: string, params?: unknown[], client?: Queryable) {
    await ensureSchema(this.pool);
    return (client ?? this.pool).query(sql, params);
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

  /* ---- markets ---- */

  async listMarketStates(): Promise<PerpMarketStateRow[]> {
    const res = await this.query('select * from perp_markets order by symbol');
    return res.rows.map(rowToMarket);
  }

  async upsertMarketState(row: Omit<PerpMarketStateRow, 'updatedAt'>): Promise<void> {
    await this.query(
      `insert into perp_markets (symbol, feed_id, roll_factor, funding_rate, funding_index, funding_updated_at, rolled_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, now())
       on conflict (symbol) do update
         set feed_id = excluded.feed_id, roll_factor = excluded.roll_factor,
             funding_rate = excluded.funding_rate, funding_index = excluded.funding_index,
             funding_updated_at = excluded.funding_updated_at, rolled_at = excluded.rolled_at,
             updated_at = now()`,
      [row.symbol, row.feedId, row.rollFactor, row.fundingRate, row.fundingIndex, row.fundingUpdatedAt, row.rolledAt],
    );
  }

  async recordFunding(symbol: string, rate: number): Promise<void> {
    await this.query('insert into perp_funding_history (symbol, rate) values ($1, $2)', [symbol, rate]);
  }

  /* ---- positions ---- */

  private insertSql(row: PerpPositionInsert): { cols: string[]; params: unknown[] } {
    const withId = { ...row, id: row.id ?? randomUUID() };
    const cols = POSITION_COLUMNS.filter(([key]) => key in withId);
    return { cols: cols.map(([, c]) => c), params: cols.map(([key]) => withId[key as keyof typeof withId]) };
  }

  async insertPosition(row: PerpPositionInsert, client?: Queryable): Promise<PerpPositionRow> {
    const { cols, params } = this.insertSql(row);
    const res = await this.query(
      `insert into perp_positions (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning *`,
      params,
      client,
    );
    return rowToPosition(res.rows[0]);
  }

  async upsertChainPosition(row: PerpPositionInsert & { chainId: number; chainPositionId: string }): Promise<PerpPositionRow> {
    const { cols, params } = this.insertSql(row);
    const res = await this.query(
      `insert into perp_positions (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})
       on conflict (chain_id, chain_position_id) where chain_position_id is not null do update
         set user_id = coalesce(perp_positions.user_id, excluded.user_id),
             tx_open = coalesce(perp_positions.tx_open, excluded.tx_open)
       returning *`,
      params,
    );
    return rowToPosition(res.rows[0]);
  }

  async getPosition(id: string): Promise<PerpPositionRow | null> {
    if (!isUuid(id)) return null;
    const res = await this.query('select * from perp_positions where id = $1', [id]);
    return res.rows[0] ? rowToPosition(res.rows[0]) : null;
  }

  async getChainPosition(chainId: number, chainPositionId: string): Promise<PerpPositionRow | null> {
    const res = await this.query('select * from perp_positions where chain_id = $1 and chain_position_id = $2', [
      chainId,
      chainPositionId,
    ]);
    return res.rows[0] ? rowToPosition(res.rows[0]) : null;
  }

  async updatePosition(
    id: string,
    patch: PerpPositionPatch,
    onlyIf?: PerpPositionStatus[],
    client?: Queryable,
  ): Promise<PerpPositionRow | null> {
    if (!isUuid(id)) return null;
    const sets = ['updated_at = now()'];
    const params: unknown[] = [id];
    for (const [key, value] of Object.entries(patch) as Array<[keyof PerpPositionRow, unknown]>) {
      const col = POSITION_COLUMN.get(key);
      if (!col || value === undefined) continue;
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    }
    let guard = '';
    if (onlyIf?.length) {
      params.push(onlyIf);
      guard = ` and status = any($${params.length})`;
    }
    const res = await this.query(`update perp_positions set ${sets.join(', ')} where id = $1${guard} returning *`, params, client);
    return res.rows[0] ? rowToPosition(res.rows[0]) : null;
  }

  async listPositions(q: PerpPositionQuery): Promise<PerpPositionRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.chain) where.push(chainSql(q.chain, params));
    if (q.userId) add('user_id = ?', q.userId);
    if (q.address) add('address = ?', q.address.toLowerCase());
    if (q.venue) add('venue = ?', q.venue);
    if (q.statuses?.length) add('status = any(?)', q.statuses);
    if (q.symbol) add('symbol = ?', q.symbol);
    params.push(q.limit, q.offset ?? 0);
    const order = q.orderBy === 'closed' ? 'coalesce(closed_at, opened_at) desc' : 'opened_at desc';
    const res = await this.query(
      `select * from perp_positions ${where.length ? `where ${where.join(' and ')}` : ''}
        order by ${order} limit $${params.length - 1} offset $${params.length}`,
      params,
    );
    return res.rows.map(rowToPosition);
  }

  async openInterest(venue: PerpVenueId, chain?: PerpChainScope): Promise<Array<{ symbol: string; side: PerpSide; size: number }>> {
    const params: unknown[] = [venue];
    const scope = chain ? ` and ${chainSql(chain, params)}` : '';
    const res = await this.query(
      `select symbol, side, sum(size) as size from perp_positions
        where venue = $1 and status = 'open'${scope} group by symbol, side`,
      params,
    );
    return res.rows.map((r: Record<string, unknown>) => ({ symbol: String(r.symbol), side: r.side as PerpSide, size: num(r.size) }));
  }

  async volumeSince(venue: PerpVenueId, since: Date, chain?: PerpChainScope): Promise<Array<{ symbol: string; size: number }>> {
    const params: unknown[] = [venue, since];
    const scope = chain ? ` and ${chainSql(chain, params)}` : '';
    const res = await this.query(
      `select symbol, sum(size) as size from perp_positions where venue = $1 and opened_at >= $2${scope} group by symbol`,
      params,
    );
    return res.rows.map((r: Record<string, unknown>) => ({ symbol: String(r.symbol), size: num(r.size) }));
  }

  /* ---- actions ---- */

  async insertAction(row: PerpActionInsert): Promise<PerpActionRow> {
    const cols = ACTION_COLUMNS.filter(([key]) => key in row);
    const res = await this.query(
      `insert into perp_actions (${cols.map(([, c]) => c).join(', ')})
       values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) returning *`,
      cols.map(([key]) => (key === 'quote' ? JSON.stringify(row.quote) : row[key as keyof PerpActionInsert])),
    );
    return rowToAction(res.rows[0]);
  }

  async getAction(id: string): Promise<PerpActionRow | null> {
    if (!isUuid(id)) return null;
    const res = await this.query('select * from perp_actions where id = $1', [id]);
    return res.rows[0] ? rowToAction(res.rows[0]) : null;
  }

  async updateAction(
    id: string,
    patch: PerpActionPatch,
    onlyIf?: PerpActionStatus[],
    client?: Queryable,
  ): Promise<PerpActionRow | null> {
    if (!isUuid(id)) return null;
    const sets = ['updated_at = now()'];
    const params: unknown[] = [id];
    for (const [key, value] of Object.entries(patch) as Array<[keyof PerpActionRow, unknown]>) {
      const col = ACTION_COLUMN.get(key);
      if (!col || value === undefined) continue;
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    }
    let guard = '';
    if (onlyIf?.length) {
      params.push(onlyIf);
      guard = ` and status = any($${params.length})`;
    }
    const res = await this.query(`update perp_actions set ${sets.join(', ')} where id = $1${guard} returning *`, params, client);
    return res.rows[0] ? rowToAction(res.rows[0]) : null;
  }

  async listActions(q: { chain?: PerpChainScope; userId?: string; statuses?: PerpActionStatus[]; kinds?: PerpActionKind[]; limit: number }): Promise<PerpActionRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.chain) where.push(chainSql(q.chain, params));
    if (q.userId) {
      params.push(q.userId);
      where.push(`user_id = $${params.length}`);
    }
    if (q.statuses?.length) {
      params.push(q.statuses);
      where.push(`status = any($${params.length})`);
    }
    if (q.kinds?.length) {
      params.push(q.kinds);
      where.push(`kind = any($${params.length})`);
    }
    params.push(q.limit);
    const res = await this.query(
      `select * from perp_actions ${where.length ? `where ${where.join(' and ')}` : ''}
        order by created_at desc limit $${params.length}`,
      params,
    );
    return res.rows.map(rowToAction);
  }

  /* ---- paper collateral ---- */

  async getPaperAccount(userId: string): Promise<{ free: number; faucetTotal: number }> {
    const res = await this.query('select free_collateral, faucet_total from perp_accounts where user_id = $1', [userId]);
    const r = res.rows[0] as { free_collateral: string; faucet_total: string } | undefined;
    return { free: r ? num(r.free_collateral) : 0, faucetTotal: r ? num(r.faucet_total) : 0 };
  }

  async paperFaucet(userId: string, amount: number, cap: number): Promise<number | null> {
    if (amount <= 0 || amount > cap) return null;
    const res = await this.query(
      `insert into perp_accounts (user_id, free_collateral, faucet_total) values ($1, $2, $2)
       on conflict (user_id) do update
         set free_collateral = perp_accounts.free_collateral + excluded.free_collateral,
             faucet_total = perp_accounts.faucet_total + excluded.faucet_total,
             updated_at = now()
         where perp_accounts.faucet_total + excluded.faucet_total <= $3
       returning free_collateral`,
      [userId, amount, cap],
    );
    return res.rows[0] ? num((res.rows[0] as { free_collateral: string }).free_collateral) : null;
  }

  async paperOpen(input: {
    actionId: string;
    signature: string;
    debit: number;
    position: PerpPositionInsert;
  }): Promise<PerpPositionRow | 'insufficient' | 'conflict'> {
    class Abort extends Error {
      constructor(readonly reason: 'insufficient' | 'conflict') {
        super(reason);
      }
    }
    try {
      return await this.tx(async (client) => {
        const debited = await client.query(
          `update perp_accounts set free_collateral = free_collateral - $2, updated_at = now()
            where user_id = $1 and free_collateral >= $2 returning free_collateral`,
          [input.position.userId, usdc(input.debit)],
        );
        if (!debited.rowCount) throw new Abort('insufficient');
        const position = await this.insertPosition(input.position, client);
        const done = await this.updateAction(
          input.actionId,
          { status: 'done', signature: input.signature, positionId: position.id },
          ['quoted'],
          client,
        );
        if (!done) throw new Abort('conflict');
        return position;
      });
    } catch (err) {
      if (err instanceof Abort) return err.reason;
      throw err;
    }
  }

  async paperSettle(input: {
    positionId: string;
    patch: PerpPositionPatch & { status: 'closed' | 'liquidated' };
    payout: number;
    action?: { id: string; signature: string };
  }): Promise<PerpPositionRow | null> {
    class Abort extends Error {}
    try {
      return await this.tx(async (client) => {
        const settled = await this.updatePosition(input.positionId, input.patch, ['open'], client);
        if (!settled) throw new Abort();
        if (input.payout > 0 && settled.userId) {
          await client.query(
            `insert into perp_accounts (user_id, free_collateral) values ($1, $2)
             on conflict (user_id) do update
               set free_collateral = perp_accounts.free_collateral + excluded.free_collateral, updated_at = now()`,
            [settled.userId, usdc(input.payout)],
          );
        }
        if (input.action) {
          const done = await this.updateAction(
            input.action.id,
            { status: 'done', signature: input.action.signature, positionId: settled.id },
            ['quoted'],
            client,
          );
          if (!done) throw new Abort();
        }
        return settled;
      });
    } catch (err) {
      if (err instanceof Abort) return null;
      throw err;
    }
  }
}

/* ------------------------------------------------------------------ */
/* File fallback — used when DATABASE_URL is empty                     */
/* ------------------------------------------------------------------ */

type PerpShape = {
  positions: PerpPositionRow[];
  actions: PerpActionRow[];
  accounts: Array<{ userId: string; free: number; faucetTotal: number; updatedAt: string }>;
  markets: PerpMarketStateRow[];
  funding: Array<{ symbol: string; rate: number; recordedAt: string }>;
};

class FilePerpStore implements PerpStore {
  private readonly file: JsonFile<PerpShape>;

  constructor(dir: string) {
    this.file = new JsonFile(join(dir, 'perps-db.json'), () => ({
      positions: [],
      actions: [],
      accounts: [],
      markets: [],
      funding: [],
    }));
  }

  async listMarketStates(): Promise<PerpMarketStateRow[]> {
    return structuredClone([...this.file.read().markets].sort((a, b) => a.symbol.localeCompare(b.symbol)));
  }

  async upsertMarketState(row: Omit<PerpMarketStateRow, 'updatedAt'>): Promise<void> {
    this.file.mutate((data) => {
      data.markets = [...data.markets.filter((m) => m.symbol !== row.symbol), { ...row, updatedAt: new Date().toISOString() }];
    });
  }

  async recordFunding(symbol: string, rate: number): Promise<void> {
    this.file.mutate((data) => {
      data.funding.push({ symbol, rate, recordedAt: new Date().toISOString() });
      data.funding = data.funding.slice(-1000);
    });
  }

  private static newPosition(row: PerpPositionInsert): PerpPositionRow {
    return { ...row, id: row.id ?? randomUUID(), address: row.address.toLowerCase(), updatedAt: new Date().toISOString() };
  }

  async insertPosition(row: PerpPositionInsert): Promise<PerpPositionRow> {
    return this.file.mutate((data) => {
      const position = FilePerpStore.newPosition(row);
      data.positions.push(position);
      return structuredClone(position);
    });
  }

  async upsertChainPosition(row: PerpPositionInsert & { chainId: number; chainPositionId: string }): Promise<PerpPositionRow> {
    return this.file.mutate((data) => {
      const existing = data.positions.find((p) => p.chainId === row.chainId && p.chainPositionId === row.chainPositionId);
      if (existing) {
        existing.userId ??= row.userId;
        existing.txOpen ??= row.txOpen;
        return structuredClone(existing);
      }
      const position = FilePerpStore.newPosition(row);
      data.positions.push(position);
      return structuredClone(position);
    });
  }

  async getPosition(id: string): Promise<PerpPositionRow | null> {
    const row = this.file.read().positions.find((p) => p.id === id);
    return row ? structuredClone(row) : null;
  }

  async getChainPosition(chainId: number, chainPositionId: string): Promise<PerpPositionRow | null> {
    const row = this.file.read().positions.find((p) => p.chainId === chainId && p.chainPositionId === chainPositionId);
    return row ? structuredClone(row) : null;
  }

  private static patch(row: PerpPositionRow, patch: PerpPositionPatch): void {
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) (row as Record<string, unknown>)[key] = value;
    }
    row.updatedAt = new Date().toISOString();
  }

  async updatePosition(id: string, patch: PerpPositionPatch, onlyIf?: PerpPositionStatus[]): Promise<PerpPositionRow | null> {
    return this.file.mutate((data) => {
      const row = data.positions.find((p) => p.id === id);
      if (!row || (onlyIf?.length && !onlyIf.includes(row.status))) return null;
      FilePerpStore.patch(row, patch);
      return structuredClone(row);
    });
  }

  async listPositions(q: PerpPositionQuery): Promise<PerpPositionRow[]> {
    const key = (p: PerpPositionRow) => (q.orderBy === 'closed' ? (p.closedAt ?? p.openedAt) : p.openedAt);
    return this.file
      .read()
      .positions.filter((p) => inChainScope(q.chain, p.chainId))
      .filter((p) => (q.userId ? p.userId === q.userId : true))
      .filter((p) => (q.address ? p.address === q.address.toLowerCase() : true))
      .filter((p) => (q.venue ? p.venue === q.venue : true))
      .filter((p) => (q.statuses?.length ? q.statuses.includes(p.status) : true))
      .filter((p) => (q.symbol ? p.symbol === q.symbol : true))
      .sort((a, b) => key(b).localeCompare(key(a)))
      .slice(q.offset ?? 0, (q.offset ?? 0) + q.limit)
      .map((p) => structuredClone(p));
  }

  async openInterest(venue: PerpVenueId, chain?: PerpChainScope): Promise<Array<{ symbol: string; side: PerpSide; size: number }>> {
    const sums = new Map<string, { symbol: string; side: PerpSide; size: number }>();
    for (const p of this.file.read().positions) {
      if (p.venue !== venue || p.status !== 'open' || !inChainScope(chain, p.chainId)) continue;
      const k = `${p.symbol}:${p.side}`;
      const cur = sums.get(k) ?? { symbol: p.symbol, side: p.side, size: 0 };
      cur.size = usdc(cur.size + p.size);
      sums.set(k, cur);
    }
    return [...sums.values()];
  }

  async volumeSince(venue: PerpVenueId, since: Date, chain?: PerpChainScope): Promise<Array<{ symbol: string; size: number }>> {
    const sums = new Map<string, number>();
    for (const p of this.file.read().positions) {
      if (p.venue !== venue || Date.parse(p.openedAt) < since.getTime() || !inChainScope(chain, p.chainId)) continue;
      sums.set(p.symbol, usdc((sums.get(p.symbol) ?? 0) + p.size));
    }
    return [...sums].map(([symbol, size]) => ({ symbol, size }));
  }

  async insertAction(row: PerpActionInsert): Promise<PerpActionRow> {
    return this.file.mutate((data) => {
      const now = new Date().toISOString();
      const action: PerpActionRow = { ...row, address: row.address.toLowerCase(), createdAt: now, updatedAt: now };
      data.actions.push(action);
      // Unsigned quotes pile up; keep the file bounded.
      if (data.actions.length > 5000) data.actions = data.actions.filter((a) => a.status !== 'expired').slice(-5000);
      return structuredClone(action);
    });
  }

  async getAction(id: string): Promise<PerpActionRow | null> {
    const row = this.file.read().actions.find((a) => a.id === id);
    return row ? structuredClone(row) : null;
  }

  async updateAction(id: string, patch: PerpActionPatch, onlyIf?: PerpActionStatus[]): Promise<PerpActionRow | null> {
    return this.file.mutate((data) => FilePerpStore.applyAction(data, id, patch, onlyIf));
  }

  private static applyAction(data: PerpShape, id: string, patch: PerpActionPatch, onlyIf?: PerpActionStatus[]): PerpActionRow | null {
    const row = data.actions.find((a) => a.id === id);
    if (!row || (onlyIf?.length && !onlyIf.includes(row.status))) return null;
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) (row as Record<string, unknown>)[key] = value;
    }
    row.updatedAt = new Date().toISOString();
    return structuredClone(row);
  }

  async listActions(q: { chain?: PerpChainScope; userId?: string; statuses?: PerpActionStatus[]; kinds?: PerpActionKind[]; limit: number }): Promise<PerpActionRow[]> {
    return this.file
      .read()
      .actions.filter((a) => inChainScope(q.chain, a.chainId))
      .filter((a) => (q.userId ? a.userId === q.userId : true))
      .filter((a) => (q.statuses?.length ? q.statuses.includes(a.status) : true))
      .filter((a) => (q.kinds?.length ? q.kinds.includes(a.kind) : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, q.limit)
      .map((a) => structuredClone(a));
  }

  async getPaperAccount(userId: string): Promise<{ free: number; faucetTotal: number }> {
    const a = this.file.read().accounts.find((x) => x.userId === userId);
    return { free: a?.free ?? 0, faucetTotal: a?.faucetTotal ?? 0 };
  }

  private static account(data: PerpShape, userId: string) {
    let a = data.accounts.find((x) => x.userId === userId);
    if (!a) {
      a = { userId, free: 0, faucetTotal: 0, updatedAt: new Date().toISOString() };
      data.accounts.push(a);
    }
    return a;
  }

  async paperFaucet(userId: string, amount: number, cap: number): Promise<number | null> {
    if (amount <= 0) return null;
    return this.file.mutate((data) => {
      const a = FilePerpStore.account(data, userId);
      if (a.faucetTotal + amount > cap) return null;
      a.free = usdc(a.free + amount);
      a.faucetTotal = usdc(a.faucetTotal + amount);
      a.updatedAt = new Date().toISOString();
      return a.free;
    });
  }

  async paperOpen(input: {
    actionId: string;
    signature: string;
    debit: number;
    position: PerpPositionInsert;
  }): Promise<PerpPositionRow | 'insufficient' | 'conflict'> {
    return this.file.mutate((data) => {
      const userId = input.position.userId as string;
      const a = FilePerpStore.account(data, userId);
      if (a.free + 1e-9 < input.debit) return 'insufficient' as const;
      const action = data.actions.find((x) => x.id === input.actionId);
      if (!action || action.status !== 'quoted') return 'conflict' as const;
      a.free = usdc(Math.max(0, a.free - input.debit));
      a.updatedAt = new Date().toISOString();
      const position = FilePerpStore.newPosition(input.position);
      data.positions.push(position);
      FilePerpStore.applyAction(data, input.actionId, { status: 'done', signature: input.signature, positionId: position.id });
      return structuredClone(position);
    });
  }

  async paperSettle(input: {
    positionId: string;
    patch: PerpPositionPatch & { status: 'closed' | 'liquidated' };
    payout: number;
    action?: { id: string; signature: string };
  }): Promise<PerpPositionRow | null> {
    return this.file.mutate((data) => {
      const row = data.positions.find((p) => p.id === input.positionId);
      if (!row || row.status !== 'open') return null;
      if (input.action) {
        const action = data.actions.find((x) => x.id === input.action?.id);
        if (!action || action.status !== 'quoted') return null;
      }
      FilePerpStore.patch(row, input.patch);
      if (input.payout > 0 && row.userId) {
        const a = FilePerpStore.account(data, row.userId);
        a.free = usdc(a.free + input.payout);
        a.updatedAt = new Date().toISOString();
      }
      if (input.action) {
        FilePerpStore.applyAction(data, input.action.id, { status: 'done', signature: input.action.signature, positionId: row.id });
      }
      return structuredClone(row);
    });
  }
}

let store: PerpStore | null = null;

export function getPerpStore(): PerpStore {
  if (store) return store;
  const pool = getPgPool();
  store = pool ? new PgPerpStore(pool) : new FilePerpStore(dataDir());
  return store;
}
