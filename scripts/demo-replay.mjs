#!/usr/bin/env node
// SUB-01 / D-82 demo replay (plan 07-04): on Helen's Mac, open one of her own
// projects' collected pages in a headed terminal-browser pane, in collection
// order, and end on the app's report for the same project.
//
//   node scripts/demo-replay.mjs --view <ReportView.json> --own-host <host> \
//        --report-url <app URL> [--pause-ms 2500] [--dry-run]
//
// Replay only: it reads one identifiable ReportView and writes nothing (no
// snapshot, span, manifest or database row). Collection stays headless; there
// is no headed browser on the server. It refuses any view whose page hosts are
// not --own-host or a subdomain of it, so no third party's site is filmed.
// --dry-run prints one `REPLAY step=<n> cmd=<command> args=<JSON>` line per step.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const BROWSER = "terminal-browser";

function httpUrl(u) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return null;
  }
  return url.protocol === "https:" || url.protocol === "http:" ? url : null;
}

/** null when every collection URL is on ownHost (or a subdomain of it), else the reason. */
export function ownHostError(view, ownHost) {
  const own = String(ownHost ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!own) return "no --own-host given";
  if (view?.view !== "identifiable") return "view is not an identifiable ReportView";
  const urls = view.collection?.urls;
  if (!Array.isArray(urls) || urls.length === 0) return "view has no collection urls";
  for (const u of urls) {
    const url = httpUrl(u);
    if (!url) return `not an http(s) url: ${u}`;
    const h = url.hostname.toLowerCase().replace(/\.$/, "");
    if (h !== own && !h.endsWith(`.${own}`)) return `host ${h} is outside ${own}`;
  }
  return null;
}

/**
 * Runs in the page (never in Node): find the quote by exact string equality in
 * the page's concatenated text nodes (no normalisation, the builder's
 * exact-text rule), wrap the first match in <mark>, scroll it into view.
 * The quote arrives only as a JSON-encoded string literal argument.
 */
function markQuote(q) {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let text = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push([n, text.length]);
    text += n.data;
  }
  const at = q === "" ? -1 : text.indexOf(q);
  if (at === -1) return "prism-mark:missing";
  const locate = (pos, isEnd) => {
    for (const [n, start] of nodes) if (isEnd ? pos <= start + n.data.length : pos < start + n.data.length) return [n, pos - start];
  };
  const range = document.createRange();
  range.setStart(...locate(at, false));
  range.setEnd(...locate(at + q.length, true));
  const mark = document.createElement("mark");
  mark.setAttribute("data-prism-quote", "");
  mark.appendChild(range.extractContents());
  range.insertNode(mark);
  mark.scrollIntoView({ block: "center", behavior: "smooth" });
  return "prism-mark:found";
}

export const markScript = (quote) => `(${markQuote.toString()})(${JSON.stringify(String(quote))})`;

/** The ordered replay: each collected page in collection order with its cited quotes marked, then the report. */
export function buildSteps(view, { ownHost, reportUrl }) {
  const err = ownHostError(view, ownHost);
  if (err) throw new Error(`not an own project: ${err}`);
  if (!httpUrl(reportUrl)) throw new Error("--report-url must be an http(s) url");
  const steps = [];
  view.collection.urls.forEach((url, i) => {
    steps.push(i === 0 ? { kind: "page", cmd: BROWSER, args: ["open", url, "--split", "right"] } : { kind: "page", cmd: BROWSER, args: ["action", "--", "open", url] });
    const seen = new Set();
    for (const c of view.checks ?? []) {
      for (const q of c.quotes ?? []) {
        if (q.url !== url || seen.has(q.spanId)) continue;
        seen.add(q.spanId);
        steps.push({ kind: "mark", cmd: BROWSER, args: ["action", "--", "eval", markScript(q.text)], quote: q.text });
      }
    }
  });
  steps.push({ kind: "page", cmd: BROWSER, args: ["action", "--", "open", reportUrl] });
  return steps;
}

export const replayLine = (n, s) => `REPLAY step=${n} cmd=${s.cmd} args=${JSON.stringify(s.args)}`;

function spawnRunner(cmd, args) {
  // Argument array, never a shell string.
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (r.error) return { status: 1, stdout: "", error: r.error.message };
  return { status: r.status ?? 1, stdout: r.stdout ?? "" };
}

/** Run (or with dryRun, print) the steps. runner(cmd, args) -> { status, stdout }. Returns the exit code. */
export async function run(steps, { runner = spawnRunner, dryRun = false, pauseMs = 2500, sleep = delay, log = console.log } = {}) {
  for (let i = 0; i < steps.length; i++) {
    const n = i + 1;
    const s = steps[i];
    log(replayLine(n, s));
    if (dryRun) continue;
    if (s.kind === "page" && i > 0 && pauseMs > 0) await sleep(pauseMs);
    const r = await runner(s.cmd, s.args);
    if (s.kind === "mark") {
      // Reported, never guessed: anything but an explicit "found" is a note, and the replay goes on.
      if (r.status !== 0) log(`REPLAY note=mark-failed step=${n} status=${r.status}`);
      else if (!String(r.stdout ?? "").includes("prism-mark:found")) log(`REPLAY note=quote-not-found step=${n}`);
      continue;
    }
    if (r.status !== 0) {
      log(`REPLAY error step=${n} status=${r.status}${r.error ? ` error=${JSON.stringify(r.error)}` : ""}`);
      return 1;
    }
  }
  return 0;
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      view: { type: "string" },
      "own-host": { type: "string" },
      "report-url": { type: "string" },
      "pause-ms": { type: "string", default: "2500" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (!values.view || !values["report-url"]) {
    console.error("usage: demo-replay.mjs --view <ReportView.json> --own-host <host> --report-url <url> [--pause-ms 2500] [--dry-run]");
    return 2;
  }
  const view = JSON.parse(fs.readFileSync(values.view, "utf8"));
  let steps;
  try {
    steps = buildSteps(view, { ownHost: values["own-host"], reportUrl: values["report-url"] });
  } catch (e) {
    console.error(`REPLAY refused: ${e.message}`);
    return 2;
  }
  const pauseMs = Number(values["pause-ms"]);
  if (!Number.isFinite(pauseMs) || pauseMs < 0) {
    console.error("--pause-ms must be a non-negative number");
    return 2;
  }
  return run(steps, { dryRun: values["dry-run"], pauseMs });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
