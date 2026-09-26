import { redirect } from 'next/navigation';
import { perpMarket } from '@robinchan/shared';

/**
 * Trade was replaced by Perps (Agri Perps brief §1). Old links — shared
 * URLs, bookmarks — land on the same market there when it has one.
 */
export default async function TradePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = (await searchParams).symbol;
  const symbol = (Array.isArray(raw) ? raw[0] : raw)?.toUpperCase();
  redirect(symbol && perpMarket(symbol) ? `/perps?symbol=${encodeURIComponent(symbol)}` : '/perps');
}
