// The CLI's credential loader: environment first, then a mode-600 key file; errors never carry the value.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { readKey } from "../../src/pipeline/run.ts";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "prism-keys-"));
}

test("the environment variable wins over the key file", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "t.key"), "from-file\n", { mode: 0o600 });
  assert.equal(readKey("T_KEY", "t.key", { T_KEY: "from-env", PRISM_KEY_DIR: dir }), "from-env");
});

test("falls back to the key file, trimming the trailing newline", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "t.key"), "secret-value\n", { mode: 0o600 });
  assert.equal(readKey("T_KEY", "t.key", { PRISM_KEY_DIR: dir }), "secret-value");
});

test("a missing or empty key file is undefined", () => {
  const dir = tmpDir();
  assert.equal(readKey("T_KEY", "t.key", { PRISM_KEY_DIR: dir }), undefined);
  fs.writeFileSync(path.join(dir, "t.key"), "\n", { mode: 0o600 });
  assert.equal(readKey("T_KEY", "t.key", { PRISM_KEY_DIR: dir }), undefined);
});

test("a group- or world-readable key file is refused, and the error names the path, not the value", () => {
  const dir = tmpDir();
  const p = path.join(dir, "t.key");
  fs.writeFileSync(p, "secret-value\n");
  fs.chmodSync(p, 0o644);
  assert.throws(
    () => readKey("T_KEY", "t.key", { PRISM_KEY_DIR: dir }),
    (err) => err.message.includes(p) && !err.message.includes("secret-value"),
  );
});
