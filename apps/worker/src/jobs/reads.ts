import { HEAT_READ_TOP } from '@robinchan/shared';
import { heatInputsHash, heatUniverseForReads, readIsCurrent, refreshHeatRead } from '@robinchan/core';
import { getDb } from '@robinchan/store';

import { log } from '../lib/log.js';

/**
 * Robinchan's heat reads, on the heat score's schedule (Heat §5): generated
 * here for the 20 hottest symbols, stored, and served from the table —
 * never generated on the click that opens a row. The rest are made on
 * demand the first time a Tier 1 viewer opens one.
 *
 * A read is only regenerated when what it would say changed, and at most
 * `MAX_GENERATIONS` per run, so a noisy five minutes can't turn into twenty
 * LLM calls; whatever's left over keeps its previous read until next run.
 */
const MAX_GENERATIONS = 6;

export async function runHeatReads(): Promise<void> {
  const db = getDb();
  const universe = (await heatUniverseForReads()).slice(0, HEAT_READ_TOP);
  let written = 0;
  let kept = 0;
  let deferred = 0;

  for (const u of universe) {
    const drivers = await db.getNewsByIds(u.row.components.news.drivers.slice(0, 3));
    const input = { row: u.row, rank: u.rank, drivers, changePct: u.changePct };
    if (readIsCurrent(await db.getHeatRead(u.row.symbol), heatInputsHash(input))) {
      kept += 1;
      continue;
    }
    if (written >= MAX_GENERATIONS) {
      deferred += 1;
      continue;
    }
    if ((await refreshHeatRead(input)) === 'written') written += 1;
    else kept += 1;
  }
  log.info('reads', `heat reads: ${written} written, ${kept} unchanged${deferred ? `, ${deferred} deferred` : ''}`);
}
