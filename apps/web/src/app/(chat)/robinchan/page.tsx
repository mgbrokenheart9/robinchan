import type { Metadata } from 'next';

import { Live2DStage } from '@/components/live2d/Live2DStage';

export const metadata: Metadata = {
  title: 'Robinchan',
  description: 'A Live2D companion that reads the market and helps build orders.',
};

/**
 * Character page (brief §5), laid out as a full-screen chat: the Live2D
 * stage fills the viewport, her replies appear in a speech bubble beside
 * her, and the composer floats at the bottom. Expression, background, and
 * tier details sit behind floating buttons instead of taking page space.
 */
export default function RobinchanPage() {
  return (
    <>
      <h1 className="sr-only">Robinchan</h1>
      <Live2DStage />
    </>
  );
}
