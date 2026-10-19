#!/usr/bin/env node
// D-43/D-44: a CLI around 03-02's floorEffectReport, printed over the real
// private store, one line per check in the gate file's own canonical order.
// This is a report, not a gate: the sign-off reviewer role (A6) decides each floor effect
// (D-44), so this script never fails the build on one existing — it always
// exits 0, even on an unexpected error (printed to stderr for visibility).
//
//   node scripts/phase3-floor-effect-report.mjs

import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { getDb } from "../src/app/server/db.ts";
import { loadGateFile, resolveGatesPath } from "../src/pipeline/coding/contract.ts";
import { ensurePipelineSchema } from "../src/pipeline/store/results.ts";
import { floorEffectReport } from "../src/pipeline/store/floor-effect.ts";

export async function main() {
  const db = getDb();
  await ensurePipelineSchema(db);
  const gateFile = loadGateFile(resolveGatesPath());
  const rows = await floorEffectReport(db, gateFile);
  for (const row of rows) {
    process.stdout.write(`${row.checkId}: passPlusClaimed=${row.passPlusClaimed}${row.isFloorEffect ? " FLOOR-EFFECT" : ""}\n`);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main()
    .catch((err) => {
      process.stderr.write(`${err?.stack ?? err}\n`);
    })
    .finally(() => process.exit(0));
}
