'use client';

import type { OrderQuote } from '@robinchan/shared';

import { apiFetch } from './api';
import { CHAT_MAX_HISTORY, type ChatHistoryItem } from './chat';

/**
 * The one conversation with Robinchan (Trade-Heat-Portfolio §2: "Satu chat,
 * satu riwayat"). The floating companion on every dashboard page and the
 * full-screen `/robinchan` stage both read and write this store, so a
 * question asked on Heat is still there on Trade.
 *
 * Signed in, the thread is loaded from the server, which also records every
 * new turn. Signed out, it lives in sessionStorage for this tab.
 */
export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** An order preview built from this turn, rendered under the reply. */
  order?: OrderQuote | null;
  /** Robinchan telling the user about something that happened while they were away. */
  notice?: boolean;
};

type State = {
  owner: string | null;
  messages: ChatMessage[];
  loading: boolean;
};

const STORAGE_KEY = 'robinchan.chat';
const MAX_KEPT = 60;

let state: State = { owner: null, messages: [], loading: false };
const listeners = new Set<() => void>();

function emit(next: State): void {
  state = next;
  for (const l of listeners) l();
}

export function subscribeChat(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function chatSnapshot(): State {
  return state;
}

const EMPTY: State = { owner: null, messages: [], loading: false };
export function chatServerSnapshot(): State {
  return EMPTY;
}

let seq = 0;
export const newMessageId = () => `m${Date.now().toString(36)}${(seq += 1)}`;

function persistAnon(messages: ChatMessage[]): void {
  try {
    // Order previews expire in 30 seconds; don't carry them across reloads.
    const plain = messages.slice(-MAX_KEPT).map((m) => ({ id: m.id, role: m.role, text: m.text, notice: m.notice }));
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(plain));
  } catch {
    /* storage blocked — the thread just won't survive a reload */
  }
}

/**
 * Point the store at whoever is using the app now: an address once signed
 * in, or `null` for the anonymous tab thread. Switching wallets loads that
 * wallet's thread — never shows one account's conversation to another.
 */
export async function setChatOwner(owner: string | null): Promise<void> {
  if (state.owner === owner && (state.messages.length > 0 || state.loading)) return;
  if (!owner) {
    let messages: ChatMessage[] = [];
    try {
      messages = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]') as ChatMessage[];
    } catch {
      messages = [];
    }
    emit({ owner: null, messages, loading: false });
    return;
  }
  emit({ owner, messages: [], loading: true });
  try {
    const { data } = await apiFetch<ChatHistoryItem[]>('/api/chat/history');
    if (state.owner !== owner) return;
    emit({
      owner,
      messages: data.map((m) => ({ id: newMessageId(), role: m.role, text: m.text })),
      loading: false,
    });
  } catch {
    if (state.owner === owner) emit({ ...state, loading: false });
  }
}

export function appendChat(...messages: ChatMessage[]): void {
  const next = [...state.messages, ...messages].slice(-MAX_KEPT);
  emit({ ...state, messages: next });
  if (!state.owner) persistAnon(next);
}

/** A fresh quote for an order card whose 30 seconds ran out. */
export function replaceOrder(messageId: string, order: OrderQuote): void {
  emit({ ...state, messages: state.messages.map((m) => (m.id === messageId ? { ...m, order } : m)) });
}

/** Recent turns for the request body — only used by the server when signed out. */
export function chatHistoryForRequest(): ChatHistoryItem[] {
  return state.messages
    .filter((m) => !m.notice)
    .map((m) => ({ role: m.role, text: m.text }))
    .slice(-CHAT_MAX_HISTORY);
}
