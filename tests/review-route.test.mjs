// VAL-04 / D-58: review route auth gate — each server function throws with no
// request context before any database write (T-04-23).
//
// Node 24 cannot import() a .tsx file directly ("Unknown file extension .tsx").
// Transpile the real source with the installed typescript package into a
// throwaway sibling .mjs, import that, delete in finally — same technique as
// the (now-retired) confirm-timing.test.mjs.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const routePath = fileURLToPath(
  new URL("../src/app/routes/review.$projectN.tsx", import.meta.url),
);
const routeSource = fs.readFileSync(routePath, "utf8");

async function importRouteModule() {
  const tmpPath = routePath.replace(/\.tsx$/, `.__test-${process.pid}-${Date.now()}__.mjs`);
  const { outputText } = ts.transpileModule(routeSource, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      jsxImportSource: "react",
    },
    fileName: routePath,
  });
  fs.writeFileSync(tmpPath, outputText);
  try {
    return await import(tmpPath);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
}

test("the route exports getTrail, submitEdit, submitDecision, submitGold and Route", async () => {
  const mod = await importRouteModule();
  assert.deepEqual(
    Object.keys(mod).sort(),
    ["Route", "getTrail", "submitDecision", "submitEdit", "submitGold"],
  );
});

test("route source has no dangerouslySetInnerHTML and exactly four requireRole(\"admin\") calls", () => {
  assert.equal((routeSource.match(/dangerouslySetInnerHTML/g) ?? []).length, 0);
  assert.equal((routeSource.match(/requireRole\("admin"\)/g) ?? []).length, 4);
});

test("getTrail with no request context throws before any database write", async () => {
  const mod = await importRouteModule();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prism-review-route-"));
  const saved = process.env.PRISM_DATA_DIR;
  process.env.PRISM_DATA_DIR = tmp;
  try {
    await assert.rejects(() => mod.getTrail({ data: { projectN: 7, blind: true } }));
    assert.equal(fs.existsSync(path.join(tmp, "prism.sqlite")), false);
  } finally {
    if (saved === undefined) delete process.env.PRISM_DATA_DIR;
    else process.env.PRISM_DATA_DIR = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("submitEdit with no request context throws before any database write", async () => {
  const mod = await importRouteModule();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prism-review-route-"));
  const saved = process.env.PRISM_DATA_DIR;
  process.env.PRISM_DATA_DIR = tmp;
  try {
    await assert.rejects(() =>
      mod.submitEdit({
        data: {
          projectN: 7,
          checkId: "output-reproducible",
          state: "pass",
          spanIds: [],
          reason: "x",
        },
      }),
    );
    assert.equal(fs.existsSync(path.join(tmp, "prism.sqlite")), false);
  } finally {
    if (saved === undefined) delete process.env.PRISM_DATA_DIR;
    else process.env.PRISM_DATA_DIR = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("submitDecision with no request context throws before any database write", async () => {
  const mod = await importRouteModule();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prism-review-route-"));
  const saved = process.env.PRISM_DATA_DIR;
  process.env.PRISM_DATA_DIR = tmp;
  try {
    await assert.rejects(() =>
      mod.submitDecision({
        data: {
          projectN: 7,
          checkId: "output-reproducible",
          decision: "confirmed",
          reason: "x",
        },
      }),
    );
    assert.equal(fs.existsSync(path.join(tmp, "prism.sqlite")), false);
  } finally {
    if (saved === undefined) delete process.env.PRISM_DATA_DIR;
    else process.env.PRISM_DATA_DIR = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("submitGold with no request context throws before any database write", async () => {
  const mod = await importRouteModule();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prism-review-route-"));
  const saved = process.env.PRISM_DATA_DIR;
  process.env.PRISM_DATA_DIR = tmp;
  try {
    // Validator needs 24 labels; build minimal stubs so auth runs first after parse.
    // With no request context, getRequestHeaders throws before getDb.
    const { loadGateFile, resolveGatesPath } = await import("../src/pipeline/coding/contract.ts");
    const ids = loadGateFile(resolveGatesPath()).checkIds;
    const labels = ids.map((checkId) => ({ checkId, state: "unknown", spanIds: [] }));
    await assert.rejects(() => mod.submitGold({ data: { projectN: 7, labels } }));
    assert.equal(fs.existsSync(path.join(tmp, "prism.sqlite")), false);
  } finally {
    if (saved === undefined) delete process.env.PRISM_DATA_DIR;
    else process.env.PRISM_DATA_DIR = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
