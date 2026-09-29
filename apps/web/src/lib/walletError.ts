/**
 * What went wrong between the page, the wallet and the chain, in a sentence.
 * viem's messages carry the whole request — "chain: Robinhood Chain (id:
 * 4663)", the calldata — so matching words across all of it misreads every
 * failure as a wrong network. This reads the error's name, its short message
 * and the root cause's details instead. Null for a rejection-free error it
 * can't place: the caller says it in its own words.
 */
export function walletErrorText(err: unknown): string | null {
  const e = err as { name?: string; shortMessage?: string; details?: string; message?: string } | null;
  const message = e?.message ?? String(err);
  const short = e?.shortMessage ?? message.split('\n')[0] ?? '';
  const details = e?.details ?? '';
  const said = `${short} ${details}`;

  if (/rejected|denied|user cancel/i.test(said)) return 'You declined it in the wallet. Nothing was sent.';
  if (/insufficient funds/i.test(said)) return 'The wallet doesn’t have enough ETH to cover this and its network fee.';
  if (e?.name === 'ChainMismatchError' || e?.name === 'ChainNotConfiguredError' || /does not match the target chain|unrecognized chain|chain mismatch/i.test(said)) {
    return 'Switch the wallet to Robinhood Chain and try again.';
  }
  if (/rate limit|too many requests|\b429\b|upgrade to paid plan/i.test(said)) {
    return 'The wallet’s Robinhood Chain RPC is refusing requests right now (rate limited). Nothing was sent — try again in a minute, or give the wallet another RPC for Robinhood Chain.';
  }
  if (/nonce/i.test(said)) return 'Another transaction from this address went out at the same moment. Nothing was sent — try again.';
  if (/HTTP request failed|fetch failed|network error|failed to fetch/i.test(said)) {
    return 'The wallet couldn’t reach Robinhood Chain. Nothing was sent — check its network settings and try again.';
  }
  return null;
}

/** The short, readable part of an error, for a message that has nothing better to say. */
export function walletErrorShort(err: unknown): string {
  const e = err as { shortMessage?: string; details?: string; message?: string } | null;
  const text = e?.details || e?.shortMessage || (e?.message ?? String(err)).split('\n')[0] || 'unknown error';
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}
