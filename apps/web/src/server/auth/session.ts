import 'server-only';

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Address } from '@robinchan/shared';
import { isDev } from '@robinchan/core';
import { dataDir } from '@robinchan/store';

/**
 * Sessions: a short-lived HS256 JWT in an httpOnly cookie, issued only after
 * a Sign-In with Ethereum signature checks out (brief §14). The wallet
 * address alone is never an identity — it's public.
 */
export const SESSION_COOKIE = 'rc_session';
export const SESSION_TTL_SEC = 24 * 60 * 60;

export type Session = {
  userId: string;
  address: Address;
  chainId: number;
  /** UNIX seconds. */
  exp: number;
};

let devSecret: string | null = null;

/**
 * `JWT_SECRET` from the environment. In `RC_ENV=dev` with none set, a random
 * one is generated once and kept in `.data/`, so sessions survive a dev
 * server restart. Anywhere else, no secret means no sessions at all.
 */
export function jwtSecret(): string | null {
  const configured = process.env.JWT_SECRET?.trim();
  if (configured) return configured.length >= 32 ? configured : null;
  if (!isDev()) return null;
  if (devSecret) return devSecret;
  const file = join(dataDir(), 'jwt-secret');
  try {
    if (existsSync(file)) devSecret = readFileSync(file, 'utf8').trim();
  } catch {
    /* regenerate below */
  }
  if (!devSecret || devSecret.length < 32) {
    devSecret = randomBytes(32).toString('hex');
    try {
      mkdirSync(dataDir(), { recursive: true });
      writeFileSync(file, devSecret);
    } catch {
      /* in-memory for this process only */
    }
  }
  return devSecret;
}

const b64url = (buf: Buffer | string) =>
  Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function sign(data: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(data).digest());
}

export function issueSession(s: Omit<Session, 'exp'>): { token: string; session: Session } | null {
  const secret = jwtSecret();
  if (!secret) return null;
  const now = Math.floor(Date.now() / 1000);
  const session: Session = { ...s, exp: now + SESSION_TTL_SEC };
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({ sub: s.userId, addr: s.address, cid: s.chainId, iat: now, exp: session.exp }),
  );
  return { token: `${header}.${payload}.${sign(`${header}.${payload}`, secret)}`, session };
}

export function verifySession(token: string | undefined | null): Session | null {
  if (!token) return null;
  const secret = jwtSecret();
  if (!secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  const expected = Buffer.from(sign(`${header}.${payload}`, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const head = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { alg?: string };
    if (head.alg !== 'HS256') return null;
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub?: string;
      addr?: string;
      cid?: number;
      exp?: number;
    };
    if (!body.sub || !body.addr || typeof body.exp !== 'number') return null;
    if (body.exp <= Math.floor(Date.now() / 1000)) return null;
    if (!/^0x[0-9a-fA-F]{40}$/.test(body.addr)) return null;
    return { userId: body.sub, address: body.addr as Address, chainId: Number(body.cid ?? 0), exp: body.exp };
  } catch {
    return null;
  }
}

export function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function sessionFromCookieHeader(cookieHeader: string | null | undefined): Session | null {
  return verifySession(readCookie(cookieHeader, SESSION_COOKIE));
}

function secureCookies(): boolean {
  return process.env.NODE_ENV === 'production' || (process.env.NEXT_PUBLIC_SITE_URL ?? '').startsWith('https:');
}

export function sessionCookie(token: string): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SEC}`,
    ...(secureCookies() ? ['Secure'] : []),
  ].join('; ');
}

export function clearedSessionCookie(): string {
  return [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0', ...(secureCookies() ? ['Secure'] : [])].join('; ');
}
