#!/usr/bin/env node
// The 12-config schema-valid-rate matrix (FND-05, D-15, COD-01, D-21).
//
//   node --env-file=<private env file> scripts/spikes/nebius-matrix.mjs \
//     [--configs 1|all] [--pages <n>] [--gates <path>]
//
// For each config (model in {Ultra, Super, Lightning} x output_mode in
// {json_schema, json_object} x thinking in {on, off}) the same N real pages
// (the first N pages of the deterministic corpus order, plan 01-06's corpus)
// are segmented into spans, sent with the {checks:[{checkId,proposedState,
// spanIds}]} contract in the prompt AND in response_format, parsed, zod- and
// span-checked (scripts/spikes/lib/contract.mjs's single isSchemaValid
// definition), retried once on an invalid reply, and aggregated into one
// matrix row. `--configs 1` runs a single fixed config (Lightning,
// json_schema, thinking off) for the tracer. A config the API rejects
// outright (detected on its first page) is recorded `status: "unsupported"`
// with the error class, not omitted or silently skipped.
//
// Raw replies are persisted under PRISM_DATA_DIR/spikes/nebius-runs (D-21);
// spikes/nebius.md carries only the aggregated numbers.

import fs from "node:fs";
import path from "node:path";

import { extractJsonBlock, replaceJsonBlock } from "../lib/spike-record.mjs";
import { pickCandidateModels } from "./lib/candidates.mjs";
import { buildContract, isSchemaValid, loadGateFile, resolveGatesPath } from "./lib/contract.mjs";
import { buildChatBody, createClient } from "./lib/nebius.mjs";
import { spikeDirs } from "./lib/paths.mjs";
import { capPage, loadPageCorpus } from "./lib/pages.mjs";
import { segmentPage } from "./lib/segment.mjs";

const RECORD_PATH = "spikes/nebius.md";
const KEY = process.env.NEBIUS_API_KEY ?? "";
const BASE_URL = process.env.NEBIUS_BASE_URL ?? "";
const MAX_TOKENS = 4096;
const BUDGET_USD = 10;
const UNSUPPORTED_RE = /thinking|chat_template_kwargs|response_format|json_schema|unsupported|not[_ ]?support/i;

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

function parseArgs(argv) {
  const out = { configs: "1", pages: 3, gates: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--configs" && argv[i + 1]) out.configs = argv[++i];
    else if (argv[i] === "--pages" && argv[i + 1]) out.pages = Number(argv[++i]);
    else if (argv[i] === "--gates" && argv[i + 1]) out.gates = argv[++i];
  }
  return out;
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

function priceOf(catalogue, modelId) {
  const entry = catalogue.find((e) => e.id === modelId);
  const p = entry?.pricing ?? {};
  return { prompt: Number(p.prompt ?? 0), completion: Number(p.completion ?? 0) };
}

function buildConfigList(candidates, configsArg) {
  if (configsArg === "1") {
    const lightning = candidates.find((c) => c.label === "lightning");
    if (!lightning) throw new Error("no lightning candidate found for the tracer config");
    return [{ model: lightning.id, label: lightning.label, mode: "json_schema", thinking: false }];
  }
  const all = [];
  for (const c of candidates) {
    for (const mode of ["json_schema", "json_object"]) {
      for (const thinking of [false, true]) {
        all.push({ model: c.id, label: c.label, mode, thinking });
      }
    }
  }
  return all;
}

/** Worst-case cost: max_tokens output on every attempt, one retry on every page. */
function projectWorstCaseCost(configs, catalogue, pages) {
  let total = 0;
  for (const cfg of configs) {
    const price = priceOf(catalogue, cfg.model);
    const perCallWorst = 6000 * price.prompt + MAX_TOKENS * price.completion;
    total += perCallWorst * pages * 2; // 2 = first attempt + one retry, worst case
  }
  return total;
}

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

function schema(jsonSchema) {
  return { name: "gate_checks", schema: jsonSchema, strict: true };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function round(n, places) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** One chat call for one page + config. Returns { status, content, usage, finishReason, latencyMs, json }. */
async function callOnce(client, cfg, jsonSchema, checkIds, checkLabels, spans) {
  const body = buildChatBody({
    model: cfg.model,
    messages: buildCodingPrompt(checkIds, checkLabels, jsonSchema, spans),
    mode: cfg.mode,
    schema: cfg.mode === "json_schema" ? schema(jsonSchema) : undefined,
    thinking: cfg.thinking,
    maxTokens: MAX_TOKENS,
  });
  const res = await client.request("/chat/completions", { method: "POST", body });
  const choice = res.json?.choices?.[0];
  return {
    status: res.status,
    json: res.json,
    content: choice?.message?.content ?? "",
    finishReason: choice?.finish_reason ?? null,
    usage: res.json?.usage ?? null,
    latencyMs: res.latencyMs,
  };
}

function detectUnsupported(res) {
  if (res.status === 200) return null;
  const detail =
    typeof res.json?.detail === "string" ? res.json.detail : typeof res.json?.error?.message === "string" ? res.json.error.message : "";
  if (UNSUPPORTED_RE.test(detail)) {
    return { http_status: res.status, error_class: "unsupported_parameter", detail: detail.slice(0, 150) };
  }
  return null;
}

async function runConfig(client, dirs, cfg, contract, gate, pages, catalogue) {
  const price = priceOf(catalogue, cfg.model);
  const runsLog = [];
  const tally = {
    n: 0,
    jsonParseOk: 0,
    zodOk: 0,
    spanOk: 0,
    schemaValidOk: 0,
    retries: 0,
    finishReasons: {},
    latencies: [],
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
  };

  function record(res) {
    if (res.usage) {
      tally.tokensIn += res.usage.prompt_tokens ?? 0;
      tally.tokensOut += res.usage.completion_tokens ?? 0;
      tally.costUsd += (res.usage.prompt_tokens ?? 0) * price.prompt + (res.usage.completion_tokens ?? 0) * price.completion;
    }
  }

  async function processPage(page, prefetched) {
    const { text: capped, truncated } = capPage(page.text);
    const spans = segmentPage(capped);
    const spanIds = spans.map((s) => s.id);

    let attempt = prefetched;
    if (!attempt) {
      attempt = await callOnce(client, cfg, contract.jsonSchema, contract.checkIds, gate.checkLabels, spans);
      record(attempt);
    }
    let evalResult = isSchemaValid(attempt.content, spanIds, contract.zodSchema);
    let usedRetry = false;

    if (!evalResult.valid) {
      usedRetry = true;
      const retryAttempt = await callOnce(client, cfg, contract.jsonSchema, contract.checkIds, gate.checkLabels, spans);
      record(retryAttempt);
      evalResult = isSchemaValid(retryAttempt.content, spanIds, contract.zodSchema);
      attempt = retryAttempt;
    }

    runsLog.push({
      page_id: page.id,
      truncated,
      spans: spanIds.length,
      retried: usedRetry,
      valid: evalResult.valid,
      stage: evalResult.stage,
      finish_reason: attempt.finishReason,
      status: attempt.status,
      latency_ms: attempt.latencyMs,
      content: attempt.content,
    });

    return { evalResult, usedRetry, finishReason: attempt.finishReason, latencyMs: attempt.latencyMs };
  }

  // Probe the first page alone: a hard API rejection here marks the whole
  // config unsupported without spending the rest of the page budget on it.
  const firstSpans = segmentPage(capPage(pages[0].text).text);
  const probeRaw = await callOnce(client, cfg, contract.jsonSchema, contract.checkIds, gate.checkLabels, firstSpans);
  const unsupported = detectUnsupported(probeRaw);
  if (unsupported) {
    fs.writeFileSync(
      path.join(dirs.spikes, "nebius-runs", `matrix-${cfg.label}-${cfg.mode}-${cfg.thinking ? "on" : "off"}.json`),
      JSON.stringify({ unsupported, probe: probeRaw }, null, 2),
      { mode: 0o600 },
    );
    return {
      model: cfg.model,
      output_mode: cfg.mode,
      thinking: cfg.thinking ? "on" : "off",
      n: 0,
      json_parse_rate: null,
      zod_valid_rate: null,
      span_resolve_rate: null,
      schema_valid_rate: null,
      retry_rate: null,
      finish_reasons: {},
      latency_ms: { p50: 0, p95: 0 },
      tokens: { in: 0, out: 0 },
      cost_usd: 0,
      status: "unsupported",
      error_class: unsupported.error_class,
      http_status: unsupported.http_status,
    };
  }
  record(probeRaw); // the probe call counts as page[0]'s first attempt

  const firstResult = await processPage(pages[0], probeRaw);
  const results = [firstResult];
  if (pages.length > 1) {
    const rest = await Promise.all(pages.slice(1).map((page) => processPage(page)));
    results.push(...rest);
  }

  for (const r of results) {
    tally.n += 1;
    if (r.evalResult.stage !== "json_parse") tally.jsonParseOk += 1;
    if (r.evalResult.stage === "span_resolve" || r.evalResult.valid) tally.zodOk += 1;
    if (r.evalResult.valid) {
      tally.spanOk += 1;
      tally.schemaValidOk += 1;
    }
    if (r.usedRetry) tally.retries += 1;
    tally.finishReasons[r.finishReason ?? "null"] = (tally.finishReasons[r.finishReason ?? "null"] ?? 0) + 1;
    tally.latencies.push(r.latencyMs);
  }

  fs.writeFileSync(
    path.join(dirs.spikes, "nebius-runs", `matrix-${cfg.label}-${cfg.mode}-${cfg.thinking ? "on" : "off"}.json`),
    JSON.stringify({ config: cfg, runs: runsLog }, null, 2),
    { mode: 0o600 },
  );

  const sortedLatencies = [...tally.latencies].sort((a, b) => a - b);
  const rate = (x) => (tally.n === 0 ? null : round(x / tally.n, 4));

  return {
    model: cfg.model,
    output_mode: cfg.mode,
    thinking: cfg.thinking ? "on" : "off",
    n: tally.n,
    json_parse_rate: rate(tally.jsonParseOk),
    zod_valid_rate: rate(tally.zodOk),
    span_resolve_rate: rate(tally.spanOk),
    schema_valid_rate: rate(tally.schemaValidOk),
    retry_rate: rate(tally.retries),
    finish_reasons: tally.finishReasons,
    latency_ms: { p50: percentile(sortedLatencies, 0.5), p95: percentile(sortedLatencies, 0.95) },
    tokens: { in: tally.tokensIn, out: tally.tokensOut },
    cost_usd: round(tally.costUsd, 6),
    status: "measured",
  };
}

function mergeMatrix(existing, entries, replaceWhole) {
  if (replaceWhole) return entries;
  const out = Array.isArray(existing) ? [...existing] : [];
  for (const entry of entries) {
    const key = (e) => `${e.model}|${e.output_mode}|${e.thinking}`;
    const idx = out.findIndex((e) => key(e) === key(entry));
    if (idx >= 0) out[idx] = entry;
    else out.push(entry);
  }
  return out;
}

async function main() {
  requireEnv();
  const args = parseArgs(process.argv.slice(2));
  const dirs = spikeDirs(); // assertOutsideRepo runs here, before anything is written
  fs.mkdirSync(path.join(dirs.spikes, "nebius-runs"), { recursive: true, mode: 0o700 });

  const gatesPath = resolveGatesPath(args.gates, dirs.root);
  const gate = loadGateFile(gatesPath);
  if (gate.checkIds.length !== 24) {
    console.error(`gate file at ${gatesPath} yielded ${gate.checkIds.length} check ids, expected exactly 24`);
    process.exit(1);
  }
  const contract = buildContract(gate.checkIds);

  const catalogue = loadCatalogue(dirs);
  const candidates = pickCandidateModels(catalogue);
  const configs = buildConfigList(candidates, args.configs);

  const pages = loadPageCorpus(dirs).slice(0, args.pages);
  if (pages.length < args.pages) {
    console.error(`corpus has only ${pages.length} pages, requested ${args.pages}`);
    process.exit(1);
  }

  if (args.configs === "all") {
    const worst = projectWorstCaseCost(configs, catalogue, pages.length);
    if (worst > BUDGET_USD) {
      console.error(`projected worst-case spend $${worst.toFixed(2)} exceeds the $${BUDGET_USD} budget; not running`);
      process.exit(1);
    }
    log({ projected_worst_case_usd: round(worst, 4), budget_usd: BUDGET_USD });
  }

  const client = createClient({ baseUrl: BASE_URL, apiKey: KEY, concurrency: 4 });

  const entries = [];
  for (const cfg of configs) {
    const entry = await runConfig(client, dirs, cfg, contract, gate, pages, catalogue);
    log({
      model: entry.model,
      output_mode: entry.output_mode,
      thinking: entry.thinking,
      n: entry.n,
      schema_valid_rate: entry.schema_valid_rate,
      status: entry.status,
    });
    entries.push(entry);
  }

  const target = recordTarget(dirs);
  const md = fs.readFileSync(target, "utf8");
  const obj = extractJsonBlock(md);
  obj.updated = new Date().toISOString().slice(0, 10);
  const relGate = path.relative(dirs.root, gatesPath);
  obj.gate_file = { path: relGate.startsWith("..") ? gatesPath : relGate, sha256: gate.sha256, check_ids_count: gate.checkIds.length };
  obj.matrix = mergeMatrix(obj.matrix, entries, args.configs === "all");
  fs.writeFileSync(target, replaceJsonBlock(md, obj));

  const totalCost = (Array.isArray(obj.matrix) ? obj.matrix : []).reduce((s, e) => s + (e.cost_usd ?? 0), 0);
  log({
    record_written: RECORD_PATH,
    configs_run: entries.length,
    matrix_entries: Array.isArray(obj.matrix) ? obj.matrix.length : 0,
    total_recorded_cost_usd: round(totalCost, 4),
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
