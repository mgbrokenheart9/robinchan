import { AppProviders } from '@/components/AppProviders';
import { WalletPicker } from '@/components/wallet/ConnectButton';
import { publicConfig } from '@/server/config';

/**
 * Full-screen chat shell for `/robinchan` — no sidebar, no topbar. The
 * character fills the viewport and every control floats over her, the way a
 * companion app reads rather than a dashboard with a chat widget in it.
 * Getting to the other pages goes through Home: the only way out of here is
 * the floating Home button, and the landing navbar carries the links.
 *
 * Wrapped in the same providers as the dashboard: it's the same chat thread
 * as the companion on the other pages, and an order she prepares here is
 * signed through the same wallet flow.
 */
export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppProviders config={publicConfig()}>
      <main id="content" className="fixed inset-0 overflow-hidden bg-bg">
        {children}
      </main>
      <WalletPicker />
    </AppProviders>
  );
}
