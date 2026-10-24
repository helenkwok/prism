// Plan 07-13 Task 2: the real live runner end to end at $0. Every network reply is injected
// (own site, GitHub, model host) and the gate is the vendored JS evaluator behind the spawn seam.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import dnsPromises from "node:dns/promises";

// The collector resolves hosts itself: answer only *.example, with one public address (never contacted).
const realLookup = dnsPromises.lookup;
dnsPromises.lookup = async (hostname, opts) => {
  if (!String(hostname).endsWith(".example")) return realLookup(hostname, opts);
  const address = "93.184.215.14";
  return opts?.all ? [{ address, family: 4 }] : { address, family: 4 };
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-live-real-"));
process.env.PRISM_DATA_DIR = dataDir;
process.env.BETTER_AUTH_URL = "http://127.0.0.1:3997";
delete process.env.TRUSTED_ORIGINS;

const live = await import("../../src/app/server/live-run.ts");
const { ensureAccessSchema, upsertProjectAccess } = await import("../../src/app/server/access-store.ts");
const { ensureReportViewSchema, readReportView } = await import("../../src/report/store.ts");
const { loadGateFile, resolveGatesPath } = await import("../../src/pipeline/coding/contract.ts");
const { priceOf } = await import("../../src/pipeline/coding/spend-guards.ts");
const { A9_ITEMS, a9Section } = await import("../../src/pipeline/signoff/a9.ts");
const { evaluateClaim, loadBundledGates } = await import("../../vendor/ai-output-to-value/packages/mcp/src/core.mjs");
const crypto = await import("node:crypto");

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const HOST = "own-live.example";
const ORIGIN = `https://${HOST}`;
const SITE = new Map([
  ["/robots.txt", { type: "text/plain", body: "User-agent: *\nAllow: /\n" }],
  ["/", { type: "text/html", body: `<html><body><main><h1>Own product</h1>${"<p>The assistant drafts replies with a model; a test suite of 120 cases runs on every change and results are published here.</p>".repeat(12)}<a href="/docs">Docs</a></main></body></html>` }],
  ["/docs", { type: "text/html", body: `<html><body><main><h1>Docs</h1>${"<p>Intended use: drafting replies. Known limit: no images. Incidents are fixed within two days.</p>".repeat(12)}</main></body></html>` }],
]);
const siteFetch = async (url) => {
  const u = new URL(url);
  const hit = u.host === HOST ? SITE.get(u.pathname) : undefined;
  return hit ? new Response(hit.body, { status: 200, headers: { "content-type": hit.type } }) : new Response("nf", { status: 404 });
};
const githubFetch = async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });

const checkIds = loadGateFile(resolveGatesPath()).checkIds;
function modelFetch({ include = true, codingUsage = null } = {}) {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const name = body.response_format?.json_schema?.name;
    calls.push(name);
    const reply = (content, usage = { prompt_tokens: 10, completion_tokens: 5 }) =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }], usage }), { status: 200 });
    if (name === "screen") return reply(include ? { include: true, reasonCode: null } : { include: false, reasonCode: "not-ai" });
    if (name === "confirm") return reply({ decision: "confirmed", reason: "p1-x shows it." }, codingUsage?.confirm ?? undefined);
    const user = body.messages.find((m) => m.role === "user").content;
    const ids = [...user.matchAll(/^(p\d+-[^:\s]+):/gm)].map((m) => m[1]);
    const checks = checkIds.map((checkId, k) => (k < 3 && ids[k] ? { checkId, proposedState: "pass", spanIds: [ids[k]] } : { checkId, proposedState: "unknown", spanIds: [] }));
    return reply({ checks }, codingUsage?.code ?? undefined);
  };
  return { fetchImpl, calls };
}

// The gate behind run-gate's spawn seam: the vendored JS evaluator (CI has no Python venv).
const gateSpawnImpl = (_py, args) => {
  const record = JSON.parse(fs.readFileSync(args[2], "utf8"));
  const status = evaluateClaim(record, loadBundledGates()).status;
  return { status: status === "PASS" ? 0 : 1, stdout: JSON.stringify({ status }), stderr: "" };
};

// A9 records bound to the current addendum, as seed-access stores them.
const a9Digest = crypto.createHash("sha256").update(a9Section(fs.readFileSync("protocol/PROTOCOL.md", "utf8"))).digest("hex");
const a9Lines = async () => A9_ITEMS.map((item) => JSON.stringify({ item, decision: "approved", docDigest: a9Digest }));

let db;
beforeEach(async () => {
  db = new Kysely({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
  await ensureAccessSchema(db);
  await ensureReportViewSchema(db);
  await live.ensureLiveRunSchema(db);
  await upsertProjectAccess(db, { projectId: "OWN1", title: "Show HN: Own – a test assistant", basis: "own", sponsorHold: false, inSample: false, liveBoundaryJson: JSON.stringify([{ host: HOST }]) });
});

const resolver = async () => ["93.184.216.34"];
async function runOnce(model, { cap = "1.00" } = {}) {
  const runner = live.createRealRunner({ apiKey: "test", githubToken: "test", modelFetch: model.fetchImpl, siteFetch, githubFetch, gateSpawnImpl, pythonPath: "js-gate", a9Lines, scratchRoot: path.join(dataDir, "live") });
  const env = { ...process.env, PRISM_LIVE_RUN_CAP_USD: cap };
  const r = await live.startLiveRunCore({ user: { id: "admin" } }, new Headers({ origin: "http://127.0.0.1:3997" }), `${ORIGIN}/`, { db, runner, resolver, env });
  assert.ok(r.jobId, JSON.stringify(r));
  await live.whenIdle();
  return live.readRunStatus(db, r.jobId);
}
const tableNames = async () => (await db.introspection.getTables()).map((t) => t.name);

test("a real-runner job ends Done with every stage, a gate-first report and no pipeline rows in the app database", async () => {
  const model = modelFetch();
  const s = await runOnce(model);
  assert.equal(s.job.status, "done", s.job.message ?? "");
  for (const st of ["screen", "collect", "code", "gate", "confirm", "report"]) assert.equal(s.stages.find((x) => x.stage === st).status, "done", st);
  assert.match(s.stages.find((x) => x.stage === "collect").message, /pages collected/); // from run.ts's onStage
  const view = await readReportView(db, "OWN1", "identifiable");
  assert.equal(view.decisions.length, 5);
  assert.equal(view.collection.renderAvailable, false);
  assert.ok(view.checks.some((c) => c.published === "pass"), "confirmed positives are published");
  assert.deepEqual((await tableNames()).filter((t) => t.startsWith("pipeline_")), []);
  assert.ok(model.calls.includes("confirm"));
  assert.ok(!fs.existsSync(path.join(dataDir, "live", String(s.job.id))), "scratch removed");
  const ledger = await live.readLedger(db);
  assert.ok(ledger.spent > 0 && ledger.reserved === 0);
});

test("a screen exclusion ends with the not-analysed copy and no report", async () => {
  const s = await runOnce(modelFetch({ include: false }));
  assert.equal(s.job.status, "done");
  assert.equal(s.job.message, "Not analysed: the screen found not-ai. No report was built.");
  assert.equal(s.report, null);
  assert.equal(await readReportView(db, "OWN1", "identifiable"), null);
});

test("spend past $0.10 before the gate stops the job with no report", async () => {
  const s = await runOnce(modelFetch({ codingUsage: { code: { prompt_tokens: 5_000_000, completion_tokens: 5 } } }));
  assert.equal(s.job.status, "stopped");
  assert.equal(s.job.stopStage, "code");
  assert.equal(s.report, null);
});

test("spend past $0.10 in Confirm stops after the gate with a report whose positives await", async () => {
  const s = await runOnce(modelFetch({ codingUsage: { confirm: { prompt_tokens: 5_000_000, completion_tokens: 5 } } }));
  assert.equal(s.job.status, "stopped");
  assert.equal(s.job.stopStage, "confirm");
  assert.ok(s.report, "report kept");
  const view = await readReportView(db, "OWN1", "identifiable");
  assert.ok(view.checks.some((c) => c.published === null), "unconfirmed positives await");
});

test("the screener has a list price", () => {
  assert.deepEqual(priceOf("nvidia/Nemotron-3_5-Lightning"), { prompt: 0.06 / 1e6, completion: 0.24 / 1e6 });
});

test("runnerFromEnv: real needs the key and the cap; fixture and unset unchanged", () => {
  assert.equal(live.runnerFromEnv({ PRISM_LIVE_RUNNER: "real", NEBIUS_API_KEY: "k", PRISM_LIVE_RUN_CAP_USD: "1" }).name, "real");
  assert.throws(() => live.runnerFromEnv({ PRISM_LIVE_RUNNER: "real", PRISM_LIVE_RUN_CAP_USD: "1" }), /NEBIUS_API_KEY/);
  assert.throws(() => live.runnerFromEnv({ PRISM_LIVE_RUNNER: "real", NEBIUS_API_KEY: "k" }), /PRISM_LIVE_RUN_CAP_USD/);
  assert.equal(live.runnerFromEnv({ PRISM_LIVE_RUNNER: "fixture" }).name, "fixture");
  assert.equal(live.runnerFromEnv({}).name, "not-configured");
});

test("seed-access: --input upserts own rows with live boundaries; --a9 --check refuses span text and writes nothing", async () => {
  const { spawnSync } = await import("node:child_process");
  const dbFile = path.join(dataDir, "seed.sqlite");
  const run = (args, input) => spawnSync(process.execPath, ["scripts/seed-access.mjs", ...args], { input, encoding: "utf8" });
  const list = JSON.stringify([{ projectId: "OWN9", title: "Show HN: Nine", basis: "own", url: "https://nine.example/" }]);
  const r1 = run(["--input", "-", "--db", dbFile], list);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(r1.stdout.trim(), "SEEDED projects=1 a9=0");
  const sdb = new Database(dbFile);
  assert.deepEqual(JSON.parse(sdb.prepare("select live_boundary_json j from app_project_access where project_id='OWN9'").get().j)[0].host, "nine.example");
  sdb.close();
  const bad = JSON.stringify({ item: A9_ITEMS[0], decision: "approved", spans: [{ text: "page text" }] });
  const r2 = run(["--a9", "-", "--check"], bad + "\n");
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /SEED REFUSED/);
  assert.doesNotMatch(r2.stdout + r2.stderr, /page text/);
});
