import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function copyDirIfPresent(from, to) {
  if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true });
}

/**
 * Create an isolated git repository under the OS temp dir, with this repo's
 * hooks and guard scripts copied in and core.hooksPath pointing at them.
 * The developer's global and system git configuration is disabled for every
 * call, so their own hooks and settings cannot influence a test.
 */
export function createTempGitRepo({ prefix = "prism-git" } = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)));

  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_") && !["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT"].includes(key)) {
      delete env[key];
    }
  }

  function run(cmd, args = [], opts = {}) {
    const res = spawnSync(cmd, args, {
      cwd: dir,
      env: { ...env, ...(opts.env ?? {}) },
      encoding: "utf8",
      input: opts.input,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  }

  function git(...args) {
    return run("git", args);
  }

  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test User");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");

  copyDirIfPresent(path.join(REPO_ROOT, ".githooks"), path.join(dir, ".githooks"));
  copyDirIfPresent(path.join(REPO_ROOT, "scripts"), path.join(dir, "scripts"));
  const hooksDir = path.join(dir, ".githooks");
  if (fs.existsSync(hooksDir)) {
    for (const f of fs.readdirSync(hooksDir)) fs.chmodSync(path.join(hooksDir, f), 0o755);
  }
  git("config", "core.hooksPath", ".githooks");

  return {
    dir,
    run,
    git,
    write(relPath, contents = "") {
      const abs = path.join(dir, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, contents);
      return abs;
    },
    stage(relPath, { force = false } = {}) {
      return git("add", ...(force ? ["-f"] : []), "--", relPath);
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
