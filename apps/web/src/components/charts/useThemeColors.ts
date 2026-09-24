'use client';

import { useSyncExternalStore } from 'react';

/**
 * Canvas charts can't use Tailwind classes, so they read the theme tokens
 * (`--c-*` in globals.css, bare RGB channels) straight off `<html>` and
 * re-read them whenever the light/dark class flips.
 */
export type ThemeColors = {
  dark: boolean;
  text: string;
  text2: string;
  text3: string;
  border: string;
  borderSoft: string;
  surface: string;
  up: string;
  down: string;
  accent: string;
  accentFg: string;
  warning: string;
  info: string;
};

const TOKENS = {
  text: '--c-text',
  text2: '--c-text-2',
  text3: '--c-text-3',
  border: '--c-border',
  borderSoft: '--c-border-soft',
  surface: '--c-surface',
  up: '--c-up',
  down: '--c-down',
  accent: '--c-accent',
  accentFg: '--c-accent-fg',
  warning: '--c-warning',
  info: '--c-info',
} as const;

let cache: { key: string; colors: ThemeColors } | null = null;

function read(): ThemeColors {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const dark = root.classList.contains('dark');
  const channels = Object.values(TOKENS).map((v) => style.getPropertyValue(v).trim());
  const key = `${dark}|${channels.join('|')}`;
  if (cache?.key === key) return cache.colors;
  const colors = { dark } as ThemeColors;
  (Object.keys(TOKENS) as Array<keyof typeof TOKENS>).forEach((name, i) => {
    const ch = channels[i] || '128 128 128';
    (colors as Record<string, string | boolean>)[name] = `rgb(${ch.split(/\s+/).join(', ')})`;
  });
  cache = { key, colors };
  return colors;
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

/** `null` during SSR; charts only mount on the client anyway. */
export function useThemeColors(): ThemeColors | null {
  return useSyncExternalStore(subscribe, read, () => null);
}

/** `rgb(a, b, c)` → `rgba(a, b, c, alpha)`. */
export function withAlpha(rgb: string, alpha: number): string {
  return rgb.replace(/^rgb\((.*)\)$/, `rgba($1, ${alpha})`);
}
