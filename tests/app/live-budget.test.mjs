// APP-02 / D-80 / research Pattern 6 and caveat C7: money for live runs.
// Every run reserves $0.10 against a persisted cumulative cap in one
// transaction; a run cannot spend past its $0.10; a restart charges every
// unfinished reservation as spent; spent is never lowered. Fixture runners
// only: no network and no model call.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ORIGIN = "http://127.0.0.1:3997";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-live-budget-"));
process.env.PRISM_DATA_DIR = dataDir;
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
process.env.BETTER_AUTH_URL = ORIGIN;
delete process.env.TRUSTED_ORIGINS;
delete process.env.PRISM_LIVE_RUN_CAP_USD;

const { getAuth } = await import("../../src/app/server/auth.ts");
const { ensureAccessSchema, upsertProjectAccess } = await import("../../src/app/server/access-store.ts");
const { ensureReportViewSchema, upsertReportView, readReportView } = await import("../../src/report/store.ts");
const { assertRequestAllowed, BudgetExceededError, formatBudgetLine } = await import("../../src/pipeline/coding/spend-guards.ts");
const live = await import("../../src/app/server/live-run.ts");

const ULTRA = "nvidia/Nemotron-3-Ultra-550b-a55b";
let admin;
let db;

before(async () => {
  const email = "admin@live-budget.test";
  const password = randomBytes(16).toString("hex");
  const r = spawnSync(process.execPath, [path.join(repoRoot, "src/app/server/seed-account.ts"), "--email", email, "--role", "admin", "--password-stdin"], {
    cwd: repoRoot,
    env: { ...process.env },
    input: `${password}\n`,
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  const res = await getAuth().api.signInEmail({ body: { email, password }, asResponse: true });
  admin = new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), origin: ORIGIN });
});

const view = (checks) => ({
  version: 1,
  view: "identifiable",
  projectRef: "P01",
  title: "Fixture P01",
  fixture: true,
  generatedAt: "2026-10-01T00:00:00.000Z",
  codebookVersion: "1.0",
  gateSha: "0000000",
  collection: { pages: 2, rendered: 2, notRendered: 0, renderAvailable: true, collectedAt: "2026-10-01T00:00:00.000Z", urls: [] },
  decisions: [],
  checks,
  howMade: {},
});

beforeEach(async () => {
  db = new Kysely({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
  await ensureAccessSchema(db);
  await ensureReportViewSchema(db);
  await live.ensureLiveRunSchema(db);
  await upsertProjectAccess(db, { projectId: "P01", basis: "own", sponsorHold: false, inSample: true, liveBoundaryJson: JSON.stringify([{ host: "p01.example" }]) });
});

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const env = (cap) => ({ ...process.env, ...(cap === undefined ? {} : { PRISM_LIVE_RUN_CAP_USD: cap }) });
const deps = (runner, cap = "1.00") => ({ db, runner, resolver: live.fixtureResolver, env: env(cap) });
const ledger = () => live.readLedger(db);
const jobs = () => db.selectFrom("app_job").selectAll().orderBy("id").execute();
const close = (a, b) => Math.abs(a - b) < 1e-9;

/** A runner that waits at Screen until released. */
function gated() {
  let release;
  const gate = new Promise((r) => (release = r));
  const runner = async ({ emit, job }) => {
    await emit("screen", "running");
    await gate;
    return { projectRef: job.projectRef };
  };
  return { runner, release };
}

async function untilStatus(jobId, status) {
  for (let i = 0; i < 200; i += 1) {
    const r = await db.selectFrom("app_job").select("status").where("id", "=", jobId).executeTakeFirst();
    if (r?.status === status) return;
    await new Promise((r2) => setTimeout(r2, 5));
  }
  assert.fail(`job ${jobId} never reached ${status}`);
}

test("concurrent reservation: with cap 0.15 two simultaneous submissions create exactly one job", async () => {
  const { runner, release } = gated();
  try {
  const results = await Promise.all([
    live.startLiveRunAs(admin, "https://p01.example/", deps(runner, "0.15")),
    live.startLiveRunAs(admin, "https://p01.example/a", deps(runner, "0.15")),
  ]);
  const refused = results.filter((r) => "refused" in r);
  assert.equal(results.filter((r) => "jobId" in r).length, 1, JSON.stringify(results));
  assert.deepEqual(refused, [{ refused: "budget" }]);
  assert.equal((await jobs()).length, 1);
  const l = await ledger();
  assert.ok(close(l.reserved, 0.1) && close(l.spent, 0) && close(l.cap, 0.15), JSON.stringify(l));
  console.log(`RESULT concurrent cap=0.15 jobs=1 refused=budget ${formatBudgetLine({ estimated: 0, spent: l.spent + l.reserved, cap: l.cap })}`);
  } finally {
    release();
    await live.whenIdle();
  }
  const end = await ledger();
  assert.ok(close(end.reserved, 0) && close(end.spent, 0), JSON.stringify(end));
});

test("stop before gate: a run spending past $0.10 through assertRequestAllowed ends stopped with no report", async () => {
  const runner = async ({ emit, budget }) => {
    await emit("screen", "running");
    await emit("screen", "done", "screened");
    await emit("collect", "running");
    await emit("collect", "done", "2 pages collected");
    await emit("code", "running");
    budget.recordSpent(0.06);
    assertRequestAllowed({ messages: [{ content: "x".repeat(4000) }], model: ULTRA, budget, completionTokens: 15_000 });
    throw new Error("unreachable: the guard must refuse");
  };
  const r = await live.startLiveRunAs(admin, "https://p01.example/", deps(runner));
  await live.whenIdle();
  const s = await live.readRunStatus(db, r.jobId);
  assert.equal(s.job.status, "stopped");
  assert.equal(s.job.stopStage, "code");
  assert.equal(s.report, null);
  assert.equal(s.stages.find((x) => x.stage === "code").status, "stopped");
  assert.ok(close(s.job.spentUsd, 0.06));
  const l = await ledger();
  assert.ok(close(l.spent, 0.06) && close(l.reserved, 0), JSON.stringify(l));
  console.log(`RESULT stop before gate job ${r.jobId} ${s.job.status} at ${s.job.stopStage} report=none ${formatBudgetLine({ estimated: 0, spent: s.job.spentUsd, cap: 0.1 })}`);
});

test("stop after gate: the report is built and unconfirmed positives show as awaiting confirmation", async () => {
  const runner = async ({ db: d, emit, budget, setReport }) => {
    for (const st of ["screen", "collect", "code", "gate"]) {
      await emit(st, "running");
      await emit(st, "done", `${st} ok`);
    }
    // After the gate: positives stored as awaiting confirmation (published null).
    await upsertReportView(d, view([{ checkId: "c1", published: null }, { checkId: "c2", published: "unknown" }]));
    await setReport("P01");
    await emit("confirm", "running");
    budget.recordSpent(0.09);
    assertRequestAllowed({ messages: [{ content: "confirm c1" }], model: ULTRA, budget, completionTokens: 10_000 });
    throw new Error("unreachable: the guard must refuse");
  };
  const r = await live.startLiveRunAs(admin, "https://p01.example/", deps(runner));
  await live.whenIdle();
  const s = await live.readRunStatus(db, r.jobId);
  assert.equal(s.job.status, "stopped");
  assert.equal(s.job.stopStage, "confirm");
  assert.equal(s.report?.projectRef, "P01");
  assert.equal(s.stages.find((x) => x.stage === "report").status, "skipped");
  assert.equal((await readReportView(db, "P01", "identifiable")).checks[0].published, null);
  const l = await ledger();
  assert.ok(close(l.spent, 0.09) && close(l.reserved, 0), JSON.stringify(l));
  console.log(`RESULT stop after gate job ${r.jobId} ${s.job.status} at ${s.job.stopStage} report=${s.report.projectRef} ${formatBudgetLine({ estimated: 0, spent: s.job.spentUsd, cap: 0.1 })}`);
});

test("a stopped run's report link is not offered for a stop before gate even when an older view exists", async () => {
  await upsertReportView(db, view([{ checkId: "c1", published: "pass" }]));
  const runner = async ({ emit, budget }) => {
    await emit("screen", "running");
    assertRequestAllowed({ messages: [{ content: "x" }], model: ULTRA, budget, completionTokens: 40_000 });
    return { projectRef: "P01" };
  };
  const r = await live.startLiveRunAs(admin, "https://p01.example/", deps(runner));
  await live.whenIdle();
  const s = await live.readRunStatus(db, r.jobId);
  assert.equal(s.job.status, "stopped");
  assert.equal(s.report, null);
});

test("interrupted: a restart charges every queued or running reservation as spent, once", async () => {
  const { runner, release } = gated();
  let a, b, before, once;
  try {
    a = await live.startLiveRunAs(admin, "https://p01.example/", deps(runner));
    await untilStatus(a.jobId, "running");
    b = await live.startLiveRunAs(admin, "https://p01.example/b", deps(runner));
    before = await ledger();
    assert.ok(close(before.reserved, 0.2) && close(before.spent, 0), JSON.stringify(before));

    assert.equal(await live.markInterruptedJobs(db), 2); // simulated boot
    once = await ledger();
    assert.ok(close(once.spent, 0.2) && close(once.reserved, 0), JSON.stringify(once));
    for (const id of [a.jobId, b.jobId]) {
      const s = await live.readRunStatus(db, id);
      assert.equal(s.job.status, "interrupted");
      assert.ok(close(s.job.spentUsd, 0.1));
    }
  } finally {
    // The old process's runner finishing late must change nothing.
    release();
    await live.whenIdle();
  }
  assert.equal(await live.markInterruptedJobs(db), 0); // second boot
  assert.deepEqual(await ledger(), once);
  assert.equal((await live.readRunStatus(db, a.jobId)).job.status, "interrupted");
  console.log(`RESULT interrupted jobs=2 spent ${before.spent.toFixed(2)} -> ${once.spent.toFixed(2)} reserved ${before.reserved.toFixed(2)} -> ${once.reserved.toFixed(2)}; second boot unchanged`);
});

test("not configured: with PRISM_LIVE_RUN_CAP_USD unset (or not a positive number) startLiveRun refuses and writes nothing", async () => {
  const runner = live.createFixtureRunner({ stageMs: 0 });
  for (const cap of [undefined, "", "0", "-1", "abc"]) {
    assert.deepEqual(await live.startLiveRunAs(admin, "https://p01.example/", { ...deps(runner), env: env(cap) }), { refused: "not-configured" }, String(cap));
  }
  assert.equal((await jobs()).length, 0);
  assert.equal(await db.selectFrom("app_spend_ledger").selectAll().executeTakeFirst(), undefined);
  console.log("RESULT not-configured refused jobs=0");
});

test("the cap is cumulative: runs are refused once less than $0.10 remains, and spent is never lowered", async () => {
  const runner = async ({ emit, budget }) => {
    await emit("screen", "running");
    budget.recordSpent(0.04);
    await emit("screen", "done", "ok");
    return { projectRef: "P01" };
  };
  const results = [];
  for (let i = 0; i < 4; i += 1) {
    results.push(await live.startLiveRunAs(admin, "https://p01.example/", deps(runner, "0.20")));
    await live.whenIdle();
  }
  // 0.04 + 0.04 + 0.04 spent; a fourth would need 0.12 + 0.10 > 0.20.
  assert.deepEqual(results.map((r) => ("refused" in r ? r.refused : "ok")), ["ok", "ok", "ok", "budget"]);
  const l = await ledger();
  assert.ok(close(l.spent, 0.12) && close(l.reserved, 0), JSON.stringify(l));
  // Restarting with a lower cap keeps what was spent.
  await live.startLiveRunAs(admin, "https://p01.example/", deps(runner, "0.05"));
  assert.ok(close((await ledger()).spent, 0.12));
});

test("budget summary for /run: line, meter values and the disabled state", () => {
  assert.deepEqual(live.budgetSummary({ configured: true, cap: 1, spent: 0.3, reserved: 0.1 }), {
    configured: true,
    cap: 1,
    used: 0.4,
    line: "Live-run budget: $0.40 of $1.00 spent",
    disabled: false,
    notice: null,
  });
  assert.deepEqual(live.budgetSummary({ configured: true, cap: 1, spent: 0.95, reserved: 0 }), {
    configured: true,
    cap: 1,
    used: 0.95,
    line: "Live-run budget: $0.95 of $1.00 spent",
    disabled: true,
    notice: "The live-run budget is spent ($0.95 of $1.00). Raise the cap in the server settings to run again.",
  });
  assert.equal(live.budgetSummary({ configured: true, cap: 1, spent: 0.9, reserved: 0 }).disabled, false);
  const off = live.budgetSummary({ configured: false, cap: 0, spent: 0, reserved: 0 });
  assert.equal(off.disabled, true);
  assert.equal(off.notice, "Live runs are not configured on this server: no budget cap is set.");
});

test("no code path in live-run.ts lowers spent_usd", () => {
  const src = fs.readFileSync(path.join(repoRoot, "src/app/server/live-run.ts"), "utf8");
  // Ledger writes are SQL expressions; each one only adds to spent_usd.
  const sqlWrites = [...src.matchAll(/spent_usd: sql`[^`]*`/g)].map((m) => m[0]);
  assert.ok(sqlWrites.length >= 1, "settleRun (end of run and the interrupted charge) writes spent_usd");
  for (const w of sqlWrites) assert.match(w, /^spent_usd: sql`spent_usd \+ /, w);
  assert.doesNotMatch(src, /spent_usd\s*-/);
  assert.doesNotMatch(src, /doUpdateSet\([^)]*spent_usd/);
});
