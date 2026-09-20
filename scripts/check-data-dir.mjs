// PRISM_DATA_DIR containment guard.
//
// Per-project data must live outside the public repository. This module is the
// single guard: the app boot, every spike harness and CI import or run it.
//
//   import { assertOutsideRepo, resolvePrivateDir, resolveRepoRoot } from "./check-data-dir.mjs";
//
// CLI: node scripts/check-data-dir.mjs
//   exit 0  PRISM_DATA_DIR is absolute and resolves outside the repo
//   exit 1  DATA_DIR_INSIDE_REPO
//   exit 2  DATA_DIR_RELATIVE or any other usage error

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DATA_DIR_INSIDE_REPO = "DATA_DIR_INSIDE_REPO";
export const DATA_DIR_RELATIVE = "DATA_DIR_RELATIVE";

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Repo root: `git rev-parse --show-toplevel`, else the nearest folder with a
 * package.json walking up from cwd, else cwd itself.
 */
export function resolveRepoRoot(cwd = process.cwd()) {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out) return out;
  } catch {
    // not a git repo, or git missing: fall through
  }
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(cwd);
    dir = parent;
  }
}

/**
 * The private data directory from the environment. Unset means ~/.prism-data.
 * A leading `~` is expanded. Anything still relative is rejected, because it
 * would resolve against a working directory that may be inside the repo.
 */
export function resolvePrivateDir(env = process.env, repoRoot = resolveRepoRoot()) {
  void repoRoot; // accepted so callers share one signature; a relative value is never resolved against it
  let value = env.PRISM_DATA_DIR;
  if (value === undefined || value === "") {
    return path.join(os.homedir(), ".prism-data");
  }
  if (value === "~") {
    value = os.homedir();
  } else if (value.startsWith("~/")) {
    value = path.join(os.homedir(), value.slice(2));
  }
  if (!path.isAbsolute(value)) {
    throw codedError(
      DATA_DIR_RELATIVE,
      `PRISM_DATA_DIR must be an absolute path (got "${value}"): a relative path resolves against the working directory, which may be inside the repo`,
    );
  }
  return path.normalize(value);
}

/**
 * Resolve `dir` to a real path even when it does not exist yet: realpath the
 * nearest existing ancestor (following symlinks), then re-append the tail.
 */
function realpathWithTail(dir) {
  let current = path.resolve(dir);
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (err) {
      if (err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(dir);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Throw DATA_DIR_INSIDE_REPO when `dir` resolves to, or beneath, the repo root.
 * Both sides are compared as real paths (macOS /tmp and /var are symlinks into
 * /private), so a symlink outside the repo that points into it is rejected.
 * Returns the resolved path otherwise.
 */
export function assertOutsideRepo(dir, repoRoot) {
  const resolved = realpathWithTail(dir);
  const repoReal = fs.realpathSync.native(repoRoot);
  const rel = path.relative(repoReal, resolved);
  const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (inside) {
    throw codedError(
      DATA_DIR_INSIDE_REPO,
      `PRISM_DATA_DIR is inside the repo: ${resolved} is under ${repoReal}. Private data must live outside the repository.`,
    );
  }
  return resolved;
}

function main() {
  try {
    const root = resolveRepoRoot(process.cwd());
    const dir = resolvePrivateDir(process.env, root);
    const resolved = assertOutsideRepo(dir, root);
    process.stdout.write(`PRISM_DATA_DIR ok: ${resolved}\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(err.code === DATA_DIR_INSIDE_REPO ? 1 : 2);
  }
}

// The basename test matters once a bundler inlines this module into a server
// entry file: there import.meta.url is the entry itself, and without it the
// bundled server would run the CLI (and exit) at start.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.basename(process.argv[1]) === "check-data-dir.mjs" &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url));

if (invokedDirectly) main();
