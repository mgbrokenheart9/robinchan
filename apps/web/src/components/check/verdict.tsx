import type { ComponentType, SVGProps } from 'react';
import type { CheckSeverity, CheckVerdict } from '@robinchan/shared';
import { CHECK_VERDICT_LABEL } from '@robinchan/shared';

import {
  FindingDangerIcon,
  FindingGoodIcon,
  FindingInfoIcon,
  FindingWarnIcon,
  VerdictCautionIcon,
  VerdictCleanIcon,
  VerdictDangerIcon,
  VerdictOfficialIcon,
  VerdictUnknownIcon,
} from '@/components/icons';
import { TickerLogo } from '@/components/TickerCard';
import { cx } from '@/components/ui';

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

/** One look per verdict: its icon, its color, and a word or two under it. */
export const VERDICT_STYLE: Record<CheckVerdict, { icon: Icon; text: string; ring: string; wash: string; blurb: string }> = {
  official: {
    icon: VerdictOfficialIcon,
    text: 'text-accent-fg',
    ring: 'border-accent-fg/45',
    wash: 'bg-accent/[0.10]',
    blurb: 'Issuer known',
  },
  clean: { icon: VerdictCleanIcon, text: 'text-up', ring: 'border-up/40', wash: 'bg-up/[0.08]', blurb: 'Nothing we check for came up' },
  caution: { icon: VerdictCautionIcon, text: 'text-warning', ring: 'border-warning/45', wash: 'bg-warning/[0.09]', blurb: 'Worth knowing first' },
  danger: { icon: VerdictDangerIcon, text: 'text-down', ring: 'border-down/45', wash: 'bg-down/[0.08]', blurb: 'Red flags found' },
  unknown: { icon: VerdictUnknownIcon, text: 'text-text-3', ring: 'border-border', wash: 'bg-surface-2', blurb: 'Not a readable token' },
};

export const SEVERITY_STYLE: Record<CheckSeverity, { icon: Icon; text: string; label: string }> = {
  danger: { icon: FindingDangerIcon, text: 'text-down', label: 'Red flag' },
  warn: { icon: FindingWarnIcon, text: 'text-warning', label: 'Caution' },
  info: { icon: FindingInfoIcon, text: 'text-info', label: 'Note' },
  good: { icon: FindingGoodIcon, text: 'text-up', label: 'Good sign' },
};

/**
 * A token's mark when DexScreener has no image for it. A company's logo only
 * for a token whose issuer is known — a memecoin borrowing the TSLA ticker
 * mustn't get Tesla's logo from us — and its first letter otherwise.
 */
export function TokenMarkFallback({ symbol, official, size }: { symbol: string; official: boolean; size: number }) {
  if (official) return <TickerLogo symbol={symbol} size={size} />;
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-full bg-surface-2 font-mono text-text-2 ring-1 ring-overlay/10"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
    >
      {symbol.replace(/^\$/, '').charAt(0).toUpperCase() || '?'}
    </span>
  );
}

export function VerdictPill({ verdict, className }: { verdict: CheckVerdict; className?: string }) {
  const s = VERDICT_STYLE[verdict];
  const Icon = s.icon;
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-[0.06em]', s.ring, s.text, className)}>
      <Icon width={12} height={12} />
      {CHECK_VERDICT_LABEL[verdict]}
    </span>
  );
}
