// PUB-01 / PUB-03 / D-75 / D-77 / D-83: the private store -> AggregateInput, and the real-input write rules.
// Every store here is synthetic and lives in a temp dir; nothing touches the real data dir.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

import { loadCodebook } from "../../src/pipeline/coding/codebook-prompt.ts";
import { ARTCRAFT_HN_ID } from "../../src/pipeline/select/draw-sample.ts";
import { RefusalError, exportRelease, refuseRealOut } from "../../src/publish/export.ts";
import { buildIdentifierSetFromStore, scanTexts } from "../../src/publish/identifiers.ts";
import { readStore, sourceType } from "../../src/publish/read-store.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const checkIds = Object.keys(loadCodebook(path.join(repo, "codebook.md")).checks);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "prism-read-store-"));
const write = (f, x) => (fs.mkdirSync(path.dirname(f), { recursive: true }), fs.writeFileSync(f, typeof x === "string" ? x : JSON.stringify(x)));
const gateResult = async () => ({ status: "INSUFFICIENT_EVIDENCE", raw: {}, gateSha: "x" });

function fakeGate(status = "released") {
  return {
    codebookVersion: "v1.0",
    labeller: { provider: "ollama", modelId: "labeller-model" },
    collection: { projectNs: [] },
    screeningAudit: { figure: { errors: 1, assessable: 20, bar: 0.1 } },
    validationReady: true,
    checks: checkIds.map((checkId) => ({ checkId, status, reason: "x", goldPasses: 20, ac1: 0.8, ac1CI: [0.7, 0.9], precision: 0.9, coderPasses: 20 })),
  };
}

/** A two-project store: synthetic names, every check unknown. */
async function store({ picks, artcraftInFrame = true } = {}) {
  const dir = tmp();
  const pipe = path.join(dir, "pipeline");
  const sample = [1, 2].map((n) => ({ n, hn_id: String(91000000 + n), title: `Show HN: Zylophant Tool ${n}`, entry_url: `https://zylophant-${n}.example/`, final_url: `https://zylophant-${n}.example/`, quarter: n }));
  write(path.join(pipe, "sample-projects.json"), sample);
  const posts = [...sample.map((e) => ({ id: e.hn_id, title: e.title, url: e.final_url })), { id: "91000099", title: "Show HN: Quorvex Excluded", url: "https://quorvex.example/" }];
  if (artcraftInFrame) posts.push({ id: ARTCRAFT_HN_ID, title: "Show HN: Worked Case Studio", url: "https://worked-case.example/" });
  write(path.join(pipe, "frame.json"), { window: { startEpoch: 1756684800, endEpochExclusive: 1788220800 }, posts });
  write(path.join(pipe, "sample-screening-log.json"), { model: "screen-model", counts: { screened: 3, included: 2, "included-insufficient-text": 0, "stage1:not-ai": 1 }, log: posts.slice(0, 3).map((p, i) => ({ id: p.id, rank: i })) });
  write(path.join(pipe, "sample-subsets.json"), { seeds: { sampling: "s", gold: "g", secondModel: "m", screeningAudit: "a", recall: "r" } });
  for (const n of [1, 2]) write(path.join(pipe, "manifests", `${n}.json`), { snapshots: [], snapshotHashesInCollectionOrder: [] });
  write(path.join(dir, "validation", "screening-audit.json"), { provider: "ollama", model: "audit-model" });
  write(path.join(dir, "validation", "recall.json"), { provider: "ollama", model: "gather-model", figure: { contributing: 2, projects: 2 }, support: { supportedFound: 9, supported: 10, rawFound: 18, rawItems: 20, itemsJudged: 20, unsupported: 10, boilerplate: 3 } });
  write(path.join(dir, "validation", "tavily-vs-free-142.json"), { n: 2, checkAgreementRate: 0.9, projects: [{ checks: { pairs: [{ tavily: "pass", free: "pass" }] } }] });
  write(path.join(dir, "decisions", "screening-audit-action-a7.10.md"), "- Remeasured errors: 0 / assessable\n");
  if (picks) write(path.join(dir, "reddit", "picks.json"), picks);
  const db = new Kysely({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
  await db.schema.createTable("pipeline_check_states").addColumn("project_n", "integer").addColumn("check_id", "text").addColumn("proposed_state", "text").addColumn("filtered_state", "text").addColumn("span_ids_json", "text").execute();
  await db.schema.createTable("pipeline_confirmations").addColumn("project_n", "integer").addColumn("check_id", "text").execute();
  await db.schema.createTable("pipeline_edits").addColumn("project_n", "integer").addColumn("check_id", "text").addColumn("actor_kind", "text").addColumn("actor_id", "text").addColumn("filtered_state", "text").addColumn("span_ids_json", "text").addColumn("edited_at", "text").execute();
  for (const n of [1, 2]) for (const c of checkIds) await db.insertInto("pipeline_check_states").values({ project_n: n, check_id: c, proposed_state: "unknown", filtered_state: "unknown", span_ids_json: "[]" }).execute();
  return { dir, db };
}

test("an unsigned gate refuses before anything is read", async () => {
  await assert.rejects(readStore(tmp(), { date: "2026-10-25", db: {}, loadGate: () => null }), (e) => e instanceof RefusalError && e.rule === "unsigned-gate");
});

test("the store reads into the aggregate input: sample projects, gate statuses, decisions from the gate", async () => {
  const { dir, db } = await store();
  const input = await readStore(dir, { date: "2026-10-25", db, runGate: gateResult, loadGate: () => fakeGate() });
  assert.equal(input.synthetic, false);
  assert.equal(input.projects.length, 2);
  assert.deepEqual(input.projects.map((p) => p.decisions), ["IIIII", "IIIII"]);
  assert.equal(input.published.length, 2 * checkIds.length);
  assert.deepEqual(input.gate.checks[0].precision, { c: 18, m: 20 });
  assert.equal(input.validation.screeningAudit.bar, 10);
  assert.equal(input.validation.crossCheck.positiveAgreement, 1);
  assert.equal(input.screening.identified, 4);
  assert.equal(input.method.window, "2025-09-01 to 2026-08-31");
});

test("a withheld check enters the decisions as unknown and adds the decisions limitation", async () => {
  const { dir, db } = await store();
  const seen = [];
  const input = await readStore(dir, { date: "2026-10-25", db, runGate: async (r) => (seen.push(r), gateResult()), loadGate: () => fakeGate("withheld") });
  assert.ok(seen.every((r) => Object.values(r.gateChecks).every((s) => s === "unknown" || s === "not-applicable")));
  assert.ok(input.notes.some((n) => n.id === "limitation:decisions-need-withheld-checks"));
});

test("a context pick is passed through so the export refuses it (D-75)", async () => {
  const { dir, db } = await store({ picks: [{ url: "https://r.example/x", tag: "context", subreddit: "s", date: "2026-01-01" }] });
  const input = await readStore(dir, { date: "2026-10-25", db, runGate: gateResult, loadGate: () => fakeGate() });
  assert.equal(input.projects.length, 2);
  await assert.rejects(exportRelease({ input, outDir: path.join(dir, "preview") }), (e) => e.rule === "context-record");
});

test("the worked case outside the sample is not a project but is in the identifier set (D-77)", async () => {
  const { dir, db } = await store();
  const input = await readStore(dir, { date: "2026-10-25", db, runGate: gateResult, loadGate: () => fakeGate() });
  assert.ok(!input.projects.some((p) => p.hnId === ARTCRAFT_HN_ID));
  const ids = buildIdentifierSetFromStore(dir);
  assert.ok(ids.hnIds.has(ARTCRAFT_HN_ID));
  assert.equal(scanTexts([{ file: "t", text: "see worked-case.example" }], ids).length, 1);
  assert.equal(scanTexts([{ file: "t", text: "the quorvex.example page" }], ids).length, 1, "an excluded frame candidate is an identifier");
  assert.equal(scanTexts([{ file: "t", text: "a modular, overflow-safe baseline" }], ids).length, 0, "dictionary words are not names");
});

test("real input writes into public-data/ only with A14 signed, and nowhere outside the data dir", () => {
  const dataDir = tmp();
  const fakeRepo = tmp();
  const unsigned = () => {
    throw new Error("A14: item not approved");
  };
  assert.throws(() => refuseRealOut(dataDir, path.join(fakeRepo, "public-data"), { repo: fakeRepo, a14: unsigned }), (e) => e.rule === "unsigned-a14");
  assert.doesNotThrow(() => refuseRealOut(dataDir, path.join(fakeRepo, "public-data"), { repo: fakeRepo, a14: () => {} }));
  assert.doesNotThrow(() => refuseRealOut(dataDir, path.join(dataDir, "publish-preview"), { repo: fakeRepo, a14: unsigned }));
  assert.throws(() => refuseRealOut(dataDir, path.join(tmp(), "elsewhere"), { repo: fakeRepo, a14: () => {} }), (e) => e.rule === "out-dir");
});

test("source types come from the cited page URL", () => {
  assert.equal(sourceType("https://a.example/"), "homepage");
  assert.equal(sourceType("https://docs.a.example/start"), "docs");
  assert.equal(sourceType("https://a.example/privacy"), "policy-page");
  assert.equal(sourceType("https://github.com/o/r"), "repository-readme");
  assert.equal(sourceType("https://github.com/o/r/blob/main/x.py"), "repository-file");
  assert.equal(sourceType("https://a.example/blog/post"), "other");
});
