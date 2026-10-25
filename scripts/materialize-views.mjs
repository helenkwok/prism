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
// Output names pseudonyms only, never a project name or host.
//
// --store (plan 07-14) builds the real sample from PRISM_DATA_DIR on the Mac:
//   node scripts/materialize-views.mjs --store --db <private temp sqlite> --key-file <pseudonym key> [--js-gate]
// It needs the signed gate, writes only to --db (never the app database), writes the §11 and sponsor
// candidates to PRISM_DATA_DIR/exports/judge-access-candidates.json (mode 600) and prints counts only.
//
// --pack --db <local db> --out <file>   (Mac) the finished load file: every de-identified view, the method
//                                        view, every access row, identifiable views and snapshots only for a
//                                        basis without a hold; mode 600, outside the repository
// --load -                               (VM, through vm-deploy.sh op) the pack on stdin, checked, then loaded into
//                                        the app database in one transaction; counts only
//
// When synthetic-method.json sits next to the corpus, the same transaction also
// writes the method audit's one row (plan 07-10) and prints "METHOD rows=1 ...".

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
import { buildDocumentFrequency, deidentifyView, dictionaryOf, scanDeidentified } from "../src/report/deidentify.ts";
import { buildMethodView, decisionLabelsOf } from "../src/report/method-view.ts";
import { ensureReportViewSchema, upsertMethodView, upsertReportView, upsertSnapshot } from "../src/report/store.ts";
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
    store: { type: "boolean" },
    pack: { type: "boolean" },
    out: { type: "string" },
    load: { type: "string" },
  },
});
const packLine = (c) => `PACK deid=${c.deid} identifiable=${c.identifiable} snapshots=${c.snapshots} access=${c.access} method=${c.method}`;
if (values.pack) {
  const { buildPack } = await import("../src/report/judge-pack.ts");
  const { assertOutsideRepo } = await import("./check-data-dir.mjs");
  if (!values.db || !values.out) refuse("usage: --pack --db <local db> --out <file>");
  const out = path.resolve(values.out);
  assertOutsideRepo(path.dirname(out), root);
  if (fs.existsSync(out)) refuse("pack-exists");
  const from = new Kysely({ dialect: new SqliteDialect({ database: new Database(path.resolve(values.db), { readonly: true, fileMustExist: true }) }) });
  const to = new Kysely({ dialect: new SqliteDialect({ database: new Database(out) }) });
  const counts = await buildPack(from, to);
  await from.destroy();
  await to.destroy();
  fs.chmodSync(out, 0o600);
  console.log(packLine(counts));
  process.exit(0);
}
if (values.load) {
  const { loadPack, PackRefusal } = await import("../src/report/judge-pack.ts");
  const { getDb } = await import("../src/app/server/db.ts");
  if (values.load !== "-") refuse("usage: --load - (the pack on stdin)");
  // The pack lives only in this process's temp directory, gone with the container.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prism-pack-"));
  const file = path.join(tmp, "pack.sqlite");
  fs.writeFileSync(file, fs.readFileSync(0), { mode: 0o600 });
  const pack = new Kysely({ dialect: new SqliteDialect({ database: new Database(file, { readonly: true, fileMustExist: true }) }) });
  const app = getDb();
  try {
    console.log(packLine(await loadPack(pack, app)).replace(/^PACK/, "LOADED"));
  } catch (e) {
    if (e instanceof PackRefusal) refuse(`load: ${e.message}`);
    throw e;
  } finally {
    await pack.destroy();
    await app.destroy();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(0);
}
if (values.store) {
  await storeMode();
  process.exit(0);
}
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

async function storeMode() {
  const { resolveDataDir } = await import("../src/app/server/db.ts");
  const { assertOutsideRepo } = await import("./check-data-dir.mjs");
  const { signedGate } = await import("../src/publish/read-store.ts");
  const { sourceFromStore } = await import("../src/report/source-from-store.ts");
  const { projectSpans } = await import("../src/pipeline/confirm/confirm.ts");
  const { PINNED_MODEL } = await import("../src/pipeline/coding/nebius-client.ts");
  const { materializeStore, MaterializeRefusal } = await import("../src/report/materialize-store.ts");

  const dataDir = resolveDataDir();
  if (!values.db) refuse("no-db");
  const target = path.resolve(values.db);
  assertOutsideRepo(path.dirname(target), root);
  if (target === path.join(dataDir, "prism.sqlite")) refuse("db-is-app-database");
  const key = readKey();
  const gate = signedGate(dataDir);
  if (!gate) refuse("unsigned-gate");

  const pipe = path.join(dataDir, "pipeline");
  const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
  const sample = readJson(path.join(pipe, "sample-projects.json"));
  const byId = new Map(sample.map((e) => [`S${String(e.n).padStart(3, "0")}`, e]));
  const TF = "Nebius Token Factory";
  const OLLAMA = "Ollama Cloud";
  const pipelineDb = new Kysely({ dialect: new SqliteDialect({ database: new Database(path.join(dataDir, "prism.sqlite"), { readonly: true }) }) });
  const personEdits = new Map();
  for (const e of await pipelineDb.selectFrom("pipeline_edits").select(["project_n", "check_id", "actor_kind"]).execute()) {
    if (e.actor_kind === "person") personEdits.set(e.project_n, (personEdits.get(e.project_n) ?? new Set()).add(e.check_id));
  }

  const codebook = loadCodebook(path.join(root, "codebook.md"));
  const gapText = loadGapText({ repoRoot: root, codebook });
  const sourceOf = async ({ projectId }) => {
    const e = byId.get(projectId);
    const manifestFile = path.join(pipe, "manifests", `${e.n}.json`);
    const manifest = fs.existsSync(manifestFile) ? readJson(manifestFile) : { snapshotHashesInCollectionOrder: [] };
    const hashes = manifest.snapshotHashesInCollectionOrder ?? [];
    const snaps = hashes.map((h) => readJson(path.join(pipe, "snapshots", `${h}.json`)));
    const collectedAt = snaps.map((s) => s.retrievedAt).filter(Boolean).sort()[0] ?? gate.generatedAt;
    const edited = personEdits.get(e.n)?.size ?? 0;
    const source = await sourceFromStore(pipelineDb, dataDir, codebook, e.n, {
      projectId,
      title: e.title,
      hnId: Number(e.hn_id),
      collectedAt,
      generatedAt: new Date().toISOString(),
      renderAvailable: true,
      roles: {
        coding: { role: "coder", modelId: PINNED_MODEL, host: TF },
        confirmation: { role: "confirmer", modelId: "nemotron-3-ultra", host: OLLAMA },
        humanEdits: edited ? `${edited} check${edited === 1 ? "" : "s"} edited by a person` : "None",
      },
    });
    const snapshots = Object.fromEntries(hashes.map((h, i) => [h, snaps[i].redactedText]));
    const spans = projectSpans(dataDir, e.n).map((s) => ({ projectId, spanId: s.id, text: s.text, url: snaps[Number(/^p(\d+)-/.exec(s.id)?.[1]) - 1]?.url ?? null }));
    return { source, snapshots, spans };
  };

  // The method audit from the signed gate; PRISMA from the screening log and frame the export used.
  const bare = (m) => String(m).replace(/:cloud$/, "");
  const counts = readJson(path.join(pipe, "sample-screening-log.json")).counts;
  const failed = gate.collection?.projectNs?.length ?? 0;
  const method = {
    generatedAt: gate.generatedAt,
    labeller: { role: "independent labeller", modelId: bare(gate.labeller.modelId), host: gate.labeller.provider === "ollama" ? OLLAMA : TF },
    agreement: gate.checks.map((c) => ({
      checkId: c.checkId,
      status: c.status,
      ac1: c.ac1 ?? undefined,
      ac1CI: c.ac1CI ?? undefined,
      ...(typeof c.precision === "number" && c.coderPasses > 0 ? { precision: { c: Math.round(c.precision * c.coderPasses), m: c.coderPasses } } : {}),
      reason: c.reason,
    })),
    prisma: [
      { label: "Show HN posts in the sampling frame", count: readJson(path.join(pipe, "frame.json")).posts.length },
      { label: "Records screened", count: counts.screened },
      ...Object.entries(counts)
        .filter(([k]) => /^(stage\d|not-collectable):/.test(k))
        .map(([k, v]) => ({ label: k.startsWith("not-collectable:") ? `Not collectable: ${k.slice(16)}` : `Excluded at ${k.replace(":", ": ")}`, count: v })),
      { label: "Included", count: counts.included },
      { label: "Included with too little page text to judge", count: counts["included-insufficient-text"] ?? 0 },
      { label: "Sampled", count: sample.length },
      { label: "Collection failed", count: failed },
    ],
  };

  const out = new Kysely({ dialect: new SqliteDialect({ database: new Database(target) }) });
  let res;
  try {
    res = await materializeStore({
      entries: [...byId.keys()].map((projectId) => ({ projectId, hnId: Number(byId.get(projectId).hn_id) })),
      sourceOf,
      workedCaseHnIds: [46838772],
      key,
      codebook,
      gatesPath,
      runGate: values["js-gate"] ? await jsGate() : (record) => runGate(record, { repoRoot: root }),
      gapText,
      method,
      db: out,
    });
  } catch (e) {
    if (e instanceof MaterializeRefusal) {
      for (const [k, v] of Object.entries(e.diagnosis).sort((a, b) => b[1] - a[1])) console.log(`DEID hits=${v} ${k}`);
      refuse(e.reason);
    }
    throw e;
  } finally {
    await out.destroy();
    await pipelineDb.destroy();
  }
  fs.chmodSync(target, 0o600);

  const exports = path.join(dataDir, "exports");
  fs.mkdirSync(exports, { recursive: true, mode: 0o700 });
  assertOutsideRepo(exports, root);
  const candidatesFile = path.join(exports, "judge-access-candidates.json");
  fs.writeFileSync(candidatesFile, JSON.stringify({ generatedAt: new Date().toISOString(), candidates: res.candidates, sponsors: res.sponsors }, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(candidatesFile, 0o600);

  const projectsOf = (xs) => new Set(xs.map((x) => x.projectId)).size;
  console.log(`REPORT rows=${res.reportRows}`);
  console.log(`SNAPSHOT rows=${res.snapshots}`);
  console.log(`DEID scan hits=0 views=${res.deidViews}`);
  console.log(`METHOD rows=1`);
  console.log(`CANDIDATES well-known=${projectsOf(res.candidates)} (${res.candidates.length} quotes) sponsor=${projectsOf(res.sponsors)} worked-case-excluded=${res.excludedWorkedCase}`);
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
  if (new Set(deids.map((d) => d.view.projectRef)).size !== deids.length) refuse("pseudonym-collision");
  const hits = scanDeidentified(deids);
  // Hits name pseudonyms and term indexes only (T-07-23).
  for (const h of hits) console.log(`DEID hit project=${h.pseudonym} term_of=${h.termOf} term=${h.termIndex}`);
  if (hits.length > 0) refuse("identifier-scan");
  console.log(`DEID scan hits=0 views=${deids.length}`);
}

// The method audit (plan 07-10): one row from the method fixture next to the corpus, when there is one.
const methodPath = path.join(path.dirname(values.fixture), "synthetic-method.json");
const methodView = fs.existsSync(methodPath)
  ? buildMethodView({
      method: JSON.parse(fs.readFileSync(methodPath, "utf8")),
      codebook,
      gapText,
      decisionLabels: decisionLabelsOf(gatesPath),
      projects: built.map((b) => ({ view: b.view, pseudonym: b.pseudonym ?? null })),
    })
  : null;

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
let snapshots = 0;
await db.transaction().execute(async (trx) => {
  for (const b of built) {
    await upsertReportView(trx, b.view);
    rows++;
    // The archived text behind each page (plan 07-08); identifiable only, keyed by project and hash.
    for (const page of b.p.pages) {
      const text = b.p.snapshots?.[page.snapshotHash];
      if (typeof text !== "string") continue;
      await upsertSnapshot(trx, { projectRef: b.view.projectRef, hash: page.snapshotHash, url: page.url, archivedAt: b.p.collectedAt, text, fixture });
      snapshots++;
    }
  }
  if (methodView) await upsertMethodView(trx, methodView);
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
console.log(`SNAPSHOT rows=${snapshots}`);
console.log(
  methodView
    ? `METHOD rows=1 checks=${methodView.agreement.rows.length} confirmations=${methodView.confirmations.length}`
    : "METHOD rows=0 (no synthetic-method.json next to the corpus)",
);
await db.destroy();
