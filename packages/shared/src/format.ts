import { SENTIMENT_NEG, SENTIMENT_POS } from './constants';

const NUM = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '––––';
  return NUM.format(value);
}

export function formatChange(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '––––';
  return `${value >= 0 ? '+' : '−'}${NUM.format(Math.abs(value))}`;
}

export function formatPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '––%';
  return `${value >= 0 ? '+' : '−'}${NUM.format(Math.abs(value))}%`;
}

export function formatCompact(value: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

export type Direction = 'up' | 'down' | 'flat';

export function direction(value: number | null | undefined): Direction {
  if (value == null || !Number.isFinite(value) || value === 0) return 'flat';
  return value > 0 ? 'up' : 'down';
}

export type Sentiment = 'pos' | 'neg' | 'neu';

/** Brief §9: threshold −0.15 / +0.15. */
export function sentimentBucket(score: number | null | undefined): Sentiment {
  if (score == null || !Number.isFinite(score)) return 'neu';
  if (score > SENTIMENT_POS) return 'pos';
  if (score < SENTIMENT_NEG) return 'neg';
  return 'neu';
}

/**
 * Relative time is computed from the UTC timestamp on the client (brief §6),
 * not sent by the server, so it doesn't go stale when the response is cached.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';
  const sec = Math.max(0, Math.round((now - then) / 1000));
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hour = Math.round(min / 60);
  if (hour < 24) return `${hour}h ago`;
  const day = Math.round(hour / 24);
  return `${day}d ago`;
}

export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function shortAddress(addr: string): string {
  if (addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * A price at the precision it needs: two decimals at a dollar and up, more
 * below that so a $0.0421 token doesn't collapse to "0.04".
 */
export function formatPriceSmart(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '––––';
  const abs = Math.abs(value);
  if (abs >= 1 || abs === 0) return NUM.format(value);
  const digits = Math.min(8, Math.max(2, 2 - Math.floor(Math.log10(abs)) + 1));
  return value.toFixed(digits);
}

export function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '––––';
  const sign = value < 0 ? '−' : '';
  return `${sign}$${formatPriceSmart(Math.abs(value))}`;
}

export function formatSignedUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '––––';
  return `${value >= 0 ? '+' : '−'}$${formatPriceSmart(Math.abs(value))}`;
}

export function formatUsdCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '––';
  return `$${formatCompact(value)}`;
}

/** Quantities: up to six decimals, trailing zeros dropped. */
export function formatQty(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '––';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(value);
}

/** A native-token amount (gas), e.g. "0.000213 ETH". */
export function formatNative(value: number | null | undefined, symbol: string): string {
  if (value == null || !Number.isFinite(value)) return `–– ${symbol}`;
  if (value === 0) return `0 ${symbol}`;
  const digits = value >= 1 ? 4 : Math.min(10, 2 - Math.floor(Math.log10(value)) + 2);
  // Trim trailing zeros by hand — `Number()` would switch tiny values to "1e-7".
  return `${value.toFixed(digits).replace(/\.?0+$/, '')} ${symbol}`;
}

/** Heat scores shown without a wallet are rounded to a multiple of ten (brief §13). */
export function roundToTen(score: number): number {
  return Math.round(score / 10) * 10;
}
