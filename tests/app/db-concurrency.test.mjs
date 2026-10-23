// The server's one SQLite connection (db.ts getDb) under concurrent async
// callers. Kysely 0.29.6's SqliteDriver has no lock of its own, but its
// RuntimeDriver adds a ConnectionMutex for any adapter whose
// supportsMultipleConnections is false, which SqliteAdapter is. The mutex is
// held from acquireConnection to releaseConnection, i.e. for one query or for a
// whole transaction. These tests pin that guarantee on the real getDb()
// instance, and a control run with the mutex switched off shows each scenario
// fails without it, so the tests can detect the bug.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Kysely, SqliteAdapter, SqliteDialect } from "kysely";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-db-concurrency-"));
process.env.PRISM_DATA_DIR = dataDir;
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
process.env.BETTER_AUTH_URL = "http://127.0.0.1:3996";

const { getDb, ensureSchema } = await import("../../src/app/server/db.ts");
const { getAuth } = await import("../../src/app/server/auth.ts");
const { loadCodebook } = await import("../../src/pipeline/coding/codebook-prompt.ts");
const { loadGateFile, resolveGatesPath } = await import("../../src/pipeline/coding/contract.ts");
const { recordPersonGold } = await import("../../src/pipeline/review/trail.ts");

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Control only: the same SQLite dialect with Kysely's single-connection mutex switched off. */
class UnlockedSqliteDialect extends SqliteDialect {
  createAdapter() {
    return new (class extends SqliteAdapter {
      get supportsMultipleConnections() {
        return true;
      }
    })();
  }
}

async function freshTable(db, name) {
  await db.schema.dropTable(name).ifExists().execute();
  await db.schema.createTable(name).addColumn("v", "text").execute();
}

// ---- scenarios, each run on the real instance and on the unlocked control ----

/** (a) Two concurrent transactions both commit; neither sees the other's row mid-transaction. */
async function scenarioA(db) {
  await freshTable(db, "cc_a");
  const seen = {};
  const tx = (name) =>
    db.transaction().execute(async (trx) => {
      await trx.insertInto("cc_a").values({ v: name }).execute();
      await pause(20);
      seen[name] = (await trx.selectFrom("cc_a").select("v").execute()).map((r) => r.v).sort();
    });
  await Promise.all([tx("t1"), tx("t2")]);
  const rows = (await db.selectFrom("cc_a").select("v").execute()).map((r) => r.v).sort();
  assert.deepEqual(rows, ["t1", "t2"], "both committed");
  // Whichever ran first saw only its own row while it was open.
  const first = seen.t1.length === 1 ? "t1" : "t2";
  assert.deepEqual(seen[first], [first], `${first} saw another transaction's uncommitted row`);
  return seen;
}

/** (b) A write by another caller while a transaction is open survives that transaction's rollback. */
async function scenarioB(db) {
  await freshTable(db, "cc_b");
  const rolledBack = db
    .transaction()
    .execute(async (trx) => {
      await trx.insertInto("cc_b").values({ v: "inside" }).execute();
      await pause(30);
      throw new Error("roll back");
    })
    .catch((e) => e.message);
  await pause(5); // the transaction is open now
  const outside = db.insertInto("cc_b").values({ v: "outside" }).execute();
  assert.equal(await rolledBack, "roll back");
  await outside;
  const rows = (await db.selectFrom("cc_b").select("v").execute()).map((r) => r.v);
  assert.deepEqual(rows, ["outside"], "the other caller's write was rolled back with the transaction");
}

/** (c) Ten concurrent transactions: no "cannot start a transaction within a transaction". */
async function scenarioC(db) {
  await freshTable(db, "cc_c");
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) =>
      db.transaction().execute(async (trx) => {
        await trx.insertInto("cc_c").values({ v: String(i) }).execute();
        await pause(2);
      }),
    ),
  );
  const errors = results.filter((r) => r.status === "rejected").map((r) => r.reason.message);
  assert.deepEqual(errors, [], "transactions failed");
  assert.equal((await db.selectFrom("cc_c").select("v").execute()).length, 10);
}

const SCENARIOS = { "(a) two concurrent transactions": scenarioA, "(b) outside write survives a rollback": scenarioB, "(c) ten concurrent transactions": scenarioC };

before(async () => {
  await ensureSchema();
});
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

describe("the server's getDb() instance", () => {
  for (const [name, run] of Object.entries(SCENARIOS)) {
    test(name, async () => {
      await run(getDb());
      console.log(`RESULT locked ${name}: pass`);
    });
  }

  test("(d) better-auth sign-in alongside a review-route transaction (recordPersonGold) and a rolled-back transaction", async () => {
    const db = getDb();
    const email = "concurrency@example.test";
    const password = randomBytes(16).toString("hex");
    const seed = spawnSync(process.execPath, [path.join(repoRoot, "src/app/server/seed-account.ts"), "--email", email, "--role", "admin", "--password-stdin"], {
      cwd: repoRoot,
      env: { ...process.env },
      input: `${password}\n`,
      encoding: "utf8",
    });
    assert.equal(seed.status, 0);

    // One collected page for project 7 (the trail.ts fixture shape).
    const pipe = path.join(dataDir, "pipeline");
    fs.mkdirSync(path.join(pipe, "manifests"), { recursive: true });
    fs.mkdirSync(path.join(pipe, "snapshots"), { recursive: true });
    fs.writeFileSync(path.join(pipe, "manifests", "7.json"), JSON.stringify({ snapshotHashesInCollectionOrder: ["snap1"] }));
    fs.writeFileSync(path.join(pipe, "snapshots", "snap1.json"), JSON.stringify({ redactedText: "We publish a status page for customers." }));
    const gate = loadGateFile(resolveGatesPath());
    const labels = gate.checkIds.map((id) => ({ checkId: id, state: "unknown", spanIds: [] }));

    const held = db
      .transaction()
      .execute(async (trx) => {
        await trx.selectFrom("user").select("id").execute();
        await pause(40);
        throw new Error("roll back");
      })
      .catch((e) => e.message);
    await pause(5);
    const [signIn, gold, heldResult] = await Promise.all([
      getAuth().api.signInEmail({ body: { email, password }, asResponse: true }),
      recordPersonGold(db, dataDir, { projectN: 7, labels, actorId: "person:test", codebookVersion: loadCodebook().codebookVersion }).then(() => "ok"),
      held,
    ]);
    assert.equal(signIn.status, 200);
    assert.equal(gold, "ok");
    assert.equal(heldResult, "roll back");
    const user = await db.selectFrom("user").select("id").where("email", "=", email).executeTakeFirstOrThrow();
    const sessions = await db.selectFrom("session").select("id").where("userId", "=", user.id).execute();
    assert.equal(sessions.length, 1, "the session written during the open transaction survived its rollback");
    assert.equal((await db.selectFrom("pipeline_gold_labels").select("check_id").where("project_n", "=", 7).execute()).length, gate.checkIds.length);
    console.log(`RESULT locked (d) sign-in 200, gold rows ${gate.checkIds.length}, session kept after a concurrent rollback`);
  });
});

describe("control: Kysely's single-connection mutex switched off", () => {
  for (const [name, run] of Object.entries(SCENARIOS)) {
    test(`${name} fails without the mutex`, async () => {
      const db = new Kysely({ dialect: new UnlockedSqliteDialect({ database: new Database(path.join(dataDir, `control-${name[1]}.sqlite`)) }) });
      const err = await run(db).then(
        () => null,
        (e) => e,
      );
      assert.ok(err, "the scenario passed without the mutex, so it would not detect the bug");
      console.log(`RESULT unlocked ${name}: fails (${err.message.split("\n")[0].slice(0, 90)})`);
      await db.destroy();
    });
  }
});
