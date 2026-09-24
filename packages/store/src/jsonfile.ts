import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { withFileLock, writeFileAtomic } from './filelock';

/**
 * One JSON document on disk for the `.data/` fallback, read whole and
 * rewritten whole.
 *
 * Reads are memoized on the file's mtime and size, so a request that reads
 * twenty keys parses the file once — and only again after someone writes.
 * The object handed out is shared: callers treat it as read-only. Writes
 * re-parse from disk under the cross-process lock, never from the memo.
 */
export class JsonFile<T extends object> {
  private memo: { mtimeMs: number; size: number; data: T } | null = null;

  constructor(
    readonly file: string,
    private readonly empty: () => T,
  ) {
    mkdirSync(dirname(file), { recursive: true });
  }

  private parse(): T {
    try {
      return { ...this.empty(), ...(JSON.parse(readFileSync(this.file, 'utf8')) as Partial<T>) };
    } catch {
      return this.empty();
    }
  }

  read(): T {
    let st: { mtimeMs: number; size: number };
    try {
      st = statSync(this.file);
    } catch {
      return this.empty();
    }
    if (this.memo && this.memo.mtimeMs === st.mtimeMs && this.memo.size === st.size) {
      return this.memo.data;
    }
    const data = this.parse();
    this.memo = { mtimeMs: st.mtimeMs, size: st.size, data };
    return data;
  }

  mutate<R>(fn: (data: T) => R): R {
    return withFileLock(this.file, () => {
      const data = this.parse();
      const result = fn(data);
      writeFileAtomic(this.file, JSON.stringify(data));
      try {
        const st = statSync(this.file);
        this.memo = { mtimeMs: st.mtimeMs, size: st.size, data };
      } catch {
        this.memo = null;
      }
      return result;
    });
  }
}
