#!/usr/bin/env node
// The D-15 pin rule, the 50-page streak, and the Batch close-out (FND-05,
// D-15, D-17, D-21, plan 01-10 Task 3).
//
//   node --env-file=<private env file> scripts/spikes/nebius-pin.mjs [--matrix-pages <n>]
//
// (1) Pin rule, applied programmatically to the recorded matrix: among
//     configs with schema_valid_rate >= 0.95 and n >= 20, prefer Ultra if it
//     qualifies, else Super, else Lightning; ties broken by higher
//     schema_valid_rate, then lower retry_rate, then json_schema over
//     json_object, then thinking off. If none qualifies, pin the best config
//     by schema_valid_rate with mode "schema-in-prompt-plus-zod-plus-retry".
// (2) Streak: the pinned config run sequentially on 50 further pages (the
//     corpus pages after the ones the matrix used), recording
//     {n, max_consecutive_valid}.
// (3) Batch close-out: poll scripts/spikes/nebius-batch.mjs until every batch
//     is terminal (exit 0) or up to 60 minutes (5-minute sleeps); on
//     timeout, a blocker is returned and status is NOT set final.
// Finalises spikes/nebius.md: pinned, fallbacks, status final (only when the
// resulting record validates clean against the final contract).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractJsonBlock, replaceJsonBlock, validateRecord } from "../lib/spike-record.mjs";
import { pickCandidateModels } from "./lib/candidates.mjs";
import { buildContract, isSchemaValid, loadGateFile, resolveGatesPath } from "./lib/contract.mjs";
import { buildChatBody, createClient } from "./lib/nebius.mjs";
import { spikeDirs, sleep } from "./lib/paths.mjs";
import { capPage, loadPageCorpus } from "./lib/pages.mjs";
import { segmentPage } from "./lib/segment.mjs";

const RECORD_PATH = "spikes/nebius.md";
const KEY = process.env.NEBIUS_API_KEY ?? "";
const BASE_URL = process.env.NEBIUS_BASE_URL ?? "";
const MAX_TOKENS = 4096;
const STREAK_N = 50;
const BATCH_WAIT_MS = 5 * 60 * 1000;
const BATCH_MAX_WAIT_MS = 60 * 60 * 1000;
const PIN_ORDER = ["ultra", "super", "lightning"];
const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

function log(obj) {
  console.log(JSON.stringify(obj));
}

function requireEnv() {
  if (!KEY || !BASE_URL) {
    console.error("NEBIUS_API_KEY and NEBIUS_BASE_URL must be set (run with node --env-file=<private env file>)");
    process.exit(2);
  }
}

function parseArgs(argv) {
  const out = { matrixPages: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--matrix-pages" && argv[i + 1]) out.matrixPages = Number(argv[++i]);
  }
  return out;
}

function recordTarget(dirs) {
  return path.join(dirs.root, RECORD_PATH);
}

function loadRecord(dirs) {
  const target = recordTarget(dirs);
  if (!fs.existsSync(target)) throw new Error(`${RECORD_PATH} does not exist`);
  return { target, md: fs.readFileSync(target, "utf8") };
}

// ---- (1) the D-15 pin rule --------------------------------------------------

function tieBreakCompare(a, b) {
  if (a.schema_valid_rate !== b.schema_valid_rate) return b.schema_valid_rate - a.schema_valid_rate; // higher first
  if (a.retry_rate !== b.retry_rate) return a.retry_rate - b.retry_rate; // lower first
  const aSchemaFirst = a.output_mode === "json_schema" ? 0 : 1;
  const bSchemaFirst = b.output_mode === "json_schema" ? 0 : 1;
  if (aSchemaFirst !== bSchemaFirst) return aSchemaFirst - bSchemaFirst; // json_schema over json_object
  const aThinkOff = a.thinking === "off" ? 0 : 1;
  const bThinkOff = b.thinking === "off" ? 0 : 1;
  return aThinkOff - bThinkOff; // thinking off preferred
}

/**
 * Apply D-15 to the recorded matrix. Returns
 * { picked, mode, qualified, label, tieBreakOrder }.
 */
export function applyPinRule(matrix, candidates) {
  const measurable = (e) => e.status !== "unsupported" && typeof e.schema_valid_rate === "number";
  const qualifying = matrix.filter((e) => measurable(e) && e.n >= 20 && e.schema_valid_rate >= 0.95);

  for (const label of PIN_ORDER) {
    const candidate = candidates.find((c) => c.label === label);
    if (!candidate) continue;
    const forModel = qualifying.filter((e) => e.model === candidate.id);
    if (forModel.length > 0) {
      const picked = [...forModel].sort(tieBreakCompare)[0];
      return {
        picked,
        mode: "real-time",
        qualified: true,
        label,
        tieBreakOrder: "higher schema_valid_rate, then lower retry_rate, then json_schema over json_object, then thinking off",
      };
    }
  }

  const eligible = matrix.filter(measurable);
  if (eligible.length === 0) throw new Error("no matrix entry has a measurable schema_valid_rate; cannot pin (D-15)");
  const best = [...eligible].sort(tieBreakCompare)[0];
  return {
    picked: best,
    mode: "schema-in-prompt-plus-zod-plus-retry",
    qualified: false,
    label: null,
    tieBreakOrder: "no config met >=95% on >=20 pages (D-15 last clause): best schema_valid_rate overall",
  };
}

// ---- (2) the 50-page streak --------------------------------------------------

function buildCodingPrompt(checkIds, checkLabels, jsonSchema, spans) {
  const checklist = checkIds.map((id, i) => `${i + 1}. ${id} — ${checkLabels[id]}`).join("\n");
  const spanText = spans.map((s) => `${s.id}: ${s.text}`).join("\n\n");
  const system =
    "You are coding evidence for a fixed set of decision-gate checks, from a single fetched page split into " +
    "numbered spans. For EACH of the following 24 checks, decide proposedState (one of: pass, fail, unknown, " +
    "claimed) using only the numbered spans below, and cite the span ids (from the list given) that support your " +
    "decision in spanIds. If no span supports a decision, use unknown and an empty spanIds array. Never invent a " +
    "span id that is not in the list below.\n\nChecks:\n" +
    checklist +
    "\n\nRespond with JSON only, matching this JSON Schema exactly (24 entries in checks, one per check id above, " +
    "in the order given):\n" +
    JSON.stringify(jsonSchema);
  const user = "Page spans:\n\n" + spanText;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

async function callOnce(client, model, mode, thinking, jsonSchema, checkIds, checkLabels, spans) {
  const body = buildChatBody({
    model,
    messages: buildCodingPrompt(checkIds, checkLabels, jsonSchema, spans),
    mode,
    schema: mode === "json_schema" ? { name: "gate_checks", schema: jsonSchema, strict: true } : undefined,
    thinking,
    maxTokens: MAX_TOKENS,
  });
  const res = await client.request("/chat/completions", { method: "POST", body });
  const choice = res.json?.choices?.[0];
  return { status: res.status, content: choice?.message?.content ?? "", finishReason: choice?.finish_reason ?? null };
}

async function runStreak(client, contract, gate, pinned, pages, dirs) {
  const results = [];
  for (const page of pages) {
    const { text: capped } = capPage(page.text);
    const spans = segmentPage(capped);
    const spanIds = spans.map((s) => s.id);
    const thinking = pinned.thinking === "on";

    let attempt = await callOnce(client, pinned.model, pinned.output_mode, thinking, contract.jsonSchema, contract.checkIds, gate.checkLabels, spans);
    let evalResult = isSchemaValid(attempt.content, spanIds, contract.zodSchema);
    let retried = false;
    if (!evalResult.valid) {
      retried = true;
      attempt = await callOnce(client, pinned.model, pinned.output_mode, thinking, contract.jsonSchema, contract.checkIds, gate.checkLabels, spans);
      evalResult = isSchemaValid(attempt.content, spanIds, contract.zodSchema);
    }
    results.push({ page_id: page.id, valid: evalResult.valid, stage: evalResult.stage, retried });
  }

  fs.writeFileSync(path.join(dirs.spikes, "nebius-runs", "streak.json"), JSON.stringify({ pinned, results }, null, 2), {
    mode: 0o600,
  });

  let max = 0;
  let cur = 0;
  for (const r of results) {
    if (r.valid) {
      cur += 1;
      max = Math.max(max, cur);
    } else {
      cur = 0;
    }
  }
  return { n: results.length, max_consecutive_valid: max };
}

// ---- (3) the Batch close-out -------------------------------------------------

function runBatchPollOnce() {
  const script = path.join(THIS_DIR, "nebius-batch.mjs");
  const res = execFileSync(process.execPath, [script, "poll"], {
    cwd: path.resolve(THIS_DIR, "../.."),
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return res;
}

/** One poll attempt. Returns { terminal: true } | { terminal: false, pending: true } | { terminal: false, error }. */
function pollBatchOnce() {
  let out;
  let status = 0;
  try {
    out = runBatchPollOnce();
  } catch (err) {
    status = err.status ?? 1;
    out = err.stdout ?? "";
  }
  log({ batch_poll_output: (out ?? "").trim().split("\n").pop() ?? "" });
  if (status === 0) return { terminal: true };
  if (status === 3) return { terminal: false, pending: true };
  return { terminal: false, error: `nebius-batch.mjs poll exited ${status}` };
}

// ---- main --------------------------------------------------------------------

async function main() {
  requireEnv();
  const args = parseArgs(process.argv.slice(2));
  const dirs = spikeDirs(); // assertOutsideRepo runs here, before anything is written

  const { target, md } = loadRecord(dirs);
  const obj = extractJsonBlock(md);
  if (!Array.isArray(obj.matrix) || obj.matrix.length !== 12) {
    console.error(`spikes/nebius.md matrix has ${obj.matrix?.length ?? 0} entries; run nebius-matrix.mjs --configs all first`);
    process.exit(1);
  }
  if (!Array.isArray(obj.escape_probe) || obj.escape_probe.length < 1) {
    console.error("spikes/nebius.md escape_probe is empty; run nebius-escape-probe.mjs first");
    process.exit(1);
  }

  const catalogue = obj.catalogue ?? [];
  const candidates = pickCandidateModels(catalogue);

  const pinResult = applyPinRule(obj.matrix, candidates);
  log({
    pin_rule: pinResult.qualified ? `qualified: ${pinResult.label}` : "no config qualified; fallback",
    model: pinResult.picked.model,
    output_mode: pinResult.picked.output_mode,
    thinking: pinResult.picked.thinking,
    schema_valid_rate: pinResult.picked.schema_valid_rate,
  });

  const gatesPath = resolveGatesPath(undefined, dirs.root);
  const gate = loadGateFile(gatesPath);
  const contract = buildContract(gate.checkIds);

  const matrixPagesUsed = args.matrixPages ?? Math.max(25, ...obj.matrix.map((e) => e.n ?? 0));
  const allPages = loadPageCorpus(dirs);
  const streakPages = allPages.slice(matrixPagesUsed, matrixPagesUsed + STREAK_N);
  if (streakPages.length < STREAK_N) {
    console.error(`only ${streakPages.length} distinct pages available after the matrix's ${matrixPagesUsed}; need ${STREAK_N}`);
    process.exit(1);
  }

  const client = createClient({ baseUrl: BASE_URL, apiKey: KEY, concurrency: 4 });
  const streak = await runStreak(
    client,
    contract,
    gate,
    { model: pinResult.picked.model, output_mode: pinResult.picked.output_mode, thinking: pinResult.picked.thinking },
    streakPages,
    dirs,
  );
  log({ streak });

  // (3) Batch close-out: poll up to 60 minutes total, sleeping 5 minutes between attempts.
  const batchStarted = Date.now();
  let batchOutcome = pollBatchOnce();
  while (batchOutcome.pending && Date.now() - batchStarted < BATCH_MAX_WAIT_MS) {
    log({ batch_status: "pending, waiting 5 minutes" });
    await sleep(BATCH_WAIT_MS);
    batchOutcome = pollBatchOnce();
  }
  if (batchOutcome.pending) batchOutcome = { terminal: false, timeout: true };

  const pinned = {
    model: pinResult.picked.model,
    output_mode: pinResult.picked.output_mode,
    thinking: pinResult.picked.thinking,
    base_url: BASE_URL,
    mode: pinResult.mode,
    retry_rate: pinResult.picked.retry_rate,
    streak,
  };

  const freshMd = fs.readFileSync(target, "utf8");
  const freshObj = extractJsonBlock(freshMd);
  freshObj.updated = new Date().toISOString().slice(0, 10);
  freshObj.pinned = pinned;
  freshObj.fallbacks = freshObj.fallbacks && typeof freshObj.fallbacks === "object" ? freshObj.fallbacks : {};
  freshObj.fallbacks.zdr = freshObj.zdr?.status === "on" ? "not-needed" : "triggered";
  // fallbacks.batch was already set by nebius-batch.mjs's poll/submit merge.

  if (!batchOutcome.terminal) {
    freshObj.status = "pending";
    fs.writeFileSync(target, replaceJsonBlock(freshMd, freshObj));
    console.error(
      `blocker: Batch API not terminal after ${BATCH_MAX_WAIT_MS / 60000} minutes (pending batch ids in ${dirs.spikes}/nebius-batches.json); plan not complete`,
    );
    process.exit(1);
  }

  const candidateFinal = { ...freshObj, status: "final" };
  const violations = validateRecord("nebius", candidateFinal, { requireFinal: true });
  if (violations.length > 0) {
    freshObj.status = "pending";
    fs.writeFileSync(target, replaceJsonBlock(freshMd, freshObj));
    console.error("record does not validate as final:\n" + violations.join("\n"));
    process.exit(1);
  }

  let finalMd = replaceJsonBlock(freshMd, candidateFinal);
  finalMd = finalMd.replace(
    "Status: pending. The 12-config matrix, escape probe, pinned model and the zdr fallback state are completed by plan 01-10; this plan records the catalogue, one real structured-output call, the ZDR/credits console facts and the Batch API submission.",
    "Status: final. Plan 01-10 completed the 12-config matrix, the escape probe, the D-15 pin and the 50-page streak.",
  );
  finalMd +=
    "\n- **Plan 01-10 (final):** D-15 pin rule applied to the 12-config matrix — " +
    (pinResult.qualified ? `${pinResult.label} qualified (>=0.95 schema-valid on >=${20} pages)` : "no config qualified >=0.95 on >=20 pages") +
    `; pinned \`${pinned.model}\`, output_mode \`${pinned.output_mode}\`, thinking \`${pinned.thinking}\`, mode \`${pinned.mode}\`, retry_rate ${pinned.retry_rate}. ` +
    `50-page streak: max_consecutive_valid ${streak.max_consecutive_valid} of ${streak.n}. ` +
    `Batch: final_status \`${candidateFinal.batch?.final_status}\`. Fallbacks: batch \`${candidateFinal.fallbacks?.batch}\`, zdr \`${candidateFinal.fallbacks?.zdr}\`.\n`;
  fs.writeFileSync(target, finalMd);

  log({
    record_written: RECORD_PATH,
    status: "final",
    pinned: { model: pinned.model, output_mode: pinned.output_mode, thinking: pinned.thinking, mode: pinned.mode },
    streak,
    batch_final_status: candidateFinal.batch?.final_status,
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
