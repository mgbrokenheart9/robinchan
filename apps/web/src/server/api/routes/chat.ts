import { getDb } from '@robinchan/store';

import { CHAT_MAX_HISTORY, type ChatHistoryItem } from '@/lib/chat';

import { fresh } from '../envelope';
import type { ApiRouter } from '../router';

/**
 * One chat, one history (Trade-Heat-Portfolio §2): the floating companion
 * on every page and the full-screen `/robinchan` read the same thread. For
 * a signed-in wallet it lives on the server, so it's the same on every
 * device (brief §5). `POST /api/chat` itself is its own route handler.
 */
export function chatRoutes(app: ApiRouter): void {
  app.get(
    '/api/chat/history',
    async (request) => {
      const rows = await getDb().listChat(request.session!.userId, CHAT_MAX_HISTORY * 2);
      const items: ChatHistoryItem[] = rows.map((r) => ({ role: r.role, text: r.content }));
      return fresh(items);
    },
    { auth: 'wallet' },
  );
}
