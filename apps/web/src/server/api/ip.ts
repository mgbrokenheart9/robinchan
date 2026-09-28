/**
 * The rate-limit key. Vercel overwrites `x-forwarded-for` with the real
 * client address, and a reverse proxy appends the address it saw — so the
 * right-most entry is the one a client can't forge by sending its own
 * header. (Next's own server only fills it from the socket when it's absent.)
 */
export function clientIpFrom(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  const nearest = forwarded?.split(',').at(-1)?.trim();
  return nearest || headers.get('x-real-ip') || 'unknown';
}
