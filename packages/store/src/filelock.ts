import { closeSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';

/**
 * Cross-process lock for the `.data/` JSON fallback.
 *
 * The web app and the worker are separate processes, and both now write to
 * the same files (orders, users, cache). Each write is a whole-file
 * read-modify-write, so two of them interleaving silently drops one. An
 * exclusive-create lock file serializes them. Dev-only: with DATABASE_URL
 * set, none of this runs.
 */
const STALE_MS = 4_000;
const WAIT_MS = 6_000;

const sleeper = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

export function withFileLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // A process that died mid-write leaves its lock behind; don't wait on it forever.
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue;
      }
      if (age > STALE_MS || Date.now() > deadline) {
        try {
          unlinkSync(lock);
        } catch {
          /* someone else cleared it */
        }
        continue;
      }
      sleepSync(8);
    }
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Write via a temp file and rename, retrying briefly: on Windows a rename
 * onto a file another process has open for reading fails with EPERM.
 */
export function writeFileAtomic(file: string, contents: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, contents);
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') || attempt >= 20) throw err;
      sleepSync(15);
    }
  }
}
