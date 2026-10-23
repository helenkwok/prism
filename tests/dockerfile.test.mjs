// Static checks over Dockerfile, .dockerignore and scripts/docker-smoke.sh.
// No Docker daemon needed: everything here is a text-level assertion, so
// this suite runs in `npm test` and needs nothing beyond node:test.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
const dockerignore = fs.readFileSync(path.join(root, ".dockerignore"), "utf8");
const dockerignoreLines = dockerignore.split(/\r?\n/);
const fromLines = dockerfile.split(/\r?\n/).filter((l) => /^\s*FROM\s/i.test(l));

test("both stages pin the same base image, by tag and digest", () => {
  assert.equal(fromLines.length, 2, `expected exactly two FROM lines, found ${fromLines.length}`);
  const refs = fromLines.map((l) => l.replace(/^\s*FROM\s+/i, "").split(/\s+AS\s+/i)[0].trim());
  assert.equal(refs[0], refs[1], "both FROM lines must reference the identical image");
  assert.match(refs[0], /^[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/, `not pinned by tag and digest: ${refs[0]}`);
});

// 07-12c: the VM build failed on a src import of a scripts/ file the image never copied.
test("every scripts/ module that src imports (and what it imports) is copied into the build stage", () => {
  const files = new Set();
  const visit = (file) => {
    for (const m of fs.readFileSync(file, "utf8").matchAll(/from\s+"(\.{1,2}\/[^"]+\.mjs)"/g)) {
      const target = path.resolve(path.dirname(file), m[1]);
      const rel = path.relative(root, target);
      if (rel.startsWith("scripts/") && !files.has(rel)) {
        files.add(rel);
        visit(target);
      }
    }
  };
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs)$/.test(e.name)) visit(p);
    }
  };
  walk(path.join(root, "src"));
  assert.ok(files.size > 0);
  const buildStage = dockerfile.slice(dockerfile.indexOf(fromLines[0]), dockerfile.indexOf(fromLines[1]));
  for (const f of files) {
    assert.ok(buildStage.includes(f), `Dockerfile build stage does not copy ${f}`);
    assert.ok(dockerignoreLines.includes(`!${f}`), `.dockerignore does not allow ${f}`);
  }
});

test("the container runs as a non-root user", () => {
  assert.match(dockerfile, /^USER node\s*$/m);
});

test("no ARG or ENV name suggests a secret", () => {
  const suspicious = /\b(ARG|ENV)\s+[A-Za-z0-9_]*(SECRET|PASSWORD|TOKEN|KEY|CREDENTIAL)[A-Za-z0-9_]*/i;
  for (const line of dockerfile.split(/\r?\n/)) {
    assert.doesNotMatch(line, suspicious, `looks like a secret declaration: ${line.trim()}`);
  }
});

test("dependencies install with npm ci, scripts never disabled", () => {
  assert.match(dockerfile, /^\s*RUN\s+npm ci\s*$/m);
  assert.doesNotMatch(dockerfile, /--ignore-scripts/);
});

test("the runtime stage installs python3, creates /opt/gate and installs the pinned gate requirements", () => {
  const runtimeStart = dockerfile.indexOf(fromLines[1]);
  assert.ok(runtimeStart >= 0);
  const runtimeStage = dockerfile.slice(runtimeStart);
  assert.match(runtimeStage, /apt-get install[^\n]*\bpython3\b/);
  assert.match(runtimeStage, /python3\s+-m\s+venv\s+\/opt\/gate/);
  assert.match(runtimeStage, /\/opt\/gate\/bin\/pip install[^\n]*-r requirements-gate\.txt/);
  assert.match(runtimeStage, /ENV\s+PRISM_PYTHON=\/opt\/gate\/bin\/python/);
});

test("the build stage copies only the allow-listed source paths", () => {
  const buildStart = dockerfile.indexOf(fromLines[0]);
  const buildEnd = dockerfile.indexOf(fromLines[1]);
  const buildStage = dockerfile.slice(buildStart, buildEnd);
  assert.match(buildStage, /COPY\s+package\.json\s+package-lock\.json/);
  assert.match(buildStage, /COPY\s+.*\bsrc\b/);
  assert.match(buildStage, /RUN\s+npm run build/);
});

test("the image builds with Rsbuild and runs scripts/serve.mjs over dist/", () => {
  const buildStage = dockerfile.slice(dockerfile.indexOf(fromLines[0]), dockerfile.indexOf(fromLines[1]));
  const runtimeStage = dockerfile.slice(dockerfile.indexOf(fromLines[1]));
  assert.match(buildStage, /COPY\s+rsbuild\.config\.ts\b/);
  // Tailwind runs through PostCSS; without its config the image would ship unstyled pages.
  assert.match(buildStage, /COPY\s+.*\bpostcss\.config\.mjs\b/);
  assert.match(buildStage, /RUN\s+npm prune --omit=dev/);
  assert.match(runtimeStage, /COPY\s+--from=build\s+\/app\/dist\s+\.\/dist/);
  assert.match(runtimeStage, /COPY\s+--from=build\s+\/app\/node_modules\s+\.\/node_modules/);
  assert.match(runtimeStage, /COPY\s+--from=build\s+\/app\/package\.json\s+\.\/package\.json/);
  assert.match(runtimeStage, /COPY\s+scripts\/serve\.mjs\s+\.\/scripts\/serve\.mjs/);
  assert.match(dockerfile, /^CMD \["node", "scripts\/serve\.mjs"\]\s*$/m);
  assert.doesNotMatch(dockerfile, /\.output|vite\.config/);
  assert.ok(dockerignoreLines.includes("!rsbuild.config.ts") && dockerignoreLines.includes("!postcss.config.mjs") && dockerignoreLines.includes("!scripts/serve.mjs"));
  assert.ok(!dockerignore.includes("vite.config"));
});

test(".dockerignore is deny-all-first, then a named allow-list", () => {
  const codeLines = dockerignoreLines.filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  assert.equal(codeLines[0].trim(), "*", "the first non-comment line must be a bare '*'");
  assert.ok(codeLines.some((l) => l.trim() === "!src/**"), "must allow src/**");
  assert.ok(codeLines.some((l) => l.trim() === "!vendor/**"), "must allow vendor/**");
  assert.ok(
    codeLines.every((l) => l.trim() === "*" || l.trim().startsWith("!")),
    "every rule after the first must be a negated (allow) rule",
  );
});

test(".dockerignore names no agent-tool or planning directory", () => {
  // Base64-encoded so this test file itself never carries a bare pattern
  // in cleartext (D-23/D-25 name guard self-scan).
  const NEEDLES_B64 = [
    "LmNsYXVkZQ==",
    "LmN1cnNvcg==",
    "LmNvZGV4",
    "LmFnZW50cw==",
    "LmdlbWluaQ==",
    "LndpbmRzdXJm",
    "LnBsYW5uaW5n",
    "LmdzZA==",
  ];
  for (const b64 of NEEDLES_B64) {
    const needle = Buffer.from(b64, "base64").toString("utf8");
    assert.ok(!dockerignore.includes(needle), `must not name a forbidden directory`);
  }
});

test("scripts/docker-smoke.sh is syntactically valid bash", () => {
  const res = spawnSync("bash", ["-n", path.join(root, "scripts", "docker-smoke.sh")], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
});

test("scripts/docker-smoke.sh runs under a strict shell mode and cleans up", () => {
  const smoke = fs.readFileSync(path.join(root, "scripts", "docker-smoke.sh"), "utf8");
  assert.match(smoke, /set -euo pipefail/);
  assert.match(smoke, /trap\s+\S*cleanup\S*\s+EXIT/);
});

test("the runtime image ships the codebook and gap text that /review and /method read at request time", () => {
  const runtimeStage = dockerfile.slice(dockerfile.indexOf(fromLines[1]));
  assert.match(runtimeStage, /COPY\s+codebook\.md\s+\.\/codebook\.md/);
  assert.match(runtimeStage, /COPY\s+protocol\/gap-text\.json\s+\.\/protocol\/gap-text\.json/);
  for (const allow of ["!codebook.md", "!protocol", "!protocol/gap-text.json"]) assert.ok(dockerignoreLines.includes(allow), allow);
});

// T-07-SC-12 / nodejs/node#65446: only the published better-sqlite3 binding, checked per architecture.
const BINDING = "node_modules/better-sqlite3/build/Release/better_sqlite3.node";
const buildStage = dockerfile.slice(dockerfile.indexOf(fromLines[0]), dockerfile.indexOf(fromLines[1]));

test("the build stage copies the binding checksums before npm ci and checks them on the next line", () => {
  const lines = buildStage.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
  const ci = lines.indexOf("RUN npm ci");
  const copy = lines.findIndex((l) => /^COPY\s+docker\/better-sqlite3\s+\.\/docker\/better-sqlite3$/.test(l));
  assert.ok(copy >= 0 && copy < ci, "COPY docker/better-sqlite3 must come before RUN npm ci");
  assert.equal(lines[ci + 1], 'RUN sha256sum -c "docker/better-sqlite3/linux-$(node -p process.arch).sha256"');
});

test("each binding checksum file is one sha256sum line for the better-sqlite3 binding", () => {
  for (const arch of ["arm64", "x64"]) {
    const text = fs.readFileSync(path.join(root, "docker", "better-sqlite3", `linux-${arch}.sha256`), "utf8");
    assert.match(text, new RegExp(`^[0-9a-f]{64}  ${BINDING.replaceAll(".", "\\.")}\\n?$`), arch);
  }
});

test("the Dockerfile, comments included, names no compiler, make, node-gyp or source-build option", () => {
  const tokens = dockerfile.toLowerCase().split(/[^a-z0-9+_-]+/).map((t) => t.replace(/^-+/, ""));
  const forbidden = ["gcc", "g++", "cc", "c++", "clang", "clang++", "make", "cmake", "node-gyp", "build-essential"];
  for (const word of forbidden) assert.ok(!tokens.includes(word), `Dockerfile names ${word}`);
  assert.doesNotMatch(dockerfile, /build[-_]from[-_]source|npm_config_build/i);
});

test(".dockerignore lets docker/better-sqlite3 into the build context", () => {
  for (const allow of ["!docker", "!docker/better-sqlite3", "!docker/better-sqlite3/**"]) assert.ok(dockerignoreLines.includes(allow), allow);
});
