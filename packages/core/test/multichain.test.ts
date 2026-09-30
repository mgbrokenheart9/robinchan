import './setup';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  GAPPING_MAX_LEVERAGE,
  NEW_CHAIN_MAX_POSITION_USD,
  PERP_MARKETS,
  perpMarket,
  perpMarketsOn,
  perpNetworkOfChain,
  tradablePerpMarkets,
} from '@robinchan/shared';
import { getCache, getDb, getPerpStore } from '@robinchan/store';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

/*
 * The Multichain brief: Robinhood Chain stays the primary network, exactly as
 * configured before; Base runs beside it here, on its mainnet id but an
 * unroutable RPC — everything below reads caches and rows, never a chain.
 * Arbitrum stays off.
 */
process.env.FEATURE_PERPS = 'true';
process.env.PERPS_VENUE = 'paper';
process.env.PERPS_FUNDING_RATE_PER_HOUR = '0';
process.env.PERPS_ORACLE_RPC_URL = 'http://127.0.0.1:9';
process.env.BASE_RPC_URL = 'http://127.0.0.1:9';
process.env.BASE_CHAIN_ID = '8453';
process.env.BASE_AGRI_PERP_ADDRESS = `0x${'11'.repeat(20)}`;
process.env.BASE_AGRI_VAULT_ADDRESS = `0x${'22'.repeat(20)}`;
process.env.BASE_AGRI_FEED_ADDRESS = `0x${'33'.repeat(20)}`;
process.env.BASE_AGRI_DEPLOY_BLOCK = '123';
process.env.BASE_REPORTED_FEEDS = JSON.stringify({ CORN: `0x${'44'.repeat(20)}` });
delete process.env.ARB_RPC_URL;

const core = await import('../src/index');

const PRIMARY_CHAIN_ID = 421614; // test/setup.ts's chain

async function rejects(p: Promise<unknown>, code: string, text?: RegExp): Promise<void> {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof core.PerpError, `expected PerpError, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    if (text) assert.match(err.message, text);
    return true;
  });
}

async function newUser() {
  const account = privateKeyToAccount(generatePrivateKey());
  const row = await getDb().upsertUser(account.address);
  return { id: row.id, address: account.address };
}

/** A contract state as chainState() caches it, with these markets listed. */
function fakeChainState(chainId: number, symbols: string[]): import('../src/index').ChainState {
  const markets: import('../src/index').ChainState['markets'] = {};
  for (const symbol of symbols) {
    markets[symbol] = {
      symbol,
      listed: true,
      enabled: true,
      delisted: false,
      settlementPrice: null,
      maxLeverage: 5,
      fundingRatePerHour: 0,
      fundingIndex: 0,
      fundingUpdatedAt: Date.now(),
      longOi: 0,
      shortOi: 0,
      maxOi: 10,
      feed: `0x${'55'.repeat(20)}`,
    };
  }
  return {
    chainId,
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    params: {
      openFeeBps: 10,
      closeFeeBps: 10,
      liquidationThresholdBps: 8000,
      liquidatorRewardBps: 1000,
      minLiquidationRewardBps: 50,
      maxProfitBps: 90_000,
      minExecutionDelay: 1,
      maxExecutionDelay: 90_000,
      liquidationPriceAge: 90_000,
      requestPriceAge: 90_000,
      minCollateral: 1,
      minExecutionFee: '0',
      nextOrderId: 1,
    },
    markets,
    pool: { balance: 1000, reserved: 0, available: 1000 },
    readAt: Date.now(),
  };
}

describe('multichain: the registry per network', () => {
  test('Robinhood Chain keeps its registry, untouched', () => {
    assert.equal(perpMarketsOn('robinhood'), PERP_MARKETS);
    assert.deepEqual(
      tradablePerpMarkets().map((m) => m.symbol),
      tradablePerpMarkets('robinhood').map((m) => m.symbol),
    );
    assert.equal(PERP_MARKETS.some((m) => m.category === 'commodities'), false);
  });

  test('Base lists the brief’s four agri markets and Chainlink’s gold and silver; Arbitrum adds WTI', () => {
    assert.deepEqual(
      perpMarketsOn('base').map((m) => m.symbol),
      ['CORN', 'SOYB', 'WEAT', 'COFF', 'XAU', 'XAG'],
    );
    assert.deepEqual(
      perpMarketsOn('arbitrum').map((m) => m.symbol),
      ['CORN', 'SOYB', 'WEAT', 'COFF', 'XAU', 'XAG', 'WTI'],
    );
    const xau = perpMarket('XAU', 'base')!;
    assert.equal(xau.category, 'commodities');
    assert.equal(xau.contracts[0]?.feedId, '0x5213eBB69743b85644dbB6E25cdF994aFBb8cF31');
    assert.equal(perpMarket('XAU', 'arbitrum')?.contracts[0]?.feedId, '0x1F954Dc24a49708C26E0C1777f16750B5C6d5a2c');
    assert.equal(perpMarket('WTI', 'arbitrum')?.contracts[0]?.oracleSymbol, 'WTI / USD');
    for (const m of [...perpMarketsOn('base'), ...perpMarketsOn('arbitrum')]) {
      assert.equal(m.maxLeverage, GAPPING_MAX_LEVERAGE, `${m.symbol}: markets that gap at the weekend stay at 5×`);
      assert.equal(m.maxPositionUsd, NEW_CHAIN_MAX_POSITION_USD, `${m.symbol}: the brief's $50k launch limit`);
      assert.equal(m.schedule, '24/5');
    }
  });

  test('an agri market is coming soon until its feed is deployed on that chain', () => {
    const corn = perpMarket('CORN', 'base')!;
    assert.ok(corn.unavailable?.startsWith('Coming soon'), corn.unavailable);
    assert.match(corn.unavailable ?? '', /on Base/);
    assert.deepEqual(tradablePerpMarkets('base').map((m) => m.symbol), ['XAU', 'XAG']);
    const withFeed = tradablePerpMarkets('base', { reported: { CORN: `0x${'aa'.repeat(20)}` } });
    assert.deepEqual(withFeed.map((m) => m.symbol), ['CORN', 'XAU', 'XAG']);
    assert.equal(withFeed[0]?.contracts[0]?.feedId, `0x${'aa'.repeat(20)}`);
    // Robinhood Chain's own feed addresses never leak onto another chain.
    assert.notEqual(perpMarket('CORN', 'base')?.reported?.roundFeed, perpMarket('CORN')?.reported?.roundFeed);
  });

  test('a symbol without a network resolves anywhere it is listed, Robinhood Chain first', () => {
    assert.equal(perpMarket('XAU')?.name, 'Gold');
    assert.equal(perpMarket('BTC')?.category, 'crypto');
    assert.equal(perpMarket('BTC', 'base'), null);
    assert.equal(perpMarket('PONS', 'arbitrum'), null);
    assert.equal(perpNetworkOfChain(8453), 'base');
    assert.equal(perpNetworkOfChain(84532), 'base');
    assert.equal(perpNetworkOfChain(42161), 'arbitrum');
    assert.equal(perpNetworkOfChain(4663), 'robinhood');
    assert.equal(perpNetworkOfChain(1), null);
  });
});

describe('multichain: networks from the environment', () => {
  test('Base is on once its RPC is set; Arbitrum isn’t', () => {
    assert.deepEqual(core.perpNetworks(), ['robinhood', 'base']);
    const base = core.secondaryDeploymentFor('base')!;
    assert.equal(base.chain.id, 8453);
    assert.equal(base.chain.name, 'Base');
    assert.equal(base.chain.explorerUrl, 'https://basescan.org');
    assert.equal(base.contracts?.perp, `0x${'11'.repeat(20)}`);
    assert.equal(base.deployBlock, 123n);
    assert.deepEqual(base.reportedFeeds, { CORN: `0x${'44'.repeat(20)}` });
    assert.equal(core.secondaryDeploymentFor('arbitrum'), null);
    assert.equal(core.secondaryDeploymentFor('robinhood'), null);
  });

  test('mock feeds never on a network’s mainnet, and a chain that isn’t the network’s is refused', () => {
    process.env.BASE_PERPS_ORACLE = 'mock';
    try {
      assert.equal(core.secondaryDeploymentFor('base')?.oracleMode, 'chainlink');
      process.env.BASE_CHAIN_ID = '84532';
      assert.equal(core.secondaryDeploymentFor('base')?.oracleMode, 'mock');
      assert.equal(core.secondaryDeploymentFor('base')?.chain.name, 'Base Sepolia');
    } finally {
      delete process.env.BASE_PERPS_ORACLE;
      process.env.BASE_CHAIN_ID = '8453';
    }
    process.env.ARB_RPC_URL = 'http://127.0.0.1:9';
    try {
      process.env.ARB_CHAIN_ID = '1';
      assert.equal(core.secondaryDeploymentFor('arbitrum'), null, 'Ethereum mainnet isn’t Arbitrum');
      // The tests' primary chain is Arbitrum Sepolia: two networks can't share a chain.
      process.env.ARB_CHAIN_ID = String(PRIMARY_CHAIN_ID);
      assert.equal(core.secondaryDeploymentFor('arbitrum'), null);
    } finally {
      delete process.env.ARB_RPC_URL;
      delete process.env.ARB_CHAIN_ID;
    }
  });

  test('inside a network’s scope, the chain, venue, contracts, keys and rows are its own', async () => {
    const primaryKey = core.perpKey('perp', 'feeds');
    assert.equal(core.chainConfig()?.id, PRIMARY_CHAIN_ID);
    assert.equal(core.perpsVenue(), 'paper');
    assert.deepEqual(core.perpChainScope(), { chainId: PRIMARY_CHAIN_ID, legacy: true });

    await core.withPerpNetwork('base', async () => {
      assert.equal(core.perpNetwork(), 'base');
      assert.equal(core.chainConfig()?.id, 8453);
      assert.equal(core.perpsVenue(), 'agri-perp', 'no paper venue off the primary');
      assert.equal(core.agriPerpContracts()?.vault, `0x${'22'.repeat(20)}`);
      assert.notEqual(core.perpKey('perp', 'feeds'), primaryKey);
      assert.deepEqual(core.perpChainScope(), { chainId: 8453, legacy: false });
      assert.deepEqual(core.tradableHere().map((m) => m.symbol), ['CORN', 'XAU', 'XAG'], 'CORN from BASE_REPORTED_FEEDS');
      assert.equal(core.perpDeployBlock(), 123n);
      // Across an await, still Base.
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(core.chainConfig()?.id, 8453);
      // And back to the primary, nested.
      await core.withPerpNetwork('robinhood', async () => {
        assert.equal(core.chainConfig()?.id, PRIMARY_CHAIN_ID);
        assert.equal(core.perpsVenue(), 'paper');
        assert.equal(core.perpKey('perp', 'feeds'), primaryKey);
      });
    });
    assert.equal(core.chainConfig()?.id, PRIMARY_CHAIN_ID);
    assert.throws(() => core.withPerpNetwork('arbitrum', () => 1), core.PerpNetworkOff);
  });

  test('the chain switcher’s list: each network’s chain, with a public endpoint for the wallet', () => {
    const chains = core.perpChainInfos();
    assert.deepEqual(chains.map((c) => c.network), ['robinhood', 'base']);
    const base = chains[1]!;
    assert.equal(base.chainId, 8453);
    assert.equal(base.rpcUrl, 'https://mainnet.base.org', 'never the server’s own endpoint (it may carry a key)');
    assert.equal(base.venue, 'agri-perp');
    assert.equal(base.testnet, false);
    assert.deepEqual(base.features, { rhTokens: false, gap: false });
    assert.equal(chains[0]?.features.rhTokens, true);
  });

  test('network ids of stored rows', () => {
    assert.equal(core.perpNetworkForChainId(null), 'robinhood');
    assert.equal(core.perpNetworkForChainId(PRIMARY_CHAIN_ID), 'robinhood');
    assert.equal(core.perpNetworkForChainId(8453), 'base');
    assert.equal(core.perpNetworkForChainId(42161), null, 'not run here');
  });
});

describe('multichain: caches and rows per network', () => {
  test('each network’s prices, and its markets, are its own', async () => {
    const now = Math.floor(Date.now() / 1000);
    await core.withPerpNetwork('base', async () => {
      await getCache().set(core.perpKey('perp', 'chain'), fakeChainState(8453, ['XAU', 'CORN']), 60);
      await core.writeFeedPrices([
        { symbol: 'XAU', feed: '0x5213eBB69743b85644dbB6E25cdF994aFBb8cF31', price: 4170, publishTime: now - 30, roundId: '1', source: 'chainlink' },
      ]);
    });
    await core.writeFeedPrices([
      { symbol: 'BTC', feed: perpMarket('BTC')!.contracts[0]!.feedId, price: 83_000, publishTime: now - 30, roundId: '1', source: 'fixture' },
    ]);

    const primaryFeeds = (await core.readFeedPrices())?.feeds ?? {};
    assert.equal(primaryFeeds.XAU, undefined, 'Base’s gold never shows on Robinhood Chain');
    assert.equal(primaryFeeds.BTC?.price, 83_000);

    await core.withPerpNetwork('base', async () => {
      const feeds = (await core.readFeedPrices())?.feeds ?? {};
      assert.equal(feeds.BTC, undefined);
      const views = await core.perpMarketViews();
      assert.deepEqual(views.map((m) => m.symbol), ['CORN', 'SOYB', 'WEAT', 'COFF', 'XAU', 'XAG']);
      const xau = views.find((m) => m.symbol === 'XAU')!;
      assert.equal(xau.price, 4170);
      assert.equal(xau.category, 'commodities');
      assert.equal(xau.maxPositionUsd, NEW_CHAIN_MAX_POSITION_USD);
      // Listed on the contract, no price yet: closed, not unavailable.
      assert.equal(views.find((m) => m.symbol === 'CORN')?.status, 'closed');
      assert.equal(views.find((m) => m.symbol === 'SOYB')?.status, 'unavailable');
      // XAG has a feed but isn't listed on this (fake) contract yet.
      assert.equal(views.find((m) => m.symbol === 'XAG')?.status, 'unavailable');
      assert.equal(await core.perpMarketStats('BTC'), null);
    });
    assert.equal((await core.perpMarketViews()).some((m) => m.symbol === 'XAU'), false);
  });

  test('positions and actions are read per chain; the primary keeps its rows from before chain ids', async () => {
    const store = getPerpStore();
    const user = await newUser();
    const row = (chainId: number | null, symbol: string) => ({
      userId: user.id,
      address: user.address.toLowerCase(),
      venue: chainId == null ? ('paper' as const) : ('agri-perp' as const),
      chainId,
      chainPositionId: chainId == null ? null : String(Math.floor(Math.random() * 1e9)),
      symbol,
      category: perpMarket(symbol)!.category,
      side: 'long' as const,
      collateral: 10,
      size: 50,
      leverage: 5,
      entryPrice: 1,
      entryIndex: 1,
      entryFunding: 0,
      reserve: 50,
      fee: 0.05,
      status: 'open' as const,
      exitPrice: null,
      exitIndex: null,
      realizedPnl: null,
      fundingPaid: null,
      payout: null,
      liquidationReward: null,
      txOpen: null,
      txClose: null,
      openedAt: new Date().toISOString(),
      closedAt: null,
    });
    await store.insertPosition(row(null, 'BTC'));
    await store.insertPosition(row(PRIMARY_CHAIN_ID, 'ETH'));
    await store.insertPosition(row(8453, 'XAU'));

    const symbols = async (scope: import('@robinchan/store').PerpChainScope) =>
      (await store.listPositions({ chain: scope, address: user.address, limit: 50 })).map((p) => p.symbol).sort();
    assert.deepEqual(await symbols({ chainId: PRIMARY_CHAIN_ID, legacy: true }), ['BTC', 'ETH']);
    assert.deepEqual(await symbols({ chainId: 8453, legacy: false }), ['XAU']);
    const oi = await store.openInterest('agri-perp', { chainId: 8453, legacy: false });
    assert.deepEqual(oi.map((o) => o.symbol), ['XAU']);

    const action = (id: string, chainId: number | null) =>
      store.insertAction({
        id,
        userId: user.id,
        address: user.address.toLowerCase(),
        kind: 'deposit',
        venue: 'agri-perp',
        symbol: null,
        positionId: null,
        amount: 5,
        status: 'pending',
        quote: { id, kind: 'deposit', amount: 5, address: user.address, venue: 'agri-perp', expiresAt: new Date().toISOString(), execution: { kind: 'transactions', txs: [] } },
        chainId,
        chainOrderId: null,
        txHash: null,
        txHashes: [],
        signature: null,
        error: null,
        expiresAt: null,
        checkedAt: null,
      });
    const onBase = crypto.randomUUID();
    await action(onBase, 8453);
    await action(crypto.randomUUID(), null);
    const ids = async (scope: import('@robinchan/store').PerpChainScope) =>
      (await store.listActions({ chain: scope, userId: user.id, limit: 50 })).map((a) => a.chainId ?? null);
    assert.deepEqual(await ids({ chainId: 8453, legacy: false }), [8453]);
    assert.deepEqual(await ids({ chainId: PRIMARY_CHAIN_ID, legacy: true }), [null]);

    // An order on Base, asked about on Robinhood Chain: told where it is.
    await rejects(core.perpAction(user, onBase), 'CONFLICT', /on Base/);
    // …and on Base itself, found.
    const record = await core.withPerpNetwork('base', () => core.perpAction(user, onBase));
    assert.equal(record.id, onBase);
  });

  test('a market another network lists isn’t quoted here', async () => {
    const user = await newUser();
    await core.withPerpNetwork('base', async () => {
      await rejects(core.quotePerpOpen(user, { symbol: 'BTC', side: 'long', collateral: 10, leverage: 2 }), 'NOT_FOUND');
      await rejects(core.quotePerpOpen(user, { symbol: 'SOYB', side: 'long', collateral: 10, leverage: 2 }), 'NOT_TRADABLE', /Base/);
    });
    await rejects(core.quotePerpOpen(user, { symbol: 'XAU', side: 'long', collateral: 10, leverage: 2 }), 'NOT_FOUND');
  });
});

describe('multichain: deploy files', () => {
  test('contracts/deploy/{base,arbitrum}/ match the registry (regenerate with scripts/perps-markets.mts)', () => {
    for (const network of ['base', 'arbitrum'] as const) {
      const read = (file: string) => JSON.parse(readFileSync(new URL(`../../../contracts/deploy/${network}/${file}`, import.meta.url), 'utf8'));
      assert.deepEqual(read('markets.json'), core.perpMarketsForDeploy(network));
      assert.deepEqual(read('reported-feeds.json'), core.reportedFeedsForDeploy(network));
    }
    assert.deepEqual(core.perpMarketsForDeploy('base').map((m) => m.symbol), ['XAU', 'XAG']);
    assert.deepEqual(core.perpMarketsForDeploy('arbitrum').map((m) => m.symbol), ['XAU', 'XAG', 'WTI']);
    assert.deepEqual(core.reportedFeedsForDeploy('base').map((m) => m.symbol), ['CORN', 'SOYB', 'WEAT', 'COFF']);
    // Robinhood Chain's deploy lists what it always did.
    assert.deepEqual(core.perpMarketsForDeploy('robinhood'), core.perpMarketsForDeploy());
  });
});
