import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { A9_ITEMS, a9Section, assertA9Signed } from "../../src/pipeline/signoff/a9.ts";

test("A9 refuses missing, partial, stale and rejected approvals", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-a9-test-"));
  const protocolPath = path.join(dir, "protocol.md");
  const signoffPath = path.join(dir, "decisions.jsonl");
  const doc = "## Addendum 2026-10-21 (A9)\n\nFixture proposal.\n";
  const docDigest = crypto.createHash("sha256").update(doc).digest("hex");
  const options = { protocolPath, signoffPath };
  const write = records => fs.writeFileSync(signoffPath, records.map(r => JSON.stringify(r)).join("\n"));
  try {
    fs.writeFileSync(protocolPath, "# Protocol\n");
    assert.throws(() => assertA9Signed(options), /missing/);
    fs.writeFileSync(protocolPath, doc);
    assert.throws(() => assertA9Signed(options), /missing/);
    const approvals = A9_ITEMS.map(item => ({ item, docDigest, decision: "approved" }));
    write(approvals.slice(1));
    assert.throws(() => assertA9Signed(options), /not approved/);
    write(approvals.map(r => ({ ...r, docDigest: "stale" })));
    assert.throws(() => assertA9Signed(options), /not approved/);
    write(approvals);
    assert.doesNotThrow(() => assertA9Signed(options));
    write([...approvals, { ...approvals[0], decision: "rejected" }]);
    assert.throws(() => assertA9Signed(options), /rejected/);
    assert.equal(a9Section(doc + "## Addendum next (A10)\nLater."), doc.trimEnd());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
