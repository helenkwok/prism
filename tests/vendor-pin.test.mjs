import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_VENDOR_DIR,
  VENDORED_PATHS,
  readPin,
  verifyLocal,
  verifyRemote,
} from "../scripts/verify-vendor.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "verify-vendor.mjs");

// The pinned set, written out here on purpose: the test fails if the set changes
// without a deliberate edit to this list as well as to the script.
const EXPECTED_SET = [
  "LICENSE",
  "requirements-claim-gate.txt",
  "schemas/v1/claim.schema.json",
  "schemas/v1/decision-gates.json",
  "scripts/claim_gate.py",
  "tests/fixtures/claim-gate-conformance.json",
];

const scratch = [];
function copyVendor() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-vendor-"));
  scratch.push(dir);
  fs.cpSync(DEFAULT_VENDOR_DIR, dir, { recursive: true });
  return dir;
}
after(() => {
  for (const d of scratch) fs.rmSync(d, { recursive: true, force: true });
});

function runCli(args) {
  const res = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

describe("committed vendor folder", () => {
  test("passes the offline check, in process and through the CLI", () => {
    assert.deepEqual(verifyLocal(DEFAULT_VENDOR_DIR), []);
    const res = runCli([]);
    assert.equal(res.status, 0, res.out);
  });

  test("PIN.json records tag, a 40-character commit and a hash for exactly the pinned set", () => {
    const pin = readPin(DEFAULT_VENDOR_DIR);
    assert.match(pin.commit, /^[0-9a-f]{40}$/);
    assert.ok(typeof pin.tag === "string" && pin.tag.length > 0);
    assert.equal(pin.upstream, "https://github.com/AlreadyOpen/ai-output-to-value");
    assert.deepEqual(Object.keys(pin.files).sort(), [...EXPECTED_SET].sort());
    assert.deepEqual([...VENDORED_PATHS].sort(), [...EXPECTED_SET].sort());
    assert.ok(!("PIN.json" in pin.files), "PIN.json must not list itself");
    for (const [rel, entry] of Object.entries(pin.files)) {
      assert.match(entry.sha256, /^[0-9a-f]{64}$/, rel);
      const buf = fs.readFileSync(path.join(DEFAULT_VENDOR_DIR, rel));
      assert.equal(sha256(buf), entry.sha256, rel);
      assert.equal(buf.length, entry.bytes, rel);
    }
  });

  test("only the Python evaluator is vendored for runtime use", () => {
    assert.ok(!VENDORED_PATHS.some((p) => p.endsWith(".mjs") || p.startsWith("packages/")));
  });
});

describe("offline tamper proofs", () => {
  test("one flipped byte in claim_gate.py fails with hash mismatch", () => {
    const dir = copyVendor();
    const file = path.join(dir, "scripts", "claim_gate.py");
    const buf = fs.readFileSync(file);
    buf[buf.length - 2] ^= 0x01;
    fs.writeFileSync(file, buf);
    const res = runCli(["--dir", dir]);
    assert.equal(res.status, 1);
    assert.match(res.out, /hash mismatch: scripts\/claim_gate\.py/);
  });

  test("an added file fails with unlisted file", () => {
    const dir = copyVendor();
    fs.writeFileSync(path.join(dir, "scripts", "extra.py"), "print('x')\n");
    const res = runCli(["--dir", dir]);
    assert.equal(res.status, 1);
    assert.match(res.out, /unlisted file: scripts\/extra\.py/);
  });

  test("a deleted file fails with missing", () => {
    const dir = copyVendor();
    fs.rmSync(path.join(dir, "schemas", "v1", "claim.schema.json"));
    const res = runCli(["--dir", dir]);
    assert.equal(res.status, 1);
    assert.match(res.out, /missing: schemas\/v1\/claim\.schema\.json/);
  });

  test("a hash edited in PIN.json while the file is left alone fails with hash mismatch", () => {
    const dir = copyVendor();
    const pinPath = path.join(dir, "PIN.json");
    const pin = JSON.parse(fs.readFileSync(pinPath, "utf8"));
    pin.files["schemas/v1/decision-gates.json"].sha256 = "0".repeat(64);
    fs.writeFileSync(pinPath, JSON.stringify(pin, null, 2));
    const res = runCli(["--dir", dir]);
    assert.equal(res.status, 1);
    assert.match(res.out, /hash mismatch: schemas\/v1\/decision-gates\.json/);
  });

  test("a file removed from the copy and from the manifest together still fails", () => {
    const dir = copyVendor();
    fs.rmSync(path.join(dir, "schemas", "v1", "claim.schema.json"));
    const pinPath = path.join(dir, "PIN.json");
    const pin = JSON.parse(fs.readFileSync(pinPath, "utf8"));
    delete pin.files["schemas/v1/claim.schema.json"];
    fs.writeFileSync(pinPath, JSON.stringify(pin, null, 2));
    const res = runCli(["--dir", dir]);
    assert.equal(res.status, 1);
    assert.match(res.out, /required file not pinned: schemas\/v1\/claim\.schema\.json/);
  });

  test("a symlink in place of a listed file fails", () => {
    const dir = copyVendor();
    const file = path.join(dir, "LICENSE");
    fs.rmSync(file);
    fs.symlinkSync(path.join(DEFAULT_VENDOR_DIR, "LICENSE"), file);
    const res = runCli(["--dir", dir]);
    assert.equal(res.status, 1);
    assert.match(res.out, /not a regular file: LICENSE/);
  });

  test("an unreadable or absent PIN.json is an error (exit 2), not a pass", () => {
    const dir = copyVendor();
    fs.rmSync(path.join(dir, "PIN.json"));
    const res = runCli(["--dir", dir]);
    assert.equal(res.status, 2);
  });
});

describe("remote logic with injected fakes", () => {
  const pin = readPin(DEFAULT_VENDOR_DIR);
  const urlToRel = (url) => {
    const prefix = `https://raw.githubusercontent.com/AlreadyOpen/ai-output-to-value/${pin.commit}/`;
    assert.ok(url.startsWith(prefix), `unexpected URL ${url}`);
    return url.slice(prefix.length);
  };
  const honestFetch = async (url) => {
    const buf = fs.readFileSync(path.join(DEFAULT_VENDOR_DIR, urlToRel(url)));
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  };
  const matchingTag = async () => pin.commit;

  test("matching fetch and tag pass", async () => {
    assert.deepEqual(await verifyRemote(pin, { fetchImpl: honestFetch, resolveTag: matchingTag }), []);
  });

  test("a fetch that returns altered bytes fails", async () => {
    const altered = async (url) => {
      const res = await honestFetch(url);
      if (!url.endsWith("scripts/claim_gate.py")) return res;
      const buf = Buffer.from(await res.arrayBuffer());
      buf[0] ^= 0x01;
      return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    };
    const errors = await verifyRemote(pin, { fetchImpl: altered, resolveTag: matchingTag });
    assert.deepEqual(errors, ["remote hash mismatch: scripts/claim_gate.py"]);
  });

  test("a tag that now resolves to a different commit fails", async () => {
    const moved = async () => "f".repeat(40);
    const errors = await verifyRemote(pin, { fetchImpl: honestFetch, resolveTag: moved });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /tag moved/);
  });

  test("a failed fetch and a failed tag lookup are reported, not swallowed", async () => {
    const notFound = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
    const noTag = async () => {
      throw new Error("tag not found");
    };
    const errors = await verifyRemote(pin, { fetchImpl: notFound, resolveTag: noTag });
    assert.equal(errors.filter((e) => e.startsWith("remote fetch failed (404)")).length, EXPECTED_SET.length);
    assert.ok(errors.some((e) => e.startsWith("tag check failed")));
  });

  test("a manifest and copy edited together pass offline but fail against upstream bytes", async () => {
    const dir = copyVendor();
    const file = path.join(dir, "scripts", "claim_gate.py");
    const edited = Buffer.concat([fs.readFileSync(file), Buffer.from("# tampered\n")]);
    fs.writeFileSync(file, edited);
    const pinPath = path.join(dir, "PIN.json");
    const tamperedPin = JSON.parse(fs.readFileSync(pinPath, "utf8"));
    tamperedPin.files["scripts/claim_gate.py"] = { sha256: sha256(edited), bytes: edited.length };
    fs.writeFileSync(pinPath, JSON.stringify(tamperedPin, null, 2));
    assert.deepEqual(verifyLocal(dir), [], "self-consistent tampering passes the offline check");
    const errors = await verifyRemote(tamperedPin, { fetchImpl: honestFetch, resolveTag: matchingTag });
    assert.deepEqual(errors, ["remote hash mismatch: scripts/claim_gate.py"]);
  });
});
