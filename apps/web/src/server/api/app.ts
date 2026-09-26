import 'server-only';

import { getPgPool } from '@robinchan/store';
import { attachDatabasePool } from '@vercel/functions';

import { ApiRouter } from './router';
import { authRoutes } from './routes/auth';
import { calendarRoutes } from './routes/calendar';
import { chatRoutes } from './routes/chat';
import { healthRoutes } from './routes/health';
import { heatRoutes } from './routes/heat';
import { marketRoutes } from './routes/market';
import { mediaRoutes } from './routes/media';
import { newsRoutes } from './routes/news';
import { orderRoutes } from './routes/orders';
import { perpsRoutes } from './routes/perps';
import { portfolioRoutes } from './routes/portfolio';
import { sourcesRoutes } from './routes/sources';
import { userRoutes } from './routes/user';

/**
 * Every `/api/*` endpoint (brief §9, plus the Trade/Heat/Portfolio brief
 * §9). The market-data routes only ever read from the store the worker
 * writes to — they never call a provider on an incoming request (brief §8).
 * The wallet routes read the chain (balances, tiers) and, for orders, build
 * payloads the user signs; the server itself never signs.
 */
export const api = new ApiRouter();

// On Vercel (Fluid compute), keep a function instance alive just long enough
// for idle Postgres connections to close before it suspends, instead of
// leaking them. Returns early anywhere else — local dev, builds, the worker.
const pool = getPgPool();
if (pool) attachDatabasePool(pool);

marketRoutes(api);
newsRoutes(api);
mediaRoutes(api);
calendarRoutes(api);
heatRoutes(api);
sourcesRoutes(api);
healthRoutes(api);
authRoutes(api);
userRoutes(api);
portfolioRoutes(api);
orderRoutes(api);
perpsRoutes(api);
chatRoutes(api);
