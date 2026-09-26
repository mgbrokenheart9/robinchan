import type { PerpMarket, PerpPosition } from '@robinchan/shared';
import { formatPriceSmart } from '@robinchan/shared';

/** A market price with its unit, e.g. "$3.8521/lb". */
export function marketPrice(price: number | null | undefined, unit = ''): string {
  if (price == null || !Number.isFinite(price)) return '––––';
  return `$${formatPriceSmart(price)}${unit}`;
}

/** Funding per hour as a signed percentage, e.g. "+0.0013%/h". */
export function fundingLabel(ratePerHour: number): string {
  if (ratePerHour === 0) return '0.0000%/h';
  return `${ratePerHour > 0 ? '+' : '−'}${Math.abs(ratePerHour * 100).toFixed(4)}%/h`;
}

export function sideTone(side: 'long' | 'short'): string {
  return side === 'long' ? 'text-up' : 'text-down';
}

export function pnlTone(v: number | null | undefined): string {
  if (v == null || v === 0) return 'text-text-3';
  return v > 0 ? 'text-up' : 'text-down';
}

/** Leverage marks under the slider: the brief's 1/10/25/50 for 50× markets, finer below. */
export function leverageMarks(max: number): number[] {
  if (max >= 50) return [1, 10, 25, 50];
  if (max >= 20) return [1, 5, 10, max];
  return [1, Math.max(2, Math.round(max / 2)), max];
}

export const STATUS_LABEL: Record<PerpMarket['status'], string> = {
  open: 'Open',
  closed: 'Closed',
  halted: 'Close-only',
  unavailable: 'No oracle',
};

export function openInterest(m: Pick<PerpMarket, 'openInterest'>): number {
  return m.openInterest.long + m.openInterest.short;
}

export function positionsIn(symbol: string, positions: PerpPosition[] | undefined): PerpPosition[] {
  return (positions ?? []).filter((p) => p.symbol === symbol);
}
