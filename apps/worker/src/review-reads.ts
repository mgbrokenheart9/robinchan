import { join } from 'node:path';

import { config as loadEnv } from 'dotenv';
import { getDb, repoRoot } from '@robinchan/store';

loadEnv({ path: join(repoRoot(), '.env'), quiet: true });

const { soundsLikeAdvice } = await import('@robinchan/core');

/**
 * `npm run reads -w @robinchan/worker` — prints every stored heat read for a
 * human to review before `FEATURE_HEAT_READS` is switched on (Heat §6:
 * "tinjau keluarannya sebelum fitur ini dibuka"). Anything the advice guard
 * would flag today is marked, even if it passed when it was written.
 */
const reads = await getDb().listHeatReads();
if (reads.length === 0) {
  console.log('No heat reads stored yet. The worker writes them after each heat run.');
} else {
  for (const r of reads) {
    const flag = soundsLikeAdvice(r.text) ? '  ⚠ reads like advice' : '';
    console.log(`\n${r.symbol}  [${r.source}]  ${r.computedAt}${flag}\n  ${r.text}`);
  }
  console.log(`\n${reads.length} read(s). Serving is ${process.env.FEATURE_HEAT_READS === 'true' ? 'ON' : 'OFF'} (FEATURE_HEAT_READS).`);
}
await getDb().close();
