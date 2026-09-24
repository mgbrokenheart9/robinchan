'use client';

import { useState } from 'react';
import type { OrderQuote } from '@robinchan/shared';

import { AckCheckbox, OrderHeader, OrderProgress, QuoteSummary, SignButton } from '@/components/orders/OrderParts';
import { cx } from '@/components/ui';
import { useOrderSigner } from '@/lib/useOrderSigner';

/**
 * The most sensitive component in the product (brief §7). Robinchan's chat
 * renders it under a reply when a message asked for an order; the Trade
 * page's ticket is built from the same parts and signs through the same
 * `useOrderSigner` — one pipeline (Trade-Heat-Portfolio §1).
 *
 * Rules locked in here:
 * - Every value comes from `quote`, the server's response. Nothing is
 *   recomputed on the client.
 * - The sign button stays disabled until a quote is received, and while it's
 *   expired; the countdown lives in the button itself (Trade §4).
 * - No character theming on this card — it looks identical whether or not
 *   Zundamon is in the room (design.md §5).
 */
export function OrderPreviewCard({
  quote,
  onRequote,
  className,
}: {
  quote: OrderQuote;
  /** Called from "Refresh price" once the 30-second quote lapses. */
  onRequote?: () => void;
  className?: string;
}) {
  const signer = useOrderSigner();
  const [acked, setAcked] = useState(false);
  const settled = signer.phase === 'done' || signer.phase === 'pending';
  const busyLabel =
    signer.phase === 'signing' ? 'Confirm in wallet…' : signer.phase === 'confirming' ? 'Recording…' : null;
  const { intent } = quote;

  return (
    <div className={cx('card-soft bg-surface-2 p-5', className)} aria-label="Order preview">
      <OrderHeader
        side={intent.side}
        symbol={intent.symbol}
        orderType={intent.orderType}
        right={
          <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-text-3">
            {quote.venue === 'paper' ? 'paper' : 'quote'}
          </span>
        }
      />
      <div className="border-t border-border-soft pt-4">
        <QuoteSummary quote={quote} />
      </div>

      {quote.warnings.length > 0 ? (
        <ul className="mt-4 space-y-1.5 border-t border-border-soft pt-4">
          {quote.warnings.map((w) => (
            <li key={w} className="text-[12px] leading-snug text-warning">
              {w}
            </li>
          ))}
        </ul>
      ) : null}

      {!settled ? (
        <div className="mt-5 space-y-3">
          {quote.ack ? <AckCheckbox message={quote.ack.message} checked={acked} onChange={setAcked} /> : null}
          <SignButton
            quote={quote}
            side={intent.side}
            onSign={() => void signer.sign(quote)}
            onRefresh={() => onRequote?.()}
            disabled={signer.lockedElsewhere || (quote.ack != null && !acked)}
            busyLabel={busyLabel}
          />
        </div>
      ) : null}

      <div className="mt-3">
        <OrderProgress state={signer} slow={signer.slow} onSpeedUp={signer.speedUp} onCancel={signer.cancelTx} />
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-text-3">Robinchan builds the order. You sign it.</p>
    </div>
  );
}
