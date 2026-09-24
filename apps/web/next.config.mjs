import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';

/** Monorepo root — home of the shared `.env` and the `packages/*` workspaces. */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The web app (UI + API) and the worker read the same root `.env`. Values
// already in the environment — Vercel's project settings, `apps/web/.env*` —
// win over it; on Vercel the file doesn't exist and this does nothing.
loadEnv({ path: join(repoRoot, '.env'), quiet: true });

const isDev = process.env.NODE_ENV !== 'production';

const CUBISM_ORIGIN = 'https://cubism.live2d.com';
// Home hero loop is hosted on Cloudflare R2 (src/components/home/HeroBackground.tsx).
const MEDIA_ORIGIN = 'https://pub-c928cd1d1bb64d078d179ddfd5b29169.r2.dev';

/**
 * The chain RPC the browser talks to (wagmi reads receipts and fees through
 * it; signing goes through the wallet extension, not the network). Mirrors
 * `resolveChainConfig` in @robinchan/shared: the configured RPC, or the dev
 * stand-in (Arbitrum Sepolia) when none is set and RC_ENV is dev.
 */
function rpcOrigin() {
  const configured = process.env.NEXT_PUBLIC_RPC_URL?.trim();
  const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID);
  const url =
    configured && Number.isInteger(chainId) && chainId > 0
      ? configured
      : (process.env.RC_ENV ?? 'dev') === 'dev'
        ? 'https://sepolia-rollup.arbitrum.io/rpc'
        : null;
  try {
    return url ? new URL(url).origin : '';
  } catch {
    return '';
  }
}

// Strict CSP; `frame-src` limited to the video embed domains actually used (brief §15).
const csp = [
  "default-src 'self'",
  // Next injects an inline bootstrap script, and Cubism Core executes WASM
  // (needs `wasm-unsafe-eval`, not full `unsafe-eval`). Full `unsafe-eval`
  // is only for the dev server's own tooling — PixiJS's renderer also wants
  // `new Function(...)` for its uniform-sync codegen, but that's handled
  // without weakening CSP via `@pixi/unsafe-eval` in Live2DCanvas.tsx,
  // which patches PixiJS to skip that codegen instead.
  `script-src 'self' 'unsafe-inline' ${isDev ? "'unsafe-eval'" : "'wasm-unsafe-eval'"} ${CUBISM_ORIGIN}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://i.ytimg.com",
  "font-src 'self' data:",
  // The API is served from this same origin now (app/api), so 'self' covers it.
  `connect-src 'self' ${CUBISM_ORIGIN} ${rpcOrigin()}`.trim(),
  'frame-src https://www.youtube-nocookie.com https://www.youtube.com',
  `media-src 'self' blob: ${MEDIA_ORIGIN}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  /**
   * Workspace packages are consumed as TypeScript source. Their internal
   * imports are extensionless, which Turbopack, `tsc` (bundler resolution)
   * and the worker's tsx all resolve — Turbopack has no equivalent of
   * webpack's `extensionAlias` for mapping `.js` specifiers to `.ts`.
   */
  transpilePackages: ['@robinchan/shared', '@robinchan/store', '@robinchan/core'],
  // Pin the monorepo root: a stray lockfile higher up the tree (e.g. in the
  // home directory) would otherwise be picked as the workspace root.
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  images: {
    // Next 16 narrowed the default to [75]; every <Image> here asks for 95,
    // which would otherwise be silently downgraded.
    qualities: [75, 95],
  },
  async headers() {
    return [
      {
        // Every page and asset — but not `/api/*`, whose responses carry the
        // header set the old API server sent (see src/server/api/http.ts).
        source: '/:path((?!api(?:/|$)).*)',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
      {
        // Only the large binary assets are genuinely immutable. The moc3
        // rig and its texture atlas never change without a filename bump.
        source: '/live2d/:path*.(moc3|png)',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
      {
        // The JSON config files (model3.json, expressions, motions) get
        // edited in place — e.g. adding a new expression — so they must
        // revalidate instead of being cached for a year. A stale cached
        // model3.json missing a newly-added expression name makes
        // pixi-live2d-display's `model.expression(name)` silently no-op,
        // which looks exactly like "the expression is stuck".
        source: '/live2d/:path*.json',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }],
      },
    ];
  },
};

export default nextConfig;
