import type { HeatScore, Ticker } from '@robinchan/shared';

import { Reveal } from '@/components/Reveal';
import { AmbientField } from '@/components/home/AmbientField';
import { ChatDemo } from '@/components/home/ChatDemo';
import { HeatBoard } from '@/components/home/HeatBoard';
import { Hero } from '@/components/home/Hero';
import { MarqueeRows } from '@/components/home/MarqueeRows';
import { SectionHead } from '@/components/home/SectionHead';
import { CapitalFlow, ClosingCta, FeatureCards, SiteFooter } from '@/components/home/Sections';
import { StatBand } from '@/components/home/StatBand';
import { getEnvelope } from '@/lib/api-server';

/**
 * Home (brief §4): a marketing page that must stay readable without a wallet
 * connected. Rendered on the server, then price data hydrates on the client.
 *
 * Uses the marketing shell, not the dashboard one (design.md §10) — this is
 * the one page built to be scrolled through once and sell the idea, so it
 * gets its own top nav, a full-bleed hero backdrop, and scroll-triggered
 * entrances the dashboard pages deliberately skip.
 */
export const revalidate = 15;

export default async function HomePage() {
  const [snapshot, heat] = await Promise.all([
    getEnvelope<Ticker[]>('/api/market/snapshot', []),
    getEnvelope<HeatScore[]>('/api/heat?limit=5', []),
  ]);

  return (
    <>
      <Hero />

      {/* Sections are spaced with `.section-y` rather than the small `py-4`
          this page used to run everywhere. The dashboard packs modules tight
          because density is its job; a landing page is read once, top to
          bottom, and needs each claim to finish before the next begins
          (design.md §10). */}
      {/* `<AmbientField>` is a sibling of `.page-container`, not a child, so
          it spans the full viewport width — inside the 1112px container its
          radial pools would be sliced off mid-strength at the container's
          edges and read as two hard vertical seams. `overflow-hidden` on
          this wrapper is what lets it be wider than the content without
          adding horizontal scroll. */}
      <div className="relative overflow-hidden">
        <AmbientField />

        <div className="page-container px-5 lg:px-10">
          {/* Proof band sits directly under the hero, before any argument —
            it's the fastest answer to "what is this, concretely". */}
          <Reveal>
            <div className="pb-4 pt-6">
              <StatBand />
            </div>
          </Reveal>

          <div className="section-y">
            <Reveal>
              <SectionHead
                eyebrow="Live data"
                title="The whole tape, on one screen"
                aside="Prices, indices, and $RCHAN on the same clock. Stale values dim rather than disappear, so you always know what you're looking at."
              />
            </Reveal>
            <Reveal delayMs={80}>
              <MarqueeRows initial={snapshot} />
            </Reveal>
          </div>

          <div className="section-y pt-0">
            <Reveal>
              <SectionHead
                eyebrow="How it works"
                title="Say what you want. Read it back. Sign it."
                aside="Robinchan reads the filing, quotes the price, and hands you a signed-by-you order. It asks back when the intent is ambiguous rather than guessing."
              />
            </Reveal>
            {/* The chat demo and heat board share the hero's column rhythm
              (660 / 412) so the page has one consistent backbone. */}
            <section className="grid-hero items-start">
              <Reveal>
                <ChatDemo />
              </Reveal>
              <Reveal delayMs={100}>
                <HeatBoard initial={heat} />
              </Reveal>
            </section>
          </div>

          <div className="section-y pt-0">
            <Reveal>
              <SectionHead
                eyebrow="Why it's built this way"
                title="Three decisions, held to"
                aside="Each one costs something. They're listed here because the trade-offs are the product."
              />
            </Reveal>
            <Reveal delayMs={80}>
              <FeatureCards />
            </Reveal>
          </div>

          <div className="section-y pt-0">
            <Reveal>
              <CapitalFlow />
            </Reveal>
          </div>

          <div className="pb-24">
            <Reveal>
              <ClosingCta />
            </Reveal>
          </div>

          <SiteFooter />
        </div>
      </div>
    </>
  );
}
