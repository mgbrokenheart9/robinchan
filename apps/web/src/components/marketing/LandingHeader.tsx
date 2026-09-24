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

/**
 * Top nav for the marketing shell (design.md §10) — deliberately not the
 * dashboard's sidebar. A landing page's job is to sell the idea in one
 * scroll before anyone has committed to the app; a 248px sidebar reserving
 * screen space for pages the visitor hasn't chosen yet works against that.
 *
 * Picks up a solid background once the hero's been scrolled past, so the
 * hero's own background art can show through at the very top.
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
    <header
      className={cx(
        'sticky top-0 z-30 transition-colors duration-300',
        scrolled || open
          ? 'border-b border-border-soft bg-bg/90 backdrop-blur-md'
          : 'border-b border-transparent bg-transparent',
      )}
    >
      <div className="page-container flex h-[76px] items-center gap-4 px-5 lg:px-10">
        <Link href="/" className="flex items-center gap-2.5">
          <Image
            src="/img/logo.jpg"
            alt=""
            aria-hidden
            width={36}
            height={36}
            priority
            quality={95}
            className="h-9 w-9 rounded-full ring-1 ring-overlay/15"
          />
          <span className="font-display text-[16px] font-semibold tracking-[0.01em]">
            Robinchan
          </span>
        </Link>

        <nav className="ml-4 hidden items-center gap-1 md:flex" aria-label="Main navigation">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-full px-3.5 py-2 text-[14px] text-text-2 transition-colors hover:bg-surface hover:text-text"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto hidden items-center gap-3 md:flex">
          <ThemeToggle />
          <Link href="/robinchan" className="btn-primary h-11 text-sm">
            Launch app
            <ArrowRightIcon />
          </Link>
        </div>

        <ThemeToggle className="ml-auto md:hidden" />

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
          className="flex h-11 w-11 items-center justify-center rounded-full border border-border text-text-2 transition-colors hover:border-text-3 hover:text-text md:hidden"
        >
          {open ? <CloseIcon /> : <MenuIcon />}
        </button>
      </div>

      {/* Mobile panel */}
      <div
        className={cx(
          'overflow-hidden border-b border-border-soft bg-bg/95 backdrop-blur-md transition-[grid-template-rows] duration-300 ease-soft md:hidden',
          'grid',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <nav className="min-h-0" aria-label="Mobile navigation">
          <div className="page-container flex flex-col gap-1 px-5 pb-5">
            {LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="min-h-[44px] rounded-full px-3.5 py-2.5 text-[15px] text-text-2 transition-colors hover:bg-surface hover:text-text"
              >
                {link.label}
              </Link>
            ))}
            <Link href="/robinchan" className="btn-primary mt-2 justify-center text-sm">
              Launch app
              <ArrowRightIcon />
            </Link>
          </div>
        </nav>
      </div>
    </header>
  );
}
