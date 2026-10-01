import hardhatToolboxViemPlugin from '@nomicfoundation/hardhat-toolbox-viem';
import { configVariable, defineConfig } from 'hardhat/config';

/**
 * Agri perps contracts. `hardhat test` runs on the in-process EDR network;
 * `hardhat node` + `--network localhost` is the local chain the app's
 * end-to-end check runs against; `rhTestnet` and `rhMainnet` are Robinhood
 * Chain (chain ids 46630 and 4663); `base`, `arbitrum` and their Sepolia
 * testnets carry the same stack there (Multichain brief). The RPC URLs and the deployer key come
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
  // Base and Arbitrum have one too (base.blockscout.com, arbitrum.blockscout.com), and
  // BaseScan/Arbiscan: with ETHERSCAN_API_KEY set (one Etherscan V2 key covers both, in the
  // environment or `npx hardhat keystore set ETHERSCAN_API_KEY` plus VERIFY_ETHERSCAN=true),
  // `verify --network base` verifies on both explorers.
  verify: {
    blockscout: { enabled: true },
    etherscan:
      process.env.ETHERSCAN_API_KEY || process.env.VERIFY_ETHERSCAN === 'true'
        ? { apiKey: configVariable('ETHERSCAN_API_KEY') }
        : { enabled: false },
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

    /*
     * Base and Arbitrum One (Multichain brief): the same stack, deployed again
     * — AgriFeed listing Chainlink's gold, silver (and, on Arbitrum, WTI oil)
     * proxies, and a ReportedRoundFeed per agri market. Read contracts/MAINNET.md
     * §15 first. The public endpoints rate-limit bursts; a provider's URL with
     * a key (Alchemy, QuickNode, …) deploys without retries.
     */
    // With no BASE_RPC_URL / ARB_RPC_URL set, the chains' official endpoints (publicnode began
    // refusing deploys with HTTP 403 on 2026-10-01; dRPC's free tier rate-limits a deploy's bursts).
    base: {
      type: 'http',
      chainType: 'op',
      chainId: 8453,
      url: process.env.BASE_RPC_URL ? configVariable('BASE_RPC_URL') : 'https://base.gateway.tenderly.co',
      accounts: [configVariable('DEPLOYER_PRIVATE_KEY')],
    },
    baseSepolia: {
      type: 'http',
      chainType: 'op',
      chainId: 84532,
      url: configVariable('BASE_SEPOLIA_RPC_URL'),
      accounts: [configVariable('DEPLOYER_PRIVATE_KEY')],
    },
    arbitrum: {
      type: 'http',
      chainType: 'generic',
      chainId: 42161,
      url: process.env.ARB_RPC_URL ? configVariable('ARB_RPC_URL') : 'https://arb1.arbitrum.io/rpc',
      accounts: [configVariable('DEPLOYER_PRIVATE_KEY')],
    },
    arbitrumSepolia: {
      type: 'http',
      chainType: 'generic',
      chainId: 421614,
      url: configVariable('ARB_SEPOLIA_RPC_URL'),
      accounts: [configVariable('DEPLOYER_PRIVATE_KEY')],
    },
    // A second local node standing in for Base Sepolia, beside `localhost`
    // (Robinhood Chain's): `npx hardhat node --chain-id 84532 --port 8546`.
    // The multichain end-to-end check (scripts/e2e-multichain.mts) runs on it.
    baseLocal: {
      type: 'http',
      chainType: 'generic',
      url: 'http://127.0.0.1:8546',
    },
    // Local copies of Base and Arbitrum mainnet — their real Chainlink feeds
    // and USDC, Hardhat's funded accounts — to rehearse the deploy for free.
    baseFork: {
      type: 'edr-simulated',
      chainType: 'op',
      chainId: 8453,
      forking: { url: configVariable('BASE_RPC_URL') },
    },
    arbitrumFork: {
      type: 'edr-simulated',
      chainType: 'generic',
      chainId: 42161,
      forking: { url: configVariable('ARB_RPC_URL') },
    },
  },
});
