import type { SourceState, SourceStatus } from '@robinchan/shared';
import { SOURCE_SLOTS } from '@robinchan/shared';
import { cacheKey, getCache } from '@robinchan/store';

import { envelope } from '../envelope';
import type { ApiRouter } from '../router';

type StoredHealth = {
  state: SourceState;
  lastOkAt: string | null;
  note: string;
};

const OK_WINDOW_MS = 5 * 60_000;

/**
 * Green if the provider responded within the last 5 minutes, gray if it
 * isn't configured, red if it failed (brief §6). This card also doubles as
 * the diagnostic panel when a feed goes down.
 */
export function sourcesRoutes(app: ApiRouter): void {
  app.get('/api/sources/status', async () => {
    const cache = getCache();

    const statuses: SourceStatus[] = await Promise.all(
      SOURCE_SLOTS.map(async (slot) => {
        const health = await cache.get<StoredHealth>(cacheKey('source', slot.id));
        if (!health) {
          return {
            ...slot,
            state: 'idle' as const,
            lastOkAt: null,
            note: 'not configured',
          };
        }

        const fresh =
          health.lastOkAt != null && Date.now() - Date.parse(health.lastOkAt) < OK_WINDOW_MS;

        let state: SourceState = health.state;
        // Was green but it's been over five minutes with no fresh response:
        // downgrade to red, don't let stale status look healthy.
        if (health.state === 'ok' && !fresh) state = 'down';

        return {
          ...slot,
          state,
          lastOkAt: health.lastOkAt,
          note: state === 'down' && health.state === 'ok' ? 'no fresh response' : health.note,
        };
      }),
    );

    return envelope(statuses, { stale: false });
  });
}
