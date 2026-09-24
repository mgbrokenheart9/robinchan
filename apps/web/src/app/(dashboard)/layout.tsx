import { AppProviders } from '@/components/AppProviders';
import { AppShell } from '@/components/shell/AppShell';
import { publicConfig } from '@/server/config';

/**
 * Dashboard shell — sidebar + topbar (brief §3) — for the working surfaces:
 * Market, Heat, Portfolio and Trade. Deliberately not applied to Home; see
 * `(marketing)/layout.tsx` and design.md §10.
 *
 * The providers (wallet, session, Robinchan's page context) live here, with
 * the server's configuration resolved on the server and passed down.
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppProviders config={publicConfig()}>
      <AppShell>{children}</AppShell>
    </AppProviders>
  );
}
