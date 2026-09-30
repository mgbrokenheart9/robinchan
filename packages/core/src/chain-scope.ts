import { AsyncLocalStorage } from 'node:async_hooks';

import type { ChainConfig } from '@robinchan/shared';

/**
 * A chain other than the configured one, for the length of a call (Multichain
 * brief): perps on Base or Arbitrum run the same code as on Robinhood Chain,
 * inside a scope where `chainConfig()` — and so `publicClient()`, explorer
 * links and the keeper's wallet — answer for that chain. Outside any scope,
 * nothing changes.
 */
const scope = new AsyncLocalStorage<{ chain: ChainConfig | null }>();

export function withChainOverride<T>(chain: ChainConfig | null, fn: () => T): T {
  return scope.run({ chain }, fn);
}

/** Leaves any override: `fn` sees the configured chain. */
export function withoutChainOverride<T>(fn: () => T): T {
  return scope.exit(fn);
}

/** The override in force, if any (its chain may be null: no chain there). */
export function chainOverride(): { chain: ChainConfig | null } | undefined {
  return scope.getStore();
}
