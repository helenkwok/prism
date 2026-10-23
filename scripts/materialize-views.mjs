#!/usr/bin/env node
// Build ReportView rows from the synthetic corpus and write them to the app's
// database (plan 07-03). Usage:
//   node scripts/materialize-views.mjs --fixture <corpus.json> [--db <sqlite>] [--js-gate]
// Without --db it writes to PRISM_DATA_DIR/prism.sqlite (getDb). The gate is
// the pinned Python gate (runGate) unless --js-gate is passed, which uses the
// vendored JS evaluator (CI's test job has no Python venv; the gate job proves
// the two agree on this corpus). Plan 07-06 adds the de-identified view and
// access rows; plan 07-14 adds the real-store mode.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

import { loadCodebook } from "../src/pipeline/coding/codebook-prompt.ts";
import { runGate } from "../src/pipeline/gate/run-gate.ts";
import { ensureReportViewSchema, upsertReportView } from "../src/report/store.ts";
import { buildReportView, gateCheckOrder, loadGapText, sourceFromFixture } from "../src/report/view.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gatesPath = path.join(root, "vendor", "ai-output-to-value", "schemas", "v1", "decision-gates.json");

const { values } = parseArgs({ options: { fixture: { type: "string" }, db: { type: "string" }, "js-gate": { type: "boolean" } } });
if (!values.fixture) {
  console.error("usage: materialize-views.mjs --fixture <corpus.json> [--db <sqlite>] [--js-gate]");
  process.exit(2);
}

async function jsGate() {
  const { evaluateClaim, loadBundledGates } = await import("../vendor/ai-output-to-value/packages/mcp/src/core.mjs");
  const pin = JSON.parse(fs.readFileSync(path.join(root, "vendor", "ai-output-to-value", "PIN.json"), "utf8"));
  const gateSha = `js:${pin.files["packages/mcp/src/core.mjs"].sha256}`;
  return async (record) => ({ status: evaluateClaim(record, loadBundledGates()).status, raw: null, gateSha });
}

const gate = values["js-gate"] ? await jsGate() : (record) => runGate(record, { repoRoot: root });

let db;
if (values.db) {
  db = new Kysely({ dialect: new SqliteDialect({ database: new Database(values.db) }) });
} else {
  const { getDb } = await import("../src/app/server/db.ts");
  db = getDb();
}

const corpus = JSON.parse(fs.readFileSync(values.fixture, "utf8"));
const codebook = loadCodebook(path.join(root, "codebook.md"));
const gapText = loadGapText({ repoRoot: root, codebook });
const order = gateCheckOrder(gatesPath);

await ensureReportViewSchema(db);
let rows = 0;
for (const p of corpus.projects) {
  const view = await buildReportView(sourceFromFixture(corpus, p, order), { codebook, gatesPath, runGate: gate, gapText });
  await upsertReportView(db, view);
  rows++;
  const sources = [...new Set(view.checks.map((c) => c.gapSource).filter(Boolean))].join(",") || "none";
  console.log(`REPORT project=${view.projectRef} view=${view.view} decisions=${view.decisions.length} checks=${view.checks.length} gapSource=${sources}`);
}
console.log(`REPORT rows=${rows}`);
await db.destroy();
