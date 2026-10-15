// Runnable CLI: `node src/pipeline/tally.ts` prints the per-check tally from
// the private store (success criterion 5). Node 24 strips this file's types
// natively — no build step.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getDb } from "../app/server/db.ts";
import { loadGateFile, resolveGatesPath } from "./coding/contract.ts";
import { ensurePipelineSchema, readTally } from "./store/results.ts";

const PROJECT_COUNT = 10;

export async function printTally(): Promise<void> {
  const db = getDb();
  await ensurePipelineSchema(db);
  const gateFile = loadGateFile(resolveGatesPath());
  const tally = await readTally(db, gateFile);
  for (const row of tally) {
    const { pass, fail, unknown, claimed } = row.counts;
    process.stdout.write(
      `${row.checkId}: pass ${pass}, fail ${fail}, unknown ${unknown}, claimed ${claimed} (of N=${PROJECT_COUNT})\n`,
    );
  }
}

// Same guard check-data-dir.mjs uses: importing this module for a test must
// never trigger the print.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.basename(process.argv[1]) === "tally.ts" &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  printTally().catch((err) => {
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
