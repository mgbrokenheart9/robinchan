/**
 * Writes contracts/deploy/markets.json (the markets and their Chainlink
 * feeds), contracts/deploy/pyth-feeds.json (the agri markets Pyth prices) and
 * contracts/deploy/reported-feeds.json (the agri markets the operator prices)
 * and contracts/deploy/twap-feeds.json (the RH Tokens, priced by their pools)
 * from the perps market registry in @robinchan/shared, so the deploy scripts
 * list exactly what the app shows. A core test fails if they ever drift apart.
 *
 * Base and Arbitrum (Multichain brief) get their own directory each —
 * contracts/deploy/base/ and contracts/deploy/arbitrum/ — with their
 * markets.json (Chainlink's gold, silver and oil there) and
 * reported-feeds.json (their agri markets).
 *
 *   npx tsx scripts/perps-markets.mts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { perpMarketsForDeploy, pythFeedsForDeploy, reportedFeedsForDeploy, twapFeedsForDeploy } from '../packages/core/src/perps/deploy-config';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'contracts', 'deploy');
const files: Array<readonly [string, unknown]> = [
  ['markets.json', perpMarketsForDeploy()],
  ['pyth-feeds.json', pythFeedsForDeploy()],
  ['reported-feeds.json', reportedFeedsForDeploy()],
  ['twap-feeds.json', twapFeedsForDeploy()],
  ...(['base', 'arbitrum'] as const).flatMap((network) => [
    [`${network}/markets.json`, perpMarketsForDeploy(network)] as const,
    [`${network}/reported-feeds.json`, reportedFeedsForDeploy(network)] as const,
  ]),
];
for (const [file, data] of files) {
  const path = join(dir, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`wrote ${path}`);
}
