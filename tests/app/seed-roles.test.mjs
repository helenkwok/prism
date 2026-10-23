// APP-01 / D-81 tracer: seeded admin, judge and company accounts (through the
// real seed script, password on stdin), the access tables, and the guard,
// exercised against real better-auth sessions.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const seedScript = path.join(repoRoot, "src/app/server/seed-account.ts");

// Set before the first import of auth.ts / db.ts (both read the environment lazily, once).
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-seed-roles-"));
process.env.PRISM_DATA_DIR = dataDir;
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
process.env.BETTER_AUTH_URL = "http://127.0.0.1:3999";

const { getAuth } = await import("../../src/app/server/auth.ts");
const { getDb } = await import("../../src/app/server/db.ts");
const { AccessError, checkAccess, decideAccess } = await import("../../src/app/server/access.ts");
const { grantsOf, upsertProjectAccess } = await import("../../src/app/server/access-store.ts");

function seed(args, password) {
  return spawnSync(process.execPath, [seedScript, ...args], {
    cwd: repoRoot,
    env: { ...process.env },
    input: password,
    encoding: "utf8",
  });
}

const pw = () => randomBytes(16).toString("hex");
const accounts = {
  admin: { email: "admin@example.test", password: pw() },
  judge: { email: "judge@example.test", password: pw() },
  company: { email: "company@example.test", password: pw() },
  spare: { email: "spare@example.test", password: pw() },
};
const seedOutputs = {};
const ids = {};

async function cookieFor({ email, password }) {
  const res = await getAuth().api.signInEmail({ body: { email, password }, asResponse: true });
  assert.equal(res.status, 200, `sign-in for ${email}`);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return new Headers({ cookie });
}

const headers = {};

before(async () => {
  for (const [key, role, extra] of [
    ["admin", "admin", []],
    ["judge", "judge", []],
    ["company", "company", ["--grant", "P1"]],
    ["spare", "company", []],
  ]) {
    const a = accounts[key];
    const r = seed(["--email", a.email, "--role", role, "--password-stdin", ...extra], `${a.password}\n`);
    assert.equal(r.status, 0, `seed ${key}: ${r.stderr}`);
    seedOutputs[key] = r.stdout + r.stderr;
    ids[key] = /id=([^,)]+)/.exec(r.stdout)?.[1];
  }
  const db = getDb();
  await upsertProjectAccess(db, { projectId: "P1", basis: "own", sponsorHold: false, inSample: true, pseudonym: "A1B2C" });
  await upsertProjectAccess(db, { projectId: "P2", basis: null, sponsorHold: false, inSample: true, pseudonym: "K7F2Q" });
  await upsertProjectAccess(db, { projectId: "P3", basis: "well-known", sponsorHold: true, inSample: true, pseudonym: "Z9Y8X" });
  for (const key of ["admin", "judge", "company"]) headers[key] = await cookieFor(accounts[key]);
});

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function rejectsWith(promise, status) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof AccessError, `expected AccessError, got ${err}`);
    assert.equal(err.status, status);
    return true;
  });
}

async function messageOf(promise) {
  try {
    await promise;
  } catch (err) {
    return err.message;
  }
  return null;
}

describe("seed script", () => {
  test("seeding judge and company succeeds and the company holds its grant", async () => {
    assert.match(seedOutputs.judge, /Created judge account: judge@example\.test \(id=.+, grants=0\)/);
    assert.match(seedOutputs.company, /Created company account: company@example\.test \(id=.+, grants=1\)/);
    assert.deepEqual(await grantsOf(getDb(), ids.company), ["P1"]);
  });

  test("seed output never contains a password", () => {
    for (const key of Object.keys(seedOutputs)) {
      assert.equal(seedOutputs[key].includes(accounts[key].password), false, key);
    }
  });

  test("--role superuser is refused, naming --role", () => {
    const r = seed(["--email", "s@example.test", "--role", "superuser", "--password-stdin"], "x");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--role/);
  });

  test("--password on argv is refused, naming --password-stdin", () => {
    const r = seed(["--email", "p@example.test", "--role", "admin", "--password", "x"], "");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--password-stdin/);
    assert.equal(r.stdout.includes("Created"), false);
  });

  test("--grant with --role judge is refused", () => {
    const r = seed(["--email", "g@example.test", "--role", "judge", "--password-stdin", "--grant", "P1"], "x");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--grant/);
  });

  test("an empty stdin password is refused", () => {
    const r = seed(["--email", "e@example.test", "--role", "judge", "--password-stdin"], "\n");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /empty/);
  });

  test("--password-file with group or other bits is refused; mode 600 is accepted", () => {
    const loose = path.join(dataDir, "loose.pw");
    fs.writeFileSync(loose, "secret-value\n", { mode: 0o644 });
    fs.chmodSync(loose, 0o644);
    const r1 = seed(["--email", "f1@example.test", "--role", "judge", "--password-file", loose], "");
    assert.notEqual(r1.status, 0);
    assert.match(r1.stderr, /chmod 600/);
    const tight = path.join(dataDir, "tight.pw");
    fs.writeFileSync(tight, `${pw()}\n`, { mode: 0o600 });
    fs.chmodSync(tight, 0o600);
    const r2 = seed(["--email", "f2@example.test", "--role", "judge", "--password-file", tight], "");
    assert.equal(r2.status, 0, r2.stderr);
  });
});

describe("better-auth roles", () => {
  test("a signed-in admin can still set another user's role (adminAc kept)", async () => {
    const res = await getAuth().api.setRole({ body: { userId: ids.spare, role: "judge" }, headers: headers.admin });
    assert.equal(res.user.role, "judge");
  });

  test("a judge cannot set a role through the admin plugin", async () => {
    await assert.rejects(
      getAuth().api.setRole({ body: { userId: ids.spare, role: "admin" }, headers: headers.judge }),
      (err) => err.statusCode === 403 || err.status === "FORBIDDEN",
    );
  });
});

describe("checkAccess against real sessions", () => {
  const db = () => getDb();

  test("judge: identifiable out-of-rule sampled project is refused 403 forbidden", async () => {
    await rejectsWith(checkAccess({ headers: headers.judge, db: db(), view: "identifiable", projectId: "P2" }), 403);
  });

  test("judge: de-identified view of the same sampled project is allowed", async () => {
    const r = await checkAccess({ headers: headers.judge, db: db(), view: "deidentified", pseudonym: "K7F2Q" });
    assert.equal(r.project.projectId, "P2");
  });

  test("judge: identifiable own project is allowed", async () => {
    const r = await checkAccess({ headers: headers.judge, db: db(), view: "identifiable", projectId: "P1" });
    assert.equal(r.project.projectId, "P1");
  });

  test("judge: identifiable well-known project under sponsor hold is refused 403", async () => {
    await rejectsWith(checkAccess({ headers: headers.judge, db: db(), view: "identifiable", projectId: "P3" }), 403);
  });

  test("unknown project id: 403 with the same message as the forbidden case", async () => {
    await rejectsWith(checkAccess({ headers: headers.judge, db: db(), view: "identifiable", projectId: "NOPE" }), 403);
    const missing = await messageOf(checkAccess({ headers: headers.judge, db: db(), view: "identifiable", projectId: "NOPE" }));
    const forbidden = await messageOf(checkAccess({ headers: headers.judge, db: db(), view: "identifiable", projectId: "P2" }));
    assert.equal(missing, "forbidden");
    assert.equal(missing, forbidden);
  });

  test("no session cookie: 401 unauthenticated", async () => {
    await rejectsWith(checkAccess({ headers: new Headers(), db: db(), view: "identifiable", projectId: "P1" }), 401);
  });

  test("company: identifiable P1 allowed, identifiable P2 refused, de-identified P1 refused", async () => {
    const r = await checkAccess({ headers: headers.company, db: db(), view: "identifiable", projectId: "P1" });
    assert.equal(r.project.projectId, "P1");
    await rejectsWith(checkAccess({ headers: headers.company, db: db(), view: "identifiable", projectId: "P2" }), 403);
    await rejectsWith(checkAccess({ headers: headers.company, db: db(), view: "deidentified", pseudonym: "A1B2C" }), 403);
  });

  test("admin: both views allowed", async () => {
    await checkAccess({ headers: headers.admin, db: db(), view: "identifiable", projectId: "P2" });
    await checkAccess({ headers: headers.admin, db: db(), view: "deidentified", pseudonym: "K7F2Q" });
  });
});

describe("decideAccess table (pure, no database)", () => {
  const grants = ["P-granted"];
  const classes = {
    own: { projectId: "P-own", basis: "own", sponsorHold: false, inSample: true },
    "opt-in": { projectId: "P-opt", basis: "opt-in", sponsorHold: false, inSample: true },
    "well-known": { projectId: "P-wk", basis: "well-known", sponsorHold: false, inSample: true },
    "well-known+hold": { projectId: "P-wkh", basis: "well-known", sponsorHold: true, inSample: true },
    "out-of-rule sampled": { projectId: "P-oor", basis: null, sponsorHold: false, inSample: true },
    granted: { projectId: "P-granted", basis: null, sponsorHold: false, inSample: true },
    "not granted": { projectId: "P-other", basis: null, sponsorHold: false, inSample: true },
    "not sampled": { projectId: "P-ns", basis: null, sponsorHold: false, inSample: false },
  };
  // [identifiable, deidentified] per role per class.
  const expected = {
    admin: {
      own: [1, 1], "opt-in": [1, 1], "well-known": [1, 1], "well-known+hold": [1, 1],
      "out-of-rule sampled": [1, 1], granted: [1, 1], "not granted": [1, 1], "not sampled": [1, 1],
    },
    judge: {
      own: [1, 1], "opt-in": [1, 1], "well-known": [1, 1], "well-known+hold": [0, 1],
      "out-of-rule sampled": [0, 1], granted: [0, 1], "not granted": [0, 1], "not sampled": [0, 0],
    },
    company: {
      own: [0, 0], "opt-in": [0, 0], "well-known": [0, 0], "well-known+hold": [0, 0],
      "out-of-rule sampled": [0, 0], granted: [1, 0], "not granted": [0, 0], "not sampled": [0, 0],
    },
    none: {
      own: [0, 0], "opt-in": [0, 0], "well-known": [0, 0], "well-known+hold": [0, 0],
      "out-of-rule sampled": [0, 0], granted: [0, 0], "not granted": [0, 0], "not sampled": [0, 0],
    },
  };
  for (const [role, row] of Object.entries(expected)) {
    for (const [cls, [ident, deid]] of Object.entries(row)) {
      test(`${role} × ${cls}: identifiable ${ident ? "allow" : "deny"}, de-identified ${deid ? "allow" : "deny"}`, () => {
        const r = role === "none" ? null : role;
        assert.equal(decideAccess(r, grants, classes[cls], "identifiable"), Boolean(ident));
        assert.equal(decideAccess(r, grants, classes[cls], "deidentified"), Boolean(deid));
      });
    }
  }
});
