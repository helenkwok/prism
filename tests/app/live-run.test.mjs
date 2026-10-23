// APP-02 / SC2 / D-80: the live run's queue and progress with the fixture
// runner (no network, no model call). Real better-auth sessions from seeded
// accounts (password on stdin); the live-run tables live in an in-memory db.
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
const ORIGIN = "http://127.0.0.1:3998";

// Set before the first import of auth.ts / db.ts (both read the environment lazily, once).
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-live-run-"));
process.env.PRISM_DATA_DIR = dataDir;
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
process.env.BETTER_AUTH_URL = ORIGIN;
delete process.env.TRUSTED_ORIGINS;

const { getAuth } = await import("../../src/app/server/auth.ts");
const { AccessError } = await import("../../src/app/server/access.ts");
const { ensureAccessSchema, upsertProjectAccess } = await import("../../src/app/server/access-store.ts");
const { ensureReportViewSchema, upsertReportView, readReportView } = await import("../../src/report/store.ts");
const live = await import("../../src/app/server/live-run.ts");

const headers = {};
let db;

function seed(email, role, password) {
  const r = spawnSync(process.execPath, [path.join(repoRoot, "src/app/server/seed-account.ts"), "--email", email, "--role", role, "--password-stdin"], {
    cwd: repoRoot,
    env: { ...process.env },
    input: `${password}\n`,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `seed ${role}`);
}

async function cookieFor(email, password) {
  const res = await getAuth().api.signInEmail({ body: { email, password }, asResponse: true });
  assert.equal(res.status, 200);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

export function fixtureView(projectRef, pages = 3) {
  return {
    version: 1,
    view: "identifiable",
    projectRef,
    title: `Fixture ${projectRef}`,
    fixture: false,
    generatedAt: "2026-10-01T00:00:00.000Z",
    codebookVersion: "1.0",
    gateSha: "0000000",
    collection: { pages, rendered: pages, notRendered: 0, renderAvailable: true, collectedAt: "2026-10-01T00:00:00.000Z", urls: [] },
    decisions: [],
    checks: [{ checkId: "c1", published: "pass" }, { checkId: "c2", published: "unknown" }],
    howMade: {},
  };
}

before(async () => {
  for (const role of ["admin", "judge", "company"]) {
    const email = `${role}@live-run.test`;
    const password = randomBytes(16).toString("hex");
    seed(email, role, password);
    headers[role] = new Headers({ cookie: await cookieFor(email, password), origin: ORIGIN });
  }
});

beforeEach(async () => {
  db = new Kysely({ dialect: new SqliteDialect({ database: new Database(":memory:") }) });
  await ensureAccessSchema(db);
  await ensureReportViewSchema(db);
  await live.ensureLiveRunSchema(db);
  await upsertProjectAccess(db, { projectId: "P01", basis: "own", sponsorHold: false, inSample: true, liveBoundaryJson: JSON.stringify([{ host: "p01.example" }]) });
  await upsertProjectAccess(db, { projectId: "P02", basis: null, sponsorHold: false, inSample: true, liveBoundaryJson: JSON.stringify([{ host: "p02.example" }]) });
  await upsertReportView(db, fixtureView("P01"));
});

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const deps = (extra = {}) => ({ db, runner: live.createFixtureRunner({ stageMs: 0 }), resolver: live.fixtureResolver, ...extra });
const jobCount = async () => Number((await db.selectFrom("app_job").select((eb) => eb.fn.countAll().as("n")).executeTakeFirst()).n);

test("fixture run: queued -> running -> done, seven stages in order with one message each, report flagged fixture", async () => {
  const r = await live.startLiveRunAs(headers.admin, "https://p01.example/", deps());
  assert.ok("jobId" in r, JSON.stringify(r));
  const first = await live.readRunStatus(db, r.jobId);
  assert.ok(["queued", "running"].includes(first.job.status), first.job.status);
  await live.whenIdle();
  const s = await live.readRunStatus(db, r.jobId);
  assert.equal(s.job.status, "done");
  assert.equal(s.job.projectRef, "P01");
  assert.deepEqual(s.stages.map((x) => x.label), ["Queued", "Screen", "Collect (robots.txt first)", "Code", "Gate", "Confirm positives", "Build report"]);
  for (const st of s.stages) {
    assert.equal(st.status, "done", st.stage);
    assert.ok(st.message && st.message.length > 0, `${st.stage} message`);
  }
  const events = await db.selectFrom("app_job_event").selectAll().where("job_id", "=", r.jobId).orderBy("seq").execute();
  assert.deepEqual(events.slice(0, 2).map((e) => `${e.stage}:${e.status}`), ["queued:running", "queued:done"]);
  assert.deepEqual([...new Set(events.map((e) => e.stage))], live.STAGES);
  assert.deepEqual(s.report, { projectRef: "P01", pages: 3, pass: 1, fixture: true });
  assert.equal((await readReportView(db, "P01", "identifiable")).fixture, true);
  console.log(`RESULT job ${r.jobId} ${first.job.status} -> ${s.job.status} stages=${s.stages.map((x) => x.stage).join(",")} report=${s.report.projectRef}`);
});

test("refusals: off-list, private-address and bad-url create no job and make no lookup before the list check", async () => {
  const calls = [];
  const resolver = async (h) => {
    calls.push(h);
    return h === "p01.example" ? ["10.0.0.1"] : ["93.184.216.34"];
  };
  assert.deepEqual(await live.startLiveRunAs(headers.admin, "https://not-listed.example/", deps({ resolver })), { refused: "off-list" });
  assert.deepEqual(await live.startLiveRunAs(headers.admin, "https://p02.example/", deps({ resolver })), { refused: "off-list" }, "basis null is not own or opt-in");
  assert.equal(calls.length, 0);
  assert.deepEqual(await live.startLiveRunAs(headers.admin, "https://p01.example/", deps({ resolver })), { refused: "private-address" });
  assert.deepEqual(await live.startLiveRunAs(headers.admin, "http://p01.example/", deps({ resolver })), { refused: "bad-url" });
  assert.deepEqual(await live.startLiveRunAs(headers.admin, "x".repeat(2049), deps({ resolver })), { refused: "bad-url" });
  assert.deepEqual(await live.startLiveRunAs(headers.admin, 42, deps({ resolver })), { refused: "bad-url" });
  assert.equal(await jobCount(), 0);
  console.log("RESULT refusals off-list,private-address,bad-url jobs=0");
});

test("a missing or foreign Origin header is refused with 403 and creates no job", async () => {
  const cookie = headers.admin.get("cookie");
  for (const h of [new Headers({ cookie }), new Headers({ cookie, origin: "https://evil.example" })]) {
    await assert.rejects(live.startLiveRunAs(h, "https://p01.example/", deps()), (e) => e instanceof AccessError && e.status === 403);
  }
  assert.equal(await jobCount(), 0);
});

test("judge and company get 403 from startLiveRun, getRunStatus and listRecentRuns; no session gets 401", async () => {
  const ok = await live.startLiveRunAs(headers.admin, "https://p01.example/", deps());
  await live.whenIdle();
  for (const role of ["judge", "company"]) {
    const is403 = (e) => e instanceof AccessError && e.status === 403;
    await assert.rejects(live.startLiveRunAs(headers[role], "https://p01.example/", deps()), is403, role);
    await assert.rejects(live.getRunStatusAs(headers[role], ok.jobId, db), is403, role);
    await assert.rejects(live.listRecentRunsAs(headers[role], db), is403, role);
  }
  await assert.rejects(live.getRunStatusAs(new Headers(), ok.jobId, db), (e) => e instanceof AccessError && e.status === 401);
  assert.equal(await jobCount(), 1);
  assert.equal((await live.getRunStatusAs(headers.admin, ok.jobId, db)).job.status, "done");
  console.log("RESULT judge,company 403 on startLiveRun,getRunStatus,listRecentRuns");
});

test("the default runner ends the job as Error: not configured", async () => {
  assert.equal(live.runnerFromEnv({}).name, "not-configured");
  assert.equal(live.runnerFromEnv({ PRISM_LIVE_RUNNER: "fixture" }).name, "fixture");
  const r = await live.startLiveRunAs(headers.admin, "https://p01.example/", deps({ runner: live.runnerFromEnv({}).runner }));
  await live.whenIdle();
  const s = await live.readRunStatus(db, r.jobId);
  assert.equal(s.job.status, "error");
  assert.equal(s.job.message, "Live run is not configured on this server");
  assert.equal(s.report, null);
  console.log(`RESULT default runner job ${r.jobId} ${s.job.status}: ${s.job.message}`);
});

test("recent runs: newest 20 first, ties broken by job id", async () => {
  for (let i = 0; i < 22; i += 1) {
    await db.insertInto("app_job").values({ url: "https://p01.example/", host: "p01.example", status: "done", created_by: "u", created_at: i < 2 ? "2026-10-23T00:00:00.000Z" : "2026-10-22T00:00:00.000Z" }).execute();
  }
  const runs = await live.readRecentRuns(db);
  assert.equal(runs.length, 20);
  assert.deepEqual(runs.slice(0, 3).map((r) => r.id), [2, 1, 22]);
});
