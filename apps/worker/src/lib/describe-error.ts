/**
 * One line saying why something failed. An AggregateError (a connection that
 * tried several addresses, as pg does) has an empty message and the reasons
 * inside; viem's first line ("RPC Request failed.") leaves out the details.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as Error & { shortMessage?: string; details?: string; code?: string; errors?: unknown[] };
  const head = e.shortMessage ?? e.message.split('\n')[0];
  const inner = e.errors?.length ? describeError(e.errors[0]) : '';
  const parts = [head || e.name, e.code && !head?.includes(e.code) ? e.code : '', e.details, inner && inner !== head ? inner : ''];
  return parts.filter(Boolean).join(' — ');
}
