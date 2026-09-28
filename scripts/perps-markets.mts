/**
 * Writes contracts/deploy/markets.json (the markets and their Chainlink
 * feeds), contracts/deploy/pyth-feeds.json (the agri markets Pyth prices) and
 * contracts/deploy/reported-feeds.json (the agri markets the operator prices)
 * from the perps market registry in @robinchan/shared, so the deploy scripts
 * list exactly what the app shows. A core test fails if they ever drift apart.
 *
 *   npx tsx scripts/perps-markets.mts
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { perpMarketsForDeploy, pythFeedsForDeploy, reportedFeedsForDeploy } from '../packages/core/src/perps/deploy-config';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'contracts', 'deploy');
for (const [file, data] of [
  ['markets.json', perpMarketsForDeploy()],
  ['pyth-feeds.json', pythFeedsForDeploy()],
  ['reported-feeds.json', reportedFeedsForDeploy()],
] as const) {
  writeFileSync(join(dir, file), `${JSON.stringify(data, null, 2)}\n`);
  console.log(`wrote ${join(dir, file)}`);
}
