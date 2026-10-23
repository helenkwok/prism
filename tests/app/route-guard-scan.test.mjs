// APP-01 / T-07-01: a static scan of every server function and server-route
// handler under src/app/routes and src/app/server. Each handler must open with
// an awaited requireRole(...) or requireProjectAccess(...) call, or be on the
// public allowlist below. Path-class rules (access.ts PATH_CLASSES) cover route
// files that later plans add, without editing this test.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { PATH_CLASSES } from "../../src/app/server/access.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCAN_DIRS = ["src/app/routes", "src/app/server"];

/** Server functions and server-route files that are public by design. */
const PUBLIC_FUNCTIONS = new Set(["getSessionEmail", "getSessionUser"]);
const PUBLIC_FILES = new Set(["src/app/routes/api/auth.$.ts", "src/app/routes/api/report[.]pdf.ts", "src/app/routes/robots[.]txt.ts"]);

const OPEN = { "(": ")", "[": "]", "{": "}" };

/** Index of the bracket closing the one at `start`, skipping strings, templates and comments. */
function matchBracket(text, start) {
  const stack = [OPEN[text[start]]];
  for (let i = start + 1; i < text.length; i += 1) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      i = text.indexOf("\n", i);
      if (i === -1) return -1;
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i) + 1;
    } else if (c === '"' || c === "'" || c === "`") {
      for (i += 1; i < text.length && text[i] !== c; i += 1) if (text[i] === "\\") i += 1;
    } else if (OPEN[c]) {
      stack.push(OPEN[c]);
    } else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

const GUARD_RE = /^(?:return\s+)?(?:(?:const|let)\s+[\w${}\s,:]+=\s*)?await\s+(requireRole|requireProjectAccess)\s*\(([^)]*)\)/;

/** Classify a handler function's source: the guard its body opens with, or "unguarded". */
function classifyHandler(fnText) {
  const arrow = fnText.indexOf("=>");
  if (arrow === -1) return "unguarded";
  let body = fnText.slice(arrow + 2).trim();
  if (body.startsWith("{")) body = body.slice(1).trim();
  const m = GUARD_RE.exec(body);
  if (!m) return "unguarded";
  const literals = [...m[2].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
  if (m[1] === "requireRole") return { roles: literals.sort() };
  return { view: literals[0] ?? "?" };
}

/**
 * Finds each createServerFn(...) chain's .handler(...) and each method in a
 * `server: { handlers: { ... } }` block. Returns [{ handler, kind, guard }].
 */
export function scanSource(fileName, text) {
  const found = [];
  for (const m of text.matchAll(/createServerFn\s*\(/g)) {
    const name = /(?:const|let)\s+(\w+)\s*=\s*$/.exec(text.slice(Math.max(0, m.index - 200), m.index))?.[1] ?? "<anonymous>";
    const h = text.indexOf(".handler(", m.index);
    const next = text.indexOf("createServerFn(", m.index + 1);
    if (h === -1 || (next !== -1 && h > next)) {
      found.push({ handler: name, kind: "serverFn", guard: "unguarded" });
      continue;
    }
    const open = h + ".handler".length;
    const close = matchBracket(text, open);
    found.push({ handler: name, kind: "serverFn", guard: classifyHandler(text.slice(open + 1, close)) });
  }
  for (const m of text.matchAll(/\bhandlers\s*:\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(text, open);
    const block = text.slice(open + 1, close);
    // Top-level keys only: walk the block, skipping nested brackets.
    let i = 0;
    while (i < block.length) {
      const key = /^\s*,?\s*(\w+)\s*:/.exec(block.slice(i));
      if (!key) break;
      let j = i + key[0].length;
      const start = j;
      while (j < block.length && block[j] !== ",") {
        if (OPEN[block[j]]) j = matchBracket(block, j);
        else if (block[j] === '"' || block[j] === "'" || block[j] === "`") {
          const q = block[j];
          for (j += 1; j < block.length && block[j] !== q; j += 1) if (block[j] === "\\") j += 1;
        }
        j += 1;
      }
      found.push({ handler: key[1], kind: "serverRoute", guard: classifyHandler(block.slice(start, j)) });
      i = j;
    }
  }
  return found;
}

function listFiles(dir) {
  return fs
    .readdirSync(path.join(repoRoot, dir), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]))
    .filter((f) => /\.tsx?$/.test(f) && path.basename(f) !== "routeTree.gen.ts");
}

function describeGuard(g, isPublic) {
  if (isPublic) return "public";
  if (g === "unguarded") return "unguarded";
  return g.roles ? g.roles.join(",") : `view=${g.view}`;
}

test("every handler under src/app/routes and src/app/server is guarded or allowlisted", () => {
  const problems = [];
  let count = 0;
  for (const file of SCAN_DIRS.flatMap(listFiles)) {
    const text = fs.readFileSync(path.join(repoRoot, file), "utf8");
    const results = scanSource(file, text);
    // The scanner must account for every occurrence it is looking for.
    const fnCount = (text.match(/createServerFn\s*\(/g) ?? []).length;
    assert.equal(results.filter((r) => r.kind === "serverFn").length, fnCount, `${file}: missed a createServerFn`);
    for (const r of results) {
      count += 1;
      const isPublic = PUBLIC_FUNCTIONS.has(r.handler) || (r.kind === "serverRoute" && PUBLIC_FILES.has(file));
      console.log(`ROUTE ${file} ${r.handler} ${describeGuard(r.guard, isPublic)}`);
      if (isPublic) continue;
      if (r.guard === "unguarded") {
        problems.push(`${file} ${r.handler}: unguarded`);
        continue;
      }
      if (!file.startsWith("src/app/routes/")) continue;
      const cls = PATH_CLASSES.find((c) => c.pattern.test(path.basename(file)));
      if (!cls) continue;
      if (cls.view) {
        if (r.guard.view !== cls.view) problems.push(`${file} ${r.handler}: needs requireProjectAccess("${cls.view}")`);
      } else if (!r.guard.roles || r.guard.roles.join(",") !== [...cls.roles].sort().join(",")) {
        problems.push(`${file} ${r.handler}: needs requireRole(${cls.roles.map((x) => `"${x}"`).join(", ")})`);
      }
    }
  }
  assert.ok(count > 0, "the scan found no handlers");
  assert.deepEqual(problems, []);
});

test("the four review functions are admin-only", () => {
  const file = "src/app/routes/review.$projectN.tsx";
  const results = scanSource(file, fs.readFileSync(path.join(repoRoot, file), "utf8"));
  for (const name of ["getTrail", "submitEdit", "submitDecision", "submitGold"]) {
    assert.deepEqual(results.find((r) => r.handler === name)?.guard, { roles: ["admin"] }, name);
  }
});

test("a planted unguarded server function is reported unguarded", () => {
  const planted = `
    export const leak = createServerFn({ method: "GET" })
      .validator((d: { id: string }) => d)
      .handler(async ({ data }) => {
        const db = getDb();
        await requireRole("admin");
        return db.selectFrom("x").selectAll().execute();
      });`;
  assert.deepEqual(scanSource("planted.ts", planted), [{ handler: "leak", kind: "serverFn", guard: "unguarded" }]);
});

test("a planted unguarded server-route handler is reported unguarded; a guarded one is not", () => {
  const planted = `
    export const Route = createFileRoute("/api/x")({
      server: {
        handlers: {
          GET: async ({ request }) => { return new Response(await read(request)); },
          POST: async () => { const s = await requireProjectAccess("identifiable", id); return s; },
        },
      },
    });`;
  assert.deepEqual(scanSource("planted.ts", planted), [
    { handler: "GET", kind: "serverRoute", guard: "unguarded" },
    { handler: "POST", kind: "serverRoute", guard: { view: "identifiable" } },
  ]);
});

test("guards are recognised with arguments and assignment forms", () => {
  const src = `
    export const a = createServerFn({ method: "GET" }).handler(async () => {
      const session = await requireRole("judge", "admin");
      return session;
    });
    export const b = createServerFn({ method: "GET" }).handler(async ({ data }) => {
      const { project } = await requireProjectAccess("deidentified", data.pseudonym);
      return project;
    });`;
  assert.deepEqual(
    scanSource("x.ts", src).map((r) => r.guard),
    [{ roles: ["admin", "judge"] }, { view: "deidentified" }],
  );
});

test("path classes cover review, run, method, p and j route files", () => {
  const byName = (n) => PATH_CLASSES.find((c) => c.pattern.test(n))?.name;
  assert.equal(byName("review.$projectN.tsx"), "review");
  assert.equal(byName("run.tsx"), "run");
  assert.equal(byName("run.$jobId.tsx"), "run");
  assert.equal(byName("method.tsx"), "method");
  assert.equal(byName("p.$projectId.tsx"), "p");
  assert.equal(byName("p.$projectId.snapshot.$hash.tsx"), "p");
  assert.equal(byName("j.$pseudonym.tsx"), "j");
  assert.equal(byName("index.tsx"), undefined);
  assert.equal(byName("sign-in.tsx"), undefined);
});
