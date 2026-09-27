# Robinchan

A Live2D character companion market for tokenized stocks on Robinhood Chain.
\



This implementation covers **M1 (static landing page)** and **M2 (live data)** from
`robinchan-dev-brief.md` §17, plus the pages of the Trade / Heat / Portfolio brief — **Heat**,
**Portfolio** and **Trade** — with what they need from M3 and M4: wallet connect, Sign-In with
Ethereum, tiers read on the server, and the order pipeline Robinchan's chat uses. **Perps**
(`robinchan-agri-perps-brief.md`) has since replaced the Trade page: perpetual futures on crypto
and US stocks, priced by Chainlink Data Feeds on Robinhood Chain, with its own contracts in
`contracts/` (the brief's agricultural markets are listed, but Chainlink has no feed for them
there yet). Perps sits behind `FEATURE_PERPS` and spot trading behind `FEATURE_TRADING`, both
off by default. See [Heat, Portfolio, Trade](#heat-portfolio-trade), [Perps](#perps) and
[Scope boundaries](#scope-boundaries).

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
| `npx hardhat test` in `contracts/` | The perps contracts: lifecycle, which Chainlink round fills an order, taking orders back, liquidation, funding, delisting, the vault's solvency after every step, and the attacks from the security reviews |
| `npx tsx scripts/e2e-perps.mts` | Perps over HTTP on either venue — paper, or the contracts on a local chain with the worker's keeper executing orders (see the script's header) |
| `npm run reads -w @robinchan/worker` | Prints Robinchan's stored heat reads for review before `FEATURE_HEAT_READS` goes on |

**To try Perps locally**, set `FEATURE_PERPS=true` in `.env` and restart `npm run dev`. The dev
venue is `paper`: the test-USDC button funds a virtual balance, and every open and close is
really signed in the wallet, then filled at the live Chainlink price without moving anything on
chain. The prices are read from Robinhood Chain mainnet — no key needed; if it can't be reached,
dev runs on a fixture random walk flagged as such.

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
  web/          Next.js 16 App Router — Home, Robinchan, Market, Heat, Portfolio, Perps,
                and the API (src/app/api/[...path] → src/server/api)
  worker/       Cron — pulls from providers, writes to the database
packages/
  shared/       Types, constants, format utils (used by all)
  store/        Postgres (cache + tables) behind one interface, with the .data/ fallback
  core/         Server-side domain logic shared by web and worker: chain reads (viem),
                tiers, holdings, cost basis, portfolio valuation, the order pipeline and
                its venues, perps (quotes, the keeper, Chainlink), heat gating, and Robinchan's
                generated reads
contracts/      The perps contracts — a standalone Hardhat project, outside the workspaces
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

Replaced by [Perps](#perps): `/trade?symbol=X` now redirects to `/perps?symbol=X`. The spot
order pipeline below stays, for Robinchan's chat orders and Portfolio's order history.

Behind `FEATURE_TRADING`. The chat produces an order intent and goes through the
`quoteOrder` → sign → `recordOrder` pipeline in `packages/core/src/orders` — the same intent
gave the same quote on the old Trade form. Quotes live 30 seconds, are bound to one address, and
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

## Perps

`/perps` (`robinchan-agri-perps-brief.md`): perpetual futures on crypto and US stocks, priced by
Chainlink Data Feeds on Robinhood Chain and settled in USDC against a liquidity pool. Behind
`FEATURE_PERPS`. Every open and close is signed by the trader; the server computes every number
that reaches a signature or a transaction, from its own prices and balances.

### Markets

| Category | Markets | Max leverage | Notes |
| --- | --- | --- | --- |
| Crypto | BTC, ETH | 20× | 24/7. Chainlink's `BTC / USD` and `ETH / USD` |
| Stocks | AAPL, TSLA, NVDA, AMZN, GOOGL, MSFT, META | 5× | Robinhood's tokenized stocks, 24/5 (Sunday 20:00 to Friday 20:00 New York). The feeds report total return value, so splits and dividends need nothing on chain |
| Crypto | SOL, ARB | — | Listed but not tradable: no Chainlink feed on Robinhood Chain |
| Agri | CORN, SOYB, WEAT, COFF, COCC, SUGA, PALM, RICE, COTT | — | Listed but not tradable: Chainlink has no agricultural feed on Robinhood Chain (checked 2026-09-26), and the page says so |

A Chainlink feed publishes a new round when its price moves 0.5% or once a day, so between
rounds the on-chain price can trail the market by up to 0.5%. That's why crypto stops at 20× —
at 50× the lag alone would be a third of a position's margin. Stocks stop at 5×: they gap over
weekends, when their feeds publish nothing (52–57 hours without a round, the weekend of
2026-09-19), and nothing can be liquidated while a feed is quiet.

### Venues

- **`paper`** (dev only, the default there): positions live in the database against a virtual
  USDC balance, opened and closed with an EIP-712 signature, filled at the live price and
  liquidated by the worker. The math is the contract's.
- **`agri-perp`**: the contracts. The server builds the transactions and the wallet sends them.

### An order on chain

1. **Request.** Only while the market's feed is live (a round in the last 25 hours), and with a
   limit the current price meets. It commits the collateral and fee, the pool's reserve for the
   position's maximum profit, and the open interest. A deposit can ride along in the same
   transaction.
2. **Execute.** The worker's keeper, or anyone, executes it at the feed's first round that was
   *observed* after the request (Chainlink observes a price about 13 seconds before it lands on
   chain; 2 seconds of margin cover clock drift) and landed within 25 hours of it, on the
   aggregator it was requested on. The contract checks the rounds before it, so there's exactly
   one such round: nobody can choose a price, nor fill at one already on its way. However late
   it's executed, the order settles at that round — waiting buys nothing. A fill past the
   trader's limit cancels it and refunds it. On a quiet market the round can take hours; the
   quote says so.
3. **Or take it back.** Before its round lands the trader can ask for a waiting order back, and
   forfeits the opening fee — the order held the pool's liquidity while it waited. A price
   observed after the ask then cancels it instead of filling it; one observed before still
   fills it, so whoever sees a round before it lands can't cancel only the fills that go against
   them. With no round, it's released five minutes after the ask. The page lists waiting orders
   under *Waiting*.
4. **Or expire.** An order no round priced within its 25 hours is released with that proven from
   the feed's history (anyone can, and earns its execution fee); the trader gets everything
   back. So is one whose feed Chainlink moves to a new aggregator, or whose market is delisted.
5. **Liquidate.** At 80% loss (price and funding), on the feed's latest round. The liquidator
   keeps 10% of what's left, never less than 0.5% of the collateral, and the trader gets the
   rest.

An order keeps the terms it was requested under (delays, fees, liquidation parameters), and so
does its position: owner changes to those reach only new orders, and every setting has hard
bounds. Profit per position is capped at min(9× collateral, size), the reserve set aside at
request — that's what keeps the pool able to pay every open position's best case. Funding is
the exception: it's set by the owner per market (manual for the MVP, brief §12.4), applies to
open positions from the change on (never retroactively), is capped at 0.01% of size per hour,
accrues per second, and is 0 by default. A market whose feed stops for a week can be delisted by
the owner, and after two weeks by anyone: its positions settle at the last price, with no close
fee — the last price the contract read, if the feed can't be read at all.

### Contracts

`contracts/` is a standalone Hardhat 3 project, kept out of the npm workspaces so the app never
installs the Solidity toolchain.

| Contract | Role |
| --- | --- |
| `AgriFeed` | Market → Chainlink feed proxy, answers as 18-decimal USD. Proves from the feed's own round history which round settles an order — or that none did — pinned to the aggregator (phase) the order was requested on |
| `AgriVault` | The USDC: each trader's free and locked collateral, the LP pool and its reserve, protocol fees |
| `AgriPerp` | Orders, positions, funding, liquidation, delisting |

The brief's `AgriLiquidatorBot` isn't a separate contract: `liquidate` is permissionless and
takes a batch, and the keeper calls it. The version built on Pyth (with the agri futures, rolls
and split handling) is archived in `contracts/archive/pyth/`.

```bash
cd contracts && npm install
npx hardhat test                                        # 32 tests
npx hardhat node                                        # a local chain
npx hardhat run scripts/deploy.ts --network localhost   # MockAggregators + MockUSDC locally; prints the .env lines
npm run abi                                             # after changing a contract: ABIs into packages/core
```

The deploy script lists every market in `deploy/markets.json` (generated from the app's registry
by `npx tsx scripts/perps-markets.mts`) and seeds the pool (`SEED_LIQUIDITY_USDC`). Locally each
market gets a MockAggregator, and the worker (`PERPS_ORACLE=mock`) posts live prices into it; on
Robinhood Chain it lists Chainlink's proxies, after checking each against Chainlink's feed
directory. Off the local chain it needs `USDC_ADDRESS`; `OWNER_ADDRESS` hands ownership to a
multisig. `set-markets.ts` pauses markets or changes their caps, and `delist.ts` delists one
whose feed has stopped.

### API and worker

- **API** under `/api/perps/`: `markets`, `stats/:symbol`, `price/:symbol`, `candles/:symbol`,
  `positions`, `history`, `orders` (waiting on chain), `collateral`, `quote`, `record`,
  `cancel`, `actions/:id`, `faucet` (dev). Wallet routes need the SIWE session and have
  per-wallet limits; a quote lives 20 seconds and is bound to one address.
- **Worker.** `perp-prices` reads every feed's latest round in one multicall every 5 s into the
  cache the API reads, and builds the chart bars — carrying each round forward until the next,
  as positions are marked, and backfilling a new market from the feed's last two days of rounds.
  `perp-orders` runs every 3 s: the keeper reads each waiting order's fate from its feed's
  history as the contract will prove it — executes the ones whose round has landed, expires the
  ones no round priced, releases the ones asked back, and cancels the ones on a feed Chainlink
  moved to a new aggregator. `perps` runs every 5 s: lapsed quotes, transactions
  in flight, the contract's events mirrored into `perp_positions`, liquidations and delisted
  markets. Both keep running with the flag off while positions are open.
- **The keeper key** (`KEEPER_PRIVATE_KEY`, worker only) calls only permissionless functions. It
  holds gas and the execution fees it earns, never user funds. Without it, orders wait for
  someone else to execute them.
- **Chainlink** is read over plain RPC — the feeds are public contracts, with no key or plan.
  Pages poll `/api/perps/*` rather than holding the brief's WebSocket, so no page load ever
  reaches the chain for a price. Robinhood's own RPC is blocked by Indonesian ISPs; the default
  `PERPS_ORACLE_RPC_URL` is dRPC's public endpoint.

| Variable | Meaning |
| --- | --- |
| `FEATURE_PERPS` | The page and every perps-writing endpoint |
| `PERPS_VENUE` | `paper` (dev only) or `agri-perp` |
| `AGRI_FEED_ADDRESS`, `AGRI_VAULT_ADDRESS`, `AGRI_PERP_ADDRESS`, `AGRI_DEPLOY_BLOCK` | The deployment |
| `PERPS_ORACLE_RPC_URL` | Where prices are read when the contracts aren't on Robinhood Chain (paper, a local chain) |
| `PERPS_ORACLE=mock` | Local chains only: the worker posts the cached prices into the MockAggregators |
| `KEEPER_PRIVATE_KEY`, `PERPS_EXECUTION_FEE_WEI` | The keeper, and what each order pays whoever executes it |
| `PERPS_FUNDING_RATES`, `PERPS_FEE_BPS`, `PERPS_CLOSE_FEE_BPS`, `PERPS_MAX_OI_USD`, `PERPS_FAUCET_USDC` | The paper venue's copies of what the contract holds on chain |

### Where it differs from the brief

| Brief | Built | Why |
| --- | --- | --- |
| Pyth price feeds | Chainlink Data Feeds on Robinhood Chain | Pyth's commodity and equity data needs a paid plan; Chainlink's feeds there are free to read |
| Nine agri markets | Listed, not tradable | Chainlink has no agricultural feed on Robinhood Chain; the Pyth version that traded coffee, cocoa and sugar is archived |
| SOL, ARB | Listed, not tradable | No Chainlink feed on Robinhood Chain |
| 50× on every market | 20× crypto, 5× stocks | The feeds' 0.5% deviation lag, and weekend gaps |
| Open at the current price | Request, then execute at the first round observed after it | Opening at a price the trader has already seen lets them pick a favourable one (the first review's critical finding) |
| — | Orders can be asked back | Waiting for a round can take hours |
| 0.1% opening fee | 0.1% to open and 0.1% to close | A free round trip is an option on the pool |
| Uncapped profit | min(9× collateral, size), reserved from the pool | The pool has to cover every position's best case |
| Funding 0.01% per hour | 0 by default, owner-set, capped at 0.01% per hour | 0.01% an hour is about 88% of size a year |
| `GOOG` | `GOOGL` | The rest of the app, and Chainlink, track class A |
| WebSocket price stream | Polling the cached price | No chain read behind a page load |
| `positions`, `price_candles`, `funding_history` tables | `perp_positions`, `perp_funding_history`, plus `perp_actions`, `perp_accounts`, `perp_markets`; chart bars in the cache | Named apart from the spot tables; bars live where the app's other candles do |
| `AgriLiquidatorBot` contract | The worker's keeper | `liquidate` is permissionless |

### Before mainnet

The step-by-step for Robinhood Chain mainnet — accounts, a preflight check of every feed against
Chainlink's directory, a rehearsal on a copy of mainnet, the deploy, the app's settings, and
running and pausing markets from a Safe — is [`contracts/MAINNET.md`](contracts/MAINNET.md).

- **An audit** (brief §12.1). The internal security reviews that shaped the contracts don't
  replace one. What they left open, for the audit and for operations:
  - Waiting orders hold pool liquidity and open interest until their round. Taking one back
    costs the opening fee, but an order a quiet feed never prices (a stock's weekend) is
    released free after 25 hours, so a large enough stack of orders can crowd the pool for a
    while. The owner can pause markets and add liquidity.
  - The stock feeds are verified silent on weekends; on US market holidays and trading halts
    they're assumed to be too. If one published at a stale price, orders would fill at a price
    known in advance: pause stock markets over a holiday until that's confirmed.
  - A price gap wider than the liquidation distance between two rounds (a sequencer outage, a
    flash crash) is paid by the pool, like any perps venue's. There's no sequencer-uptime feed
    for Robinhood Chain yet to pause on.
  - In the second a round lands through Chainlink's private SVR path, the contract doesn't see
    it yet; a cancel released in that very second, of an order that round would have filled,
    needs a transmission delayed five minutes as well.
  - An order that would need more than 64 in-flight rounds of proof can't settle — 64 rounds
    landing within a minute, beyond what a Chainlink network publishes.
  - The keeper has to stay live for orders to fill promptly (they settle at their round
    whenever executed, so a slow keeper costs time, not money). Run one worker.
- **A minimum execution fee** (`MIN_EXECUTION_FEE_WEI` at deploy) on a real chain, so anyone
  can profitably execute orders when the keeper is slow and spamming orders costs something.
- **USDC on Robinhood Chain** (brief step 3A): the only USDC found there has about 340 in
  circulation; which USDC to settle in needs Robinhood's confirmation.
- The LP seed (brief §12.5), the keeper's gas budget and execution fee, a borrow fee on open
  interest (today the pool earns only fees and traders' losses), and trading from the chat (a
  later phase in the brief).
- A regulatory answer for leveraged derivatives on stocks.

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
| USDC on Robinhood Chain (perps brief step 3A) | Perps on chain | `paper` venue; a local chain with MockAggregators and MockUSDC |
| An agri price feed on Robinhood Chain (perps brief §3) | The agri markets | Listed as unavailable; the Pyth version of the contracts is archived in `contracts/archive/pyth/` |
| Audit (perps brief §12.1) | Perps in production | `FEATURE_PERPS=false` |
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
