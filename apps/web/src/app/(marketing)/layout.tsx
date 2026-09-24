import { LandingHeader } from '@/components/marketing/LandingHeader';

/**
 * Marketing shell for Home only (design.md §10) — a plain top nav instead of
 * the dashboard's sidebar, so a first-time visitor sees a page that sells
 * the product rather than a workspace with five other tabs waiting for them.
 */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <LandingHeader />
      <main id="content">{children}</main>
    </div>
  );
}
