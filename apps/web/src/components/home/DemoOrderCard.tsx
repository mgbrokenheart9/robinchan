import type { OrderIntent } from '@robinchan/shared';
import { formatPrice } from '@robinchan/shared';

import { OrderHeader } from '@/components/orders/OrderParts';
import { cx } from '@/components/ui';

/**
 * Home's example order card (brief §4 block 3): the same header and layout
 * as the real `<OrderPreviewCard>`, but static and never signable — and it
 * deliberately doesn't import the signing code, so the landing page's
 * bundle doesn't carry wallet libraries.
 */
export function DemoOrderCard({
  intent,
  estPrice,
  protocolFee,
  estTotal,
  className,
}: {
  intent: OrderIntent;
  estPrice: number;
  protocolFee: number;
  estTotal: number;
  className?: string;
}) {
  return (
    <div className={cx('card-soft bg-surface-2 p-5', className)} aria-label="Order preview example">
      <OrderHeader
        side={intent.side}
        symbol={intent.symbol}
        orderType={intent.orderType}
        right={<span className="font-mono text-[11px] uppercase tracking-[0.1em] text-text-3">example</span>}
      />
      <dl className="space-y-2.5 border-t border-border-soft pt-4">
        <Line label="Quantity" value={`${intent.qty} unit`} />
        <Line label="Entry price" value={formatPrice(estPrice)} />
        {intent.limitPrice != null ? <Line label="Limit price" value={formatPrice(intent.limitPrice)} /> : null}
        <Line label="Protocol fee" value={formatPrice(protocolFee)} muted />
        <Line label="Estimated total" value={formatPrice(estTotal)} emphasis />
      </dl>
      <div className="mt-5">
        <button type="button" disabled className="btn-primary w-full text-sm" title="Example card — not connected to a wallet">
          Sign order
        </button>
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-text-3">
        You&apos;re the one who signs. The server only builds the payload and can never send a transaction on
        your behalf.
      </p>
    </div>
  );
}

function Line({ label, value, muted, emphasis }: { label: string; value: string; muted?: boolean; emphasis?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={cx('text-[13px]', muted ? 'text-text-3' : 'text-text-2')}>{label}</dt>
      <dd className={cx('font-mono text-[13px]', emphasis ? 'text-[15px] text-text' : muted ? 'text-text-3' : 'text-text')}>
        {value}
      </dd>
    </div>
  );
}
