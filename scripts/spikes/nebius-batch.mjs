#!/usr/bin/env node
// Nebius Batch API round trip, submitted first because the completion window
// may be up to 24h (FND-05, D-17, D-21, research Pitfall 5).
//
//   node --env-file=<private env file> scripts/spikes/nebius-batch.mjs submit
//   node --env-file=<private env file> scripts/spikes/nebius-batch.mjs poll
//
// submit: for each candidate model (Ultra, Super, Lightning, read from the
// catalogue already recorded by nebius-catalogue.mjs) builds a 10-line JSONL
// of synthetic chat requests (no page content), uploads it (purpose batch)
// and creates a batch with a 24h completion window. A rejection at either
// step is recorded as this model's measured result, not a script failure;
// the other candidates are still attempted. Per-model results (file id,
// batch id or a rejection's error class) go to PRISM_DATA_DIR/spikes/nebius-batches.json
// (private) and are merged into spikes/nebius.md (numbers, ids and statuses
// only; per D-21 an id is not raw text).
//
// poll: reads nebius-batches.json, retrieves the status of any batch still in
// flight, and on a terminal state downloads the output file and counts ok and
// error lines. Exit 0 when every batch is terminal (completed, failed,
// cancelled, expired) or was rejected at submission, exit 3 when at least one
// is still in flight, exit 2 on error.

import fs from "node:fs";
import path from "node:path";

import { extractJsonBlock, replaceJsonBlock } from "../lib/spike-record.mjs";
import { createClient } from "./lib/nebius.mjs";
import { spikeDirs } from "./lib/paths.mjs";

const RECORD_PATH = "spikes/nebius.md";
const BATCHES_FILE = "nebius-batches.json";
const KEY = process.env.NEBIUS_API_KEY ?? "";
const BASE_URL = process.env.NEBIUS_BASE_URL ?? "";
const TERMINAL_STATES = ["completed", "failed", "cancelled", "expired"];
const CANDIDATES = [
  ["ultra", /ultra/i],
  ["super", /super/i],
  ["lightning", /lightning/i],
];

function log(obj) {
  console.log(JSON.stringify(obj));
}

function requireEnv() {
  if (!KEY) {
    console.error("NEBIUS_API_KEY is not set (run with node --env-file=<private env file>)");
    process.exit(2);
  }
  if (!BASE_URL) {
    console.error("NEBIUS_BASE_URL is not set (run with node --env-file=<private env file>)");
    process.exit(2);
  }
}

function recordTarget(dirs) {
  return path.join(dirs.root, RECORD_PATH);
}

function loadCatalogue(dirs) {
  const target = recordTarget(dirs);
  if (!fs.existsSync(target)) throw new Error(`${RECORD_PATH} does not exist; run nebius-catalogue.mjs first`);
  const obj = extractJsonBlock(fs.readFileSync(target, "utf8"));
  if (!Array.isArray(obj.catalogue) || obj.catalogue.length === 0) {
    throw new Error(`${RECORD_PATH} has no catalogue; run nebius-catalogue.mjs first`);
  }
  return obj.catalogue;
}

/** Pick one model id per candidate label, deduped across hosts. */
function pickCandidates(catalogue) {
  const out = [];
  for (const [label, re] of CANDIDATES) {
    const entry = catalogue.find((e) => typeof e?.id === "string" && re.test(e.id));
    if (!entry) throw new Error(`no ${label} model found in the catalogue`);
    if (!out.some((o) => o.id === entry.id)) out.push({ label, id: entry.id });
  }
  return out;
}

function buildJsonl(model) {
  const lines = [];
  for (let i = 0; i < 10; i += 1) {
    lines.push(
      JSON.stringify({
        custom_id: `probe-${i}`,
        method: "POST",
        url: "/v1/chat/completions",
        body: {
          model,
          messages: [{ role: "user", content: `Reply with only the digit ${i} and nothing else.` }],
          max_tokens: 20,
          temperature: 0,
          chat_template_kwargs: { enable_thinking: false },
        },
      }),
    );
  }
  return lines.join("\n") + "\n";
}

function errorClassOf(httpStatus, json) {
  const detail =
    typeof json?.detail === "string" ? json.detail : typeof json?.error?.message === "string" ? json.error.message : null;
  let code = "unknown_error";
  if (httpStatus === 401) code = "unauthorized";
  else if (httpStatus === 403) code = "forbidden";
  else if (httpStatus === 404) code = "not_found";
  else if (httpStatus >= 500) code = "server_error";
  else if (httpStatus >= 400) code = "client_error";
  return { http_status: httpStatus, error_class: code, detail: detail ? detail.slice(0, 150) : null };
}

async function submitOne(client, dirs, candidate) {
  const jsonl = buildJsonl(candidate.id);
  fs.writeFileSync(path.join(dirs.spikes, `nebius-batch-${candidate.label}.jsonl`), jsonl, { mode: 0o600 });

  const form = new FormData();
  form.append("purpose", "batch");
  form.append("file", new Blob([jsonl], { type: "application/jsonl" }), `${candidate.label}.jsonl`);

  const fileRes = await client.request("/files", { method: "POST", body: form });
  if (fileRes.status !== 200 || !fileRes.json?.id) {
    log({ model: candidate.id, label: candidate.label, stage: "file_upload", result: "rejected", http_status: fileRes.status });
    return { model: candidate.id, label: candidate.label, status: "rejected", stage: "file_upload", ...errorClassOf(fileRes.status, fileRes.json) };
  }
  const fileId = fileRes.json.id;

  const batchRes = await client.request("/batches", {
    method: "POST",
    body: { input_file_id: fileId, endpoint: "/v1/chat/completions", completion_window: "24h" },
  });
  if (batchRes.status !== 200 || !batchRes.json?.id) {
    log({ model: candidate.id, label: candidate.label, stage: "batch_create", result: "rejected", http_status: batchRes.status });
    return {
      model: candidate.id,
      label: candidate.label,
      status: "rejected",
      stage: "batch_create",
      file_id: fileId,
      ...errorClassOf(batchRes.status, batchRes.json),
    };
  }
  log({ model: candidate.id, label: candidate.label, stage: "batch_create", result: "submitted", batch_id: batchRes.json.id });
  return {
    model: candidate.id,
    label: candidate.label,
    status: "submitted",
    stage: "batch_create",
    file_id: fileId,
    batch_id: batchRes.json.id,
    batch_status: batchRes.json.status ?? "validating",
    completion_window: batchRes.json.completion_window ?? "24h",
  };
}

function loadBatchesFile(dirs) {
  const p = path.join(dirs.spikes, BATCHES_FILE);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : { submitted_at: null, results: [] };
}

function saveBatchesFile(dirs, data) {
  fs.writeFileSync(path.join(dirs.spikes, BATCHES_FILE), JSON.stringify(data, null, 2), { mode: 0o600 });
}

/** Merge submit/poll results into spikes/nebius.md (numbers, ids and statuses only; D-21). */
function mergeRecord(dirs, { submittedAt, results }) {
  const target = recordTarget(dirs);
  const md = fs.readFileSync(target, "utf8");
  const obj = extractJsonBlock(md);
  obj.updated = new Date().toISOString().slice(0, 10);

  const perModel = {};
  let anyCompletedAt = null;
  for (const r of results) {
    const entry = { label: r.label, status: r.status, stage: r.stage };
    if (r.status === "rejected") {
      entry.http_status = r.http_status;
      entry.error_class = r.error_class;
      if (r.detail) entry.detail = r.detail;
    } else {
      entry.file_id = r.file_id;
      entry.batch_id = r.batch_id;
      entry.batch_status = r.batch_status;
      entry.completion_window = r.completion_window;
      if (r.output_ok !== undefined) entry.output_ok = r.output_ok;
      if (r.output_error !== undefined) entry.output_error = r.output_error;
      if (r.completed_at) {
        entry.completed_at = r.completed_at;
        anyCompletedAt = anyCompletedAt ?? r.completed_at;
      }
    }
    perModel[r.model] = entry;
  }

  const allRejected = results.length > 0 && results.every((r) => r.status === "rejected");
  const allTerminal =
    results.length > 0 && results.every((r) => r.status === "rejected" || TERMINAL_STATES.includes(r.batch_status));

  const existingBatch = obj.batch && typeof obj.batch === "object" ? obj.batch : {};
  obj.batch = {
    submitted_at: submittedAt ?? existingBatch.submitted_at ?? null,
    completed_at: anyCompletedAt ?? existingBatch.completed_at ?? null,
    final_status: allRejected ? "rejected" : allTerminal ? "completed" : existingBatch.final_status ?? null,
    per_model: perModel,
    price_ratio: existingBatch.price_ratio ?? null,
  };
  obj.fallbacks = obj.fallbacks && typeof obj.fallbacks === "object" ? obj.fallbacks : {};
  // D-17: every candidate rejected means the Batch API is unusable; real-time + p-limit applies.
  obj.fallbacks.batch = allRejected ? "triggered" : "not-needed";

  fs.writeFileSync(target, replaceJsonBlock(md, obj));
  return { allRejected, allTerminal };
}

async function cmdSubmit(dirs) {
  const catalogue = loadCatalogue(dirs);
  const candidates = pickCandidates(catalogue);
  const client = createClient({ baseUrl: BASE_URL, apiKey: KEY });
  const submittedAt = new Date().toISOString();

  const results = [];
  for (const c of candidates) {
    results.push(await submitOne(client, dirs, c));
  }

  saveBatchesFile(dirs, { submitted_at: submittedAt, results });
  const { allRejected } = mergeRecord(dirs, { submittedAt, results });

  log({
    record_written: RECORD_PATH,
    submitted_at: submittedAt,
    candidates: results.map((r) => ({ model: r.model, label: r.label, status: r.status })),
    all_rejected: allRejected,
    fallback_batch: allRejected ? "triggered" : "not-needed",
  });
}

async function pollOne(client, dirs, r) {
  if (r.status === "rejected") return r; // already terminal, nothing to poll
  const res = await client.request(`/batches/${r.batch_id}`);
  if (res.status !== 200 || !res.json) {
    console.error(`poll: batch ${r.batch_id} (${r.label}) returned status ${res.status}`);
    return r;
  }
  const batchStatus = res.json.status ?? r.batch_status;
  const next = { ...r, batch_status: batchStatus };
  log({ label: r.label, model: r.model, batch_id: r.batch_id, batch_status: batchStatus });

  if (TERMINAL_STATES.includes(batchStatus)) {
    next.completed_at = new Date().toISOString();
    if (res.json.output_file_id) {
      const outRes = await client.request(`/files/${res.json.output_file_id}/content`);
      const lines = (outRes.text ?? "").split("\n").filter((l) => l.trim().length > 0);
      let ok = 0;
      let errorCount = 0;
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.error || parsed.response?.status_code >= 400) errorCount += 1;
          else ok += 1;
        } catch {
          errorCount += 1;
        }
      }
      next.output_ok = ok;
      next.output_error = errorCount;
      fs.writeFileSync(path.join(dirs.spikes, `nebius-batch-${r.label}-output.jsonl`), outRes.text ?? "", { mode: 0o600 });
    }
  }
  return next;
}

async function cmdPoll(dirs) {
  const data = loadBatchesFile(dirs);
  if (!data.results || data.results.length === 0) {
    console.error("no nebius-batches.json results found; run submit first");
    process.exit(2);
  }
  const client = createClient({ baseUrl: BASE_URL, apiKey: KEY });

  const updated = [];
  for (const r of data.results) updated.push(await pollOne(client, dirs, r));

  data.results = updated;
  saveBatchesFile(dirs, data);
  const { allTerminal } = mergeRecord(dirs, { submittedAt: data.submitted_at, results: updated });

  log({
    record_written: RECORD_PATH,
    all_terminal: allTerminal,
    statuses: updated.map((r) => ({ model: r.model, label: r.label, status: r.status, batch_status: r.batch_status ?? null })),
  });
  process.exit(allTerminal ? 0 : 3);
}

async function main() {
  requireEnv();
  const dirs = spikeDirs(); // assertOutsideRepo runs here, before anything is written
  const cmd = process.argv[2];
  if (cmd === "submit") {
    await cmdSubmit(dirs);
  } else if (cmd === "poll") {
    await cmdPoll(dirs);
  } else {
    console.error("usage: nebius-batch.mjs <submit|poll>");
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
