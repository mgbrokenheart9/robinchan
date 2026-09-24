import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import type { HeatBoard } from '@robinchan/shared';

import { HeatView } from '@/components/heat/HeatView';
import { getEnvelope } from '@/lib/api-server';

export const metadata: Metadata = {
  title: 'Heat',
  description: "The full heat board: what's hot among tokenized stocks and RH Chain tokens, and why.",
};

/**
 * Heat (Trade-Heat-Portfolio §5). Rendered per request with the viewer's
 * session, because what the board contains depends on who's looking — the
 * gating is applied on the server before anything is sent (§9).
 */
export const dynamic = 'force-dynamic';

export default async function HeatPage() {
  const cookie = (await cookies()).toString();
  const initial = await getEnvelope<HeatBoard | null>('/api/heat/full', null, { cookie });
  return <HeatView initial={initial} />;
}
