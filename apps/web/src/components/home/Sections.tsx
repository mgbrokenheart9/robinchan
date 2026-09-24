import Link from 'next/link';

import { ArrowRightIcon, ChatIcon, GridIcon, KeyIcon } from '@/components/icons';

import { SectionHead } from './SectionHead';

/**
 * Static Home blocks (brief §4 blocks 6–8). Their content is fixed and can be
 * hardcoded; since it never changes, the visual treatment is kept simple
 * (design.md §4) — though on the marketing page specifically, "simple"
 * still leaves room for a hover state and one accent color per item
 * (design.md §10). Two of three lean on brand green; the middle one gets
 * `ember`, the marketing layout's one supporting color, so the row reads as
 * three distinct ideas rather than three copies of the same thing.
 *
 * These are numbered rules rather than cards on purpose. Home was running
 * `card`/`card-soft` for every section, which flattened it — a page where
 * each block has identical chrome gives a reader no way to tell the thesis
 * from the footnote. The surrounding sections keep their panels; this one
 * drops to a hairline and a numeral so the sequence reads as an argument in
 * three parts.
 */

const FEATURES = [
  {
    title: 'One screen, not six tabs',
    body: 'Prices, SEC filings, news, and on-chain activity collected into one feed with relative time and sentiment, not six sources you have to stitch together yourself.',
    Icon: GridIcon,
    tone: 'accent',
  },
  {
    title: 'Commands in plain sentences',
    body: 'Write what you want in normal language. If anything is unclear, Robinchan asks back, it never guesses, because guessing wrong here means you lose money.',
    Icon: ChatIcon,
    tone: 'ember',
  },
  {
    title: 'Keys stay in your hands',
    body: 'The server builds the transaction payload, then stops there. No private key, seed phrase, or session key is ever stored, every transaction needs a fresh signature from you.',
    Icon: KeyIcon,
    tone: 'accent',
  },
] as const;

const TONE_STYLES = {
  accent: {
    mark: 'text-accent-fg',
    rule: 'group-hover:border-accent',
    iconHover: 'group-hover:text-accent-fg',
  },
  ember: {
    mark: 'text-ember',
    rule: 'group-hover:border-ember',
    iconHover: 'group-hover:text-ember',
  },
  /* Written out in full rather than composed at runtime — Tailwind's JIT
     scans source text for class names, so a template-built `group-hover:...`
     never gets emitted. */
} satisfies Record<string, { mark: string; rule: string; iconHover: string }>;

export function FeatureCards() {
  return (
    <ol className="grid gap-12 md:grid-cols-3 md:gap-8" aria-label="Core capabilities">
      {FEATURES.map(({ title, body, Icon, tone }, i) => {
        const styles = TONE_STYLES[tone];
        return (
          <li
            key={title}
            className={`group border-t-2 border-border pt-7 transition-colors duration-300 ${styles.rule}`}
          >
            <div className="mb-6 flex items-center justify-between">
              <span
                className={`font-mono text-[13px] tracking-[0.12em] transition-colors duration-300 ${styles.mark}`}
              >
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className={`text-text-3 transition-colors duration-300 ${styles.iconHover}`}>
                <Icon />
              </span>
            </div>
            <h3 className="mb-3 font-display text-[21px] font-semibold leading-[1.2] tracking-[-0.01em]">
              {title}
            </h3>
            <p className="text-[14px] leading-relaxed text-text-3">{body}</p>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ */

const STEPS = [
  {
    label: 'Trading fees',
    body: 'A portion of every order fee flows to the treasury address.',
  },
  {
    label: 'Premium tiers',
    body: 'Tier subscriptions flow into the same treasury.',
  },
  {
    label: 'Treasury',
    body: 'Balance and accrual are logged hourly, open for anyone to read.',
  },
  {
    label: 'Buyback $RCHAN',
    body: 'Purchase execution is run manually, not by the server.',
  },
];

export function CapitalFlow() {
  return (
    <section aria-label="Capital flow">
      <SectionHead
        eyebrow="Capital flow"
        title="Where the fees go"
        aside="Buyback is deliberately not automated. A server that can move funds is a server holding keys, which conflicts with the non-custodial principle."
      />

      {/* Same reason as `<StatBand>`: the gap-px divider trick needs opaque
          cells, so glass tiles are separated by real gaps instead. */}
      <ol className="grid gap-3 md:grid-cols-4">
        {STEPS.map((step, i) => (
          <li key={step.label} className="card-glass card-glass-hover group p-6">
            <span className="mb-5 block font-mono text-[28px] leading-none tracking-[-0.03em] text-text-3 transition-colors duration-300 group-hover:text-accent-fg">
              {String(i + 1).padStart(2, '0')}
            </span>
            <p className="mb-2 font-display text-[16px] font-semibold leading-tight">
              {step.label}
            </p>
            <p className="text-[13px] leading-relaxed text-text-3">{step.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Closing call to action. The page used to run straight from the last
 * content block into the footer's legal text, which left the strongest
 * intent — someone who has read the whole argument and is convinced —
 * with nothing to act on. This restates the thesis at section scale and
 * repeats the hero's two routes.
 */
export function ClosingCta() {
  return (
    <section className="card-glass relative overflow-hidden px-6 py-14 text-center md:px-12 md:py-20">
      {/* Single soft accent wash, clipped by the parent's rounding. The hero
          owns the page's one animated background (design.md §10); this stays
          static so it reads as an echo of it rather than a second event. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[280px] opacity-50"
        style={{
          background:
            'radial-gradient(60% 100% at 50% 0%, rgba(212,244,80,0.16) 0%, rgba(212,244,80,0) 70%)',
        }}
      />
      <div className="relative">
        <h2 className="t-section mx-auto max-w-[18ch]">
          Your keys. Your signature. <span className="text-accent-fg">Your call.</span>
        </h2>
        <p className="t-lead mx-auto mt-6 max-w-[520px]">
          Read the market with a companion who explains it, then sign the order yourself. Nothing
          moves without you.
        </p>
        <div className="mt-10 flex flex-wrap justify-center gap-3">
          <Link href="/robinchan" className="btn-primary group">
            Talk to Robinchan
            <ArrowRightIcon className="transition-transform duration-200 group-hover:translate-x-0.5" />
          </Link>
          <Link href="/market" className="btn-ghost">
            Browse the market
          </Link>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */

type FooterLink = { label: string; href?: string };

/** Phase-2 pages have no route yet, so they're named without a link — not a dead link. */
const FOOTER_LINKS: Array<{ heading: string; links: FooterLink[] }> = [
  {
    heading: 'Product',
    links: [
      { label: 'Home', href: '/' },
      { label: 'Robinchan', href: '/robinchan' },
      { label: 'Market', href: '/market' },
    ],
  },
  {
    heading: 'Coming soon',
    links: [{ label: 'Trade' }, { label: 'Heat' }, { label: 'Portfolio' }],
  },
  {
    heading: 'Token',
    links: [
      { label: 'Tiers & gating', href: '/robinchan' },
      { label: '$RCHAN on Pons' },
      { label: 'Buyback' },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="mt-4 border-t border-border-soft pt-10">
      <div className="grid gap-10 pb-10 md:grid-cols-[1fr_auto] md:gap-16">
        <div className="max-w-[420px]">
          {/* Wordmark at display weight rather than body size — the footer is
              the last thing on the page and was previously its quietest
              element, so the name landed smaller here than anywhere else. */}
          <p className="font-display text-[32px] font-semibold leading-none tracking-[-0.02em]">
            Robinchan
          </p>
          <p className="mt-4 text-[14px] leading-relaxed text-text-3">
            A character companion market for tokenized stocks on Robinhood Chain.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-10 sm:grid-cols-3">
          {FOOTER_LINKS.map((column) => (
            <nav key={column.heading} aria-label={column.heading}>
              <p className="t-eyebrow mb-4">{column.heading}</p>
              <ul className="space-y-2.5">
                {column.links.map((link) => (
                  <li key={link.label}>
                    {link.href ? (
                      <Link
                        href={link.href}
                        className="text-[13px] text-text-2 transition-colors hover:text-text"
                      >
                        {link.label}
                      </Link>
                    ) : (
                      <span className="text-[13px] text-text-3">{link.label}</span>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
      </div>

      <div className="border-t border-border-soft py-8">
        <p className="max-w-[760px] text-[12px] leading-relaxed text-text-3">
          Not financial advice. Tokenized stocks are securities and their availability varies by
          jurisdiction. Trading features stay behind a feature flag that&apos;s off by default until
          licensing and disclosure requirements are reviewed. Price and news data come from
          third-party providers and may be delayed or incomplete.
        </p>
      </div>
    </footer>
  );
}
