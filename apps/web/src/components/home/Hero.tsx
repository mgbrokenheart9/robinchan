import Link from 'next/link';
import type { ApiEnvelope, Ticker } from '@robinchan/shared';

import { ArrowRightIcon } from '@/components/icons';
import { PulseDot } from '@/components/ui';

import { HeroBackground } from './HeroBackground';
import { MarketSnapshot } from './MarketSnapshot';

/**
 * Hero + "Market now" panel (brief §4 blocks 1–2).
 *
 * The headline spans the full container instead of sitting in the artboard's
 * 660px left column, and the lead/CTA/panel row runs underneath it. At the
 * landing-page display size (`.t-display`, up to 100px) a 660px column would
 * break "Read the market." across two lines and cost the copy its rhythm —
 * the three-beat triad only lands if each beat is one line. Giving the
 * headline the whole width and dropping the two-column split to the row
 * below keeps the artboard's 660/412 proportions where they still matter.
 *
 * This is the one section on the landing page allowed a full-bleed moving
 * background (design.md §10, §10.3) — `<HeroBackground>`, a slow dolly
 * through the ticker valley over a standby frame, scrimmed so the headline
 * reads over it.
 * It's the page's first impression, so it's the one place worth spending
 * that visual weight; the sections past it get the static blob field
 * instead.
 */
export function Hero({ snapshot }: { snapshot: ApiEnvelope<Ticker[]> }) {
  return (
    <section className="relative isolate overflow-hidden">
      <HeroBackground />

      <div className="page-container px-5 pb-16 pt-14 lg:px-10 lg:pt-20">
        {/* `text-on-media` on the copy that sits over the video plate — the
            badge, headline and lead. It buys contrast at the glyph edge so
            the backdrop doesn't have to be darkened to compensate. */}
        <p className="pill mb-7 animate-hero-in border-accent-fg/35 bg-bg/40 font-mono text-accent-fg backdrop-blur-sm [animation-delay:0ms]">
          <PulseDot />
          Live on Robinhood Chain
        </p>

        <h1 className="t-display text-on-media mb-9 animate-hero-in [animation-delay:60ms]">
          Read the market.
          <br />
          Talk it through.
          <br />
          <span className="text-accent-fg">Sign it yourself.</span>
        </h1>

        <div className="grid-hero items-start">
          <div className="max-w-hero">
            <p className="t-lead text-on-media mb-9 max-w-[560px] animate-hero-in text-text [animation-delay:120ms]">
              Robinchan reads tokenized stocks, news, and on-chain activity on one screen. Build
              orders in plain sentences, then you&apos;re the one who presses sign in your own
              wallet. No custody, no silent execution.
            </p>

            <div className="flex animate-hero-in flex-wrap gap-3 [animation-delay:180ms]">
              <Link href="/robinchan" className="btn-primary group">
                Talk to Robinchan
                <ArrowRightIcon className="transition-transform duration-200 group-hover:translate-x-0.5" />
              </Link>
              <Link href="/market" className="btn-ghost">
                Check the market first
              </Link>
            </div>
          </div>

          <div className="animate-hero-in [animation-delay:140ms]">
            <MarketSnapshot initial={snapshot} />
          </div>
        </div>
      </div>
    </section>
  );
}
