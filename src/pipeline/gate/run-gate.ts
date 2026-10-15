// COD-05: subprocess wrapper around the pinned vendored claim_gate.py.
// Modeled on tests/gate/gate-smoke.gate.mjs's resolvePython()/classify()
// pattern — the interpreter is resolved the same way, and a result is
// classified by requiring a parsable {status,...} object on stdout, never by
// trusting exit code alone (an uncaught Python exception also exits 1, the
// same code as a valid non-PASS result).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VALID_STATUSES = new Set(["PASS", "BLOCKED", "INSUFFICIENT_EVIDENCE"]);
const SETUP_HELP =
  "Create the gate environment:\n" +
  "  python3 -m venv .venv-gate && .venv-gate/bin/pip install -r vendor/ai-output-to-value/requirements-claim-gate.txt\n" +
  "or point PRISM_PYTHON at an interpreter that has the pinned jsonschema.";

export type SpawnImpl = (
  command: string,
  args: string[],
  options: { encoding: "utf8"; timeout: number },
) => { status: number | null; stdout: string; stderr: string; error?: Error };

export interface GateResult {
  status: "PASS" | "BLOCKED" | "INSUFFICIENT_EVIDENCE";
  raw: unknown;
  gateSha: string;
}

/** PRISM_PYTHON if set, else .venv-gate/bin/python relative to repoRoot. Lazy: only resolved when runGate is actually called. */
function resolvePythonPath(repoRoot: string): string {
  return process.env.PRISM_PYTHON || path.join(repoRoot, ".venv-gate", "bin", "python");
}

function gateShaFromPin(repoRoot: string): string {
  const pinPath = path.join(repoRoot, "vendor", "ai-output-to-value", "PIN.json");
  const pin = JSON.parse(fs.readFileSync(pinPath, "utf8"));
  const sha = pin?.files?.["scripts/claim_gate.py"]?.sha256;
  if (typeof sha !== "string") throw new Error(`${pinPath} has no files["scripts/claim_gate.py"].sha256`);
  return sha;
}

/**
 * Evaluate one claim record against the pinned vendored gate. Writes `record`
 * to a temp file, spawns [pythonPath, gateScriptPath, "--json", tmpFile], and
 * classifies the result: parse stdout as JSON, require a status in
 * {PASS, BLOCKED, INSUFFICIENT_EVIDENCE}, require the exit code to agree
 * (0 for PASS, 1 otherwise). A classification failure throws — it is never
 * silently treated as a valid gate result.
 */
export async function runGate(
  record: object,
  {
    spawnImpl = spawnSync as SpawnImpl,
    pythonPath,
    gateScriptPath = "vendor/ai-output-to-value/scripts/claim_gate.py",
    repoRoot = process.cwd(),
  }: {
    spawnImpl?: SpawnImpl;
    pythonPath?: string;
    gateScriptPath?: string;
    repoRoot?: string;
  } = {},
): Promise<GateResult> {
  const python = pythonPath ?? resolvePythonPath(repoRoot);
  if (!pythonPath && !fs.existsSync(python)) {
    throw new Error(`No Python interpreter at ${python}.\n${SETUP_HELP}`);
  }
  const resolvedGateScript = path.isAbsolute(gateScriptPath) ? gateScriptPath : path.join(repoRoot, gateScriptPath);

  const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "prism-gate-run-")), "record.claim.json");
  fs.writeFileSync(tmpFile, JSON.stringify(record));

  const res = spawnImpl(python, [resolvedGateScript, "--json", tmpFile], { encoding: "utf8", timeout: 60_000 });
  if (res.error) throw new Error(`could not run ${python}: ${res.error.message}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new Error(`gate produced no JSON result on stdout (exit ${res.status}):\n${res.stderr}`);
  }
  const status = (parsed as { status?: unknown })?.status;
  if (typeof status !== "string" || !VALID_STATUSES.has(status)) {
    throw new Error(`gate result has no valid status (exit ${res.status}): ${res.stdout}`);
  }
  const expectedExit = status === "PASS" ? 0 : 1;
  if (res.status !== expectedExit) {
    throw new Error(`gate exit ${res.status} disagrees with status ${status}`);
  }

  return { status: status as GateResult["status"], raw: parsed, gateSha: gateShaFromPin(repoRoot) };
}
