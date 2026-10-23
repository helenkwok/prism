// T-07-65: session IPs are blanked once a session is more than a day old, on real
// better-auth session rows, and boot runs the job once plus hourly.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-session-ip-"));
process.env.PRISM_DATA_DIR = dataDir;
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
process.env.BETTER_AUTH_URL = "http://127.0.0.1:3995";

const { getAuth } = await import("../../src/app/server/auth.ts");
const { getDb } = await import("../../src/app/server/db.ts");
const { blankOldSessionIps } = await import("../../src/app/server/session-ip.ts");

const account = { email: "ip-judge@example.test", password: randomBytes(16).toString("hex") };
const HOUR = 60 * 60 * 1000;
const sessionIds = {};

async function signInFrom(ip) {
  const res = await getAuth().api.signInEmail({
    body: account,
    headers: new Headers({ "x-forwarded-for": ip }),
    asResponse: true,
  });
  assert.equal(res.status, 200);
  const rows = await getDb().selectFrom("session").select(["id", "ipAddress"]).where("ipAddress", "=", ip).execute();
  assert.equal(rows.length, 1, `one session from ${ip}`);
  return rows[0].id;
}

before(async () => {
  const seed = spawnSync(
    process.execPath,
    [path.join(repoRoot, "src/app/server/seed-account.ts"), "--email", account.email, "--role", "judge", "--password-stdin"],
    { cwd: repoRoot, env: { ...process.env }, input: `${account.password}\n`, encoding: "utf8" },
  );
  assert.equal(seed.status, 0, seed.stderr);
  sessionIds.old = await signInFrom("192.0.2.25");
  sessionIds.young = await signInFrom("192.0.2.23");
});

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const ipOf = async (id) => (await getDb().selectFrom("session").select("ipAddress").where("id", "=", id).executeTakeFirstOrThrow()).ipAddress;

test("better-auth stores session.createdAt as an ISO-8601 UTC string (the job compares in this format)", async () => {
  const row = await getDb().selectFrom("session").select("createdAt").where("id", "=", sessionIds.old).executeTakeFirstOrThrow();
  assert.equal(typeof row.createdAt, "string");
  assert.match(row.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});

test("a session 25 hours old loses its IP, one 23 hours old keeps it, and a second run blanks nothing", async () => {
  const now = new Date();
  const db = getDb();
  await db.updateTable("session").set({ createdAt: new Date(now.getTime() - 25 * HOUR).toISOString() }).where("id", "=", sessionIds.old).execute();
  await db.updateTable("session").set({ createdAt: new Date(now.getTime() - 23 * HOUR).toISOString() }).where("id", "=", sessionIds.young).execute();

  assert.equal(await blankOldSessionIps(db, now), 1);
  assert.equal(await ipOf(sessionIds.old), null);
  assert.equal(await ipOf(sessionIds.young), "192.0.2.23");
  assert.equal(await blankOldSessionIps(db, now), 0);
});

test("boot runs the job once, logs a count only, and schedules it hourly on an unref'd timer", async () => {
  const young = await signInFrom("192.0.2.40");
  await getDb().updateTable("session").set({ createdAt: new Date(Date.now() - 30 * HOUR).toISOString() }).where("id", "=", young).execute();

  const logs = [];
  const timers = [];
  const realLog = console.log;
  const realSetInterval = globalThis.setInterval;
  console.log = (...a) => logs.push(a.join(" "));
  globalThis.setInterval = (fn, ms) => {
    const t = { fn, ms, unrefed: false, unref() { this.unrefed = true; return this; } };
    timers.push(t);
    return t;
  };
  try {
    const { default: boot } = await import("../../src/app/server/boot.ts");
    await boot();
  } finally {
    console.log = realLog;
    globalThis.setInterval = realSetInterval;
  }
  const jobLines = logs.filter((l) => l.startsWith("[prism] session ip job"));
  assert.deepEqual(jobLines, ["[prism] session ip job: blanked 1"]);
  assert.ok(!logs.join("\n").includes("192.0.2."), "no address is logged");
  assert.equal(await ipOf(young), null);
  const hourly = timers.filter((t) => t.ms === HOUR);
  assert.equal(hourly.length, 1);
  assert.equal(hourly[0].unrefed, true);
});
