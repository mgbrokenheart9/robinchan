'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiEnvelope } from '@robinchan/shared';

import { ApiClientError, apiFetch } from './api';

/**
 * One data block's lifecycle, with all four states the dashboard pages must
 * handle (Trade-Heat-Portfolio §2) — not just the success path:
 *
 * - `loading`  nothing to show yet → a skeleton the exact size of the content
 * - `ready`    data (possibly empty — emptiness is the caller's to explain)
 * - `error`    nothing to show and the request failed → message + retry
 * - `stale`    data is shown, dimmed, with its last-updated time — either the
 *              server flagged it stale, or a refresh failed after a success
 */
export type Resource<T> = {
  data: T | undefined;
  status: 'loading' | 'ready' | 'error';
  stale: boolean;
  /** When the shown data was produced (ISO), for the "updated …" line. */
  asOf: string | null;
  error: ApiClientError | null;
  /** A refresh is in flight while data is already shown. */
  refreshing: boolean;
  reload: () => void;
  /** Replace the data locally after a write the server already confirmed. */
  set: (data: T) => void;
};

export function useApi<T>(
  path: string | null,
  opts: {
    intervalMs?: number;
    initial?: ApiEnvelope<T> | null;
    /**
     * Keep showing the previous path's data while the new one loads (a
     * filter change, a sign-in) instead of dropping back to the skeleton.
     */
    keepPrevious?: boolean;
  } = {},
): Resource<T> {
  const { intervalMs, initial, keepPrevious } = opts;
  const unsetInitial = initial && Date.parse(initial.asOf) === 0;
  const [state, setState] = useState<{
    path: string | null;
    data: T | undefined;
    asOf: string | null;
    serverStale: boolean;
    error: ApiClientError | null;
    loaded: boolean;
    refreshing: boolean;
  }>(() => ({
    path,
    data: initial && !unsetInitial ? initial.data : undefined,
    asOf: initial && !unsetInitial ? initial.asOf : null,
    serverStale: initial?.stale ?? false,
    error: null,
    loaded: Boolean(initial && !unsetInitial),
    refreshing: false,
  }));
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  // The server-rendered data covers the first path only, and only once.
  const initialFor = useRef<string | null>(initial && !unsetInitial ? path : null);

  // A new path starts over — unless the caller would rather keep the old
  // data on screen (dimmed as refreshing) until the new data arrives.
  if (state.path !== path) {
    setState(
      keepPrevious && state.data !== undefined
        ? { ...state, path, error: null, refreshing: true }
        : { path, data: undefined, asOf: null, serverStale: false, error: null, loaded: false, refreshing: false },
    );
  }

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      const id = ++seq.current;
      setState((s) => (s.path === path ? { ...s, refreshing: true } : s));
      try {
        const env = await apiFetch<T>(path);
        if (cancelled || id !== seq.current) return;
        setState({
          path,
          data: env.data,
          asOf: Date.parse(env.asOf) === 0 ? null : env.asOf,
          serverStale: env.stale,
          error: null,
          loaded: true,
          refreshing: false,
        });
      } catch (err) {
        if (cancelled || id !== seq.current) return;
        const error = err instanceof ApiClientError ? err : new ApiClientError('INTERNAL', 'Something went wrong.', 0);
        setState((s) => (s.path === path ? { ...s, error, loaded: true, refreshing: false } : s));
      }
    };

    const schedule = () => {
      if (!intervalMs) return;
      timer = setTimeout(async () => {
        if (document.visibilityState === 'visible') await load();
        if (!cancelled) schedule();
      }, intervalMs);
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible' && intervalMs) void load();
    };

    // Skip the immediate fetch when the server already rendered this exact path.
    const hasInitial = tick === 0 && initialFor.current != null && initialFor.current === path;
    initialFor.current = null;
    if (!hasInitial) void load();
    schedule();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [path, intervalMs, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const set = useCallback((data: T) => {
    setState((s) => ({ ...s, data, error: null, loaded: true, asOf: new Date().toISOString(), serverStale: false }));
  }, []);

  const hasData = state.data !== undefined;
  return {
    data: state.data,
    status: hasData ? 'ready' : state.error ? 'error' : 'loading',
    stale: hasData && (state.serverStale || state.error != null),
    asOf: state.asOf,
    error: state.error,
    refreshing: state.refreshing && hasData,
    reload,
    set,
  };
}
