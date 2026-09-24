'use client';

import { useSyncExternalStore } from 'react';

/**
 * One order in flight at a time, across the whole tab — the Trade ticket
 * and an order card in Robinchan's chat share this. Two orders sent back to
 * back collide on the nonce and one fails without explanation (Trade §4),
 * so every sign button stays locked while any order is being signed or is
 * waiting on the chain. The server refuses a new quote in that state too.
 */
let current: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function lockOrder(orderId: string): boolean {
  if (current && current !== orderId) return false;
  current = orderId;
  emit();
  return true;
}

export function unlockOrder(orderId: string): void {
  if (current !== orderId) return;
  current = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The order currently holding the lock, if any. */
export function useOrderLock(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}
