import hardhatToolboxViemPlugin from '@nomicfoundation/hardhat-toolbox-viem';
import { configVariable, defineConfig } from 'hardhat/config';

/**
 * Agri perps contracts. `hardhat test` runs on the in-process EDR network;
 * `hardhat node` + `--network localhost` is the local chain the app's
 * end-to-end check runs against; `rhTestnet` and `rhMainnet` are Robinhood
 * Chain (chain ids 46630 and 4663). The RPC URLs and the deployer key come
 * from Hardhat's encrypted keystore (`npx hardhat keystore set NAME`) or the
 * environment — never from this file. See MAINNET.md before `rhMainnet`.
 */
export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  // viaIR: the events carry every figure the indexer needs, which is more
  // stack slots than the legacy code generator can juggle.
  solidity: {
    profiles: {
      default: {
        version: '0.8.28',
        settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true },
      },
      production: {
        version: '0.8.28',
        settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true },
      },
    },
  },
  chainDescriptors: {
    4663: {
      name: 'Robinhood Chain',
      chainType: 'generic',
      blockExplorers: {
        blockscout: {
          name: 'Robinhood Chain Blockscout',
          url: 'https://robinhoodchain.blockscout.com',
          apiUrl: 'https://robinhoodchain.blockscout.com/api',
        },
      },
    },
  },
  // Robinhood Chain's explorer is a Blockscout: `npx hardhat verify --network rhMainnet …`.
  verify: {
    blockscout: { enabled: true },
    etherscan: { enabled: false },
    sourcify: { enabled: false },
  },
  networks: {
    hardhatMainnet: {
      type: 'edr-simulated',
      chainType: 'l1',
    },
    localhost: {
      type: 'http',
      chainType: 'l1',
      url: 'http://127.0.0.1:8545',
    },
    rhTestnet: {
      type: 'http',
      chainType: 'generic',
      chainId: 46630,
      url: configVariable('RH_TESTNET_RPC_URL'),
      accounts: [configVariable('DEPLOYER_PRIVATE_KEY')],
    },
    // Robinhood's own RPC (rpc.mainnet.chain.robinhood.com) is blocked by
    // Indonesian ISPs: use a provider's, e.g. https://robinhood.drpc.org or
    // an Alchemy/QuickNode endpoint with a key.
    rhMainnet: {
      type: 'http',
      chainType: 'generic',
      chainId: 4663,
      url: configVariable('RH_MAINNET_RPC_URL'),
      accounts: [configVariable('DEPLOYER_PRIVATE_KEY')],
    },
    // A local copy of Robinhood Chain mainnet — the real Chainlink feeds, USDC
    // and Safe contracts, Hardhat's funded test accounts — to rehearse the
    // mainnet deploy without spending anything (MAINNET.md).
    rhMainnetFork: {
      type: 'edr-simulated',
      chainType: 'generic',
      chainId: 4663,
      forking: { url: configVariable('RH_MAINNET_RPC_URL') },
    },
  },
});
