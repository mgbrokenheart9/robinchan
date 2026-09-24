import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Every test file imports this first: a throwaway `.data/` directory and a
 * dev environment, set before any module reads them. Nothing here touches
 * the real `.data/` or a database — DATABASE_URL is cleared.
 */
process.env.RC_DATA_DIR = mkdtempSync(join(tmpdir(), 'robinchan-test-'));
process.env.RC_ENV = 'dev';
process.env.DATABASE_URL = '';
process.env.POSTGRES_URL = '';
process.env.FEATURE_TRADING = 'true';
process.env.FEATURE_HEAT_READS = 'true';
process.env.RC_VENUE = 'paper';
process.env.RC_PAPER_ONCHAIN = 'false';
process.env.PROTOCOL_FEE_BPS = '10';
process.env.DEFAULT_SLIPPAGE_BPS = '50';
// No real chain in tests: an unroutable RPC, so nothing waits on the network.
process.env.NEXT_PUBLIC_CHAIN_ID = '421614';
process.env.NEXT_PUBLIC_RPC_URL = 'http://127.0.0.1:9';
process.env.RC_TOKENS = '';
process.env.MEGALLM_API_KEY = '';
