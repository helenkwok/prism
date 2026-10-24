import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { agreementByCheck } from "../../src/pipeline/validate/agreement.ts";
import { prepareGateReviewBundle, expandGateReviewBundle } from "../../src/pipeline/validate/gate-review-bundle.ts";

const sha = s => crypto.createHash("sha256").update(s).digest("hex");
function fixture() {
  const matrix = agreementByCheck([{ projectN: 1, checkId: "x", a: "pass", b: "pass" }, { projectN: 2, checkId: "x", a: "claimed", b: "fail" }], ["x"], "synthetic", 10);
  return { generatedAt: "2026-10-25T00:00:00Z", codebookVersion: "v1.0", sampleNs: [1, 2],
    checks: matrix.checks.map(c => ({ ...c, status: "released", reason: "synthetic", correctionApplied: false })), pooled: matrix.pooled,
    published: structuredClone(matrix), secondModel: { requested: 2, usedAsGate: false, vsGold: structuredClone(matrix), vsPrimary: structuredClone(matrix) },
    extraMetadata: { exact: 0.12345678901234568, states: ["pass", "fail", "unknown", "claimed"], unknownFutureField: true } };
}
function store() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prism-review-bundle-"));
  const dir = path.join(root, "validation"); fs.mkdirSync(dir);
  return { root, dir, ledger: path.join(dir, "release-signoffs.jsonl") };
}
function approvals(bundle, ledger) {
  const rows = bundle.components.map(c => ({ item: c.item, docDigest: c.docDigest, decision: "approved", decidedAt: "2026-10-25T00:00:00Z" }));
  fs.writeFileSync(ledger, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
}

test("all four matrices and arbitrary metadata round-trip without numeric changes", () => {
  const s = store();
  try {
    const original = fixture();
    const bundle = prepareGateReviewBundle(original, s.dir);
    assert.equal(bundle.components.length, 3);
    assert.deepEqual(bundle.manifest.checks, original.checks);
    assert.deepEqual(bundle.manifest.pooled, original.pooled);
    assert.equal(bundle.manifest.completeGateDigest, sha(JSON.stringify(original)));
    assert.equal(bundle.manifest.reviewFormat, "signed-matrix-manifest-v1");
    for (const c of bundle.components) {
      assert.equal(sha(c.doc), c.docDigest);
      assert.equal(fs.readFileSync(c.path, "utf8"), c.doc);
      assert.equal(fs.statSync(c.path).mode & 0o777, 0o600);
      assert.match(c.basename, new RegExp(c.docDigest));
    }
    approvals(bundle, s.ledger);
    assert.deepEqual(expandGateReviewBundle(JSON.parse(bundle.manifestText), s.dir, s.ledger), original);
    assert.deepEqual(prepareGateReviewBundle(original, s.dir), bundle);
    assert.deepEqual(expandGateReviewBundle(original, s.dir, s.ledger), original);
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test("missing, changed, rejected or stale component approvals fail closed", () => {
  const s = store();
  try {
    const bundle = prepareGateReviewBundle(fixture(), s.dir);
    approvals(bundle, s.ledger);
    const c = bundle.components[0];
    fs.writeFileSync(s.ledger, "");
    assert.throws(() => expandGateReviewBundle(bundle.manifest, s.dir, s.ledger), /approval/);
    approvals(bundle, s.ledger);
    const stale = fs.readFileSync(s.ledger, "utf8").replace(c.docDigest, "f".repeat(64));
    fs.writeFileSync(s.ledger, stale);
    assert.throws(() => expandGateReviewBundle(bundle.manifest, s.dir, s.ledger), /approval/);
    approvals(bundle, s.ledger);
    fs.appendFileSync(s.ledger, JSON.stringify({ item: c.item, docDigest: c.docDigest, decision: "rejected", decidedAt: "2026-10-26T00:00:00Z" }) + "\n");
    assert.throws(() => expandGateReviewBundle(bundle.manifest, s.dir, s.ledger), /approval/);
    approvals(bundle, s.ledger);
    fs.writeFileSync(c.path, c.doc + " ");
    assert.throws(() => expandGateReviewBundle(bundle.manifest, s.dir, s.ledger), /digest/);
    assert.throws(() => prepareGateReviewBundle(fixture(), s.dir), /immutable/);
    fs.unlinkSync(c.path);
    assert.throws(() => expandGateReviewBundle(bundle.manifest, s.dir, s.ledger));
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test("manifest omissions, unknown reference fields and path escapes are refused", () => {
  const s = store();
  try {
    const bundle = prepareGateReviewBundle(fixture(), s.dir); approvals(bundle, s.ledger);
    for (const mutate of [
      m => { delete m.secondModel.vsPrimary; },
      m => { m.published.extra = true; },
      m => { m.published.$ref = "../outside.json"; },
      m => { m.published.item = "unrelated"; },
      m => { m.checks[0].ac1 = .5; },
      m => { m.reviewFormat = "unknown"; },
    ]) {
      const changed = structuredClone(bundle.manifest); mutate(changed);
      assert.throws(() => expandGateReviewBundle(changed, s.dir, s.ledger));
    }
    const c = bundle.components[0];
    fs.unlinkSync(c.path);
    const outside = path.join(s.root, "outside.json"); fs.writeFileSync(outside, c.doc);
    fs.symlinkSync(outside, c.path);
    assert.throws(() => expandGateReviewBundle(bundle.manifest, s.dir, s.ledger), /outside|contain/);
    assert.throws(() => prepareGateReviewBundle(fixture(), s.dir), /immutable/);
    assert.throws(() => expandGateReviewBundle(bundle.manifest, s.dir), /explicit/);
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test("an altered component cannot be legitimised by updating its hash and approval", () => {
  const s = store();
  try {
    const bundle = prepareGateReviewBundle(fixture(), s.dir);
    const manifest = structuredClone(bundle.manifest);
    const c = bundle.components[0];
    const matrix = JSON.parse(c.doc);
    matrix.checks[0].ac1 = .12345678901234568;
    const text = JSON.stringify(matrix) + "\n";
    const digest = sha(text);
    const basename = `gate-review-published-${digest}.json`;
    fs.writeFileSync(path.join(s.dir, basename), text);
    manifest.published = { $ref: basename, docDigest: digest, item: c.item };
    approvals(bundle, s.ledger);
    fs.appendFileSync(s.ledger, JSON.stringify({ item: c.item, docDigest: digest, decision: "approved", decidedAt: "2026-10-25T00:00:00Z" }) + "\n");
    assert.throws(() => expandGateReviewBundle(manifest, s.dir, s.ledger), /complete gate digest/);
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test("shape checks reject missing metric intervals, extra matrix fields and non-JSON values", () => {
  const s = store();
  try {
    for (const mutate of [
      g => { delete g.published.checks[0].ac1CI; },
      g => { g.secondModel.vsGold.extra = "unexpected"; },
      g => { g.secondModel.vsPrimary.checks[0].checkId = "other"; },
      g => { g.extraMetadata.exact = NaN; },
      g => { g.reviewFormat = "collision"; },
    ]) {
      const changed = fixture(); mutate(changed);
      assert.throws(() => prepareGateReviewBundle(changed, s.dir));
    }
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});
