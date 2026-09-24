import type { SessionInfo } from '@robinchan/shared';
import { getDb } from '@robinchan/store';
import { z } from 'zod';

import { clearedSessionCookie, issueSession, jwtSecret, sessionCookie } from '../../auth/session';
import { issueNonce, verifySignIn } from '../../auth/siwe';
import { ApiFailure, fresh } from '../envelope';
import type { ApiRouter } from '../router';

const verifyBody = z.object({
  message: z.string().min(20).max(2000),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/, 'signature must be hex').max(2000),
});

function assertConfigured(): void {
  if (!jwtSecret()) {
    throw new ApiFailure('NOT_CONFIGURED', 'Sign-in is not configured on the server (JWT_SECRET).', 503);
  }
}

/**
 * SIWE (brief §14): nonce → the wallet signs a message with it → verify →
 * a 24-hour session cookie. `session` tells the client who the server
 * thinks it's talking to, which it compares against the connected wallet.
 */
export function authRoutes(app: ApiRouter): void {
  app.get('/api/auth/nonce', async () => {
    assertConfigured();
    return fresh({ nonce: await issueNonce() });
  });

  app.post('/api/auth/verify', async (request, reply) => {
    assertConfigured();
    const parsed = verifyBody.safeParse(request.body);
    if (!parsed.success) throw new ApiFailure('BAD_REQUEST', parsed.error.issues[0]?.message ?? 'invalid body');

    const result = await verifySignIn(parsed.data.message, parsed.data.signature as `0x${string}`, request.headers);
    if (!result.ok) throw new ApiFailure('UNAUTHORIZED', result.reason, 401);

    const user = await getDb().upsertUser(result.address);
    const issued = issueSession({ userId: user.id, address: result.address, chainId: result.chainId });
    if (!issued) throw new ApiFailure('NOT_CONFIGURED', 'Sign-in is not configured on the server.', 503);
    reply.headers.append('set-cookie', sessionCookie(issued.token));
    const info: SessionInfo = {
      address: result.address,
      chainId: result.chainId,
      expiresAt: new Date(issued.session.exp * 1000).toISOString(),
    };
    return fresh(info);
  });

  app.get('/api/auth/session', async (request) => {
    const s = request.session;
    const info: SessionInfo | null = s
      ? { address: s.address, chainId: s.chainId, expiresAt: new Date(s.exp * 1000).toISOString() }
      : null;
    return fresh(info);
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    reply.headers.append('set-cookie', clearedSessionCookie());
    return fresh({ ok: true });
  });
}
