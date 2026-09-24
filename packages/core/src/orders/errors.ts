import type { ApiErrorCode } from '@robinchan/shared';

/**
 * A refusal from the order pipeline. `field` points the UI at the input
 * the message belongs next to (Trade §4: errors sit by the input that
 * caused them, not in a corner toast).
 */
export class OrderError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status = 400,
    readonly field: 'qty' | 'limitPrice' | 'symbol' | 'side' | 'gas' | null = null,
  ) {
    super(message);
    this.name = 'OrderError';
  }
}
