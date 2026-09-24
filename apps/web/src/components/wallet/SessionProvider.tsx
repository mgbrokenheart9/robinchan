'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { ChainConfig, SessionInfo, TierState } from '@robinchan/shared';
import { createSiweMessage } from 'viem/siwe';
import { useAccount, useDisconnect, useSignMessage, useSwitchChain } from 'wagmi';

import { ApiClientError, apiFetch } from '@/lib/api';

/**
 * Who the app is talking to. Three things have to agree before anything
 * account-specific shows:
 *
 * 1. a wallet is connected (wagmi),
 * 2. the server holds a SIWE session (the httpOnly cookie), and
 * 3. both are the same address.
 *
 * If the user switches accounts in their wallet mid-session, (3) breaks:
 * the page falls back to the signed-out view and offers to sign in as the
 * new address, and anything bound to the old one (a quote) is dropped
 * (Trade §4). Tier always comes from the server, which reads the chain.
 */
export type SessionState = {
  chain: ChainConfig | null;
  /** Server session, once known. `undefined` while loading. */
  session: SessionInfo | null | undefined;
  tier: TierState | null;
  /** The connected wallet address, if any. */
  address: `0x${string}` | undefined;
  /** Session and wallet agree — safe to show this user's data. */
  signedIn: boolean;
  /** Still working out the above; render skeletons, not the gate. */
  resolving: boolean;
  wrongChain: boolean;
  /** Connected wallet differs from the signed-in one. */
  mismatch: boolean;
  signingIn: boolean;
  error: string | null;
  signIn: () => Promise<boolean>;
  signOut: () => Promise<void>;
  switchChain: () => Promise<void>;
  refreshTier: () => void;
  pickerOpen: boolean;
  openPicker: () => void;
  closePicker: () => void;
  /** The user chose a wallet in the picker: sign in as soon as it connects. */
  markConnectIntent: () => void;
};

const SessionContext = createContext<SessionState | null>(null);

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}

/** For components that also render outside the providers (they just see no session). */
export function useOptionalSession(): SessionState | null {
  return useContext(SessionContext);
}

const STATEMENT =
  'Sign in to Robinchan. This proves you own this wallet; it sends no transaction and costs no gas.';

export function SessionProvider({ chain, children }: { chain: ChainConfig | null; children: ReactNode }) {
  const { address, chainId, isConnected, status: walletStatus } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync } = useSwitchChain();
  const { disconnectAsync } = useDisconnect();

  const [session, setSession] = useState<SessionInfo | null | undefined>(undefined);
  // Keyed by address, so a tier fetched for one wallet never shows for another.
  const [tierFor, setTierFor] = useState<{ address: string; tier: TierState | null } | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [tierTick, setTierTick] = useState(0);
  const autoSignFor = useRef<string | null>(null);
  /** Set by the wallet picker the moment the user chooses a wallet. */
  const connectIntent = useRef(false);

  // Server session, once on mount.
  useEffect(() => {
    let cancelled = false;
    apiFetch<SessionInfo | null>('/api/auth/session')
      .then((env) => !cancelled && setSession(env.data))
      .catch(() => !cancelled && setSession(null));
    return () => {
      cancelled = true;
    };
  }, []);

  const mismatch = Boolean(
    session && address && session.address.toLowerCase() !== address.toLowerCase(),
  );
  // A disconnected wallet with a valid cookie still counts: reading your own
  // portfolio needs proof of ownership, not a live connection. Signing will
  // ask the wallet to reconnect.
  const signedIn = Boolean(session) && !mismatch && walletStatus !== 'reconnecting' && walletStatus !== 'connecting';
  const wrongChain = Boolean(chain && isConnected && chainId !== chain.id);

  // Tier, from the server, whenever the signed-in address changes.
  const sessionAddress = signedIn && session ? session.address.toLowerCase() : null;
  useEffect(() => {
    if (!sessionAddress) return;
    let cancelled = false;
    apiFetch<TierState>('/api/user/tier')
      .then((env) => !cancelled && setTierFor({ address: sessionAddress, tier: env.data }))
      .catch(() => !cancelled && setTierFor({ address: sessionAddress, tier: null }));
    return () => {
      cancelled = true;
    };
  }, [sessionAddress, tierTick]);
  const tier = sessionAddress && tierFor?.address === sessionAddress ? tierFor.tier : null;

  const signIn = useCallback(async (): Promise<boolean> => {
    if (!address || !chain) return false;
    setError(null);
    setSigningIn(true);
    try {
      if (chainId !== chain.id) await switchChainAsync({ chainId: chain.id });
      const { data } = await apiFetch<{ nonce: string }>('/api/auth/nonce');
      const message = createSiweMessage({
        address,
        chainId: chain.id,
        domain: window.location.host,
        uri: window.location.origin,
        nonce: data.nonce,
        version: '1',
        statement: STATEMENT,
        issuedAt: new Date(),
        expirationTime: new Date(Date.now() + 10 * 60_000),
      });
      const signature = await signMessageAsync({ message });
      const verified = await apiFetch<SessionInfo>('/api/auth/verify', { json: { message, signature } });
      setSession(verified.data);
      return true;
    } catch (err) {
      setError(signInError(err));
      return false;
    } finally {
      setSigningIn(false);
    }
  }, [address, chain, chainId, signMessageAsync, switchChainAsync]);

  // Connecting a wallet goes straight on to signing in — one flow for the
  // user, not two buttons. But only when the user just pressed connect in
  // this page: a wallet that reconnects on its own (it authorized this site
  // before) or an account switched inside the wallet must never pop up a
  // signature request by itself — those get a "Sign in" button instead.
  useEffect(() => {
    if (!connectIntent.current || session === undefined || !isConnected || !address || signingIn) return;
    const key = address.toLowerCase();
    if (session && session.address.toLowerCase() === key) {
      connectIntent.current = false;
      return;
    }
    if (autoSignFor.current === key || wrongChain) return;
    autoSignFor.current = key;
    connectIntent.current = false;
    void signIn();
  }, [session, isConnected, address, signingIn, wrongChain, signIn]);

  const signOut = useCallback(async () => {
    await apiFetch('/api/auth/logout', { json: {} }).catch(() => undefined);
    setSession(null);
    setTierFor(null);
    autoSignFor.current = null;
    await disconnectAsync().catch(() => undefined);
  }, [disconnectAsync]);

  const switchChain = useCallback(async () => {
    if (!chain) return;
    setError(null);
    try {
      await switchChainAsync({ chainId: chain.id });
    } catch (err) {
      setError(signInError(err));
    }
  }, [chain, switchChainAsync]);

  const value = useMemo<SessionState>(
    () => ({
      chain,
      session,
      tier,
      address,
      signedIn,
      resolving: session === undefined || walletStatus === 'reconnecting' || walletStatus === 'connecting',
      wrongChain,
      mismatch,
      signingIn,
      error,
      signIn,
      signOut,
      switchChain,
      refreshTier: () => setTierTick((t) => t + 1),
      pickerOpen,
      openPicker: () => setPickerOpen(true),
      closePicker: () => setPickerOpen(false),
      markConnectIntent: () => {
        connectIntent.current = true;
      },
    }),
    [chain, session, tier, address, signedIn, walletStatus, wrongChain, mismatch, signingIn, error, signIn, signOut, switchChain, pickerOpen],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

function signInError(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  const message = err instanceof Error ? err.message : String(err);
  if (/rejected|denied|cancel/i.test(message)) return 'Signature request was declined in the wallet.';
  if (/chain/i.test(message)) return 'Switch the wallet to the right network and try again.';
  return 'Sign-in failed. Try again.';
}
