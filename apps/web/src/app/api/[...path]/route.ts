import { handleApiRequest } from '@/server/api/http';

/**
 * The backend that used to run as a separate Fastify server now answers
 * here, inside Next.js. One catch-all handler keeps the old server's shape:
 * a single router for every `/api/*` endpoint, a JSON 404 for anything
 * unknown, and the same headers on every response.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handleApiRequest;
export const HEAD = handleApiRequest;
export const POST = handleApiRequest;
export const PUT = handleApiRequest;
export const PATCH = handleApiRequest;
export const DELETE = handleApiRequest;
export const OPTIONS = handleApiRequest;
