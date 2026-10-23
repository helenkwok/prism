// T-07-63: scripts/serve.mjs serves files from dist/client only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { staticFile } from "../scripts/serve.mjs";

test("staticFile resolves inside the client directory and refuses everything else", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prism-serve-"));
  const base = path.join(tmp, "client");
  fs.mkdirSync(path.join(base, "assets"), { recursive: true });
  fs.writeFileSync(path.join(base, "assets", "app.js"), "x");
  fs.writeFileSync(path.join(tmp, "secret.txt"), "s");
  fs.mkdirSync(path.join(tmp, "client-evil"));
  fs.writeFileSync(path.join(tmp, "client-evil", "x.js"), "e");
  try {
    assert.equal(staticFile("/assets/app.js", base), path.join(base, "assets", "app.js"));
    for (const p of [
      "/../secret.txt",
      "/assets/../../secret.txt",
      "/%2e%2e/secret.txt",
      "/assets/%2e%2e%2f%2e%2e%2fsecret.txt",
      "/..%5csecret.txt",
      "/../client-evil/x.js",
      "/assets/app.js%00.png",
      "/%E0%A4%A",
      "/",
      "/assets",
      "/missing.js",
    ]) {
      assert.equal(staticFile(p, base), null, p);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
