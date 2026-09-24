import type { Config } from 'tailwindcss';

/**
 * Tokens pulled from dev brief §3 and design.md §2. Don't change their
 * values without recording the reason in design.md.
 *
 * Every color resolves to a CSS variable holding bare RGB channels, so one
 * utility (`bg-surface`, `text-text-2/60`, …) serves both themes. The actual
 * values live in globals.css: light on `:root` (the default), dark under
 * `.dark` on `<html>`.
 */
const token = (name: string) => `rgb(var(--c-${name}) / <alpha-value>)`;

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: token('bg'),
        surface: token('surface'),
        'surface-2': token('surface-2'),
        border: token('border'),
        'border-soft': token('border-soft'),
        text: token('text'),
        'text-2': token('text-2'),
        'text-3': token('text-3'),
        // Brand fill — buttons, bars, dots. Same lime in both themes.
        accent: token('accent'),
        // Brand color used as *text or outline*. On the light theme the fill
        // lime is ~1.2:1 against white and can't carry copy, so it steps
        // down to a deep lime there; on dark it's the fill lime itself.
        'accent-fg': token('accent-fg'),
        'accent-2': token('accent-2'),
        'accent-ink': token('accent-ink'),
        up: token('up'),
        down: token('down'),
        warning: token('warning'),
        info: token('info'),
        // Hairlines and washes that sit *on* a surface: white on dark,
        // ink on light (replaces the old hard-coded `white/10` etc.).
        overlay: token('overlay'),
        // Character accent, its scope is locked in design.md §2.
        'companion-pink': token('companion-pink'),
        // Warm supporting accent for the marketing layout only, used
        // sparingly for variety without turning companion-pink into a
        // second general-purpose brand color (design.md §10).
        ember: token('ember'),
      },
      fontFamily: {
        display: ['var(--font-display)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['var(--font-body)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      borderRadius: {
        card: '20px',
        panel: '16px',
        tile: '10px',
        row: '8px',
      },
      spacing: {
        sidebar: '248px',
        topbar: '76px',
        hero: '660px',
        panel: '412px',
        stage: '736px',
      },
      boxShadow: {
        'glow-accent': '0 0 24px rgba(212, 244, 80, 0.15)',
        'glow-soft': '0 0 18px rgba(212, 244, 80, 0.08)',
        'glow-pink': '0 0 26px rgba(255, 182, 193, 0.12)',
      },
      // Marquee keyframes are deliberately not here: `<Marquee>` sets
      // `animation-name` via inline style since speed is a runtime prop, and
      // Tailwind only emits @keyframes referenced by an `animate-*` utility.
      // They live in globals.css instead so they don't get tree-shaken.
      keyframes: {
        'pulse-dot': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.45', transform: 'scale(0.82)' },
        },
        breathe: {
          '0%, 100%': { opacity: '0.22' },
          '50%': { opacity: '0.55' },
        },
        'pod-bounce': {
          '0%, 80%, 100%': { transform: 'translateY(0)', opacity: '0.35' },
          '40%': { transform: 'translateY(-5px)', opacity: '1' },
        },
        'caret-blink': {
          '0%, 45%': { opacity: '1' },
          '55%, 100%': { opacity: '0.15' },
        },
        // Idle drift of Robinchan's speech bubble on the chat stage.
        'float-bubble': {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-8px)' },
        },
        // One-shot hero entrance, not a loop — plays once on mount.
        'hero-in': {
          from: { opacity: '0', transform: 'translateY(16px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'pulse-dot': 'pulse-dot 2s ease-in-out infinite',
        breathe: 'breathe 2.8s ease-in-out infinite',
        'pod-bounce': 'pod-bounce 1.25s ease-in-out infinite',
        'caret-blink': 'caret-blink 1.1s steps(1, end) infinite',
        'hero-in': 'hero-in 0.8s cubic-bezier(0.22, 1, 0.36, 1) both',
        'float-bubble': 'float-bubble 4s ease-in-out infinite',
      },
      transitionTimingFunction: {
        // Sidebar drawer: soft, not a snap (design.md §3).
        soft: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
    },
  },
  plugins: [],
};

export default config;
