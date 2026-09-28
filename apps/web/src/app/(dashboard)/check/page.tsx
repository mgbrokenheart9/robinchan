import type { Metadata } from 'next';

import { CheckView } from '@/components/check/CheckView';

export const metadata: Metadata = {
  title: 'Token Check',
  description:
    'Paste any token address on Robinhood Chain: Robinchan reads its contract and pools, spots fakes of real stock tokens, and simulates a buy and a sell.',
};

/** Rendered per request, so the shell's feature flags reflect the running server. */
export const dynamic = 'force-dynamic';

export default function CheckPage() {
  return <CheckView address={null} initial={null} />;
}
