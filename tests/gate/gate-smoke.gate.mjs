// Smoke test for the vendored claim gate, run through the pinned jsonschema.
// Not part of `npm test` (the .gate.mjs suffix keeps it out of that glob, which needs
// no Python); run it with `npm run test:gate`.
//
// Interpreter: PRISM_PYTHON, else .venv-gate/bin/python. If neither exists, or
// `import jsonschema` fails, or the installed jsonschema is not the pinned version, this
// FAILS rather than skipping: a silent skip would hide a broken gate.
//
// Exit-code contract of the gate CLI: 0 is PASS, 1 is any other VALID result
// (BLOCKED, INSUFFICIENT_EVIDENCE), 2 is an error. One more thing this suite pins down:
// an uncaught Python exception (for example the ImportError raised when jsonschema is
// missing) also exits 1, so exit code 1 alone cannot separate "valid non-PASS result"
// from "the gate did not run". A caller must require a parsable status object on stdout.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const vendor = path.join(root, "vendor", "ai-output-to-value");
const gateScript = path.join(vendor, "scripts", "claim_gate.py");
const fixture = JSON.parse(fs.readFileSync(path.join(vendor, "tests", "fixtures", "claim-gate-conformance.json"), "utf8"));
const gates = JSON.parse(fs.readFileSync(path.join(vendor, "schemas", "v1", "decision-gates.json"), "utf8"));

const VALID_STATUSES = new Set(["PASS", "BLOCKED", "INSUFFICIENT_EVIDENCE"]);
const SETUP_HELP =
  "Create the gate environment:\n" +
  "  python3 -m venv .venv-gate && .venv-gate/bin/pip install -r vendor/ai-output-to-value/requirements-claim-gate.txt\n" +
  "or point PRISM_PYTHON at an interpreter that has the pinned jsonschema.";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "prism-gate-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" };
delete env.PYTHONPATH;

function run(python, args, { input, cwd } = {}) {
  const res = spawnSync(python, args, { encoding: "utf8", env, input, cwd, timeout: 60_000 });
  if (res.error) throw new Error(`could not run ${python}: ${res.error.message}`);
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function resolvePython() {
  const candidate = process.env.PRISM_PYTHON || path.join(root, ".venv-gate", "bin", "python");
  if (!fs.existsSync(candidate)) throw new Error(`No Python interpreter at ${candidate}.\n${SETUP_HELP}`);
  const probe = run(candidate, ["-c", "import importlib.metadata as m, jsonschema; print(m.version('jsonschema'))"]);
  if (probe.status !== 0) throw new Error(`${candidate} cannot import jsonschema.\n${probe.stderr}\n${SETUP_HELP}`);
  return { python: candidate, jsonschemaVersion: probe.stdout.trim() };
}

const { python: PY, jsonschemaVersion } = resolvePython();

/** A result is valid only if the exit code and a parsable status object agree. */
function classify(res) {
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return { kind: "error", reason: "no JSON result on stdout", exit: res.status };
  }
  if (!parsed || !VALID_STATUSES.has(parsed.status)) return { kind: "error", reason: "no valid status", exit: res.status };
  const expectedExit = parsed.status === "PASS" ? 0 : 1;
  if (res.status !== expectedExit) return { kind: "error", reason: `exit ${res.status} disagrees with ${parsed.status}`, exit: res.status };
  return { kind: "result", result: parsed, exit: res.status };
}

function writeRecord(name, value) {
  const file = path.join(scratch, `${name}.claim.json`);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function caseRecord(item) {
  if ("record" in item) return structuredClone(item.record);
  const value = structuredClone(fixture.baseRecord);
  for (const [key, replacement] of Object.entries(item.patch ?? {})) {
    if (key === "gateChecks" && replacement && typeof replacement === "object" && !Array.isArray(replacement)) {
      value.gateChecks = { ...value.gateChecks, ...replacement };
    } else {
      value[key] = structuredClone(replacement);
    }
  }
  for (const key of item.remove ?? []) delete value[key];
  return value;
}

function assertExpectations(item, result) {
  assert.equal(result.status, item.expectedStatus, `${item.name}: status`);
  assert.equal(result.gateVersion, gates.version, `${item.name}: gateVersion`);
  if ("expectedClaimMismatch" in item) assert.equal(result.claimMismatch, item.expectedClaimMismatch, `${item.name}: claimMismatch`);
  if ("expectedMissingFields" in item) assert.deepEqual(result.missingFields, item.expectedMissingFields, `${item.name}: missingFields`);
  const errors = result.structuralErrors.join(" ").toLowerCase();
  for (const needle of item.errorContains ?? []) {
    assert.ok(errors.includes(String(needle).toLowerCase()), `${item.name}: expected structural errors to mention ${JSON.stringify(needle)}, got ${errors}`);
  }
}

const IN_PROCESS = [
  "import json, sys",
  `sys.path.insert(0, ${JSON.stringify(path.dirname(gateScript))})`,
  "import claim_gate",
  "gates = claim_gate.load_json(claim_gate.GATES_PATH)",
  "print(json.dumps(claim_gate.evaluate(json.load(sys.stdin), gates)))",
].join("\n");

before(() => {
  console.log(`gate interpreter: ${PY}`);
  console.log(`jsonschema ${jsonschemaVersion}`);
});

describe("environment", () => {
  test("installed jsonschema is the version pinned by the vendored requirements file", () => {
    const req = fs.readFileSync(path.join(vendor, "requirements-claim-gate.txt"), "utf8");
    const pin = /^jsonschema==(\S+)$/m.exec(req);
    assert.ok(pin, "vendored requirements file pins jsonschema");
    assert.equal(jsonschemaVersion, pin[1]);
  });

  test("the repository's requirements-gate.txt carries the same pin, with no format extras", () => {
    const own = fs.readFileSync(path.join(root, "requirements-gate.txt"), "utf8").trim().split("\n").filter((l) => l && !l.startsWith("#"));
    const upstream = fs.readFileSync(path.join(vendor, "requirements-claim-gate.txt"), "utf8").trim().split("\n").filter((l) => l && !l.startsWith("#"));
    assert.deepEqual(own, upstream);
    assert.ok(own.every((l) => !l.includes("[")), "no extras such as jsonschema[format]");
  });
});

describe("vendored gate through the pinned jsonschema", () => {
  test("(a) the conformance base record exits 0 with status PASS", () => {
    const res = run(PY, [gateScript, "--json", writeRecord("base", fixture.baseRecord)]);
    const c = classify(res);
    assert.equal(c.kind, "result", `${c.reason}\n${res.stderr}`);
    assert.equal(res.status, 0);
    assert.equal(c.result.status, "PASS");
  });

  const objectCases = fixture.cases.filter((item) => {
    const r = caseRecord(item);
    return r !== null && typeof r === "object" && !Array.isArray(r);
  });
  const nonObjectCases = fixture.cases.filter((item) => !objectCases.includes(item));

  test("(b) fixture shape is what this suite understands", () => {
    assert.equal(fixture.version, "1.1");
    assert.equal(fixture.cases.length, 40);
    assert.ok(nonObjectCases.length > 0, "the fixture includes non-object records");
    for (const item of fixture.cases) {
      for (const key of Object.keys(item)) {
        assert.ok(["name", "patch", "remove", "record", "expectedStatus", "expectedClaimMismatch", "expectedMissingFields", "errorContains"].includes(key), `unknown case key ${key}`);
      }
    }
  });

  describe("(b) every fixture case, through the CLI", () => {
    for (const item of objectCases) {
      test(item.name, () => {
        const res = run(PY, [gateScript, "--json", writeRecord(`case-${fixture.cases.indexOf(item)}`, caseRecord(item))]);
        assert.notEqual(res.status, 2, `a valid record must never exit 2:\n${res.stdout}${res.stderr}`);
        const c = classify(res);
        assert.equal(c.kind, "result", `${c.reason}\n${res.stdout}${res.stderr}`);
        assertExpectations(item, c.result);
        assert.equal(res.status, item.expectedStatus === "PASS" ? 0 : 1, "0 for PASS, 1 for any other valid result");
      });
    }
  });

  describe("(b) non-object records: the library says BLOCKED, the CLI refuses with exit 2", () => {
    for (const item of nonObjectCases) {
      test(item.name, () => {
        const record = caseRecord(item);
        const inProcess = run(PY, ["-c", IN_PROCESS], { input: JSON.stringify(record) });
        assert.equal(inProcess.status, 0, inProcess.stderr);
        assertExpectations(item, JSON.parse(inProcess.stdout));

        const cli = run(PY, [gateScript, "--json", writeRecord(`nonobject-${fixture.cases.indexOf(item)}`, record)]);
        assert.equal(cli.status, 2);
        assert.match(cli.stdout, /^ERROR: .*top-level JSON value must be an object/m);
        assert.equal(classify(cli).kind, "error");
      });
    }
  });

  test("(c) an unreadable path exits 2 with an ERROR line", () => {
    const res = run(PY, [gateScript, "--json", path.join(scratch, "does-not-exist.claim.json")]);
    assert.equal(res.status, 2);
    assert.match(res.stdout, /^ERROR: /m);
    assert.equal(classify(res).kind, "error");
  });

  test("(c) a file that is not JSON exits 2 with an ERROR line", () => {
    const file = path.join(scratch, "garbage.claim.json");
    fs.writeFileSync(file, "{ not json");
    const res = run(PY, [gateScript, "--json", file]);
    assert.equal(res.status, 2);
    assert.match(res.stdout, /^ERROR: /m);
  });

  test("(d) the relative layout matters: with schemas/ moved away the gate exits 2", () => {
    const copy = path.join(scratch, "layout-copy");
    fs.mkdirSync(path.join(copy, "scripts"), { recursive: true });
    fs.copyFileSync(gateScript, path.join(copy, "scripts", "claim_gate.py"));
    const res = run(PY, [path.join(copy, "scripts", "claim_gate.py"), "--json", writeRecord("layout", fixture.baseRecord)]);
    assert.equal(res.status, 2);
    assert.match(res.stdout, /^ERROR: /m);
    assert.equal(classify(res).kind, "error");
  });

  test("(d) the intact layout, copied whole to another place, still runs", () => {
    const copy = path.join(scratch, "layout-whole");
    fs.cpSync(vendor, copy, { recursive: true });
    const res = run(PY, [path.join(copy, "scripts", "claim_gate.py"), "--json", writeRecord("layout-ok", fixture.baseRecord)]);
    assert.equal(classify(res).kind, "result", res.stdout + res.stderr);
    assert.equal(res.status, 0);
  });
});

describe("a missing dependency is not a result", () => {
  test("without jsonschema the gate fails closed, but exits 1, which a caller must not read as BLOCKED", () => {
    const bare = path.join(scratch, "bare-venv");
    const made = run(PY, ["-m", "venv", "--without-pip", bare]);
    assert.equal(made.status, 0, made.stderr);
    const barePython = path.join(bare, "bin", "python");
    const res = run(barePython, [gateScript, "--json", writeRecord("bare", fixture.baseRecord)]);
    assert.match(res.stderr, /requires the pinned dependency in requirements-claim-gate\.txt/);
    assert.equal(res.stdout.trim(), "", "no claim is evaluated without schema validation");
    assert.equal(res.status, 1, "an uncaught exception exits 1, the same code as a valid non-PASS result");
    assert.equal(classify(res).kind, "error", "classification must look for a status object, not trust the exit code");
  });
});
