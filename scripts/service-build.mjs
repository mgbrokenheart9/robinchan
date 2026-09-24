#!/usr/bin/env node
/**
 * Root `build` script. `apps/worker` runs straight off `tsx` (see its own
 * `start` script) and has no separate build step — only `apps/web` needs
 * one. When `SERVICE_TARGET` marks this as the worker deploy (Railway), skip
 * the Next.js build entirely rather than waste build minutes compiling a
 * service that never gets served there. With `SERVICE_TARGET` unset (local
 * dev, and Vercel building apps/web), it just builds the web app.
 */
import { spawnSync } from 'node:child_process';

const target = process.env.SERVICE_TARGET;

if (target === 'api') {
  console.error(
    'SERVICE_TARGET=api is gone: the API now runs inside apps/web as Next.js route handlers ' +
      '(deployed with the web app on Vercel). Delete this Railway service; only the worker stays on Railway.',
  );
  process.exit(1);
}

if (target === 'worker') {
  console.log(`Skipping the @robinchan/web build (SERVICE_TARGET=${target}).`);
  process.exit(0);
}

const result = spawnSync('npm', ['run', 'build', '-w', '@robinchan/web'], {
  stdio: 'inherit',
  shell: true,
});

process.exit(result.status ?? 1);
