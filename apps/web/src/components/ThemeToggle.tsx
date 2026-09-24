'use client';

import { useSyncExternalStore } from 'react';

import { MoonIcon, SunIcon } from '@/components/icons';
import { cx } from '@/components/ui';
import { THEME_COLOR, THEME_STORAGE_KEY, type Theme } from '@/lib/theme';

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private mode / blocked storage: the switch still works for this visit.
  }
}

/**
 * The `<html>` class is the source of truth; every toggle on the page
 * subscribes to it, so two of them (e.g. desktop + mobile header) stay in
 * step. The server snapshot is `null` — the server can't know the stored
 * theme — so the icon settles on hydration without a mismatch.
 */
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

const readTheme = (): Theme =>
  document.documentElement.classList.contains('dark') ? 'dark' : 'light';

/** Light / dark switch. */
export function ThemeToggle({
  className,
  base = 'flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border text-text-2 transition-colors hover:border-text-3 hover:text-text',
}: {
  className?: string;
  /** Replaces the default outlined-circle look, e.g. with the chat's glass chip. */
  base?: string;
}) {
  const theme = useSyncExternalStore<Theme | null>(subscribe, readTheme, () => null);
  const next: Theme = theme === 'dark' ? 'light' : 'dark';

  return (
    <button
      type="button"
      onClick={() => applyTheme(next)}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      className={cx(base, className)}
    >
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
