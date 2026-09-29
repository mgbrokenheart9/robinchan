'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { OrderQuote, OrderRecord } from '@robinchan/shared';
import { PENDING_SLOW_MS } from '@robinchan/shared';
import type { Hex } from 'viem';
import { useConfig as useWagmiConfig } from 'wagmi';
import {
  estimateFeesPerGas,
  getAccount,
  getTransaction,
  sendTransaction,
  signTypedData,
  switchChain,
  waitForTransactionReceipt,
} from 'wagmi/actions';

import { useSession } from '@/components/wallet/SessionProvider';

import { ApiClientError, apiFetch } from './api';
import { lockOrder, unlockOrder, useOrderLock } from './orderLock';
import { walletErrorShort, walletErrorText } from './walletError';

/**
 * Signing an order — the one client path for both the Trade form and an
 * order card in Robinchan's chat. What's signed is always the server's
 * quote, verbatim: its typed data, or its transactions. Nothing here builds
 * or adjusts a value.
 *
 * - Signature venues (paper): sign typed data → the server verifies and fills.
 * - Transaction venues: send each step (approve, then swap), record each
 *   hash, then follow the order on the server — which keeps watching even
 *   if this tab closes (Trade §4). Past two minutes pending, offer to speed
 *   up (same nonce, higher fee) or cancel (same nonce, empty transfer to self).
 */
export type SignPhase = 'idle' | 'signing' | 'confirming' | 'pending' | 'done';

export type SignerState = {
  phase: SignPhase;
  record: OrderRecord | null;
  error: string | null;
  /** Which transaction of a multi-step quote is being sent. */
  step: { index: number; total: number; label: string } | null;
  pendingSince: number | null;
};

const INITIAL: SignerState = { phase: 'idle', record: null, error: null, step: null, pendingSince: null };
const TERMINAL = new Set(['filled', 'failed', 'cancelled', 'expired', 'open']);
const POLL_MS = 3_000;

export function useOrderSigner(opts: { onSettled?: (record: OrderRecord) => void } = {}) {
  const wagmiConfig = useWagmiConfig();
  const session = useSession();
  const lock = useOrderLock();
  const [state, setState] = useState<SignerState>(INITIAL);
  const onSettled = useRef(opts.onSettled);
  const orderRef = useRef<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    onSettled.current = opts.onSettled;
  });

  // Follow a pending order on the server until it settles.
  useEffect(() => {
    if (state.phase !== 'pending' || !state.record) return;
    const id = state.record.id;
    let cancelled = false;
    const timer = setInterval(async () => {
      setNow(Date.now());
      try {
        const { data } = await apiFetch<OrderRecord>(`/api/orders/${id}`);
        if (cancelled) return;
        if (TERMINAL.has(data.status)) {
          setState((s) => ({ ...s, phase: 'done', record: data }));
          unlockOrder(id);
          onSettled.current?.(data);
        } else {
          setState((s) => ({ ...s, record: data }));
        }
      } catch {
        /* keep polling; the server keeps watching regardless */
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [state.phase, state.record]);

  const fail = useCallback((orderId: string | null, message: string) => {
    if (orderId) unlockOrder(orderId);
    setState((s) => ({ ...s, phase: 'idle', error: message, step: null }));
  }, []);

  const ensureWallet = useCallback(
    async (quote: OrderQuote): Promise<boolean> => {
      const account = getAccount(wagmiConfig);
      if (!account.isConnected || !account.address) {
        session.openPicker();
        return false;
      }
      // Quotes are bound to one address (Trade §4).
      if (account.address.toLowerCase() !== quote.address.toLowerCase()) {
        throw new Error('ADDRESS_CHANGED');
      }
      const chainId = session.chain?.id;
      if (chainId && account.chainId !== chainId) await switchChain(wagmiConfig, { chainId });
      return true;
    },
    [wagmiConfig, session],
  );

  const sign = useCallback(
    async (quote: OrderQuote): Promise<OrderRecord | null> => {
      if (!lockOrder(quote.id)) {
        setState((s) => ({ ...s, error: 'Another order is still in progress.' }));
        return null;
      }
      orderRef.current = quote.id;
      setState({ ...INITIAL, phase: 'signing' });
      try {
        if (!(await ensureWallet(quote))) {
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
          const { data } = await apiFetch<OrderRecord>('/api/order/record', {
            json: { orderId: quote.id, signature },
          });
          unlockOrder(quote.id);
          setState({ ...INITIAL, phase: 'done', record: data });
          onSettled.current?.(data);
          return data;
        }

        const { txs } = quote.execution;
        let record: OrderRecord | null = null;
        for (const [index, tx] of txs.entries()) {
          setState((s) => ({ ...s, phase: 'signing', step: { index, total: txs.length, label: tx.label } }));
          const hash = await sendTransaction(wagmiConfig, {
            to: tx.to,
            data: tx.data,
            value: BigInt(tx.value),
            chainId: tx.chainId,
          });
          ({ data: record } = await apiFetch<OrderRecord>('/api/order/record', {
            json: { orderId: quote.id, txHash: hash, step: index },
          }));
          if (index < txs.length - 1) {
            // An approval has to land before the swap can spend it.
            setState((s) => ({ ...s, phase: 'confirming' }));
            await waitForTransactionReceipt(wagmiConfig, { hash, timeout: 180_000 });
          }
        }
        setState({ ...INITIAL, phase: 'pending', record, pendingSince: Date.now() });
        return record;
      } catch (err) {
        fail(quote.id, signError(err));
        return null;
      }
    },
    [wagmiConfig, ensureWallet, fail],
  );

  /** Same nonce, same call, higher fee — the original is replaced if this one lands first. */
  const replace = useCallback(
    async (mode: 'speedup' | 'cancel') => {
      const record = state.record;
      if (!record?.txHash) return;
      try {
        const tx = await getTransaction(wagmiConfig, { hash: record.txHash as Hex });
        const fees = await estimateFeesPerGas(wagmiConfig).catch(() => null);
        const bump = (v: bigint | undefined | null) => ((v ?? 0n) * 13n) / 10n;
        const maxFeePerGas = [bump(tx.maxFeePerGas), fees?.maxFeePerGas ?? 0n].reduce((a, b) => (a > b ? a : b));
        const maxPriorityFeePerGas = [bump(tx.maxPriorityFeePerGas), fees?.maxPriorityFeePerGas ?? 0n].reduce((a, b) => (a > b ? a : b));
        const hash = await sendTransaction(wagmiConfig, {
          to: mode === 'cancel' ? tx.from : (tx.to as Hex),
          data: mode === 'cancel' ? '0x' : tx.input,
          value: mode === 'cancel' ? 0n : tx.value,
          nonce: tx.nonce,
          maxFeePerGas,
          maxPriorityFeePerGas,
        });
        // No step: a replacement always stands in for the final (swap) transaction.
        const { data } = await apiFetch<OrderRecord>('/api/order/record', {
          json: { orderId: record.id, txHash: hash },
        });
        setState((s) => ({ ...s, record: data, error: null, pendingSince: Date.now() }));
      } catch (err) {
        setState((s) => ({ ...s, error: signError(err) }));
      }
    },
    [state.record, wagmiConfig],
  );

  /** Resume following an order that was already pending when the page loaded. */
  const follow = useCallback((record: OrderRecord) => {
    if (record.status !== 'pending') return;
    lockOrder(record.id);
    orderRef.current = record.id;
    setState({ ...INITIAL, phase: 'pending', record, pendingSince: Date.parse(record.submittedAt ?? record.updatedAt) });
  }, []);

  const reset = useCallback(() => {
    if (orderRef.current && state.phase !== 'pending') unlockOrder(orderRef.current);
    setState(INITIAL);
  }, [state.phase]);

  const slow = state.phase === 'pending' && state.pendingSince != null && now - state.pendingSince > PENDING_SLOW_MS;

  return {
    ...state,
    /** Another order (elsewhere on the page) holds the lock. */
    lockedElsewhere: lock != null && lock !== orderRef.current,
    busy: state.phase === 'signing' || state.phase === 'confirming' || state.phase === 'pending',
    slow,
    sign,
    speedUp: () => replace('speedup'),
    cancelTx: () => replace('cancel'),
    follow,
    reset,
  };
}

function signError(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  const message = err instanceof Error ? err.message : String(err);
  if (message === 'ADDRESS_CHANGED') return 'The connected wallet changed since this quote. Get a new quote.';
  const known = walletErrorText(err);
  if (known) return known;
  if (/timed? ?out/i.test(message.split('\n')[0] ?? '')) return 'The approval is taking long to confirm. Check the wallet, then refresh the price.';
  return `The wallet couldn’t send it (${walletErrorShort(err)}). Nothing was sent.`;
}
