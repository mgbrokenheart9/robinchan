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
import { usePathname } from 'next/navigation';
import type { CompanionNotice, PageContext } from '@robinchan/shared';

import { useSession } from '@/components/wallet/SessionProvider';
import { apiFetch } from '@/lib/api';
import { appendChat, newMessageId, setChatOwner } from '@/lib/chatStore';

/**
 * Robinchan's presence on every dashboard page (Trade-Heat-Portfolio §2).
 * Pages tell her where the user is (`usePageContext`) — the page and the
 * symbol or row in view — and that goes with each chat message as
 * metadata; the server looks up the rest. She can also say one short line
 * unprompted (`hint`), and on return she mentions orders that settled
 * while the user was away.
 */
type Hint = { id: number; text: string };

type CompanionState = {
  context: PageContext;
  setContext: (ctx: PageContext) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Seed text for the composer, e.g. "Ask Robinchan" on a heat row. */
  draft: string | null;
  /** Bumped on every `ask`, so an open panel picks up the new draft. */
  draftSeq: number;
  ask: (draft: string, ctx?: PageContext) => void;
  hint: Hint | null;
  say: (text: string) => void;
  dismissHint: () => void;
  unread: number;
};

const CompanionContext = createContext<CompanionState | null>(null);

export function useCompanion(): CompanionState {
  const ctx = useContext(CompanionContext);
  if (!ctx) throw new Error('useCompanion must be used inside <CompanionProvider>');
  return ctx;
}

/** Declare what this page is showing. */
export function usePageContext(ctx: PageContext): void {
  const { setContext } = useCompanion();
  const { page, symbol } = ctx;
  useEffect(() => {
    setContext({ page, symbol: symbol ?? null });
  }, [page, symbol, setContext]);
}

const HINT_MS = 9_000;

function pageFromPath(pathname: string | null): PageContext['page'] {
  if (!pathname || pathname === '/') return 'home';
  const first = pathname.split('/')[1];
  return first === 'heat' || first === 'portfolio' || first === 'trade' || first === 'market' || first === 'robinchan'
    ? first
    : 'home';
}

export function CompanionProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const page = pageFromPath(usePathname());
  const [declared, setDeclared] = useState<PageContext>({ page, symbol: null });
  const [open, setOpenState] = useState(false);
  const [draft, setDraft] = useState<{ text: string; seq: number } | null>(null);
  const [hint, setHint] = useState<Hint | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hintSeq = useRef(0);

  // What a page declared only counts on that page; anywhere else she just
  // knows which page it is.
  const context = useMemo<PageContext>(
    () => (declared.page === page ? declared : { page, symbol: null }),
    [declared, page],
  );

  const setContext = useCallback((ctx: PageContext) => {
    setDeclared((cur) => (cur.page === ctx.page && cur.symbol === ctx.symbol ? cur : ctx));
  }, []);

  const say = useCallback((text: string) => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintSeq.current += 1;
    setHint({ id: hintSeq.current, text });
    hintTimer.current = setTimeout(() => setHint(null), HINT_MS);
  }, []);

  const dismissHint = useCallback(() => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
    setHint(null);
  }, []);

  useEffect(
    () => () => {
      if (hintTimer.current) clearTimeout(hintTimer.current);
    },
    [],
  );

  // One thread per wallet; the anonymous tab thread otherwise.
  const owner = session.signedIn && session.session ? session.session.address.toLowerCase() : null;
  useEffect(() => {
    if (session.resolving) return;
    void setChatOwner(owner);
  }, [owner, session.resolving]);

  // Orders that settled while the user was away (Trade §4), kept per owner
  // so another wallet's news never shows.
  const [noticesFor, setNoticesFor] = useState<{ owner: string; list: CompanionNotice[] } | null>(null);
  const notices = useMemo(
    () => (owner && noticesFor?.owner === owner ? noticesFor.list : []),
    [owner, noticesFor],
  );
  useEffect(() => {
    if (!owner) return;
    let cancelled = false;
    const load = () =>
      apiFetch<CompanionNotice[]>('/api/user/notifications')
        .then(({ data }) => {
          if (cancelled || data.length === 0) return;
          setNoticesFor({ owner, list: data });
          say(data.length === 1 ? (data[0] as CompanionNotice).text : `${data.length} of your orders settled while you were away.`);
        })
        .catch(() => undefined);
    void load();
    const onFocus = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [owner, say]);

  // Opening the chat delivers them as her messages, and marks them told.
  const setOpen = useCallback(
    (next: boolean) => {
      if (next && notices.length) {
        appendChat(...notices.map((n) => ({ id: newMessageId(), role: 'assistant' as const, text: n.text, notice: true })));
        void apiFetch('/api/user/notifications/ack', { json: { ids: notices.map((n) => n.id) } }).catch(() => undefined);
        setNoticesFor(null);
        dismissHint();
      }
      setOpenState(next);
    },
    [notices, dismissHint],
  );

  const ask = useCallback(
    (text: string, ctx?: PageContext) => {
      if (ctx) setContext(ctx);
      setDraft((cur) => ({ text, seq: (cur?.seq ?? 0) + 1 }));
      setOpen(true);
    },
    [setContext, setOpen],
  );

  const value = useMemo<CompanionState>(
    () => ({
      context,
      setContext,
      open,
      setOpen,
      draft: draft?.text ?? null,
      draftSeq: draft?.seq ?? 0,
      ask,
      hint,
      say,
      dismissHint,
      unread: notices.length,
    }),
    [context, setContext, open, setOpen, draft, ask, hint, say, dismissHint, notices.length],
  );

  return <CompanionContext.Provider value={value}>{children}</CompanionContext.Provider>;
}
