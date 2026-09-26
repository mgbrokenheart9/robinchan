'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { ArrowRightIcon, CloseIcon, MenuIcon } from '@/components/icons';
import { ThemeToggle } from '@/components/ThemeToggle';
import { cx } from '@/components/ui';

const LINKS = [
  { href: '/robinchan', label: 'Robinchan' },
  { href: '/market', label: 'Market' },
];

/** Icon buttons inside the island share the links' quiet, chrome-less look. */
const ICON_BUTTON =
  'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-2 transition-colors hover:bg-overlay/[0.06] hover:text-text';

/**
 * Top nav for the marketing shell (design.md §10) — deliberately not the
 * dashboard's sidebar. A landing page's job is to sell the idea in one
 * scroll before anyone has committed to the app; a 248px sidebar reserving
 * screen space for pages the visitor hasn't chosen yet works against that.
 *
 * A floating "island": fixed over the hero, wide and chrome-less at the top
 * so the hero footage runs behind it, then contracting into a centred glass
 * pill once the page scrolls (styles: `.nav-isle*` in globals.css). While
 * wide, a page-coloured gradient (`.nav-scrim`) keeps the links legible over
 * the footage.
 */
export function LandingHeader() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <header className="fixed inset-x-0 top-0 z-30 px-3 pt-3 sm:px-5 sm:pt-4">
      <span aria-hidden className={cx('nav-scrim', (scrolled || open) && 'is-hidden')} />

      <div className={cx('nav-isle', (scrolled || open) && 'is-compact')}>
        <span className="nav-isle-glass" aria-hidden />

        <Link href="/" className="relative flex items-center gap-2.5" aria-label="Robinchan home">
          <Image
            src="/img/logo.jpg"
            alt=""
            aria-hidden
            width={40}
            height={40}
            priority
            quality={95}
            className="h-10 w-10 rounded-full ring-1 ring-overlay/15"
          />
          <span className="font-display text-[17px] font-semibold tracking-[-0.02em] text-text">
            Robinchan
          </span>
        </Link>

        <div className="relative ml-auto hidden items-center gap-1 md:flex">
          <nav className="flex items-center" aria-label="Main navigation">
            {LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="navlink"
                aria-current={pathname?.startsWith(link.href) ? 'page' : undefined}
              >
                {link.label}
                <span className="navlink-rule" aria-hidden />
              </Link>
            ))}
          </nav>
          <ThemeToggle base={ICON_BUTTON} />
          <Link href="/robinchan" className="btn-nav-cta ml-2">
            Launch app
            <span className="cta-arrow" aria-hidden>
              <ArrowRightIcon />
              <ArrowRightIcon />
            </span>
          </Link>
        </div>

        <div className="relative ml-auto flex items-center gap-1 md:hidden">
          <ThemeToggle base={ICON_BUTTON} />
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            aria-controls="landing-mobile-nav"
            className={ICON_BUTTON}
          >
            {open ? <CloseIcon /> : <MenuIcon />}
          </button>
        </div>
      </div>

      {/* Mobile panel — a glass card dropping out of the island. */}
      <div
        id="landing-mobile-nav"
        className={cx(
          'mx-auto grid max-w-[720px] transition-[grid-template-rows,opacity] duration-300 ease-soft md:hidden',
          open ? 'grid-rows-[1fr] opacity-100' : 'pointer-events-none grid-rows-[0fr] opacity-0',
        )}
      >
        <nav className="min-h-0 overflow-hidden" aria-label="Mobile navigation">
          <div className="card-glass mt-2 flex flex-col gap-1 p-3">
            {LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="min-h-[44px] rounded-full px-4 py-2.5 text-[15px] text-text-2 transition-colors hover:bg-overlay/[0.06] hover:text-text"
              >
                {link.label}
              </Link>
            ))}
            <Link href="/robinchan" className="btn-nav-cta mt-1 h-11 justify-center">
              Launch app
              <span className="cta-arrow" aria-hidden>
                <ArrowRightIcon />
                <ArrowRightIcon />
              </span>
            </Link>
          </div>
        </nav>
      </div>
    </header>
  );
}
