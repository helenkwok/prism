// D-83: addendum A14 (process figures outside k = 10) and the export's exception list agree,
// and the A14 sign-off check is bound to the section digest. (Planned as A10, drafted as A11; both were taken.)

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { A11_ITEMS, PROCESS_FIGURES, a11FigureIds, a11Section, assertA11Signed } from "../../src/publish/a11.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const protocol = fs.readFileSync(path.join(REPO, "protocol/PROTOCOL.md"), "utf8");

test("a11-matches-process-figures: the A14 list and PROCESS_FIGURES name the same four figures", () => {
  assert.deepEqual(a11FigureIds(protocol), PROCESS_FIGURES.map((f) => f.id));
  assert.deepEqual(
    PROCESS_FIGURES.map((f) => f.id),
    ["screening-audit", "collection-recall", "person-edits", "confirmation-total"],
  );
});

test("A14 is appended once, after A9 to A13, with its one item heading", () => {
  const headings = protocol.split("\n").filter((l) => /^## Addendum /.test(l));
  assert.equal(headings.filter((l) => l.endsWith("(A14)")).length, 1);
  assert.equal(headings.at(-1), "## Addendum 2026-10-23 (A14)");
  assert.ok(headings.indexOf("## Addendum 2026-10-23 (A10)") < headings.length - 1);
  for (const item of A11_ITEMS) assert.ok(a11Section(protocol).includes(`### ${item}`), item);
});

test("A14 sign-off: missing, stale and rejected approvals refuse; a digest-bound approval passes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-a11-test-"));
  const protocolPath = path.join(dir, "protocol.md");
  const signoffPath = path.join(dir, "decisions.jsonl");
  const doc = "## Addendum 2026-10-23 (A14)\n\n- `screening-audit`: fixture\n";
  const docDigest = crypto.createHash("sha256").update(doc).digest("hex");
  const options = { protocolPath, signoffPath };
  const write = (records) => fs.writeFileSync(signoffPath, records.map((r) => JSON.stringify(r)).join("\n"));
  try {
    fs.writeFileSync(protocolPath, "# Protocol\n");
    assert.throws(() => assertA11Signed(options), /missing/);
    fs.writeFileSync(protocolPath, doc);
    assert.throws(() => assertA11Signed(options), /missing/);
    const approvals = A11_ITEMS.map((item) => ({ item, docDigest, decision: "approved" }));
    write(approvals.map((r) => ({ ...r, docDigest: "stale" })));
    assert.throws(() => assertA11Signed(options), /not approved/);
    write(approvals);
    assert.doesNotThrow(() => assertA11Signed(options));
    write([...approvals, { ...approvals[0], decision: "rejected" }]);
    assert.throws(() => assertA11Signed(options), /rejected/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
