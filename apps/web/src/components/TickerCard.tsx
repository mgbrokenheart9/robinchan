import Image from 'next/image';
import type { Ticker } from '@robinchan/shared';
import { direction, formatPct, formatPrice } from '@robinchan/shared';

import { cx } from '@/components/ui';

/**
 * Company marks, self-hosted in `public/img/tickers` (sourced from Parqet's
 * logo set) so a price row never waits on a third-party image host. Each
 * SVG is a full-bleed square tile, which is why they crop cleanly to a
 * circle. `RCHAN` uses the Robinchan logo; anything else not listed falls
 * back to a lettered disc.
 */
const LOGOS: Record<string, string> = {
  AAPL: '/img/tickers/AAPL.svg',
  NVDA: '/img/tickers/NVDA.svg',
  TSLA: '/img/tickers/TSLA.svg',
  MSFT: '/img/tickers/MSFT.svg',
  AMZN: '/img/tickers/AMZN.svg',
  META: '/img/tickers/META.svg',
  GOOGL: '/img/tickers/GOOGL.svg',
  COIN: '/img/tickers/COIN.svg',
  RCHAN: '/img/logo.jpg',
};

export function TickerLogo({ symbol, size = 32 }: { symbol: string; size?: number }) {
  const src = LOGOS[symbol];
  // The ring keeps black tiles (Apple, Amazon) from dissolving into the
  // dark theme's background, and white ones (Microsoft, Meta) into light.
  const shape = 'shrink-0 rounded-full ring-1 ring-overlay/10';

  if (!src) {
    return (
      <span
        aria-hidden
        className={cx(shape, 'flex items-center justify-center bg-surface-2 font-mono text-text-2')}
        style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      >
        {symbol.charAt(0)}
      </span>
    );
  }

  return (
    <Image
      src={src}
      alt=""
      aria-hidden
      width={size}
      height={size}
      // SVGs skip the optimizer (it doesn't rasterize them); the JPEG goes
      // through it so a 1254px logo isn't shipped into a 20px slot.
      unoptimized={src.endsWith('.svg')}
      className={cx(shape, 'object-cover')}
    />
  );
}

/**
 * One component with size variants, not three separate components (brief §7).
 *
 * - `chip`  — card inside the marquee
 * - `row`   — row inside the "Market now" panel
 * - `index` — index strip card with a sparkline
 */

const TONE: Record<'up' | 'down' | 'flat', string> = {
  up: 'num-up',
  down: 'num-down',
  flat: 'num-flat',
};

export function TickerChip({ ticker }: { ticker: Ticker }) {
  const dir = direction(ticker.changePct);
  return (
    <div
      className={cx(
        'flex shrink-0 items-center gap-2.5 rounded-full border py-1.5 pl-1.5 pr-4',
        dir === 'up' ? 'border-up/25 bg-surface shadow-glow-soft' : 'border-border bg-surface',
      )}
    >
      <TickerLogo symbol={ticker.symbol} size={24} />
      <span className="font-mono text-[12px] tracking-[0.04em] text-text-2">{ticker.symbol}</span>
      <span className="t-num">{formatPrice(ticker.price)}</span>
      <span className={cx('font-mono text-[12px]', TONE[dir])}>{formatPct(ticker.changePct)}</span>
    </div>
  );
}

export function TickerRow({ ticker, stale }: { ticker: Ticker; stale?: boolean }) {
  const dir = direction(ticker.changePct);
  return (
    <div
      className={cx(
        'row-dense flex items-center gap-3 px-5 py-[9px] transition-colors hover:bg-overlay/[0.05]',
        stale && 'is-stale',
      )}
    >
      <TickerLogo symbol={ticker.symbol} />
      <div className="min-w-0 flex-1">
        <p className="font-mono text-[13px] tracking-[0.04em]">{ticker.symbol}</p>
        <p className="truncate text-[12px] text-text-3">{ticker.name}</p>
      </div>
      <div className="text-right">
        <p className="t-num">{formatPrice(ticker.price)}</p>
        <p className={cx('font-mono text-[12px]', TONE[dir])}>{formatPct(ticker.changePct)}</p>
      </div>
    </div>
  );
}

export function TickerRowEmpty({ symbol }: { symbol: string }) {
  return (
    <div className="row-dense flex items-center gap-3 px-5 py-[9px]">
      <TickerLogo symbol={symbol} />
      <div className="min-w-0 flex-1">
        <p className="font-mono text-[13px] tracking-[0.04em] text-text-3">{symbol}</p>
        <p className="text-[12px] text-text-3">waiting for data</p>
      </div>
      <div className="text-right font-mono text-[13px] text-text-3">
        <p>––––</p>
        <p className="text-[12px]">––%</p>
      </div>
    </div>
  );
}
