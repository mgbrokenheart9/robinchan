import type { Ticker } from '@robinchan/shared';
import { direction, formatPct, formatPrice } from '@robinchan/shared';

import { cx } from '@/components/ui';

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
        'flex shrink-0 items-center gap-3 rounded-full border px-4 py-2',
        dir === 'up' ? 'border-up/25 bg-surface shadow-glow-soft' : 'border-border bg-surface',
      )}
    >
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
