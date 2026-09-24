import 'server-only';

import type { Address } from '@robinchan/shared';
import { chainConfig, publicClient } from '@robinchan/core';
import { cacheKey, getCache } from '@robinchan/store';
import { verifyMessage } from 'viem';
import { generateSiweNonce, parseSiweMessage, validateSiweMessage, verifySiweMessage } from 'viem/siwe';

/**
 * Sign-In with Ethereum (EIP-4361). The user signs a message carrying a
 * one-time nonce from us; the server checks the message's domain, chain,
 * nonce and time window, then the signature — and only then issues a
 * session. No transaction, no gas.
 */
const NONCE_TTL_SEC = 10 * 60;
const MAX_AGE_MS = 10 * 60_000;

const nonceKey = (nonce: string) => cacheKey('siwe', nonce);

export async function issueNonce(): Promise<string> {
  const nonce = generateSiweNonce();
  await getCache().set(nonceKey(nonce), { issuedAt: Date.now() }, NONCE_TTL_SEC);
  return nonce;
}

export type SiweResult =
  | { ok: true; address: Address; chainId: number }
  | { ok: false; reason: string };

/** Hosts a sign-in message may name: this request's host, and the configured site URL. */
function allowedDomains(headers: Headers): Set<string> {
  const out = new Set<string>();
  const forwarded = headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const host = headers.get('host')?.trim();
  if (forwarded) out.add(forwarded);
  if (host) out.add(host);
  try {
    const site = process.env.NEXT_PUBLIC_SITE_URL;
    if (site) out.add(new URL(site).host);
  } catch {
    /* ignore a malformed site URL */
  }
  return out;
}

export async function verifySignIn(message: string, signature: `0x${string}`, headers: Headers): Promise<SiweResult> {
  let fields: ReturnType<typeof parseSiweMessage>;
  try {
    fields = parseSiweMessage(message);
  } catch {
    return { ok: false, reason: 'The sign-in message is malformed.' };
  }
  const { address, chainId, domain, nonce, issuedAt } = fields;
  if (!address || !domain || !nonce || !chainId) return { ok: false, reason: 'The sign-in message is incomplete.' };

  if (!allowedDomains(headers).has(domain)) {
    return { ok: false, reason: `This sign-in message was made for ${domain}, not this site.` };
  }
  const chain = chainConfig();
  if (chain && chainId !== chain.id) {
    return { ok: false, reason: `Switch your wallet to ${chain.name} and sign in again.` };
  }
  if (!issuedAt || Math.abs(Date.now() - issuedAt.getTime()) > MAX_AGE_MS) {
    return { ok: false, reason: 'The sign-in message is too old. Try again.' };
  }
  if (!validateSiweMessage({ message: fields, domain, nonce })) {
    return { ok: false, reason: 'The sign-in message has expired or is not valid yet.' };
  }

  // One-time: taken now, whether or not the signature turns out valid.
  const issued = await getCache().take<{ issuedAt: number }>(nonceKey(nonce));
  if (!issued) return { ok: false, reason: 'That sign-in request expired or was already used. Try again.' };

  let valid = false;
  try {
    valid = await verifyMessage({ address, message, signature });
  } catch {
    valid = false;
  }
  // Contract wallets sign through ERC-1271 / ERC-6492, which needs the chain.
  const client = publicClient();
  if (!valid && client) {
    try {
      valid = await verifySiweMessage(client, { message, signature, domain, nonce });
    } catch {
      valid = false;
    }
  }
  if (!valid) return { ok: false, reason: "The signature doesn't match the wallet address." };
  return { ok: true, address, chainId };
}
