# Robinchan

A Live2D character companion market for tokenized stocks on Robinhood Chain.


This implementation covers **M1 (static landing page)** and **M2 (live data)** from
`robinchan-dev-brief.md` §17, plus the three pages of the Trade / Heat / Portfolio brief —
**Heat**, **Portfolio** and **Trade** — with what they need from M3 and M4: wallet connect,
Sign-In with Ethereum, tiers read on the server, and the order pipeline shared by the Trade page
and Robinchan's chat. Trade sits behind `FEATURE_TRADING`, off by default. See
[Heat, Portfolio, Trade](#heat-portfolio-trade) and [Scope boundaries](#scope-boundaries).

---

## Running it

Needs Node 20.9+.

```bash
npm install
cp .env.example .env        # everything can be left empty
npm run dev
```

Two processes run together: the Next.js app at `http://localhost:3000` — pages **and** the
`/api/*` endpoints — and the worker in the background. The Market page starts filling in within
the first ten seconds.

To populate data once without leaving the worker running continuously:

```bash
npm run once -w @robinchan/worker
```

Other commands: `npm run build`, `npm run typecheck`, `npm run lint`, and:

| Command | What it checks |
| --- | --- |
| `npm test -w @robinchan/core` | Cost basis, the advice guard, the order pipeline (paper venue, real signatures), heat gating, portfolio valuation, and the transaction lifecycle against a scripted chain — no network, no database |
| `npm test -w @robinchan/store` | The Postgres implementation on PGlite (Postgres in WASM): the schema upgrading an existing database, and every query the new pages use |
| `npm run eval:parse -w @robinchan/core` | Order parsing against the real model: 30 sentences, ≥28 correct or asked back, 0 silent misparses (main brief M4). Needs `MEGALLM_API_KEY` |
| `npx tsx scripts/e2e.mts` | Everything over HTTP with real SIWE sign-ins — see the header of the script for the server flags it expects |
| `npm run reads -w @robinchan/worker` | Prints Robinchan's stored heat reads for review before `FEATURE_HEAT_READS` goes on |

**To try Trade locally**, set `FEATURE_TRADING=true` in `.env` (and `RC_DEV_TIER=tier3` to open
limit orders) and restart `npm run dev`. The dev venue is `paper`: orders are really signed in
the wallet, then filled against the live price without moving anything on chain.

### Database: Vercel Postgres (Neon)

Everything the app stores lives in one Postgres database — news, heat scores and the calendar,
plus the cache (prices, feeds, provider status) and the per-IP rate-limit counters that used to
need Redis.

1. In the Vercel project: **Storage → Create Database → Neon**, connected to the web app. Vercel
   injects `DATABASE_URL` (also exposed as `POSTGRES_URL`) automatically.
2. Put the same pooled `DATABASE_URL` in the worker's environment (Railway), and in the root `.env`
   for local development against it.

The schema (`packages/store/src/schema.ts`) is applied automatically on the first query from the
web app or the worker; there's no migration step to run.

With `DATABASE_URL` empty, local development falls back to JSON files in `.data/`. This isn't
in-memory storage: the web app and the worker are two separate processes and need to keep seeing
each other's data. The fallback doesn't work on Vercel, where the filesystem is read-only.

### Without provider API keys

A provider without a key yet shows **gray ("not configured")** on the "Sources monitored" card,
not red — not being configured isn't a failure. In `RC_ENV=dev`, a provider that fails or isn't
configured is replaced with fake data that flags itself via the `source` field.

Keys that make the data real:

| Variable | Enables |
| --- | --- |
| `FINNHUB_API_KEY` | Prices, indices, news feed, earnings calendar |
| `SEC_EDGAR_USER_AGENT` | SEC filings (must include a reachable contact) |
| `YOUTUBE_API_KEY` | Active stream id per channel and Highlights clips |
| `NEXT_PUBLIC_RCHAN_ADDRESS` | $RCHAN price from DexScreener |

Without `YOUTUBE_API_KEY`, `videoId` is deliberately left empty so the frontend falls back to a
static poster + "Open on YouTube" button — a fallback path brief §6 actually requires, not a fake
id that would fail to load silently.

---

## Structure

```
apps/
  web/          Next.js 16 App Router — Home, Robinchan, Market, Heat, Portfolio, Trade,
                and the API (src/app/api/[...path] → src/server/api)
  worker/       Cron — pulls from providers, writes to the database
packages/
  shared/       Types, constants, format utils (used by all)
  store/        Postgres (cache + tables) behind one interface, with the .data/ fallback
  core/         Server-side domain logic shared by web and worker: chain reads (viem),
                tiers, holdings, cost basis, portfolio valuation, the order pipeline and
                its venues, heat gating, and Robinchan's generated reads
```

The API is served by Next.js route handlers. It keeps the contract of the Fastify server it
replaced — same endpoints, Zod validation, `{ data, stale, asOf }` envelope, error codes, CORS,
security headers, and the 60-requests-per-minute-per-IP limit. Pages render their first paint by
running the same API routes in-process, then poll `/api/*` from the browser.

The worker pulls data on its schedule and writes to the database. The API only reads — it never
calls a provider on an incoming request. Effect: pages stay fast, provider rate limits stay safe,
and if a provider goes down, the last known data still gets served with a `stale` flag.

### Deployment

| Part | Where | Notes |
| --- | --- | --- |
| `apps/web` (UI + API) | Vercel | Root directory `apps/web`; Neon connected via Storage |
| `apps/worker` | Railway | `SERVICE_TARGET=worker`, same `DATABASE_URL` |
| Database | Vercel Postgres (Neon) | |

The worker stays a long-running process on purpose (brief §16): polling every 20 seconds in a
serverless function would be expensive and flaky. It keeps the Neon compute awake around the
clock, so check that your Neon plan's compute hours cover that.

---

## Heat, Portfolio, Trade

The three pages that used to say SOON (`robinchan-trade-heat-portfolio.md`), built in the order
the brief asks for.

### Shared

- **Wallet & session.** wagmi v2 + viem, injected wallets only (every extension that announces
  itself over EIP-6963). Connecting leads straight into Sign-In with Ethereum; the server checks
  domain, chain, a one-time nonce and the signature, then sets a 24-hour httpOnly session cookie.
  A wallet that reconnects on its own, or an account switched inside the wallet, never pops up a
  signature by itself — it gets a "Sign in" button. RainbowKit isn't used: its default setup
  needs a WalletConnect Cloud project id, and its modal clashes with the design system.
- **Tiers** come from `GET /api/user/tier`: the $RCHAN balance read on chain, cached 60 seconds.
  Until the contract address and thresholds exist, everyone is Free (`source: "unconfigured"`);
  `RC_DEV_TIER` stands in during development only.
- **Four states** in every data block — skeleton sized like the content, empty with a reason and
  one action, error with a retry, and stale (dimmed, with its last update). No wallet on Portfolio
  or Trade shows the real layout with sample data blurred and the connect button in the middle.
- **Robinchan on every page.** A small avatar bottom-right (not on `/market`, which carries no
  character likeness) opens the same chat thread as `/robinchan`. Each message carries the page
  and symbol as metadata; the server looks up what that page shows, at the viewer's own access
  level. Signed in, the thread lives on the server.

### Heat

`GET /api/heat/full` and `GET /api/heat/:symbol` cut the board down on the server: no wallet sees
the top 5 with scores rounded to 10; a wallet sees the top 15 with components; Tier 1 sees
everything, the triggers behind each score, Robinchan's read, and the watchlist filter. Locked
rows are sent as `{ locked, requiredTier }` and nothing else. The worker stores each component's
inputs, a one-line note, the news ids that drove it and notable on-chain events in
`heat_scores.components`, and writes Robinchan's reads for the 20 hottest into `heat_reads` on the
heat schedule (a read is never generated on the click that opens a row). Social is `null` with
reason `belum_aktif` — shown as "not active yet", not as zero.

### Portfolio

Balances are read from the chain (`RC_TOKENS`, plus every token via `RC_EXPLORER_API` when set;
unsupported tokens get their own section). Cost basis comes only from filled Robinchan orders and
from prices the user types in (`cost_basis_overrides`): bought partly elsewhere is marked
*partial*, unknown stays empty, and PnL totals say how many assets they leave out. The value chart
is rebuilt from hourly prices for 24h and from daily `portfolio_snapshots` (00:00 UTC, first one
on the day the wallet is first seen) for longer ranges — never back-filled.

### Trade

Behind `FEATURE_TRADING`. The form and the chat both produce an order intent and go through the
same `quoteOrder` → sign → `recordOrder` pipeline in `packages/core/src/orders` — the same
intent gives the same quote either way. Quotes live 30 seconds, are bound to one address, and
their countdown sits in the sign button. Nothing executes without the user's signature on that
order; values come from the server's quote, never from the page. Pending transactions are watched
by the worker, so an order finishes correctly after the tab closes; past two minutes the page
offers speed-up and cancel; a second order waits while one is in flight. Limit orders are signed
when placed, rest until the worker sees their price, and Robinchan mentions the fill when the user
is back.

Venues: `paper` (dev only — typed-data signature, or with `RC_PAPER_ONCHAIN=true` a zero-value
transaction, filled against the live price) and `uniswap-v3` (SwapRouter02 + QuoterV2, slippage
bound in the calldata, a deadline wrapped around it). The Uniswap adapter is written against
the standard ABI but hasn't been run against a live deployment: the DEX and its addresses are still
open decision #4.

---

## Live2D character

Model: [Zundamon](https://www.live2d.com/en/learn/sample/zundamon/), a Live2D Inc. sample model.
Runtime assets live in `apps/web/public/live2d/zundamon/`.

- The model path is read from `NEXT_PUBLIC_LIVE2D_MODEL_URL`, not hardcoded, so it can be swapped
  without changing code (brief §5).
- The product's expression map (`happy`, `focused`, `alert`, `relaxed`) is kept separate from the
  expression names inside `model3.json`, in
  `apps/web/src/components/live2d/expressions.ts`. Swapping the model means changing just that
  one table.
- Cubism Core loads from Live2D's official CDN — the package isn't published on npm.
- The `model3.json` copied into `public/` has content filled in for the `EyeBlink` and `LipSync`
  groups. Live2D ships them empty; without that, auto-blink and lip-sync have no parameters to
  drive.
- Without WebGL, the stage falls back to a static placeholder and the expression buttons are
  disabled.

**Licensing isn't settled.** The bundled `ReadMe.txt` says commercial use is allowed for
individuals and small businesses under agreed terms, while medium-to-large businesses are limited
to non-public testing. Separately, the Zundamon character has its own usage guidelines from the
Tohoku Zunko / Zundamon Project. Both need confirmation before production — see design.md §9.
Until that's settled, treat this asset as a placeholder. A copy of the original notice is at
`apps/web/public/live2d/zundamon/LICENSE-NOTICE.txt`.

---

## Scope boundaries

What's still **not** built:

- Token streaming for chat (SSE) — the reply and its voice are returned together so they play
  in sync (see `app/api/chat/route.ts`).
- The social component of heat score — phase 3. Its weight is redistributed proportionally to
  on-chain and news per brief §13, and it's shown as not active rather than zero.
- The buyback logging job — brief §14.
- Real execution: needs the open decisions below. Until then trading runs on the `paper` venue
  in dev and stays behind `FEATURE_TRADING` everywhere.

Still open, and what each one blocks:

| Decision | Blocks | Stand-in until then |
| --- | --- | --- |
| $RCHAN address, tier thresholds (main #2, #3; this brief #4) | Real tiers | Everyone Free; `RC_DEV_TIER` in dev |
| Chain id / RPC / explorer, token contracts (main #4) | Real balances | Arbitrum Sepolia + a sample wallet in dev |
| DEX and ABI, fee, slippage (main #4, #5; this brief #3) | Real swaps | `paper` venue; `PROTOCOL_FEE_BPS=10`, `DEFAULT_SLIPPAGE_BPS=50` placeholders |
| Limit-order primitive vs bot (this brief #2) | Limit orders on a real venue | Paper limit orders, filled by the worker |
| Candle intervals from the provider (this brief #1) | Real charts | Provider bars when the plan allows; generated bars in dev |
| Regulatory answers (main #8) | Trading in production | `FEATURE_TRADING=false` |
| Order history retention (this brief #5) | — | Orders are kept forever (main brief §10) |
| All tokens vs supported only (this brief #6) | — | All, with unsupported in their own section (the brief's suggestion) |

### Technical notes

- **News sentiment** uses a lexicon score in `apps/worker/src/lib/sentiment.ts`. Alpha Vantage
  News Sentiment only lands in phase 2, while the sentiment dots and heat score's news component
  already need a number now.
- **Heat score gating** is decided on the server from the session and the tier read on chain.
  Home's five-row board (`/api/heat`) stays the anonymous view on purpose: it's a cached public
  page and must never render one viewer's data for another.
- **On-chain heat inputs** come from DexScreener for tokens with a configured address. Outside
  `RC_ENV=dev`, a symbol without one has an inactive on-chain component (weight moved to news)
  rather than a made-up number.
- **The `.data/` fallback** is now written by both processes, so writes go through a
  cross-process file lock, and the cache is one file per domain (`.data/cache/*.json`).
- **`npm audit`** leaves findings that can't be closed from here: `pixi-live2d-display` lists
  `gh-pages` as a dependency even though it's its own documentation deploy tool and is never
  imported from `dist/`, and `@railway/cli` (a dev-only deploy tool) pulls an old `tar`.
