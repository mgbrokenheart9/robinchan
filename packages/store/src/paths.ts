import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * The web app and worker each run from their own working directory, so the
 * `.data/` path must be pinned to the monorepo root — not to `process.cwd()`.
 *
 * `turbopackIgnore`: this only locates runtime data (`.env`, the dev-only
 * `.data/` fallback), never source. Without it Turbopack's file tracing
 * would ship the entire repository with the deployed server code.
 */
export function repoRoot(): string {
  let dir = resolve(/* turbopackIgnore: true */ process.cwd());
  for (let i = 0; i < 8; i += 1) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as {
          workspaces?: unknown;
        };
        if (parsed.workspaces) return dir;
      } catch {
        /* keep walking up */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function dataDir(): string {
  return process.env.RC_DATA_DIR ?? join(repoRoot(), '.data');
}
