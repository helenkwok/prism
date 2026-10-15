// Node-vs-Python conformance proof for COD-05: the vendored Node evaluator
// (vendor/ai-output-to-value/packages/mcp/src/core.mjs — CI-only; never imported by the
// runtime pipeline, see tests/vendor-pin.test.mjs) must agree with the vendored Python
// evaluator (scripts/claim_gate.py — the sole runtime evaluator, decision D-19) on every
// one of the 40 shared fixture cases plus two explicit boundary cases.
//
// Not part of `npm test` (the .gate.mjs suffix keeps it out of that glob, which needs no
// Python); run it with `npm run test:gate`. Python resolution and exit-code classification
// mirror tests/gate/gate-smoke.gate.mjs: an uncaught Python exception can also exit 1, so a
// parsable status object on stdout is required before trusting any exit code.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { evaluateClaim } from "../../vendor/ai-output-to-value/packages/mcp/src/core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const vendor = path.join(root, "vendor", "ai-output-to-value");
const gateScript = path.join(vendor, "scripts", "claim_gate.py");
const fixture = JSON.parse(fs.readFileSync(path.join(vendor, "tests", "fixtures", "claim-gate-conformance.json"), "utf8"));
const gates = JSON.parse(fs.readFileSync(path.join(vendor, "schemas", "v1", "decision-gates.json"), "utf8"));
const claimSchema = JSON.parse(fs.readFileSync(path.join(vendor, "schemas", "v1", "claim.schema.json"), "utf8"));

const VALID_STATUSES = new Set(["PASS", "BLOCKED", "INSUFFICIENT_EVIDENCE"]);
const SETUP_HELP =
  "Create the gate environment:\n" +
  "  python3 -m venv .venv-gate && .venv-gate/bin/pip install -r vendor/ai-output-to-value/requirements-claim-gate.txt\n" +
  "or point PRISM_PYTHON at an interpreter that has the pinned jsonschema.";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "prism-conformance-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" };
delete env.PYTHONPATH;

function run(python, args) {
  const res = spawnSync(python, args, { encoding: "utf8", env, timeout: 60_000 });
  if (res.error) throw new Error(`could not run ${python}: ${res.error.message}`);
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function resolvePython() {
  const candidate = process.env.PRISM_PYTHON || path.join(root, ".venv-gate", "bin", "python");
  if (!fs.existsSync(candidate)) throw new Error(`No Python interpreter at ${candidate}.\n${SETUP_HELP}`);
  const probe = run(candidate, ["-c", "import importlib.metadata as m, jsonschema; print(m.version('jsonschema'))"]);
  if (probe.status !== 0) throw new Error(`${candidate} cannot import jsonschema.\n${probe.stderr}\n${SETUP_HELP}`);
  return candidate;
}

const PY = resolvePython();

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

function isPlainRecord(record) {
  return record !== null && typeof record === "object" && !Array.isArray(record);
}

// For a non-object record the CLI refuses outright (exit 2, "top-level JSON value must be
// an object" — see gate-smoke.gate.mjs's own non-object-records suite), so there is no CLI
// status to compare. Call the library's evaluate() in-process instead, exactly as
// gate-smoke.gate.mjs's IN_PROCESS snippet does, to get the evaluator's own BLOCKED result.
const IN_PROCESS_PY = [
  "import json, sys",
  `sys.path.insert(0, ${JSON.stringify(path.dirname(gateScript))})`,
  "import claim_gate",
  "gates = claim_gate.load_json(claim_gate.GATES_PATH)",
  "print(json.dumps(claim_gate.evaluate(json.load(sys.stdin), gates)))",
].join("\n");

function runPythonInProcess(record) {
  const res = spawnSync(PY, ["-c", IN_PROCESS_PY], { encoding: "utf8", env, timeout: 60_000, input: JSON.stringify(record) });
  if (res.error) throw new Error(`could not run ${PY}: ${res.error.message}`);
  if (res.status !== 0) return { kind: "error", reason: `in-process evaluate() exited ${res.status}`, exit: res.status };
  // No CLI exit-code convention applies here (the script always exits 0 on success,
  // regardless of the evaluated status) — just require a parsable, valid status object.
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return { kind: "error", reason: "no JSON result on stdout", exit: res.status };
  }
  if (!parsed || !VALID_STATUSES.has(parsed.status)) return { kind: "error", reason: "no valid status", exit: res.status };
  return { kind: "result", result: parsed, exit: res.status };
}

function runPython(record, name) {
  if (!isPlainRecord(record)) return runPythonInProcess(record);
  const res = run(PY, [gateScript, "--json", writeRecord(name, record)]);
  return classify(res);
}

const COMPARED_FIELDS = [
  "status",
  "targetDecision",
  "decisionLabel",
  "requiredClaimLevel",
  "assertedClaimLevel",
  "claimMismatch",
  "missingFields",
  "failedChecks",
  "unknownChecks",
  "passedChecks",
  "gateVersion",
];

/** Compares the shared fields; returns a (possibly empty) array of disagreements. */
function compare(name, pyResult, nodeResult) {
  const disagreements = [];
  for (const field of COMPARED_FIELDS) {
    const a = pyResult[field];
    const b = nodeResult[field];
    try {
      assert.deepEqual(a, b);
    } catch {
      disagreements.push({ field, python: a, node: b });
    }
  }
  // errors/structuralErrors: same pass/fail SIGNAL required, not the same wording
  // (Python and JS may phrase a schema validation error differently).
  const pyHadErrors = (pyResult.structuralErrors ?? []).length > 0;
  const nodeHadErrors = (nodeResult.structuralErrors ?? []).length > 0;
  if (pyHadErrors !== nodeHadErrors) {
    disagreements.push({ field: "structuralErrors (presence)", python: pyResult.structuralErrors, node: nodeResult.structuralErrors });
  }
  if (disagreements.length > 0) {
    console.error(`DISAGREEMENT on "${name}":`);
    console.error("  python:", JSON.stringify(pyResult, null, 2));
    console.error("  node:  ", JSON.stringify(nodeResult, null, 2));
    console.error("  fields:", JSON.stringify(disagreements, null, 2));
  }
  return disagreements;
}

before(() => {
  console.log(`conformance: python interpreter ${PY}`);
});

let agreements = 0;
const allDisagreements = [];

function checkOne(name, record) {
  const pyClassified = runPython(record, name.replace(/[^a-z0-9-]+/gi, "-"));
  assert.equal(pyClassified.kind, "result", `${name}: ${pyClassified.reason}`);
  const nodeResult = evaluateClaim(record, gates, claimSchema);
  const d = compare(name, pyClassified.result, nodeResult);
  allDisagreements.push(...d);
  if (d.length === 0) agreements++;
  assert.deepEqual(d, [], `${name}: evaluators disagree`);
  return { pyResult: pyClassified.result, nodeResult };
}

describe("Node vs Python claim evaluator conformance (COD-05)", () => {
  test("fixture shape is what this suite expects", () => {
    assert.equal(fixture.cases.length, 40);
  });

  test("the bare baseRecord agrees", () => {
    checkOne("baseRecord", structuredClone(fixture.baseRecord));
  });

  for (const item of fixture.cases) {
    test(`fixture case: ${item.name}`, () => {
      checkOne(item.name, caseRecord(item));
    });
  }

  describe("explicit boundary cases (COD-05)", () => {
    test("empty gateChecks ({}) resolves to INSUFFICIENT_EVIDENCE on both sides, never PASS, never a crash", () => {
      const record = { ...structuredClone(fixture.baseRecord), gateChecks: {} };
      const { pyResult, nodeResult } = checkOne("boundary: empty gateChecks", record);
      assert.equal(pyResult.status, "INSUFFICIENT_EVIDENCE");
      assert.equal(nodeResult.status, "INSUFFICIENT_EVIDENCE");
    });

    test("a gateChecks value at the not-applicable enum member is treated identically (unknown-for-gating) by both evaluators", () => {
      const base = structuredClone(fixture.baseRecord);
      const record = { ...base, gateChecks: { ...base.gateChecks, "intended-use-defined": "not-applicable" } };
      const { pyResult, nodeResult } = checkOne("boundary: not-applicable gateChecks value", record);
      assert.equal(pyResult.status, "INSUFFICIENT_EVIDENCE");
      assert.equal(nodeResult.status, "INSUFFICIENT_EVIDENCE");
    });
  });

  test("summary: zero disagreements across every compared record", () => {
    console.log(`conformance summary: ${agreements} agreements, ${allDisagreements.length} disagreements`);
    assert.equal(allDisagreements.length, 0);
  });
});
