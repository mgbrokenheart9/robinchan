# The Pyth version of the perps contracts (v4)

Archived on 2026-09-26, when the protocol moved to Chainlink Data Feeds on Robinhood Chain: the
Pyth data plan that covers commodity futures and US equities is paid, and Chainlink's feeds there
are free to read. This is the version to come back to for the agri markets — Pyth is where ICE
coffee, cocoa and sugar futures are priced.

- `AgriFeed.sol` — Pyth feeds, futures rolls, stock-split rebases checked against prices.
- `AgriPerp.sol` — orders settled with Pyth's `parsePriceFeedUpdatesWithConfig` (the first print
  after a request), with update data pushed on request.
- `AgriPerp.test.ts` — its 33 tests against MockPyth (three internal security reviews).
- `preflight.ts`, `schedule-roll.ts`, `schedule-split.ts` — its deploy check and owner scripts.
- `markets.json` — its market list: the Pyth feed ids of the agri futures (two months each, with
  roll dates), crypto and US equities.

None of it is compiled or deployed from here. To bring it back, restore these files to
`contracts/contracts/`, `contracts/test/` and `contracts/scripts/`, and reinstall the Pyth SDK they
import (`npm i @pythnetwork/pyth-sdk-solidity@4.3.1` in `contracts/`). The app's side of Pyth — the
Hermes client, the roll and split keeper jobs, entitlement handling — was never committed and
isn't kept here: it would be rewritten against `packages/core/src/perps/chainlink.ts`'s shape.
