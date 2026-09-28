# Perps on Robinhood Chain mainnet

The runbook for putting the perps contracts on Robinhood Chain (chain id 4663) with real USDC,
and for running them afterwards. Everything here is scripted; nothing needs a private key in a
file or in chat.

## Where things stand (checked on chain, 2026-09-26)

| | Status |
| --- | --- |
| Chain | Mainnet live since 1 July 2026. Chain id 4663, gas in ETH (about 0.036 gwei), explorer [robinhoodchain.blockscout.com](https://robinhoodchain.blockscout.com) |
| RPC | Robinhood's own `https://rpc.mainnet.chain.robinhood.com` is **blocked by Indonesian ISPs** (it resolves to the operator's block page). `https://robinhood.drpc.org` works from Indonesia (public, rate-limited). Alchemy and QuickNode serve the chain with a key |
| Oracle | Chainlink Data Feeds, listed in Chainlink's [directory for the chain](https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json): `BTC / USD`, `ETH / USD` and Robinhood's tokenized AAPL, TSLA, NVDA, AMZN, GOOGL, MSFT and META. 8 decimals, a new round on a 0.5% move or every 24 hours, each one landing 12–13 seconds after the oracles observe it (73 at most in the rounds sampled). "Shared SVR" feeds on a `DualAggregator 1.0.0`: the contracts read the primary proxy, the one the directory lists. The stock feeds publish nothing while the market is shut (52–57 hours without a round over the weekend of 2026-09-19). No agricultural feed, and none for SOL or ARB |
| USDC | `0x80e0e24718dbFcad49ECAA6F1e6C89A190586cA8` is "USD Coin", 6 decimals, bridged through Arbitrum's canonical gateway — with about 340 USDC in circulation. **Confirm with Robinhood which USDC its users actually hold** before settling in it |
| Safe | v1.4.1 is deployed (factory `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67`, SafeL2 `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762`), and so is Multicall3 |

`scripts/preflight.ts` re-checks all of this, and more, before anything is deployed.

## 0. Go / no-go

Don't deploy with real money until every line is true:

- [ ] An external audit of `contracts/contracts/**` is done and its findings are fixed. The
      internal security reviews that shaped the contracts aren't an audit.
- [ ] The settlement USDC is confirmed.
- [ ] Legal has signed off on offering leveraged derivatives on stocks and crypto, and to whom.
- [ ] The Safe's signers exist and have practiced a transaction (see step 1).
- [ ] Launch numbers are agreed: pool seed, open-interest cap per market, execution fee.
- [ ] The preflight passes: every feed is still the one Chainlink lists, and none is being retired.

## 1. Accounts

| Account | What it is | Holds |
| --- | --- | --- |
| **Safe** | Owns all three contracts after deploy: fees, funding, caps, pausing, delisting, pool liquidity. 2-of-3 or better, signers on hardware wallets | The pool's USDC it adds later |
| **Deployer** | A fresh key used once, for the deploy. Owns nothing afterwards | Gas (≈0.01 ETH) and the pool seed in USDC |
| **Keeper** | A fresh key for the worker (Railway secret). Only calls permissionless functions; earns the execution fees | Gas: 0.02–0.05 ETH, topped up |

**Simplest setup — one wallet (`SINGLE_KEY=true`).** The deployer also owns the contracts and
runs the keeper; no Safe. The preflight then only warns about the owner. The key sits on the
worker's server, so whoever gets it can pause markets, change fees within their bounds and
withdraw the pool's unreserved liquidity (never traders' collateral): keep the pool small, and
move ownership to a Safe later with `transferOwnership` on all three contracts.

Create the Safe with the canonical v1.4.1 contracts above — in the Safe{Wallet} app if it lists
Robinhood Chain, otherwise with Safe's CLI or protocol-kit against that factory.

Keep secrets in Hardhat's encrypted keystore, not in `.env` files:

```bash
cd contracts
npx hardhat keystore set DEPLOYER_PRIVATE_KEY
npx hardhat keystore set RH_MAINNET_RPC_URL      # e.g. https://robinhood-mainnet.g.alchemy.com/v2/<key>
```

## 2. Launch settings

Everything else is plain environment, set in the shell for steps 3–5:

```bash
export USDC_ADDRESS=0x80e0e24718dbFcad49ECAA6F1e6C89A190586cA8   # once confirmed
export OWNER_ADDRESS=0x…          # the Safe
export DEPLOYER_ADDRESS=0x…       # the deployer's address (the preflight checks its balances)
export KEEPER_ADDRESS=0x…         # the keeper's address
export MIN_EXECUTION_FEE_WEI=50000000000000   # 0.00005 ETH (~$0.12) per order; check it covers the keeper's real cost in step 8
export MAX_OI_USD=25000           # per side per market at launch; the Safe raises it later
export SEED_LIQUIDITY_USDC=50000  # the pool's first liquidity, from the deployer
```

No oracle key: Chainlink's feeds are public contracts. The pool has to cover every open
position's best case — each position sets aside up to min(9× its collateral, its size). With a
$25,000 cap per side on nine markets, the pool bounds how much can actually be open; requests
past it are refused on chain, never overpaid.

## 3. Preflight

```bash
RPC_URL=https://robinhood.drpc.org npx tsx scripts/preflight.ts
```

Every line has to be ✔ (a `!` is a warning to read, not a blocker). It checks the chain id; each
market's feed against Chainlink's directory (the address has to be the proxy Chainlink lists for
it, and not being retired) and on chain (its description, decimals, observation times and last
round — a stock feed quiet over a weekend is a warning, silent for days a failure); USDC's
decimals; that the owner is a Safe with 2+ signers; balances; and the launch settings.

## 4. Rehearse on a copy of mainnet

```bash
npx hardhat run scripts/deploy.ts --network rhMainnetFork
```

Runs the whole deploy against a local copy of Robinhood Chain: real Chainlink feeds, real USDC,
nothing spent. It needs an Alchemy or QuickNode `RH_MAINNET_RPC_URL`; the public dRPC endpoint
refuses the requests a fork makes. The deployer on a fork is Hardhat's first test account, so
give `DEPLOYER_ADDRESS` that address, and the pool seed needs USDC it doesn't have: set
`SEED_LIQUIDITY_USDC=0` for the rehearsal.

## 5. Deploy

```bash
npx hardhat run scripts/deploy.ts --network rhMainnet
```

It runs the preflight again and stops before deploying anything if a check fails. Then it deploys,
lists the nine markets on their Chainlink feeds at the launch cap, sets the execution fee, seeds
the pool, and hands ownership of all three contracts to the Safe — last, so a failure midway
leaves nothing owned by a stranger. It writes `deployments/4663.json` (commit it) and prints the
app's settings and the verification commands.

If it stops midway, the deployer still owns what exists: rerun from scratch rather than patching
by hand.

## 6. Verify the source

```bash
npx hardhat verify --network rhMainnet <address> <constructor args…>   # printed by the deploy
```

The explorer's API sits behind Cloudflare and may refuse scripts. If it does, verify in the
explorer's UI: *Verify & publish → Solidity (Standard JSON input)*, with the input from
`artifacts/build-info/`.

## 7. Configure the app

**Web (Vercel)** and **worker (Railway)** both get:

| Variable | Value |
| --- | --- |
| `RC_ENV` | `production` |
| `FEATURE_PERPS` | `true` (after step 8 passes on a staging deploy) |
| `PERPS_VENUE` | `agri-perp` |
| `AGRI_FEED_ADDRESS`, `AGRI_VAULT_ADDRESS`, `AGRI_PERP_ADDRESS`, `AGRI_DEPLOY_BLOCK` | From the deploy |
| `NEXT_PUBLIC_CHAIN_ID` / `_CHAIN_NAME` / `_EXPLORER_URL` / `_NATIVE_SYMBOL` | `4663` / `Robinhood Chain` / `https://robinhoodchain.blockscout.com` / `ETH` |
| `NEXT_PUBLIC_RPC_URL` | The browser's RPC. Must be reachable from Indonesia: `https://robinhood.drpc.org`, or a provider URL whose key is restricted to your domain |
| `RPC_URL` | The server's RPC (API reads, the worker's price reads, the keeper): a paid provider with a key, never shown to browsers |
| `PERPS_EXECUTION_FEE_WEI` | The same value as `MIN_EXECUTION_FEE_WEI` |

The worker alone also gets `KEEPER_PRIVATE_KEY`. Leave `PERPS_ORACLE` unset (`mock` is for
local chains, and production ignores it).

Wallets add Robinhood Chain from `NEXT_PUBLIC_RPC_URL`. A user who already added it with
Robinhood's own RPC has a network entry that won't load from Indonesia; they need to edit its
RPC URL.

## 8. Smoke test with small money

With `FEATURE_PERPS` on for a staging deploy pointed at mainnet: deposit 20 USDC and open a 1×
ETH long with 10. It fills at Chainlink's next ETH round — when ETH moves 0.5%, or within the
day — so on a quiet day it waits under *Waiting*; ask for it back from there (that forfeits its
0.01 USDC opening fee) and check it's released five minutes later. Open another, let it fill,
close it (that waits for a round too), withdraw. Check that the worker's log shows the orders executed and the position appears in
history. Only then turn the flag on for everyone.

## 9. Running it

The worker's keeper reads each waiting order's fate from the feed's history, as the contract
proves it: it executes orders whose round landed (however late — an order settles at its round
whenever it's executed), expires the ones no round priced in 25 hours, releases the ones asked
back, cancels the ones on a feed Chainlink moved to a new aggregator, liquidates, and settles
delisted markets. Watch its log for:

- `orders executed` / `orders expired, cancelled or released` — expired orders are ones no round
  priced: a shut or silent market.
- `order N couldn't be executed: NotFirstRound` — more than 64 rounds landed while its round was
  in flight, beyond what a Chainlink network publishes. Look at the feed.
- `liquidating … failed` — the reason is named.

The keeper's ETH balance is its lifeline. Keep it topped up.

Owner jobs, once the Safe owns the contracts, are Safe transactions. Each script prints the
calldata with `SAFE_TX=true` (Hardhat still wants `DEPLOYER_PRIVATE_KEY` set to connect, but
signs nothing):

| Job | Script |
| --- | --- |
| Raise caps as the pool grows | `MARKETS=ALL MAX_OI_USD=100000 SAFE_TX=true npx hardhat run scripts/set-markets.ts --network rhMainnet` |
| A market whose feed stopped for a week (Chainlink retired it); anyone can after two | `DELIST_SYMBOL=… SAFE_TX=true npx hardhat run scripts/delist.ts --network rhMainnet` |
| A US market holiday, until the stock feeds are confirmed silent on holidays as on weekends | `MARKETS=AAPL,TSLA,NVDA,AMZN,GOOGL,MSFT,META ENABLED=false SAFE_TX=true npx hardhat run scripts/set-markets.ts --network rhMainnet`, and `ENABLED=true` after |

Other Safe calls, against the verified contracts: `AgriVault.addLiquidity` /
`removeLiquidity` (unreserved liquidity only) / `collectFees`, and `AgriPerp.setFundingRate`
(capped at 0.01% per hour).

A listed market's feed never changes. When Chainlink announces a feed's retirement, pause the
market (below), let positions close, and delist it once the feed has been silent a week; a
replacement feed is listed as a new market. Rerun the preflight now and then: it flags feeds
Chainlink is retiring.

## 10. Emergencies

- **Stop new trading:** `MARKETS=ALL ENABLED=false SAFE_TX=true npx hardhat run scripts/set-markets.ts --network rhMainnet`.
  Closing, liquidation and settlement keep working, by design.
- **The oracle misbehaves** (wrong prices, a Chainlink incident): pause as above. Positions can
  still be closed at the feed's prices, so if the prices themselves are wrong, say so publicly
  and wait for Chainlink rather than letting anyone close.
- **The keeper is down:** orders wait, and settle at their round whenever someone executes
  them — anyone can (they earn the execution fee), and anyone can expire an order no round
  priced or liquidate a position.
- **Nothing here can move traders' collateral.** The owner can pause markets, change parameters
  within hard bounds for *new* orders (funding, capped at 0.01% an hour, applies to open
  positions from the change on), and delist a market whose feed has been silent for a week —
  anyone can after two. Trust in that last one is documented: the settlement price is the
  feed's last round, or the last price the contract read if the feed can't be read at all.

The contracts aren't upgradeable. A fix means a new deployment: pause the old markets, let
positions close, and point the app at the new addresses.

## 11. Agri markets on Pyth (coffee, cocoa, sugar)

Chainlink has no agri feed on Robinhood Chain. Pyth prices the ICE softs — coffee, cocoa and
sugar, as dated futures — and its contract here (`0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a`,
v1.4.5-alpha.1) was confirmed official by the Pyth team on 2026-09-26. Corn, soybeans, wheat,
palm oil, rice and cotton aren't on Pyth either; they stay coming soon.

**How it plugs in.** `PythRoundFeed` (one per market) turns a Pyth feed into Chainlink-style
rounds, so the deployed AgriFeed lists it like a proxy and AgriPerp settles on it unchanged — no
redeploy. Each round is Pyth's *first* print at or after the next `slot` (the Pyth contract
checks the uniqueness), so the rounds follow from Pyth's history alone: whoever pushes decides
when a round lands, never which price it carries. Rolls between contract months are announced a
day ahead and carried out on each month's first print after the roll time, with a roll factor
that keeps the price continuous.

**What it costs.** A round is a keeper transaction: ~111k gas for Pyth's check plus storage,
about 0.000003 ETH on Robinhood Chain. At one round every 5 minutes during ICE hours, the three
markets take roughly 0.001 ETH a day. Pyth's update fee on this chain is 0.

**Before it can go live:** a Pyth data plan that covers the ICE softs — they're futures. Plans
are at app.pyth.com/plans: Starter ($500/month) is crypto only; futures are $5,000/month, metals
and commodities $2,500, everything $10,000 (Pyth Core upgrade post, checked 2026-09-28). Ask Pyth
which one carries `Commodities.CFZ6/USc`, `CAZ6/USD` and `RSH7/USc` before paying. Hermes needs
an API key for every feed now; a crypto-only key gets 403 for the softs. Paid plans are served at
`https://pyth.dourolabs.app/hermes`: set the worker's `HERMES_URL` to it. Check a key with
`PYTH_API_KEY=… PYTH_FEED_ID=0xa61c21c0ca93300f50f231b52f59e9a6f47a07d33e78c1a9b8f84bd5928a3e8f npx tsx scripts/pyth-check.ts`
(read-only calls against the real Pyth contract).

1. **Deploy the feeds** (any time; they need no Pyth data yet):
   `npx hardhat run scripts/deploy-pyth-feeds.ts --network rhMainnet` — writes
   `deployments/4663-pyth.json` and announces the first rolls (coffee and cocoa: 12 Nov 2026).
2. **Point the app at them:** each address goes in `packages/shared/src/perps.ts` as the market's
   `roundFeed`; the worker needs `PYTH_API_KEY`. The keeper then pushes a round per slot, carries
   out rolls, and — owning the feeds, as with SINGLE_KEY — announces the next roll a week ahead.
3. **Open the markets** once each feed has a round:
   `FEEDS=pyth npx hardhat run scripts/list-agri-markets.ts --network rhMainnet` (MAX_OI_USD, default 10).

**Watch for:** a month's roll needs the next month on Pyth. Sugar starts on March 2027 (RSH7) with
no later month listed yet, and coffee and cocoa roll to March 2027 in November; add each next month
to the registry when Pyth lists it, or the market has to be paused before its contract expires. A
keeper down for more than 64 slots (5 hours at 5-minute slots) during trading leaves orders
requested in that gap unprovable — they can still be taken back.

## 12. Agri markets priced by the operator (Yahoo Finance)

The free route, chosen on 2026-09-28: the keeper reads each agri market's contract month from
Yahoo Finance and posts it to a `ReportedRoundFeed`, which AgriFeed lists like a Chainlink proxy.
Eight markets: corn, soybeans, wheat, rough rice (CBOT), arabica coffee, cocoa, sugar, cotton
(ICE). Palm oil isn't on Yahoo and stays coming soon.

**What traders have to trust.** These prices are the operator's. Nothing on chain proves them:
the reporter key (the keeper wallet) could post any price, and a stolen key could drain the pool
up to the open-interest caps. The contract limits the damage — one round moves the price at most
15% (past that the owner posts it, `reportUnchecked`), a quote can't be older than an hour or
older than the last round — and the page says where the price comes from. Keep the caps small.

**Why the ~10-minute delay can't be traded against.** Each round carries the time the exchange
quoted it (`startedAt`), not when it was posted. An order settles on the first round *quoted* after
it, so by the time a trader places an order, no price they could already see can fill it; the delay
only makes fills slower (10+ minutes). Liquidations run ~10 minutes behind the market, which is
why agri stays at 5× at most.

**Other risks.** Yahoo's quote API is unofficial: it can change, rate-limit or block the worker's
IP without notice (no rounds then: orders wait and expire with a refund after 25 hours), and its
terms don't cover commercial use of the data. A round goes up when the price moved 0.2% or every
10 minutes of market time, ~0.000001 ETH each.

1. **Deploy the feeds:** `npx hardhat run scripts/deploy-reported-feeds.ts --network rhMainnet` —
   the reporter is KEEPER_ADDRESS (or the deployer with SINGLE_KEY). Writes
   `deployments/4663-reported.json`.
2. **Point the app at them:** each address goes in `packages/shared/src/perps.ts` as the market's
   reported `roundFeed`. The worker's `agri-prices` job then posts rounds as each market trades,
   and rolls contract months at the registry's roll times.
3. **Open the markets** once each has a round: `npx hardhat run scripts/list-agri-markets.ts
   --network rhMainnet` (MAX_OI_USD, default 10). Markets closed at the time get listed on a later
   run.

**Watch for:** a market past its roll time with no next month listed logs a warning — add the
next month to the registry before the contract expires, or pause the market.

## 13. RH Tokens, priced by their own pools (DEX TWAP)

RH Tokens brief, 2026-09-28: perps on Robinhood Chain's own tokens, which no oracle network
prices. A `TwapRoundFeed` per token reads the token's **Uniswap V2 or V3** pool: each round is the
pool's time-weighted average over 15 minutes, from the pool's own running record — a V2 pair's
cumulative price, a V3 pool's cumulative tick — which a trade inside one block can't move (a flash
loan can't reach it), in USD through Chainlink's ETH/USD. AgriFeed lists it like a Chainlink proxy;
AgriPerp is unchanged. Answers have 18 decimals (AgriFeed's own), so a token worth a fraction of a
cent keeps its digits.

**The tokens (2026-09-28): a launchpad's, a memecoin, a DeFi protocol's.**

| Market | Token | Pool the average is read from | Checked |
|---|---|---|---|
| PONS | Pons (Pons Family launchpad) | Uniswap V3 PONS/WETH 0xEd50…22ff, 0.3% | Token Check clean: no tax, no owner |
| CASHCAT | Cash Cat (memecoin) | Uniswap V3 CASHCAT/WETH 0xA70f…E313, 1% | Token Check clean |
| DELTA | Delta (deltaliquidity.app) | Uniswap V3 DELTA/WETH 0xD64F…5F94, 1% | Token Check clean |

Each pool's `factory()` is Uniswap's V3 factory on Robinhood Chain
(0x1f7d7550B1b028f7571E69A784071F0205FD2EfA, the same as the NVDA/USDG pool's) and answers
`observe()`. A simulation against mainnet (`eth_simulateV1`: the three feeds deployed and updated
for 16 minutes of block time, nothing sent) gave PONS $0.5253, CASHCAT $0.18685, DELTA $0.021583 —
DexScreener said $0.5269, $0.1875, $0.02176 — with $1.8M, $3.9M and $1.2M in the pools by the feeds'
own count.

Left out, and why:
- **The brief's RCHAN, FLOAT, WASSILY, SHERWOOD:** RCHAN and FLOAT trade only on Uniswap v4, which
  keeps no price record on chain to read, and hold ~$3 and ~$10k; there's no WASSILY on Robinhood
  Chain; Sherwood's WOOD has $440k in its V2 pair, under the floor.
- **Tokens whose deepest pools are v4 only** (GOOSE, AI, MEME, ORBIO, NOTE, SHCAT): nothing to read.
- **"Robinhood Wallet" (WALLET):** borrows Robinhood's name (Token Check: caution).
- **Robinhood's stock tokens** (SPCX, SPY, CRCL, MU, GLD have deep V3 pools): Chainlink prices every
  one of them on Robinhood Chain — they belong in the Stocks tab on those feeds, not on a DEX average.

**What the brief asked for that the deployed contracts can't do**, and what stands in:

- *Changes to AgriPerp* (per-market maintenance margin, liquidation fee): AgriPerp is deployed and
  immutable. RH Tokens use its global terms — liquidation at 80% loss, 10% liquidator reward — and
  the brief's 5× cap per market (`listMarket`).
- *$10k max position:* AgriPerp has no per-position cap, only open interest per side. Listing starts
  at the $10 launch cap every market started at; `set-markets.ts` raises it, to $10,000 a side at
  most, which then caps any one position at $10k too. The API refuses a larger position with a clear
  message either way (`maxPositionUsd` in the registry).
- *0.3%/h funding:* `setFundingRate` is capped at 0.01%/h on chain. Funding starts at 0, as for every
  market.
- *RHTokenRegistry contract:* the registry is the app's (`packages/shared/src/perps.ts`, category
  `rh`), like every other market's; the minimum liquidity is enforced by the feed itself.

**Why an average read at its end can't be traded against.** A 15-minute average trails the spot
price, and whoever sees spot move could trade against that lag. So each round's `startedAt` — what
AgriFeed takes as when the price was observed — is when its window *began*. An order settles on the
first round observed after it: an average of prices that all came after the order, about 16
minutes on. Liquidations use the latest average, 15 minutes smooth. (A V3 average is the geometric
mean of the price over the window; a V2 one, the arithmetic.)

**Guards, each answering 0 (a bad-price round: its order is cancelled and refunded):** the pool
holding less than `minLiquidityUsd` ($500k, both sides counted as twice the WETH side — for a V3
pool, its WETH balance in range or not), or ETH/USD older than 25 hours. **Circuit breaker:** once
no round has landed for an hour, the latest round reads 0 — AgriFeed refuses new orders and
liquidations — until rounds resume. After a gap in the record, the next round needs a fresh 15
minutes of history.

**The keeper.** `update()` is permissionless: the worker's `twap-rounds` job calls it, and anyone
can (the contract refuses more than one a minute). Calling it at a chosen moment only moves which
second an average ends on. It reads the pool's current record (`observe([0])` on V3), so the pool's
own observation cardinality doesn't matter. Each update costs ~150–220k gas (measured against
mainnet, 2026-09-28: ~$0.01 at 0.02 gwei), so the keeper paces each feed by what its market needs:

| The market | Updates | Why |
|---|---|---|
| An order waits on it | every minute | the order fills on the first average that starts after it: that start has to come soon |
| Positions open | every 5 minutes | liquidations stay near the market |
| Quiet | every 16 minutes | each update still makes a round (the contract takes a start 900–1,140 s back), well inside the hour-long breaker |

A quiet feed costs ~90 updates a day (~$1), not 1,440 (~$15). If the keeper stops, the circuit
breaker stops the markets; anyone can call `update()` to bring them back. Keep the keeper wallet
(the SINGLE_KEY address) funded.

1. **Deploy the feeds:** `npx hardhat run scripts/deploy-twap-feeds.ts --network rhMainnet` (or
   `ONLY=CASHCAT`). Each records its first observation; a pool under the floor deploys fine and
   answers 0. Writes `deployments/4663-twap.json`.
2. **Point the app at them:** the addresses go in `TWAP_ROUND_FEEDS` in
   `packages/shared/src/perps.ts`; deploy the worker, whose `twap-rounds` job then calls `update()`
   each minute.
3. **Open the markets** once each feed has a round priced above 0 (16–30 minutes after the worker
   starts): `FEEDS=twap npx hardhat run scripts/list-agri-markets.ts --network rhMainnet` (5×, the $10
   launch cap a side). A feed whose latest average is 0 is skipped. Raise the caps as the pool grows:
   `MARKETS=PONS,CASHCAT,DELTA MAX_OI_USD=10000 npx hardhat run scripts/set-markets.ts --network rhMainnet`.

**Watch for:** `[perps] CASHCAT: its average priced nothing` in the worker's log — the pool fell
under the floor (or ETH/USD went stale). Pause the market (`setMarket`) if it stays there; open
positions can still be closed only once rounds price again. And the tokens themselves: they're young
and move hard — re-run Token Check before raising any cap.

## 14. More stock tokens on Chainlink (SPCX, SPY, CRCL, MU, GLD)

Five more of Robinhood's stock tokens, 2026-09-28: each has deep pools on Robinhood Chain and its own
Chainlink feed there, checked on chain (description, 8 decimals, a fresh round):

| Market | Feed (proxy) | `description()` |
|---|---|---|
| SPCX (SpaceX) | 0xB265810950ba6c5C0Ff821c9963014a56fD8Bffb | Robinhood SPCX / USD |
| SPY (SPDR S&P 500 ETF) | 0x319724394D3A0e3669269846abE664Cd621f9f6A | RHSPY / USD |
| CRCL (Circle) | 0x6652eDf64bA3731C4F2D3ce821A0Fb1f1f6b482a | Robinhood CRCL / USD |
| MU (Micron) | 0x425EEFdCf05ed6526C3cE61Af99429A228a6d596 | RHMU / USD |
| GLD (SPDR Gold Trust) | 0x470A51258068043bd43dC0a56245625C9fE86eB0 | GLD / USD |

They're stocks like the other seven: 5× at most, 24/5 (nothing opens, closes or liquidates while the
feed is quiet over the weekend). SpaceX is private; its feed prices Robinhood's SPCX token.

**List them** on the live contracts (the stack's deploy only listed the first nine):
`npx hardhat run scripts/list-markets.ts --network rhMainnet`. It checks each proxy's
`description()` against the registry, lists the feed on AgriFeed and the market on AgriPerp at the
$10 launch cap, skips what's already listed, and adds them to `deployments/4663.json`. Until then the
page shows them as not listed yet.
