'use client';

import type { ApiEnvelope, Ticker } from '@robinchan/shared';
import { POLL_MS } from '@robinchan/shared';

import { Marquee } from '@/components/Marquee';
import { TickerChip } from '@/components/TickerCard';
import { usePoll } from '@/lib/usePoll';

/**
 * Two marquee rows (brief §4 block 5): ticker cards scroll left on top,
 * example-command chips scroll right below.
 */

const COMMANDS = [
  'buy 2 AAPL at market price',
  'why is NVDA hot today?',
  'sell half my TSLA position',
  'any new filings for COIN?',
  'set a limit buy on MSFT at 505',
  'summarize chain news from the last 6 hours',
  'compare heat on AAPL vs META',
  "what's on my watchlist?",
];

export function MarqueeRows({ initial }: { initial: ApiEnvelope<Ticker[]> }) {
  const envelope = usePoll<Ticker[]>('/api/market/snapshot', initial, POLL_MS.snapshot);
  const tickers = envelope.data;

  return (
    <section className="space-y-3" aria-label="Scrolling summary">
      {tickers.length > 0 ? (
        <Marquee ariaLabel="Current prices" speed={52} direction="left" gap={12}>
          {/* Five tickers aren't wide enough to fill the track at 1440px, so
              the list repeats until it clears the container width. */}
          {[0, 1, 2].flatMap((pass) =>
            tickers.map((ticker) => (
              <TickerChip key={`${pass}-${ticker.symbol}`} ticker={ticker} />
            )),
          )}
        </Marquee>
      ) : (
        <div className="h-[38px]" aria-hidden />
      )}

      <Marquee ariaLabel="Example commands" speed={64} direction="right" gap={10}>
        {COMMANDS.map((command) => (
          <span
            key={command}
            className="shrink-0 whitespace-nowrap rounded-full border border-border-soft bg-surface px-4 py-2 text-[13px] text-text-2"
          >
            {command}
          </span>
        ))}
      </Marquee>
    </section>
  );
}
