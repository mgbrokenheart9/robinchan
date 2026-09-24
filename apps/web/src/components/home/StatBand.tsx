/**
 * Big-numeral proof band (design.md §10).
 *
 * Landing pages in this category almost always lead with headline metrics —
 * total value locked, 24h volume, holder counts. Robinchan is pre-launch and
 * has none of those, and inventing them would be a lie printed at 64px. So
 * this band states what the system verifiably *is* instead of how much it has
 * moved: every figure below is read off the code, and the comment on each one
 * says where.
 *
 * `0` leads deliberately. Non-custody is the product's actual thesis (brief
 * §1), and it's the one number here a competitor can't match by growing.
 */

type Stat = { value: string; label: string; note: string; accent?: boolean };

const STATS: Stat[] = [
  {
    /* brief §1 — the server builds payloads and stops; no key, seed phrase,
       or session key is ever persisted. */
    value: '0',
    label: 'Private keys stored',
    note: 'The server builds the payload. You hold the only signature.',
    accent: true,
  },
  {
    /* WATCHED_SYMBOLS (8) + INDEX_SYMBOLS (5) in @robinchan/shared. */
    value: '13',
    label: 'Symbols tracked',
    note: 'Eight equities and five indices, priced on the same clock.',
  },
  {
    /* The `prices` job in apps/worker — 20_000ms, sized to stay under
       Finnhub's 60 req/min cap with headroom. */
    value: '20s',
    label: 'Price refresh',
    note: 'Fast enough to trust, slow enough to stay inside rate limits.',
  },
  {
    /* Six scheduled collectors in apps/worker: prices, news, heat, channels,
       clips, calendar. `retention` is housekeeping, not a feed, so it's out. */
    value: '6',
    label: 'Feeds running',
    note: 'Each polls on its own schedule and serves stale before it fails.',
  },
];

export function StatBand() {
  return (
    /* Separated glass tiles rather than the hairline-divided slab this used
       to be: that pattern draws its dividers by letting a `bg-border-soft`
       parent show through 1px gaps between opaque cells. With translucent
       cells the parent's fill shows through the cells themselves too, so
       every tile picks up the divider colour and the glass muddies. Gaps do
       the separating here instead. */
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="What the system is">
      {STATS.map(({ value, label, note, accent }) => (
        <div key={label} className="card-glass card-glass-hover group p-6 lg:p-7">
          <p className={`t-stat mb-4 ${accent ? 'text-accent-fg' : ''}`}>{value}</p>
          <p className="t-h3 mb-2">{label}</p>
          <p className="text-[13px] leading-relaxed text-text-3">{note}</p>
        </div>
      ))}
    </section>
  );
}
