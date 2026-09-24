import type { OrderIntent } from '@robinchan/shared';

import { Avatar } from '@/components/Avatar';
import { DemoOrderCard } from '@/components/home/DemoOrderCard';
import { CardHead, cx } from '@/components/ui';

/**
 * "Talk it into an order" card (brief §4 block 3).
 *
 * Its content is fixed and hardcoded. This isn't a real chat and isn't wired
 * to the API — the real one lives on `/robinchan`. Because it's static, this
 * card can afford to be the most "designed" one on the page (design.md §4).
 */

const DEMO_INTENT: OrderIntent = {
  side: 'buy',
  symbol: 'NVDA',
  qty: 4,
  orderType: 'limit',
  limitPrice: 172,
};

type Turn = { from: 'user' | 'chan'; text: string };

const TURNS: Turn[] = [
  { from: 'user', text: "how's nvda doing today?" },
  {
    from: 'chan',
    text: 'Up 2.1% since the open. There was an 8-K filing about a new supply agreement an hour ago, and volume is above the 20-day average.',
  },
  { from: 'user', text: 'grab 4 shares if it drops to 172' },
  {
    from: 'chan',
    text: "Got it, limit buy 4 NVDA at 172. I'll put the quote together, but you're still the one who presses sign.",
  },
];

export function ChatDemo() {
  return (
    <section className="card-glass overflow-hidden">
      <CardHead
        title="Talk it into an order"
        aside={<span className="font-mono text-[11px] text-text-3">example conversation</span>}
      />

      <div className="space-y-4 p-5"> 
        {TURNS.map((turn, i) => (
          <Bubble key={i} turn={turn} />
        ))}

        <div className="pl-10">
          <DemoOrderCard intent={DEMO_INTENT} estPrice={172} protocolFee={0.69} estTotal={688.69} />
        </div>
      </div>
    </section>
  );
}

function Bubble({ turn }: { turn: Turn }) {
  if (turn.from === 'user') {
    return (
      <div className="flex justify-end">
        <p className="max-w-[78%] rounded-[16px] rounded-br-[6px] border border-border bg-surface-2 px-4 py-2.5 text-[14px] leading-relaxed text-text">
          {turn.text}
        </p>
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <Avatar />
      <p
        className={cx(
          'max-w-[78%] rounded-[16px] rounded-bl-[6px] border border-accent-fg/20 bg-accent/[0.05]',
          'px-4 py-2.5 text-[14px] leading-relaxed text-text',
        )}
      >
        {turn.text}
      </p>
    </div>
  );
}
