import type { Address } from '@robinchan/shared';
import { RCHAN_TOKEN } from '@robinchan/shared';

/**
 * Token contracts on the chain. None of these addresses exist yet (open
 * decisions #2 and #4 in the main brief), so the registry is configuration:
 *
 *   RC_TOKENS={"AAPL":{"address":"0x…","decimals":18}, …}
 *   RC_QUOTE_TOKEN={"symbol":"USDC","address":"0x…","decimals":6}
 *   NEXT_PUBLIC_RCHAN_ADDRESS=0x…   (+ RCHAN_DECIMALS, default 18)
 *
 * Anything malformed is dropped with a warning instead of throwing, so one
 * bad entry doesn't take the whole portfolio page down.
 */
export type TokenInfo = {
  symbol: string;
  address: Address;
  decimals: number;
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function parseToken(symbol: string, raw: unknown): TokenInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const address = String(r.address ?? '');
  const decimals = Number(r.decimals ?? 18);
  if (!ADDRESS.test(address) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    return null;
  }
  return { symbol: symbol.toUpperCase(), address: address as Address, decimals };
}

let warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[tokens] ${message}`);
}

export function tokenRegistry(): Map<string, TokenInfo> {
  const out = new Map<string, TokenInfo>();
  const raw = process.env.RC_TOKENS?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [symbol, value] of Object.entries(parsed)) {
        const token = parseToken(symbol, value);
        if (token) out.set(token.symbol, token);
        else warnOnce(`tok:${symbol}`, `RC_TOKENS entry for ${symbol} is malformed; ignored`);
      }
    } catch {
      warnOnce('tok:json', 'RC_TOKENS is not valid JSON; no token contracts configured');
    }
  }
  const rchan = rchanToken();
  if (rchan) out.set('RCHAN', rchan);
  return out;
}

export function rchanToken(): TokenInfo | null {
  const address = process.env.NEXT_PUBLIC_RCHAN_ADDRESS?.trim() || RCHAN_TOKEN.address;
  if (!ADDRESS.test(address)) return null;
  const decimals = Number(process.env.RCHAN_DECIMALS ?? RCHAN_TOKEN.decimals);
  return { symbol: 'RCHAN', address: address as Address, decimals: Number.isInteger(decimals) ? decimals : 18 };
}

/** The stablecoin orders are priced and settled in. */
export function quoteToken(): TokenInfo | null {
  const raw = process.env.RC_QUOTE_TOKEN?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parseToken(String(parsed.symbol ?? 'USDC'), parsed);
  } catch {
    warnOnce('quote:json', 'RC_QUOTE_TOKEN is not valid JSON; ignored');
    return null;
  }
}

/** Test hook — the warnings are per-process otherwise. */
export function resetTokenWarnings(): void {
  warned = new Set();
}
