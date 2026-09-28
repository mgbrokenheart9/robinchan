import Image from 'next/image';
import type { Ticker } from '@robinchan/shared';
import { direction, formatPct, formatPriceSmart } from '@robinchan/shared';

import { cx } from '@/components/ui';

/**
 * Company marks, self-hosted in `public/img/tickers` (sourced from Parqet's
 * logo set) so a price row never waits on a third-party image host. Each
 * SVG is a full-bleed square tile, which is why they crop cleanly to a
 * circle. `RCHAN` uses the Robinchan logo; the RH Tokens, the marks on
 * their DexScreener token profiles. Anything else not listed falls back to a
 * lettered disc.
 */
const LOGOS: Record<string, string> = {
  AAPL: '/img/tickers/AAPL.svg',
  NVDA: '/img/tickers/NVDA.svg',
  TSLA: '/img/tickers/TSLA.svg',
  MSFT: '/img/tickers/MSFT.svg',
  AMZN: '/img/tickers/AMZN.svg',
  META: '/img/tickers/META.svg',
  SPY: '/img/tickers/SPY.svg',
  MU: '/img/tickers/MU.svg',
  GLD: '/img/tickers/GLD.svg',
  // Circle's mark, from its Robinhood token's DexScreener profile (Parqet has none).
  CRCL: '/img/tickers/CRCL.png',
  GOOGL: '/img/tickers/GOOGL.svg',
  COIN: '/img/tickers/COIN.svg',
  BTC: '/img/tickers/BTC.svg',
  ETH: '/img/tickers/ETH.svg',
  SOL: '/img/tickers/SOL.svg',
  ARB: '/img/tickers/ARB.png',
  RCHAN: '/img/logo.jpg',
  PONS: '/img/tickers/PONS.png',
  CASHCAT: '/img/tickers/CASHCAT.jpg',
  DELTA: '/img/tickers/DELTA.jpg',
};

/**
 * Commodities have no marks of their own: the agri markets show the good
 * itself, as Google's Noto Emoji (Apache 2.0, public/img/tickers/agri/NOTICE.md),
 * inset on a soft disc so they sit with the full-bleed logos beside them.
 */
const AGRI_ICONS: Record<string, string> = Object.fromEntries(
  ['CORN', 'SOYB', 'WEAT', 'COFF', 'COCC', 'SUGA', 'RICE', 'COTT', 'PALM'].map((s) => [s, `/img/tickers/agri/${s}.svg`]),
);

/** Whether `symbol` has a mark or an icon (the rest get a lettered disc). */
export const hasTickerLogo = (symbol: string): boolean => symbol in LOGOS || symbol in AGRI_ICONS;

export function TickerLogo({ symbol, size = 32 }: { symbol: string; size?: number }) {
  const src = LOGOS[symbol];
  // The ring keeps black tiles (Apple, Amazon) from dissolving into the
  // dark theme's background, and white ones (Microsoft, Meta) into light.
  const shape = 'shrink-0 rounded-full ring-1 ring-overlay/10';

  const icon = AGRI_ICONS[symbol];
  if (icon) {
    const inner = Math.round(size * 0.68);
    return (
      <span aria-hidden className={cx(shape, 'flex items-center justify-center bg-surface-2')} style={{ width: size, height: size }}>
        <Image src={icon} alt="" width={inner} height={inner} unoptimized />
      </span>
    );
  }

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
      // SVGs skip the optimizer (it doesn't rasterize them); the bitmaps go
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
      <span className="t-num">{formatPriceSmart(ticker.price)}</span>
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
        <p className="t-num">{formatPriceSmart(ticker.price)}</p>
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
