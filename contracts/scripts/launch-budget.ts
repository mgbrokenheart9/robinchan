/**
 * The budget launch (npm run launch:base:hemat): gold and silver on Chainlink
 * only — no agri feeds, so the keeper spends no gas posting their prices —
 * and a 5 USDC pool seed. Add the agri markets later with
 * `npm run add-agri:base`. Everything else as launch-network.ts.
 */
process.env.AGRI = 'false';
if (!process.env.SEED_LIQUIDITY_USDC?.trim()) process.env.SEED_LIQUIDITY_USDC = '5';
await import('./launch-network.js');
