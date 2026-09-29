'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { OrderExecution, PerpActionRecord, TxRequest } from '@robinchan/shared';
import { useConfig as useWagmiConfig } from 'wagmi';
import { getAccount, sendTransaction, signTypedData, switchChain, waitForTransactionReceipt } from 'wagmi/actions';

import { useSession } from '@/components/wallet/SessionProvider';

import { ApiClientError, apiFetch } from './api';
import { lockOrder, unlockOrder, useOrderLock } from './orderLock';
import { walletErrorShort, walletErrorText } from './walletError';

/**
 * Signing a perps action — an open, a close, a deposit or a withdrawal.
 * What's signed is always the server's quote, verbatim: its typed data
 * (paper), or its transactions (on chain). Nothing here builds a value.
 *
 * On chain an open or close is a request: once its transaction lands, the
 * action stays `pending` while the keeper executes the order at Chainlink's
 * next price, and this hook follows it until it's done or cancelled. The
 * tab-wide order lock is shared with the spot ticket in the chat: one thing
 * in flight at a time, so transactions never collide on a nonce.
 */
export type PerpSignPhase = 'idle' | 'signing' | 'confirming' | 'pending' | 'done';

export type PerpSignerState = {
  phase: PerpSignPhase;
  record: PerpActionRecord | null;
  error: string | null;
  step: { index: number; total: number; label: string } | null;
};

type Signable = { id: string; address: string; execution: OrderExecution };

const INITIAL: PerpSignerState = { phase: 'idle', record: null, error: null, step: null };
const POLL_MS = 2_500;

export function usePerpSigner(opts: { onSettled?: (record: PerpActionRecord) => void } = {}) {
  const wagmiConfig = useWagmiConfig();
  const session = useSession();
  const lock = useOrderLock();
  const [state, setState] = useState<PerpSignerState>(INITIAL);
  const onSettled = useRef(opts.onSettled);
  const current = useRef<string | null>(null);

  useEffect(() => {
    onSettled.current = opts.onSettled;
  });

  // Follow a pending action on the server until it settles.
  const pendingId = state.phase === 'pending' ? state.record?.id : null;
  useEffect(() => {
    if (!pendingId) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const { data } = await apiFetch<PerpActionRecord>(`/api/perps/actions/${pendingId}`);
        if (cancelled) return;
        if (data.status === 'done' || data.status === 'failed' || data.status === 'expired') {
          unlockOrder(pendingId);
          setState((s) => ({ ...s, phase: 'done', record: data, error: data.status === 'done' ? null : data.error }));
          onSettled.current?.(data);
        } else {
          setState((s) => ({ ...s, record: data }));
        }
      } catch {
        /* keep polling; the worker keeps following it regardless */
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pendingId]);

  const ensureWallet = useCallback(
    async (address: string): Promise<boolean> => {
      const account = getAccount(wagmiConfig);
      if (!account.isConnected || !account.address) {
        session.openPicker();
        return false;
      }
      if (account.address.toLowerCase() !== address.toLowerCase()) throw new Error('ADDRESS_CHANGED');
      const chainId = session.chain?.id;
      if (chainId && account.chainId !== chainId) await switchChain(wagmiConfig, { chainId });
      return true;
    },
    [wagmiConfig, session],
  );

  const sendAll = useCallback(
    async (txs: TxRequest[], onSent?: (hash: `0x${string}`, index: number) => Promise<void>) => {
      for (const [index, tx] of txs.entries()) {
        setState((s) => ({ ...s, phase: 'signing', step: { index, total: txs.length, label: tx.label } }));
        const hash = await sendTransaction(wagmiConfig, { to: tx.to, data: tx.data, value: BigInt(tx.value), chainId: tx.chainId });
        await onSent?.(hash, index);
        if (index < txs.length - 1) {
          // An approval has to land before the next step can spend it.
          setState((s) => ({ ...s, phase: 'confirming' }));
          await waitForTransactionReceipt(wagmiConfig, { hash, timeout: 180_000 });
        }
      }
    },
    [wagmiConfig],
  );

  /** Sign a quote issued by /api/perps/quote or /api/perps/collateral. */
  const sign = useCallback(
    async (quote: Signable): Promise<PerpActionRecord | null> => {
      if (!lockOrder(quote.id)) {
        setState((s) => ({ ...s, error: 'Something else is still being signed or confirmed.' }));
        return null;
      }
      current.current = quote.id;
      setState({ ...INITIAL, phase: 'signing' });
      try {
        if (!(await ensureWallet(quote.address))) {
          unlockOrder(quote.id);
          setState(INITIAL);
          return null;
        }
        if (quote.execution.kind === 'signature') {
          const { typedData } = quote.execution;
          const signature = await signTypedData(wagmiConfig, {
            domain: typedData.domain,
            types: typedData.types,
            primaryType: typedData.primaryType,
            message: typedData.message,
          } as Parameters<typeof signTypedData>[1]);
          setState((s) => ({ ...s, phase: 'confirming' }));
          const { data } = await apiFetch<PerpActionRecord>('/api/perps/record', { json: { actionId: quote.id, signature } });
          unlockOrder(quote.id);
          setState({ ...INITIAL, phase: 'done', record: data, error: data.status === 'done' ? null : data.error });
          onSettled.current?.(data);
          return data;
        }
        let record: PerpActionRecord | null = null;
        await sendAll(quote.execution.txs, async (hash, step) => {
          ({ data: record } = await apiFetch<PerpActionRecord>('/api/perps/record', { json: { actionId: quote.id, txHash: hash, step } }));
        });
        setState({ ...INITIAL, phase: 'pending', record });
        return record;
      } catch (err) {
        unlockOrder(quote.id);
        setState((s) => ({ ...s, phase: 'idle', error: signError(err), step: null }));
        return null;
      }
    },
    [wagmiConfig, ensureWallet, sendAll],
  );

  /** Transactions with no action behind them (the testnet USDC faucet): send and wait. */
  const sendPlain = useCallback(
    async (address: string, txs: TxRequest[]): Promise<boolean> => {
      const key = `plain:${Date.now()}`;
      if (!lockOrder(key)) {
        setState((s) => ({ ...s, error: 'Something else is still being signed or confirmed.' }));
        return false;
      }
      setState({ ...INITIAL, phase: 'signing' });
      try {
        if (!(await ensureWallet(address))) {
          setState(INITIAL);
          return false;
        }
        let last: `0x${string}` | null = null;
        await sendAll(txs, async (hash) => {
          last = hash;
        });
        setState((s) => ({ ...s, phase: 'confirming' }));
        if (last) await waitForTransactionReceipt(wagmiConfig, { hash: last, timeout: 180_000 });
        setState(INITIAL);
        return true;
      } catch (err) {
        setState((s) => ({ ...s, phase: 'idle', error: signError(err), step: null }));
        return false;
      } finally {
        unlockOrder(key);
      }
    },
    [wagmiConfig, ensureWallet, sendAll],
  );

  const reset = useCallback(() => {
    if (current.current && state.phase !== 'pending') unlockOrder(current.current);
    setState(INITIAL);
  }, [state.phase]);

  return {
    ...state,
    lockedElsewhere: lock != null && lock !== current.current,
    busy: state.phase === 'signing' || state.phase === 'confirming' || state.phase === 'pending',
    /** On chain: the request landed and waits for the keeper to execute it. */
    awaitingExecution: state.phase === 'pending' && Boolean(state.record?.awaitingExecution),
    sign,
    sendPlain,
    reset,
  };
}

function signError(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  const message = err instanceof Error ? err.message : String(err);
  if (message === 'ADDRESS_CHANGED') return 'The connected wallet changed since this quote. Get a new quote.';
  const known = walletErrorText(err);
  if (known) return known;
  if (/timed? ?out/i.test(message.split('\n')[0] ?? '')) return 'The approval is taking long to confirm. Check the wallet, then get a fresh quote.';
  return `The wallet couldn’t send it (${walletErrorShort(err)}). Nothing was sent.`;
}
