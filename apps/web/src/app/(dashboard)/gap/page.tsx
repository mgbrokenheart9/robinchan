import type { Metadata } from 'next';
import type { GapBoard } from '@robinchan/shared';

import { GapView } from '@/components/gap/GapView';
import { getEnvelope } from '@/lib/api-server';

export const metadata: Metadata = {
  title: 'Gap — chain vs. Wall Street',
  description:
    "Robinhood's stock tokens trade on Robinhood Chain around the clock. See how far each one has drifted from its stock while Wall Street is shut.",
};

/** The board is the same for everyone and changes every two minutes. */
export const revalidate = 60;

export default async function GapPage() {
  const initial = await getEnvelope<GapBoard | null>('/api/gap', null);
  return <GapView initial={initial} />;
}
