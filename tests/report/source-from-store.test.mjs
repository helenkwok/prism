// Plan 07-06 Task 3: the store adapter turns a seeded synthetic pipeline store
// into the same ReportSource the corpus gives (published states via readTrail,
// manifest pages in collection order, injection flags, confirmations).

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

import { ensureConfirmationSchema, ensureEditsSchema, inputDigest, projectSpans, recordConfirmation } from "../../src/pipeline/confirm/confirm.ts";
import { readTrail } from "../../src/pipeline/review/trail.ts";
import { ensurePipelineSchema, recordInjectionFlags } from "../../src/pipeline/store/results.ts";
import { sourceFromStore } from "../../src/report/source-from-store.ts";
import { buildReportView, loadGapText, sourceFromFixture } from "../../src/report/view.ts";
import { codebook, corpus, gatesPath, jsRunGate, order, root } from "./js-gate.mjs";

const STATE = { p: "pass", c: "claimed", u: "unknown", f: "fail", n: "pass" };
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-store-src-"));
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
const db = new Kysely({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
after(() => db.destroy());
const gapText = loadGapText({ repoRoot: dataDir, codebook });
const fixtureProject = (id) => corpus.projects.find((p) => p.projectId === id);

const meta = (p) => ({
  projectId: p.projectId,
  title: p.title,
  hnId: p.hnId,
  collectedAt: p.collectedAt,
  generatedAt: corpus.generatedAt,
  renderAvailable: p.renderAvailable,
  roles: p.roles,
  fixture: true,
});

/** Writes one fixture project into the pipeline store as project n; returns fixture span id -> store span id. */
async function seedFromFixture(n, p) {
  const dir = (d) => path.join(dataDir, "pipeline", d);
  fs.mkdirSync(dir("manifests"), { recursive: true });
  fs.mkdirSync(dir("snapshots"), { recursive: true });
  const hashes = [];
  p.pages.forEach((page) => {
    // One sentence per block, so segmentText gives one span per fixture span.
    const text = Object.values(p.spans).filter((s) => s.url === page.url).map((s) => s.text).join("\n\n");
    const hash = crypto.createHash("sha256").update(`${n}:${page.url}:${text}`).digest("hex");
    fs.writeFileSync(path.join(dir("snapshots"), `${hash}.json`), JSON.stringify({ url: page.url, redactedText: text }));
    hashes.push(hash);
  });
  fs.writeFileSync(
    path.join(dir("manifests"), `${n}.json`),
    JSON.stringify({
      projectN: n,
      // Manifest snapshot entries in collection order, as run.ts writes them.
      snapshots: p.pages.map((pg) => ({ url: pg.url, visibility: pg.rendered ? "rendered" : "provider-extracted" })),
      snapshotHashesInCollectionOrder: hashes,
    }),
  );

  const storeSpans = projectSpans(dataDir, n);
  const idOf = {};
  for (const [sid, s] of Object.entries(p.spans)) {
    const pageNo = p.pages.findIndex((pg) => pg.url === s.url) + 1;
    const hit = storeSpans.find((x) => x.id.startsWith(`p${pageNo}-`) && x.text === s.text);
    assert.ok(hit, `${p.projectId} ${sid} not segmented as one span`);
    idOf[sid] = hit.id;
  }

  for (const [i, checkId] of order.entries()) {
    const ch = p.states[i];
    const basis = p.basis?.[checkId];
    const state = basis === "rejected" || basis === "downgraded" ? "pass" : STATE[ch];
    const spanIds = (p.cites?.[checkId] ?? []).map((s) => idOf[s]);
    await db
      .insertInto("pipeline_check_states")
      .values({ project_n: n, check_id: checkId, proposed_state: state, filtered_state: state, span_ids_json: JSON.stringify(spanIds) })
      .execute();
    if (state !== "pass" && state !== "claimed") continue;
    if (ch === "n" && !basis) continue; // awaiting confirmation
    const digest = inputDigest(codebook, { projectN: n, checkId, state, spans: spanIds.map((id) => ({ id, text: storeSpans.find((s) => s.id === id).text })) });
    const decision = basis === "rejected" ? "rejected" : basis === "downgraded" ? "downgraded" : "confirmed";
    await recordConfirmation(db, {
      projectN: n,
      checkId,
      confirmerId: "agent:Qwen/Qwen3-235B-A22B-Instruct-2507",
      confirmerKind: "agent",
      modelId: "Qwen/Qwen3-235B-A22B-Instruct-2507",
      decision,
      reason: "seeded",
      decidedAt: "2026-10-20T09:00:00Z",
      inputDigest: basis === "stale" ? "an-older-input" : digest,
      spanIds,
      confirmedState: decision === "rejected" ? null : decision === "downgraded" ? "claimed" : state,
    });
  }
  await recordInjectionFlags(db, n, (p.flaggedSpanIds ?? []).map((s) => ({ spanId: idOf[s] })));
  return idOf;
}

let ids;
before(async () => {
  await ensurePipelineSchema(db);
  await ensureConfirmationSchema(db);
  await ensureEditsSchema(db);
  ids = { 1: await seedFromFixture(1, fixtureProject("P01")), 3: await seedFromFixture(3, fixtureProject("P03")) };
});

describe("sourceFromStore (plan 07-06)", () => {
  test("published state and basis per check equal readTrail's published field", async () => {
    for (const n of [1, 3]) {
      const src = await sourceFromStore(db, dataDir, codebook, n, meta(fixtureProject(n === 1 ? "P01" : "P03")));
      const trail = await readTrail(db, dataDir, n, { codebook });
      assert.deepEqual(
        src.published.map((p) => [p.checkId, p.published, p.basis]),
        trail.checks.map((c) => [c.checkId, c.published.published, c.published.basis]),
      );
    }
  });

  test("bases come through: downgraded, rejected, stale and unconfirmed", async () => {
    const p1 = await sourceFromStore(db, dataDir, codebook, 1, meta(fixtureProject("P01")));
    const by = (s, id) => s.published.find((p) => p.checkId === id);
    assert.deepEqual(by(p1, "acceptance-criteria-defined"), { checkId: "acceptance-criteria-defined", published: "claimed", basis: "downgraded" });
    assert.deepEqual(by(p1, "failure-modes-tested"), { checkId: "failure-modes-tested", published: null, basis: "rejected" });
    assert.deepEqual(by(p1, "acceptance-criteria-met"), { checkId: "acceptance-criteria-met", published: null, basis: "unconfirmed" });
    const p3 = await sourceFromStore(db, dataDir, codebook, 3, meta(fixtureProject("P03")));
    assert.equal(by(p3, "intended-use-defined").basis, "stale");
  });

  test("cited spans carry their text and snapshot URL; confirmations carry actor kind and model id", async () => {
    const p = fixtureProject("P01");
    const src = await sourceFromStore(db, dataDir, codebook, 1, meta(p));
    const sid = ids[1].s001;
    assert.deepEqual(src.cites["output-reproducible"], p.cites["output-reproducible"].map((s) => ids[1][s]));
    assert.equal(src.spans[sid].text, p.spans.s001.text);
    assert.equal(src.spans[sid].url, p.spans.s001.url);
    assert.equal(src.spans[sid].snapshotHash, src.pages[0].snapshotHash);
    assert.deepEqual(src.confirmations["output-reproducible"], [
      { decision: "confirmed", role: "confirmer", actorKind: "agent", modelId: "Qwen/Qwen3-235B-A22B-Instruct-2507", decidedAt: "2026-10-20T09:00:00Z" },
    ]);
  });

  test("pages follow manifest collection order, with rendered from visibility", async () => {
    const p = fixtureProject("P01");
    const src = await sourceFromStore(db, dataDir, codebook, 1, meta(p));
    assert.deepEqual(src.pages.map((x) => [x.url, x.rendered]), p.pages.map((x) => [x.url, x.rendered]));
  });

  test("injection flags come from the pipeline table", async () => {
    const src = await sourceFromStore(db, dataDir, codebook, 3, meta(fixtureProject("P03")));
    assert.deepEqual(src.flaggedSpanIds, [ids[3].s004]);
  });

  test("a project without a manifest has zero pages and every check unknown", async () => {
    const src = await sourceFromStore(db, dataDir, codebook, 99, meta(fixtureProject("P04")));
    assert.equal(src.pages.length, 0);
    assert.equal(src.published.length, order.length);
    for (const p of src.published) assert.deepEqual([p.published, p.basis], ["unknown", "not-positive"]);
    const view = await buildReportView(src, { codebook, gatesPath, runGate: jsRunGate, gapText });
    assert.equal(view.collection.pages, 0);
  });

  test("buildReportView gives the same decisions over the adapter's output and the corpus entry", async () => {
    for (const [n, id] of [[1, "P01"], [3, "P03"]]) {
      const fromStore = await buildReportView(await sourceFromStore(db, dataDir, codebook, n, meta(fixtureProject(id))), { codebook, gatesPath, runGate: jsRunGate, gapText });
      const fromFixture = await buildReportView(sourceFromFixture(corpus, fixtureProject(id), order), { codebook, gatesPath, runGate: jsRunGate, gapText });
      assert.deepEqual(fromStore.decisions, fromFixture.decisions, id);
      assert.deepEqual(fromStore.checks.map((c) => [c.checkId, c.published, c.basis, c.quotes.map((q) => q.text)]), fromFixture.checks.map((c) => [c.checkId, c.published, c.basis, c.quotes.map((q) => q.text)]), id);
    }
  });

  test("the adapter reads published states through readTrail, not the confirmation table", () => {
    const src = fs.readFileSync(path.join(root, "src", "report", "source-from-store.ts"), "utf8");
    assert.match(src, /readTrail\(/);
    assert.equal(/pipeline_confirmations/.test(src), false);
  });
});
