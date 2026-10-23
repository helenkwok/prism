// 07-12c: the first production boot is on an empty data directory. better-auth checks
// its schema when the instance is created, so boot must migrate before creating it;
// otherwise every auth request fails with SCHEMA_MISMATCH until a restart.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-fresh-boot-"));
process.env.PRISM_DATA_DIR = dataDir;
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
process.env.BETTER_AUTH_URL = "http://127.0.0.1:3996";

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test("boot on a fresh database leaves auth working without a restart", async () => {
  const realSetInterval = globalThis.setInterval;
  const realLog = console.log;
  globalThis.setInterval = () => ({ unref() { return this; } });
  console.log = () => {};
  try {
    const { default: boot } = await import("../../src/app/server/boot.ts");
    await boot();
  } finally {
    globalThis.setInterval = realSetInterval;
    console.log = realLog;
  }
  const { getAuth } = await import("../../src/app/server/auth.ts");
  const res = await getAuth().handler(new Request("http://127.0.0.1:3996/api/auth/ok"));
  assert.equal(res.status, 200);
  const signIn = await getAuth().handler(
    new Request("http://127.0.0.1:3996/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:3996" },
      body: JSON.stringify({ email: "nobody@example.test", password: randomBytes(12).toString("hex") }),
    }),
  );
  assert.equal(signIn.status, 401);
});
