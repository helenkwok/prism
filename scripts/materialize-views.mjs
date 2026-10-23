#!/usr/bin/env node
// Build ReportView rows from the synthetic corpus and write them to the app's
// database (plan 07-03). Usage:
//   node scripts/materialize-views.mjs --fixture <corpus.json> [--db <sqlite>] [--js-gate]
//        [--deidentify [--key-file <path>]]
// Without --db it writes to PRISM_DATA_DIR/prism.sqlite (getDb). The gate is
// the pinned Python gate (runGate) unless --js-gate is passed, which uses the
// vendored JS evaluator (CI's test job has no Python venv; the gate job proves
// the two agree on this corpus).
//
// --deidentify (plan 07-06, APP-03 / D-81) also builds the de-identified view
// of every sampled project (after all identifiable views: document frequency
// needs the whole corpus) and an app_project_access row per project. The
// pseudonym key comes from --key-file, else PRISM_PSEUDONYM_KEY, else
// ~/Library/Application Support/prism/pseudonym.key; there is no default key.
// Every row is written in one transaction, and only after every check passes;
// a refusal prints "DEID REFUSED <reason>", writes nothing and exits 1.
// Output names pseudonyms only, never a project name or host. Plan 07-14 adds
// the real-store mode.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

import { ensureAccessSchema, upsertProjectAccess } from "../src/app/server/access-store.ts";
import { loadCodebook } from "../src/pipeline/coding/codebook-prompt.ts";
import { runGate } from "../src/pipeline/gate/run-gate.ts";
import { buildDocumentFrequency, deidentifyView, dictionaryOf } from "../src/report/deidentify.ts";
import { ensureReportViewSchema, upsertReportView } from "../src/report/store.ts";
import { buildReportView, gateCheckOrder, loadGapText, sourceFromFixture } from "../src/report/view.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gatesPath = path.join(root, "vendor", "ai-output-to-value", "schemas", "v1", "decision-gates.json");

const { values } = parseArgs({
  options: {
    fixture: { type: "string" },
    db: { type: "string" },
    "js-gate": { type: "boolean" },
    deidentify: { type: "boolean" },
    "key-file": { type: "string" },
  },
});
if (!values.fixture) {
  console.error("usage: materialize-views.mjs --fixture <corpus.json> [--db <sqlite>] [--js-gate] [--deidentify [--key-file <path>]]");
  process.exit(2);
}

function refuse(reason) {
  console.log(`DEID REFUSED ${reason}`);
  process.exit(1);
}

/** The pseudonym key, never printed. */
function readKey() {
  const file = values["key-file"] ?? (process.env.PRISM_PSEUDONYM_KEY ? null : path.join(os.homedir(), "Library", "Application Support", "prism", "pseudonym.key"));
  const key = file ? (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "") : process.env.PRISM_PSEUDONYM_KEY.trim();
  if (!key) refuse("no-key");
  // A short key lets anyone with the inclusion list brute-force the pseudonyms (T-07-22).
  if (key.length < 16) refuse("weak-key");
  return key;
}

async function jsGate() {
  const { evaluateClaim, loadBundledGates } = await import("../vendor/ai-output-to-value/packages/mcp/src/core.mjs");
  const pin = JSON.parse(fs.readFileSync(path.join(root, "vendor", "ai-output-to-value", "PIN.json"), "utf8"));
  const gateSha = `js:${pin.files["packages/mcp/src/core.mjs"].sha256}`;
  return async (record) => ({ status: evaluateClaim(record, loadBundledGates()).status, raw: null, gateSha });
}

const key = values.deidentify ? readKey() : null;
const gate = values["js-gate"] ? await jsGate() : (record) => runGate(record, { repoRoot: root });

const corpus = JSON.parse(fs.readFileSync(values.fixture, "utf8"));
const codebook = loadCodebook(path.join(root, "codebook.md"));
const gapText = loadGapText({ repoRoot: root, codebook });
const order = gateCheckOrder(gatesPath);

// Build everything in memory first; nothing is written until every check passes.
const built = [];
for (const p of corpus.projects) {
  const view = await buildReportView(sourceFromFixture(corpus, p, order), { codebook, gatesPath, runGate: gate, gapText });
  built.push({ p, view });
  const sources = [...new Set(view.checks.map((c) => c.gapSource).filter(Boolean))].join(",") || "none";
  console.log(`REPORT project=${view.projectRef} view=${view.view} decisions=${view.decisions.length} checks=${view.checks.length} gapSource=${sources}`);
}

const deids = [];
if (key) {
  const sampled = built.filter((b) => b.p.access?.in_sample === true);
  const corpusDf = buildDocumentFrequency(sampled.map((b) => b.view));
  for (const b of sampled) {
    const dictionary = dictionaryOf(b.view);
    const { view, counts } = deidentifyView(b.view, { dictionary, corpus: corpusDf, key });
    b.pseudonym = view.projectRef;
    deids.push({ view, dictionary });
    console.log(`DEID project=${view.projectRef} masked_terms=${counts.maskedTerms} df_masked=${counts.dfMasked} ngram_breaks=${counts.ngramBreaks}`);
  }
}

let db;
if (values.db) {
  db = new Kysely({ dialect: new SqliteDialect({ database: new Database(values.db) }) });
} else {
  const { getDb } = await import("../src/app/server/db.ts");
  db = getDb();
}
await ensureReportViewSchema(db);
if (key) await ensureAccessSchema(db);

const fixture = corpus.synthetic === true;
let rows = 0;
await db.transaction().execute(async (trx) => {
  for (const b of built) {
    await upsertReportView(trx, b.view);
    rows++;
  }
  if (!key) return;
  // A new key renames every pseudonym: drop this run's earlier de-identified rows and free the pseudonyms first.
  await trx.deleteFrom("app_report_view").where("view", "=", "deidentified").where("fixture", "=", fixture ? 1 : 0).execute();
  await trx.updateTable("app_project_access").set({ pseudonym: null }).where("project_id", "in", built.map((b) => b.view.projectRef)).execute();
  for (const d of deids) {
    await upsertReportView(trx, d.view);
    rows++;
  }
  for (const { p, pseudonym } of built) {
    const a = p.access ?? {};
    await upsertProjectAccess(trx, {
      projectId: p.projectId,
      title: p.title,
      basis: a.basis ?? null,
      sponsorHold: a.sponsorHold === true,
      inSample: a.in_sample === true,
      pseudonym: pseudonym ?? null,
      liveBoundaryJson: a.liveBoundary ? JSON.stringify(a.liveBoundary) : null,
      fixture,
    });
  }
});
console.log(`REPORT rows=${rows}`);
await db.destroy();
