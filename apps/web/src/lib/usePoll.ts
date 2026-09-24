'use client';

import { useEffect, useRef, useState } from 'react';
import type { ApiEnvelope } from '@robinchan/shared';

import { getEnvelope } from './api';

/**
 * Simple polling for phase 1 (brief §8). Stops while the tab is inactive so
 * it doesn't burn through provider quota in the background, and refreshes
 * immediately once the tab becomes visible again.
 */
export function usePoll<T>(
  path: string,
  initial: ApiEnvelope<T>,
  intervalMs: number,
): ApiEnvelope<T> {
  const [state, setState] = useState<ApiEnvelope<T>>(initial);
  const fallback = useRef(initial.data);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      if (document.visibilityState === 'visible') {
        const next = await getEnvelope<T>(path, fallback.current);
        if (!cancelled) setState((prev) => (Date.parse(next.asOf) === 0 ? prev : next));
      }
      if (!cancelled) timer = setTimeout(() => void tick(), intervalMs);
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick();
    };

    timer = setTimeout(() => void tick(), intervalMs);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [path, intervalMs]);

  return state;
}

/** Relative time may only be computed after hydration, so SSR doesn't mismatch. */
export function useNow(intervalMs = 30_000): number | null {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return now;
}
