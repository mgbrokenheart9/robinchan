/**
 * The budget launch (npm run launch:base:hemat, launch:arbitrum:hemat): Chainlink's markets
 * only (gold, silver; oil on Arbitrum) — no agri feeds, so the keeper spends no gas on their prices —
 * and a 2 USDC pool seed — enough for its owner and a couple of testers. Add the agri markets later with
 * `npm run add-agri:base`. Everything else as launch-network.ts.
 */
process.env.AGRI = 'false';
if (!process.env.SEED_LIQUIDITY_USDC?.trim()) process.env.SEED_LIQUIDITY_USDC = '2';
await import('./launch-network.js');
