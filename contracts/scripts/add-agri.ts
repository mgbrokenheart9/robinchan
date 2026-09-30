/**
 * Adds the agri feeds (corn, soybeans, wheat, coffee) to a network launched
 * on the budget (npm run add-agri:base). Prints the one variable to add.
 */
process.env.ADD_AGRI = 'true';
await import('./launch-network.js');
