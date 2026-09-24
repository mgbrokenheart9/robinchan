import type { ReactNode } from 'react';

/**
 * Marketing section header — eyebrow, statement heading, optional aside.
 *
 * Home previously ran its sections without headings at all, so the feature
 * row and the marquee just appeared, reading as dashboard widgets someone had
 * stacked rather than as an argument with parts. This gives each section a
 * stated claim; the aside carries the caveat that would otherwise bloat it.
 *
 * Marketing-only, like `.t-section` itself — the dashboard keeps `PageHeader`
 * (design.md §8).
 */
export function SectionHead({
  eyebrow,
  title,
  aside,
}: {
  eyebrow: string;
  title: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="mb-10 flex flex-col gap-5 md:flex-row md:items-end md:justify-between md:gap-12">
      <div>
        <p className="t-eyebrow mb-4 text-accent-fg">{eyebrow}</p>
        <h2 className="t-section max-w-[16ch]">{title}</h2>
      </div>
      {aside ? (
        <p className="max-w-[380px] text-[13px] leading-relaxed text-text-3 md:pb-2">{aside}</p>
      ) : null}
    </div>
  );
}
