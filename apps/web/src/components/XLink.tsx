import { cx } from '@/components/ui';

/** Robinchan Perps on X. */
export const X_URL = 'https://x.com/Rchanperps';

/** The X logo linking to our account, in the same circle as `<ThemeToggle>` beside it. */
export function XLink({
  className,
  base = 'flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border text-text-2 transition-colors hover:border-text-3 hover:text-text',
}: {
  className?: string;
  /** Replaces the default outlined-circle look, as `<ThemeToggle>`'s does. */
  base?: string;
}) {
  return (
    <a
      href={X_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Robinchan Perps on X"
      title="Follow @Rchanperps on X"
      className={cx(base, className)}
    >
      <svg viewBox="0 0 24 24" width={16} height={16} fill="currentColor" aria-hidden>
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      </svg>
    </a>
  );
}
