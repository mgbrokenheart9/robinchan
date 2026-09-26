import type { ComponentType, SVGProps } from 'react';

import {
  HeatIcon,
  HomeIcon,
  MarketIcon,
  PerpsIcon,
  PodIcon,
  PortfolioIcon,
} from '@/components/icons';

export type NavItem = {
  href: string;
  label: string;
  hint: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Items without a page yet still render, just disabled (brief §3). */
  enabled: boolean;
};

export const NAV_ITEMS: NavItem[] = [
  {
    href: '/',
    label: 'Home',
    hint: 'Overview',
    icon: HomeIcon,
    enabled: true,
  },
  {
    href: '/robinchan',
    label: 'Robinchan',
    hint: 'Character',
    icon: PodIcon,
    enabled: true,
  },
  {
    href: '/market',
    label: 'Market',
    hint: 'Data & news',
    icon: MarketIcon,
    enabled: true,
  },
  {
    // Replaces Trade (Agri Perps brief §1).
    href: '/perps',
    label: 'Perps',
    hint: 'Agri · crypto',
    icon: PerpsIcon,
    // Behind FEATURE_PERPS until the regulatory questions are answered;
    // see `navItems` — it keeps its SOON badge while the flag is off.
    enabled: false,
  },
  {
    href: '/heat',
    label: 'Heat',
    hint: "What's hot",
    icon: HeatIcon,
    enabled: true,
  },
  {
    href: '/portfolio',
    label: 'Portfolio',
    hint: 'Your wallet',
    icon: PortfolioIcon,
    enabled: true,
  },
];

/** The nav as this server is configured: Perps opens only with `FEATURE_PERPS` on. */
export function navItems(opts: { perps: boolean }): NavItem[] {
  return NAV_ITEMS.map((item) => (item.href === '/perps' ? { ...item, enabled: opts.perps } : item));
}
