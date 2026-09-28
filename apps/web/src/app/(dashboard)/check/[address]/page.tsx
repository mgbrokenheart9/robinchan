import type { Metadata } from 'next';
import { cache } from 'react';
import type { TokenCheck } from '@robinchan/shared';
import { CHECK_VERDICT_LABEL, looksLikeAddress, shortAddress } from '@robinchan/shared';

import { CheckView } from '@/components/check/CheckView';
import { getEnvelope } from '@/lib/api-server';

type Props = { params: Promise<{ address: string }> };

export const dynamic = 'force-dynamic';

/**
 * What's already known about the address — `peek` never runs a new check,
 * so opening a shared link doesn't read the chain on the server. The page
 * runs a fresh one from the browser when this is missing or old.
 */
const peek = cache(async (address: string) =>
  looksLikeAddress(address) ? getEnvelope<TokenCheck | null>(`/api/check/${address}?peek=1`, null) : null,
);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  const known = (await peek(address))?.data;
  if (!known?.token) {
    return { title: `Token Check · ${shortAddress(address)}`, description: 'Is this token what it says it is? Robinchan reads it from Robinhood Chain.' };
  }
  const title = `${known.token.symbol}: ${CHECK_VERDICT_LABEL[known.verdict]} · Token Check`;
  return { title, description: known.headline, openGraph: { title, description: known.headline } };
}

export default async function CheckAddressPage({ params }: Props) {
  const { address } = await params;
  return <CheckView address={address} initial={await peek(address)} />;
}
