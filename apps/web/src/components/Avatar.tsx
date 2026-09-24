import Image from 'next/image';

/**
 * Robinchan's avatar in the message list — her full-body figure on
 * transparency, with no ring or backing disc, standing beside her bubble.
 *
 * Points at the full-resolution source (`img/chat_icon.png`, 1024×1536)
 * rather than a pre-shrunk copy: `next/image` resamples it server-side to
 * the exact 1x/2x sizes the avatar needs, so it stays sharp on high-density
 * screens without shipping the 1.4MB original. The art is 2:3, so `height`
 * is the one size knob and width follows.
 */
export function Avatar({ height = 52 }: { height?: number }) {
  const width = Math.round((height * 2) / 3);
  return (
    <Image
      src="/img/chat_icon.png"
      alt=""
      aria-hidden
      width={width}
      height={height}
      quality={95}
      className="shrink-0 select-none self-start"
      style={{ width, height }}
    />
  );
}
