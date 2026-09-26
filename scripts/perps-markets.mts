/**
 * Writes contracts/deploy/markets.json from the perps market registry in
 * @robinchan/shared — the one list of markets and Chainlink feeds — so the
 * deploy script lists exactly what the app shows. A core test fails if the
 * two ever drift apart.
 *
 *   npx tsx scripts/perps-markets.mts
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { perpMarketsForDeploy } from '../packages/core/src/perps/deploy-config';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'contracts', 'deploy', 'markets.json');
writeFileSync(out, `${JSON.stringify(perpMarketsForDeploy(), null, 2)}\n`);
console.log(`wrote ${out}`);
