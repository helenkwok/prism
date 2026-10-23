#!/usr/bin/env node
// Pre-submission checklist: one line per item of the official hackathon rules
// (read 2026-10-24), each PASS, FAIL, PENDING (its input is not available yet)
// or MANUAL (a person checks it; the rule text is printed).
//
//   node scripts/check-submission.mjs [--final-sha <sha>] [--video <mp4>] [--video-url <url>]
//                                     [--writeup <md>] [--findings-url <url>] [--pdf-url <url>]
//
// Environment: PRISM_PROD_URL (runs e2e/prod-judge.spec.ts when that spec exists).
// Exit 1 when any line is FAIL, 0 otherwise, 2 on a usage error. Every request is
// read-only. Guards print counts only, never matched text.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = "helenkwok/prism";
export const DEADLINE = "2026-10-30T17:00:00Z"; // 2026-10-30 10:00 PDT
const PHASE7 = ".planning/phases/07-private-analysis-app";
const PHASE8 = ".planning/phases/08-demo-and-submission";

const ok = (detail) => ({ status: "PASS", detail });
const fail = (detail) => ({ status: "FAIL", detail });
const pending = (detail) => ({ status: "PENDING", detail });

export function oembedUrl(videoUrl) {
  return `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(videoUrl)}`;
}

export function hoursLeft(now) {
  return (Date.parse(DEADLINE) - now.getTime()) / 3_600_000;
}

/** The URL line of 07-DEPLOY.md, or null. */
export function deployUrl(text) {
  const m = text?.match(/^URL:\s*(https:\/\/\S+)\s*$/m);
  return m ? m[1].replace(/\/$/, "") : null;
}

/** P8-Q4 answer (t1..t4) from 08-DECISIONS-HELEN.md, or null. */
export function tavilyAnswer(text) {
  const m = text?.match(/P8-Q4[^\n]*?\b(t[1-4])\b/);
  return m ? m[1] : null;
}

async function get(deps, url) {
  try {
    const res = await deps.fetch(url, { method: "GET", redirect: "manual" });
    return { status: res.status, headers: res.headers };
  } catch (err) {
    return { status: 0, error: err.message };
  }
}

function summaries(deps) {
  return ["08-02", "08-04"].map((p) => deps.read(`${PHASE8}/${p}-SUMMARY.md`)).filter(Boolean).join("\n");
}

/** The checklist. Each entry: id, rule (short quote), kind, check(deps, opts). */
export const ITEMS = [
  {
    id: "R-REPO",
    rule: "public GitHub repository with an open source licence detectable and visible in the About section",
    kind: "auto",
    check(deps) {
      const r = deps.exec("gh", ["repo", "view", REPO, "--json", "visibility,licenseInfo"]);
      if (r.status !== 0) return fail(`gh repo view failed (status ${r.status})`);
      let j;
      try {
        j = JSON.parse(r.stdout);
      } catch {
        return fail("gh repo view returned no JSON");
      }
      const key = j.licenseInfo?.key ?? null;
      const detail = `visibility=${j.visibility} licence=${key}`;
      return j.visibility === "PUBLIC" && key ? ok(detail) : fail(detail);
    },
  },
  {
    id: "R-PUSHED",
    rule: "the repository must contain all necessary source code, assets, and instructions",
    kind: "auto",
    check(deps, opts) {
      if (!opts.finalSha) return pending("no --final-sha given");
      const r = deps.exec("gh", ["api", `repos/${REPO}/compare/${opts.finalSha}...main`, "--jq", ".status"]);
      if (r.status !== 0) return fail(`${opts.finalSha} is not on GitHub (compare failed)`);
      const s = r.stdout.trim();
      const detail = `${opts.finalSha} vs main: ${s}`;
      return s === "identical" || s === "ahead" ? ok(detail) : fail(detail);
    },
  },
  {
    id: "R-README",
    rule: "README with setup instructions that highlights the use of NVIDIA Nemotron and Token Factory",
    kind: "auto",
    check(deps) {
      const t = deps.read("README.md");
      if (!t) return fail("README.md missing");
      const missing = [
        [/^#{1,3} .*\bsetup\b/im, "setup section"],
        [/nemotron/i, "Nemotron"],
        [/token factory/i, "Token Factory"],
      ]
        .filter(([re]) => !re.test(t))
        .map(([, name]) => name);
      return missing.length ? fail(`missing: ${missing.join(", ")}`) : ok("setup section, Nemotron, Token Factory");
    },
  },
  {
    id: "R-DATA",
    rule: "no per-project data in the public repository (paths, names, identifiers)",
    kind: "auto",
    async check(deps) {
      const paths = deps.exec("node", ["scripts/check-forbidden-paths.mjs", "--tracked"]);
      // Branches and tags only: what a push can publish. Local-only refs (tool
      // snapshots) are never pushed, so --all would report them falsely.
      const files = deps.exec("node", ["scripts/check-agent-names.mjs", "--files"]);
      const history = deps.exec("node", ["scripts/check-agent-names.mjs", "--refs", "--branches", "--tags"]);
      const names = { status: files.status || history.status, stderr: files.stderr + history.stderr };
      const count = (r) => (r.stderr.match(/^(refused|name guard: pattern)/gm) ?? []).length;
      const parts = [`forbidden-paths=${paths.status === 0 ? 0 : count(paths)}`, `name-guard=${names.status === 0 ? 0 : count(names)}`];
      const guardsOk = paths.status === 0 && names.status === 0;
      const ids = await deps.identifierScan();
      if (ids === null) {
        parts.push("identifier-scan=pending (needs scripts/check-writeup.mjs exporting scanIdentifiers)");
        return guardsOk ? pending(parts.join(" ")) : fail(parts.join(" "));
      }
      parts.push(`identifier-hits=${ids.hits} in ${ids.files} files`);
      return guardsOk && ids.hits === 0 ? ok(parts.join(" ")) : fail(parts.join(" "));
    },
  },
  {
    id: "R-APP",
    rule: "a working demo URL; login credentials in the testing instructions for a private site",
    kind: "auto",
    async check(deps) {
      const url = deployUrl(deps.read(`${PHASE7}/07-DEPLOY.md`));
      if (!url) return pending("no URL line in 07-DEPLOY.md");
      const r = await get(deps, `${url}/sign-in`);
      const robots = r.headers?.get("x-robots-tag") ?? "";
      const detail = `${url}/sign-in ${r.status} x-robots-tag=${robots || "none"}`;
      return r.status === 200 && /noindex/i.test(robots) ? ok(detail) : fail(detail);
    },
  },
  {
    id: "R-FINDINGS",
    rule: "a working demo URL (public findings site)",
    kind: "auto",
    async check(deps, opts) {
      if (!opts.findingsUrl) return pending("no --findings-url given");
      const r = await get(deps, opts.findingsUrl);
      const csp = r.headers?.get("content-security-policy");
      const detail = `${r.status} csp=${csp ? "present" : "none"}`;
      return r.status === 200 && csp ? ok(detail) : fail(detail);
    },
  },
  {
    id: "R-PDF",
    rule: "a text description (written review PDF)",
    kind: "auto",
    async check(deps, opts) {
      if (!opts.pdfUrl) return pending("no --pdf-url given");
      const r = await get(deps, opts.pdfUrl);
      const type = r.headers?.get("content-type") ?? "";
      const detail = `${r.status} ${type || "no content-type"}`;
      return r.status === 200 && type.startsWith("application/pdf") ? ok(detail) : fail(detail);
    },
  },
  {
    id: "R-VIDEO",
    rule: "video less than three (3) minutes",
    kind: "auto",
    check(deps, opts) {
      if (!opts.video) return pending("no --video given");
      const out = path.join(os.homedir(), "temp-storage/scratch/prism", `${deps.now().toISOString().slice(0, 10)}-check-submission-video`);
      const r = deps.exec("bash", ["scripts/video/check.sh", opts.video, "scripts/video/script.json", out]);
      const dur = r.stdout.match(/^DURATION (\S+)/m)?.[1] ?? "?";
      return r.status === 0 ? ok(`check.sh passed, ${dur} s`) : fail(`check.sh exit ${r.status}, ${dur} s`);
    },
  },
  {
    id: "R-YOUTUBE",
    rule: "video publicly visible on YouTube",
    kind: "auto",
    async check(deps, opts) {
      if (!opts.videoUrl) return pending("no --video-url given");
      const r = await get(deps, oembedUrl(opts.videoUrl));
      return r.status === 200 ? ok("oEmbed 200") : fail(`oEmbed ${r.status}`);
    },
  },
  {
    id: "R-WRITEUP",
    rule: "a text description, in English, with the required Devpost sections",
    kind: "auto",
    check(deps, opts) {
      if (!opts.writeup) return pending("no --writeup given");
      if (!deps.exists("scripts/check-writeup.mjs")) return pending("scripts/check-writeup.mjs not present (plan 08-05)");
      const allow = `${PHASE8}/08-DEVPOST.allow`;
      const args = ["scripts/check-writeup.mjs", opts.writeup, "--final", ...(deps.exists(allow) ? ["--allow", allow] : [])];
      const r = deps.exec("node", args);
      return r.status === 0 ? ok("check-writeup --final passed") : fail(`check-writeup --final exit ${r.status}`);
    },
  },
  {
    id: "R-JUDGE",
    rule: "login credentials in the testing instructions work in production",
    kind: "auto",
    check(deps) {
      if (!deps.env.PRISM_PROD_URL) return pending("PRISM_PROD_URL not set");
      if (!deps.exists("e2e/prod-judge.spec.ts")) return pending("e2e/prod-judge.spec.ts not present (plan 07-14)");
      const r = deps.exec("npx", ["playwright", "test", "e2e/prod-judge.spec.ts"]);
      return r.status === 0 ? ok("prod-judge spec passed") : fail(`prod-judge spec exit ${r.status}`);
    },
  },
  {
    id: "R-NEBIUS",
    rule: "runs on Nebius Token Factory and uses at least one NVIDIA open source model (runtime call)",
    kind: "auto",
    check(deps) {
      const t = summaries(deps);
      if (!t) return pending("no 08-02 or 08-04 SUMMARY yet");
      return /model nvidia\/\S+ on Nebius Token Factory, [1-9]\d* calls/.test(t)
        ? ok("a production job records a Token Factory call")
        : pending("no production job with a Token Factory call recorded yet");
    },
  },
  {
    id: "R-TAVILY",
    rule: "Best Use of Tavily: a functional, runtime call to the Tavily API",
    kind: "auto",
    check(deps) {
      const answer = tavilyAnswer(deps.read(`${PHASE8}/08-DECISIONS-HELEN.md`));
      if (answer === "t4") return ok("not applicable: P8-Q4 t4, no Tavily prize entry");
      if (!answer) return pending("P8-Q4 not answered yet");
      const t = summaries(deps);
      return /Tavily map \+ extract, [1-9]\d* credits/.test(t)
        ? ok(`P8-Q4 ${answer}, a production job records Tavily credits`)
        : pending(`P8-Q4 ${answer}, no production job with Tavily credits recorded yet`);
    },
  },
  {
    id: "R-DEADLINE",
    rule: "submit before 2026-10-30 10:00 PDT",
    kind: "auto",
    check(deps) {
      const h = hoursLeft(deps.now());
      return h > 0 ? ok(`${h.toFixed(1)} h left`) : fail(`deadline passed ${(-h).toFixed(1)} h ago`);
    },
  },
  { id: "R-TRACK", rule: "the track is selected (Best Apps and Agents)", kind: "manual" },
  { id: "R-ENGLISH", rule: "all submission materials in English", kind: "manual" },
  { id: "R-MEDIA", rule: "video without third-party trademarks or copyrighted music", kind: "manual" },
  { id: "R-YT-PUBLIC", rule: "YouTube visibility is Public (not Unlisted or Private)", kind: "manual" },
  { id: "R-AVAILABLE", rule: "demo available until the Judging Period ends (2026-12-15 12:00 PT)", kind: "manual" },
  { id: "R-FEEDBACK", rule: "feedback on Nebius Token Factory, AI Cloud and NVIDIA tools", kind: "manual" },
  { id: "R-UPDATED", rule: "significantly-updated statement where pre-existing work is reused", kind: "manual" },
];

export async function runChecklist(opts, deps) {
  const results = [];
  for (const item of ITEMS) {
    let r;
    if (item.kind === "manual") r = { status: "MANUAL", detail: item.rule };
    else {
      try {
        r = await item.check(deps, opts);
      } catch (err) {
        r = fail(`check threw: ${err.message}`);
      }
    }
    results.push({ id: item.id, ...r });
  }
  return results;
}

export function exitCode(results) {
  return results.some((r) => r.status === "FAIL") ? 1 : 0;
}

export function parseArgs(argv) {
  const flags = {
    "--final-sha": "finalSha",
    "--video": "video",
    "--video-url": "videoUrl",
    "--writeup": "writeup",
    "--findings-url": "findingsUrl",
    "--pdf-url": "pdfUrl",
  };
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = flags[argv[i]];
    if (!key || argv[i + 1] === undefined) throw new Error(`unknown or incomplete argument: ${argv[i]}`);
    opts[key] = argv[i + 1];
  }
  return opts;
}

function realDeps(root) {
  const exec = (cmd, args) => {
    const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const read = (rel) => {
    try {
      return fs.readFileSync(path.join(root, rel), "utf8");
    } catch {
      return null;
    }
  };
  const exists = (rel) => fs.existsSync(path.join(root, rel));
  return {
    exec,
    read,
    exists,
    fetch: globalThis.fetch,
    now: () => new Date(),
    env: process.env,
    // Identifier scan over every tracked text file, counts only. Needs plan 08-05's
    // check-writeup.mjs to export scanIdentifiers(text) -> number of hits.
    async identifierScan() {
      const file = path.join(root, "scripts/check-writeup.mjs");
      if (!fs.existsSync(file)) return null;
      const mod = await import(file);
      if (typeof mod.scanIdentifiers !== "function") return null;
      let hits = 0;
      let files = 0;
      for (const rel of exec("git", ["ls-files", "-z"]).stdout.split("\0").filter(Boolean)) {
        let buf;
        try {
          buf = fs.readFileSync(path.join(root, rel));
        } catch {
          continue;
        }
        if (buf.subarray(0, 8192).includes(0)) continue;
        const n = Number(await mod.scanIdentifiers(buf.toString("utf8")));
        hits += n;
        if (n > 0) files += 1;
      }
      return { hits, files };
    },
  };
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const results = await runChecklist(opts, realDeps(root));
  for (const r of results) console.log(`${r.status.padEnd(7)} ${r.id.padEnd(11)} ${r.detail}`);
  const n = (s) => results.filter((r) => r.status === s).length;
  console.log(`TOTAL pass=${n("PASS")} fail=${n("FAIL")} pending=${n("PENDING")} manual=${n("MANUAL")}`);
  return exitCode(results);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url));

if (invokedDirectly) process.exit(await main(process.argv.slice(2)));
