import type { ApiErrorCode } from '@robinchan/shared';

/**
 * A refusal from the perps pipeline. Like `OrderError`, `field` names the
 * ticket input the message belongs next to.
 */
export class PerpError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status = 400,
    readonly field: 'collateral' | 'leverage' | 'symbol' | 'side' | 'amount' | 'gas' | null = null,
  ) {
    super(message);
    this.name = 'PerpError';
  }
}
