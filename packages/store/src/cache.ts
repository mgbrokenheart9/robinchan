import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import type { Pool } from 'pg';

import { writeFileAtomic } from './filelock';
import { JsonFile } from './jsonfile';
import { dataDir } from './paths';
import { closePgPool, databaseUrl, ensureSchema, getPgPool } from './pg';

/**
 * Key-value cache with TTL. Keys follow the `rc:<domain>:<key>` pattern (brief §8).
 *
 * The Postgres implementation (the `kv_cache` table in Vercel Postgres /
 * Neon) is used when DATABASE_URL is set. Otherwise it falls back to a JSON
 * file in `.data/` — not in-memory, because the web server and the worker
 * are two separate processes and need to keep seeing each other's data in
 * the dev environment.
 */
export interface Cache {
  get<T>(key: string): Promise<T | null>;
  /** Returns the value plus its age in seconds, null if it doesn't exist at all. */
  getWithAge<T>(key: string): Promise<{ value: T; ageSec: number } | null>;
  set<T>(key: string, value: T, ttlSec: number): Promise<void>;
  /** Several keys in one write — the candle job stores dozens of series per run. */
  setMany(entries: Array<{ key: string; value: unknown; ttlSec: number }>): Promise<void>;
  /** Read and delete in one step — for one-time values like sign-in nonces. */
  take<T>(key: string): Promise<T | null>;
  del(key: string): Promise<void>;
  /** List all keys with a given prefix. */
  keys(prefix: string): Promise<string[]>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export function cacheKey(domain: string, key: string): string {
  return `rc:${domain}:${key}`;
}

type Entry = { v: unknown; writtenAt: number; expiresAt: number };
type Shard = Record<string, Entry>;

/**
 * A value past its TTL isn't discarded: brief §8 asks the API to always
 * serve stale data rather than fail, so TTL here only marks age.
 *
 * One file per domain (`.data/cache/<domain>.json`): the price job's writes
 * every 20 seconds shouldn't rewrite a megabyte of candles each time, and a
 * read of one key only parses its own domain.
 */
class FileCache implements Cache {
  private readonly shards = new Map<string, JsonFile<Shard>>();

  constructor(private readonly dir: string) {
    migrateLegacyCacheFile(dir);
  }

  private shard(key: string): JsonFile<Shard> {
    const domain = /^rc:([a-z0-9_-]+):/i.exec(key)?.[1] ?? 'misc';
    let shard = this.shards.get(domain);
    if (!shard) {
      shard = new JsonFile<Shard>(join(this.dir, `${domain}.json`), () => ({}));
      this.shards.set(domain, shard);
    }
    return shard;
  }

  async get<T>(key: string): Promise<T | null> {
    const hit = this.shard(key).read()[key];
    return hit ? (hit.v as T) : null;
  }

  async take<T>(key: string): Promise<T | null> {
    return this.shard(key).mutate((data) => {
      const hit = data[key];
      delete data[key];
      return hit && hit.expiresAt > Date.now() ? (hit.v as T) : null;
    });
  }

  async del(key: string): Promise<void> {
    this.shard(key).mutate((data) => {
      delete data[key];
    });
  }

  async getWithAge<T>(key: string): Promise<{ value: T; ageSec: number } | null> {
    const hit = this.shard(key).read()[key];
    if (!hit) return null;
    return {
      value: hit.v as T,
      ageSec: Math.round((Date.now() - hit.writtenAt) / 1000),
    };
  }

  async set<T>(key: string, value: T, ttlSec: number): Promise<void> {
    await this.setMany([{ key, value, ttlSec }]);
  }

  async setMany(entries: Array<{ key: string; value: unknown; ttlSec: number }>): Promise<void> {
    const byShard = new Map<JsonFile<Shard>, typeof entries>();
    for (const e of entries) {
      const shard = this.shard(e.key);
      byShard.set(shard, [...(byShard.get(shard) ?? []), e]);
    }
    for (const [shard, list] of byShard) {
      shard.mutate((data) => {
        const now = Date.now();
        for (const e of list) data[e.key] = { v: e.value, writtenAt: now, expiresAt: now + e.ttlSec * 1000 };
        // Short-lived keys (nonces, sessions) would otherwise pile up
        // forever — nothing else prunes these files.
        const cutoff = now - 24 * 60 * 60 * 1000;
        for (const [k, entry] of Object.entries(data)) {
          if (entry.expiresAt < cutoff) delete data[k];
        }
      });
    }
  }

  async keys(prefix: string): Promise<string[]> {
    return Object.keys(this.shard(prefix).read()).filter((k) => k.startsWith(prefix));
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}
}

/** The single `.data/cache.json` of earlier versions, split into domain files once. */
function migrateLegacyCacheFile(dir: string): void {
  const legacy = join(dir, '..', 'cache.json');
  if (!existsSync(legacy) || existsSync(dir)) return;
  try {
    const data = JSON.parse(readFileSync(legacy, 'utf8')) as Shard;
    const byDomain = new Map<string, Shard>();
    for (const [key, entry] of Object.entries(data)) {
      const domain = /^rc:([a-z0-9_-]+):/i.exec(key)?.[1] ?? 'misc';
      byDomain.set(domain, { ...(byDomain.get(domain) ?? {}), [key]: entry });
    }
    mkdirSync(dir, { recursive: true });
    for (const [domain, shard] of byDomain) {
      writeFileAtomic(join(dir, `${domain}.json`), JSON.stringify(shard));
    }
    renameSync(legacy, `${legacy}.migrated`);
  } catch {
    /* the worker refills everything within a minute anyway */
  }
}

/**
 * Takes over from the Redis store: same `rc:<domain>:<key>` keys, same
 * retention. Ages are measured against the writer's clock (`written_at` is
 * set from `Date.now()`, not the database's `now()`), exactly as Redis
 * stored `writtenAt`, so `stale` flags don't shift with database clock skew.
 */
export class PgCache implements Cache {
  constructor(private readonly pool: Pool) {}

  private async query(sql: string, params: unknown[]) {
    await ensureSchema(this.pool);
    return this.pool.query(sql, params);
  }

  async get<T>(key: string): Promise<T | null> {
    const hit = await this.getWithAge<T>(key);
    return hit ? hit.value : null;
  }

  async getWithAge<T>(key: string): Promise<{ value: T; ageSec: number } | null> {
    const res = await this.query(
      'select value, written_at from kv_cache where key = $1 and expires_at > $2',
      [key, new Date()],
    );
    const row = res.rows[0] as { value: T; written_at: Date } | undefined;
    if (!row) return null;
    return {
      value: row.value,
      ageSec: Math.round((Date.now() - new Date(row.written_at).getTime()) / 1000),
    };
  }

  async set<T>(key: string, value: T, ttlSec: number): Promise<void> {
    const now = Date.now();
    // Kept for ten times the TTL — the retention the Redis store used — so
    // stale data can still be served when the worker falls behind, per the
    // "stale beats failing" rule. Expired rows are pruned by the retention job.
    const expiresAt = new Date(now + Math.max(ttlSec * 10, 60) * 1000);
    await this.query(
      `insert into kv_cache (key, value, written_at, expires_at)
       values ($1, $2, $3, $4)
       on conflict (key) do update
         set value = excluded.value,
             written_at = excluded.written_at,
             expires_at = excluded.expires_at`,
      [key, JSON.stringify(value), new Date(now), expiresAt],
    );
  }

  async setMany(entries: Array<{ key: string; value: unknown; ttlSec: number }>): Promise<void> {
    if (entries.length === 0) return;
    const now = Date.now();
    await this.query(
      `insert into kv_cache (key, value, written_at, expires_at)
       select k, v::json, $3::timestamptz, e
         from unnest($1::text[], $2::text[], $4::timestamptz[]) as t(k, v, e)
       on conflict (key) do update
         set value = excluded.value,
             written_at = excluded.written_at,
             expires_at = excluded.expires_at`,
      [
        entries.map((e) => e.key),
        entries.map((e) => JSON.stringify(e.value)),
        new Date(now),
        entries.map((e) => new Date(now + Math.max(e.ttlSec * 10, 60) * 1000)),
      ],
    );
  }

  async take<T>(key: string): Promise<T | null> {
    const res = await this.query(
      'delete from kv_cache where key = $1 returning value, written_at, expires_at',
      [key],
    );
    const row = res.rows[0] as { value: T; expires_at: Date } | undefined;
    return row && new Date(row.expires_at).getTime() > Date.now() ? row.value : null;
  }

  async del(key: string): Promise<void> {
    await this.query('delete from kv_cache where key = $1', [key]);
  }

  async keys(prefix: string): Promise<string[]> {
    const res = await this.query(
      'select key from kv_cache where left(key, length($1)) = $1 and expires_at > $2 order by key',
      [prefix, new Date()],
    );
    return res.rows.map((r: { key: string }) => r.key);
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

let cached: Cache | null = null;

export function getCache(): Cache {
  if (cached) return cached;
  const pool = getPgPool();
  cached = pool ? new PgCache(pool) : new FileCache(join(dataDir(), 'cache'));
  return cached;
}

export function cacheBackend(): 'postgres' | 'file' {
  return databaseUrl() ? 'postgres' : 'file';
}
