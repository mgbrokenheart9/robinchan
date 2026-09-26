import type { Metadata } from 'next';
import type { Ticker } from '@robinchan/shared';

import { MarketSnapshot } from '@/components/home/MarketSnapshot';
import { Live2DStage } from '@/components/live2d/Live2DStage';
import { getEnvelope } from '@/lib/api-server';

export const metadata: Metadata = {
  title: 'Robinchan',
  description: 'A Live2D companion that reads the market and helps build orders.',
};

export const revalidate = 15;

/**
 * Character page (brief §5), laid out as a full-screen chat: the Live2D
 * stage fills the viewport, her replies appear in a speech bubble beside
 * her, and the composer floats at the bottom. Expression, background, and
 * tier details sit behind floating buttons instead of taking page space.
 *
 * The "Market now" glass panel floats on the left, mirroring the speech
 * bubble on the right, so the prices she's talking about stay in view.
 * Desktop only (xl+): below that the character fills the width and the
 * panel would sit on top of her.
 */
export default async function RobinchanPage() {
  const snapshot = await getEnvelope<Ticker[]>('/api/market/snapshot', []);

  return (
    <>
      <h1 className="sr-only">Robinchan</h1>
      <Live2DStage />

      <aside
        aria-label="Market now"
        className="pointer-events-none absolute left-6 top-[12%] z-10 hidden w-[340px] xl:block"
      >
        <MarketSnapshot initial={snapshot} className="pointer-events-auto" />
      </aside>
    </>
  );
}
