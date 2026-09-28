'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { KNOWN_TOKENS, looksLikeAddress, stockToken } from '@robinchan/shared';

import { PasteIcon, SearchIcon } from '@/components/icons';
import { cx } from '@/components/ui';

/** An address, or a ticker of a token whose issuer is known (TSLA, RCHAN, USDG…). */
function resolve(input: string): string | null {
  const value = input.trim();
  if (looksLikeAddress(value)) return value;
  const ticker = value.replace(/^\$/, '').toUpperCase();
  const stock = stockToken(ticker);
  if (stock) return stock.address;
  return KNOWN_TOKENS.find((k) => k.known.symbol === ticker)?.address ?? null;
}

export function CheckSearch({ initial = '', compact = false }: { initial?: string; compact?: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  const go = (input: string) => {
    const address = resolve(input);
    if (!address) {
      setError("That isn't a token address. Paste one that starts with 0x (42 characters), or type a stock ticker like TSLA.");
      return;
    }
    setError(null);
    router.push(`/check/${address}`);
  };

  const paste = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      setValue(text);
      if (text) go(text);
    } catch {
      setError("Your browser didn't let me read the clipboard. Paste into the box instead.");
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        go(value);
      }}
      className="w-full"
      role="search"
    >
      <div
        className={cx(
          'flex items-center gap-2 rounded-full border bg-surface pl-4 pr-1.5 transition-colors focus-within:border-accent-fg/60',
          error ? 'border-down/50' : 'border-border',
          compact ? 'h-12' : 'h-14 shadow-[0_18px_50px_-30px_rgba(31,41,55,0.35)]',
        )}
      >
        <SearchIcon className="shrink-0 text-text-3" />
        <label htmlFor="check-input" className="sr-only">
          Token address or stock ticker
        </label>
        <input
          id="check-input"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          placeholder="Paste a token address (0x…) or type a ticker"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent font-mono text-[14px] text-text placeholder:font-sans placeholder:text-text-3 focus:outline-none"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'check-error' : undefined}
        />
        <button
          type="button"
          onClick={() => void paste()}
          className="hidden h-10 items-center gap-1.5 rounded-full px-3 text-[13px] text-text-2 transition-colors hover:bg-surface-2 hover:text-text sm:inline-flex"
        >
          <PasteIcon />
          Paste
        </button>
        <button type="submit" className="btn-primary h-10 min-h-0 px-5 text-[13.5px]">
          Check
        </button>
      </div>
      {error ? (
        <p id="check-error" role="alert" className="mt-2 px-4 text-[12.5px] text-down">
          {error}
        </p>
      ) : null}
    </form>
  );
}
