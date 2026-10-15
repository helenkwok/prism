// D-45 / COD-05: the confirmation-timing route's auth gate and its
// no-check-state-capability property (COD-03).
//
// Node 24 cannot `import()` a `.tsx` file directly, with or without JSX in
// it: it errors "Unknown file extension .tsx" on the path alone, before any
// content is parsed (verified empirically against this exact runtime: a
// JSX-free .tsx file fails identically to one with JSX). report-route.test.mjs's
// precedent of importing the route module directly only works there because
// that route is a plain `.ts` file with no JSX. For this route we transpile
// the real source with the already-installed `typescript` package (the same
// one `npm run typecheck` uses) into a throwaway sibling `.mjs`, import that,
// and delete it in a `finally` — so the test exercises the file's actual
// compiled behaviour, not a reimplementation of it.
//
// The auth-gate behaviour is covered here by calling the exported server
// function with no simulated request at all: `getRequestHeaders()` (from
// `@tanstack/react-start/server`) throws "No Start context found in
// AsyncLocalStorage" before `getAuth().api.getSession()` or any `results.ts`
// write is ever reached, which is strictly stronger than "unauthenticated" —
// there is provably no session because there is no request context in which
// one could exist. A full authenticated round-trip through better-auth's
// cookie-backed session needs a live HTTP server and belongs to Phase 7's
// Playwright suite (APP-01), not this unit test; `startConfirmation`/
// `endConfirmation`'s own write behaviour is already covered directly in
// 03-03's results.test.mjs.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const routePath = fileURLToPath(
  new URL("../../src/app/routes/confirm.$projectN.tsx", import.meta.url),
);
const routeSource = fs.readFileSync(routePath, "utf8");

/** Transpile the real route source and import it from a throwaway sibling file. */
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

test("the route's module exports exactly logConfirmationStart, logConfirmationEnd and Route", async () => {
  const mod = await importRouteModule();
  assert.deepEqual(Object.keys(mod).sort(), ["Route", "logConfirmationEnd", "logConfirmationStart"]);
  assert.equal(typeof mod.logConfirmationStart, "function");
  assert.equal(typeof mod.logConfirmationEnd, "function");
});

test("the route's source defines exactly two server functions (no third)", () => {
  const matches = routeSource.match(/createServerFn\(/g) ?? [];
  assert.equal(matches.length, 2);
  assert.match(routeSource, /export const logConfirmationStart = createServerFn\(/);
  assert.match(routeSource, /export const logConfirmationEnd = createServerFn\(/);
});

test("the route's source never mentions a check-state identifier (COD-03)", () => {
  assert.equal(/pipeline_check_states|filteredState|proposedState/i.test(routeSource), false);
});

test("a call to logConfirmationStart with no request context throws before any results.ts write runs", async () => {
  const mod = await importRouteModule();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prism-confirm-timing-"));
  const saved = process.env.PRISM_DATA_DIR;
  process.env.PRISM_DATA_DIR = tmp;
  try {
    await assert.rejects(() => mod.logConfirmationStart({ data: { projectN: 7 } }));
    // No DB file was ever created: the write never ran.
    assert.equal(fs.existsSync(path.join(tmp, "prism.sqlite")), false);
  } finally {
    if (saved === undefined) delete process.env.PRISM_DATA_DIR;
    else process.env.PRISM_DATA_DIR = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a call to logConfirmationEnd with no request context throws before any results.ts write runs", async () => {
  const mod = await importRouteModule();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prism-confirm-timing-"));
  const saved = process.env.PRISM_DATA_DIR;
  process.env.PRISM_DATA_DIR = tmp;
  try {
    await assert.rejects(() => mod.logConfirmationEnd({ data: { projectN: 7 } }));
    assert.equal(fs.existsSync(path.join(tmp, "prism.sqlite")), false);
  } finally {
    if (saved === undefined) delete process.env.PRISM_DATA_DIR;
    else process.env.PRISM_DATA_DIR = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
