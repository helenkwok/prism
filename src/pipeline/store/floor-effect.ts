// D-43: the pilot's floor-effect report — flags a check whose pass+claimed
// count across the pilot's recorded results is exactly zero, matching
// VAL-03's "checks with fewer than ~10 gold passes are not estimable" bar
// applied at the 20-project pilot scale. Reuses readTally() verbatim; never
// a second query over pipeline_check_states.

import type { Kysely } from "kysely";

import { readTally } from "./results.ts";

export interface FloorEffectRow {
  checkId: string;
  passPlusClaimed: number;
  isFloorEffect: boolean;
}

/**
 * Does not itself assume exactly 20 projects were recorded — the caller is
 * responsible for having recorded exactly the pilot's 20 (D-43).
 */
export async function floorEffectReport(db: Kysely<any>, gateFile: { checkIds: string[] }): Promise<FloorEffectRow[]> {
  const tally = await readTally(db, gateFile);
  return tally.map((row) => {
    const passPlusClaimed = row.counts.pass + row.counts.claimed;
    return { checkId: row.checkId, passPlusClaimed, isFloorEffect: passPlusClaimed === 0 };
  });
}
