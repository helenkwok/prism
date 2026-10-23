// Executes exactly one approved stage; full confirmation requires the paired spike review.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDataDir, getDb } from "../../app/server/db.ts";
import { loadCodebook } from "../coding/codebook-prompt.ts";
import { buildContract, loadGateFile, resolveGatesPath } from "../coding/contract.ts";
import { createClient, PINNED_BASE_URL, PINNED_MODEL } from "../coding/nebius-client.ts";
import { CACHED_PRICES, estimateCostUsd, measuredCostUsd, type UsageObservation } from "../coding/spend-guards.ts";
import { readKey } from "../run.ts";
import { A9_ITEMS, a9Section, assertA9Signed } from "../signoff/a9.ts";
import { A10_ITEMS, a10Section, assertA10Signed } from "../signoff/a10.ts";
import { assertA8Signed } from "../signoff/a8.ts";
import { SIGNOFF_MODEL, signOff } from "../signoff/signoff.ts";
import { GOLD_SEED, SECOND_MODEL_SEED } from "../select/draw-sample.ts";
import { sortPilotCandidates } from "../select/pilot-draw.ts";
import { openApprovedBudget, type ApprovedStage } from "./approved-budget.ts";
import { runApprovedStage } from "./approved-stages.ts";
import { runApprovedConfirmation, validateSpikeReview } from "./approved-confirm.ts";
import { measurePromptSizes } from "./prompt-size.ts";
import { ollamaClient, formatOllamaSummary, type RoleSpec } from "./providers.ts";

export function summarizeCacheUsage(observations: UsageObservation[]) {
  const groups = new Map<string, UsageObservation[]>();
  for (const row of observations) {
    const key = `${row.provider}:${row.model}:${row.prefixDigest}`;
    const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
  }
  return [...groups.values()].map(rows => ({
    provider: rows[0].provider, model: rows[0].model, prefixDigest: rows[0].prefixDigest,
    requests: rows.length, repeatedPrefixRequests: Math.max(0, rows.length - 1),
    inputTokens: rows.reduce((n, r) => n + (r.inputTokens ?? 0), 0),
    outputTokens: rows.reduce((n, r) => n + (r.outputTokens ?? 0), 0),
    cacheMetadataRequests: rows.filter(r => r.cachedInputTokens !== null).length,
    cachedInputTokens: rows.some(r => r.cachedInputTokens !== null) ? rows.reduce((n, r) => n + (r.cachedInputTokens ?? 0), 0) : null,
    firstCachedTokens: rows[0].cachedInputTokens,
    laterCacheHitRequests: rows.slice(1).filter(r => (r.cachedInputTokens ?? 0) > 0).length,
    listPriceUsd: rows.reduce((n, r) => n + (r.measured ? estimateCostUsd(r.model, r.inputTokens!, r.outputTokens!) : r.chargedUsd), 0),
    chargedUsd: rows.reduce((n, r) => n + r.chargedUsd, 0),
    publishedPriceUsd: rows.reduce((n, r) => n + (r.measured ? measuredCostUsd(r.model, r.inputTokens!, r.outputTokens!, r.cachedInputTokens) : r.chargedUsd), 0),
    cachedInputPricePerMillion: CACHED_PRICES[rows[0].model.replace(/:cloud$/, "")] !== undefined ? CACHED_PRICES[rows[0].model.replace(/:cloud$/, "")] * 1e6 : null,
    pricingSource: rows[0].provider === "ollama" ? "https://ollama.com/pricing" : "https://tokenfactory.nebius.com/api/public/models_info",
    billingBasis: "Published cache rates apply only to returned cache counts. Ledger retains earlier conservative charges; publishedPriceUsd reprices measured usage, not an invoice.",
  }));
}

export function validateSecondCoderEnvelopeReport(report: any): boolean {
  const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
  return !!report && report.version === 1 && report.stage === "second-coder" && report.model === "nemotron-3-super:cloud" && report.strictValidation === true && report.complete === true &&
    typeof report.validationScope === "string" && report.validationScope.length > 0 &&
    [report.total, report.valid, report.failed, report.envelopeCount, report.envelopeValid, report.envelopeFailed].every(count) &&
    report.total > 0 && report.valid + report.failed === report.total && report.envelopeCount <= report.total &&
    report.envelopeValid + report.envelopeFailed === report.envelopeCount && report.envelopeValid <= report.valid && report.envelopeFailed <= report.failed;
}

export async function runApproved(stage: ApprovedStage, options: { splitNemotronThinking?: boolean } = {}) {
  if (!["signoff", "recode", "gold", "second-coder", "spike", "full-confirm"].includes(stage)) throw new Error("explicit approved stage required");
  const dataDir = resolveDataDir();
  const validation = path.join(dataDir, "validation");
  let fullSetting: boolean | undefined;
  if (stage === "full-confirm") {
    const reviewPath = path.join(validation, "confirmation-spike-review.json");
    const spikePath = path.join(validation, "confirmation-spike.json");
    if (!fs.existsSync(reviewPath) || !fs.existsSync(spikePath)) throw new Error("full confirmation is held until the paired spike decisions are reported and reviewed");
    const review = JSON.parse(fs.readFileSync(reviewPath, "utf8"));
    validateSpikeReview(review, fs.readFileSync(spikePath, "utf8"), { model: "nemotron-3-ultra:cloud", reasoning: review.selectedSetting });
    fullSetting = review.selectedSetting;
  }
  fs.mkdirSync(validation, { recursive: true, mode: 0o700 });
  const log = (line: string) => {
    fs.appendFileSync(path.join(validation, `approved-${stage}.log`), line + "\n", { mode: 0o600 });
    console.log(line);
  };
  const protocol = fs.readFileSync("protocol/PROTOCOL.md", "utf8");
  const protocolPath = path.resolve("protocol/PROTOCOL.md");
  const signoffPath = path.join(dataDir, "decisions", "signoff.jsonl");
  const splitNemotronThinking = stage === "second-coder" && options.splitNemotronThinking !== false;
  if (stage !== "signoff") {
    assertA8Signed({ protocolPath, signoffPath });
    assertA9Signed({ protocolPath, signoffPath });
    assertA10Signed({ protocolPath, signoffPath });
    if (splitNemotronThinking) {
      const offlinePath = path.join(validation, "second-coder-envelope-offline.json");
      if (!fs.existsSync(offlinePath) || !validateSecondCoderEnvelopeReport(JSON.parse(fs.readFileSync(offlinePath, "utf8")))) throw new Error("second-coder envelope separation requires a complete strict offline validation report");
    }
    const preflight = measurePromptSizes({ dataDir });
    log(`PROMPT_SIZE: ${JSON.stringify(preflight)}`);
    if (preflight.projects !== 300 || preflight.refused || !preflight.n) throw new Error("prompt preflight refused");
    fs.writeFileSync(path.join(validation, "prompt-size-pre-recode.json"), JSON.stringify(preflight, null, 2) + "\n", { mode: 0o600 });
  }
  const opened = openApprovedBudget(dataDir, stage);
  const usageFile = path.join(validation, "approved-usage.jsonl");
  let observations = 0;
  const onUsage = (row: UsageObservation) => {
    fs.appendFileSync(usageFile, JSON.stringify({ ...row, at: new Date().toISOString() }) + "\n", { mode: 0o600 });
    observations++;
    if (observations % 20 === 0) log(opened.budget.budgetLine());
  };
  let db: ReturnType<typeof getDb> | undefined;
  try {
    log(opened.budget.budgetLine());
    let client;
    let role: RoleSpec;
    if (stage === "recode" || stage === "signoff") {
      const key = readKey("NEBIUS_API_KEY", "nebius.key", {});
      if (!key) throw new Error("primary-host credential unavailable");
      client = createClient({ baseUrl: PINNED_BASE_URL, apiKey: key, budget: opened.budget, concurrency: 1, maxRetries: 1, onUsage, stage });
      role = { provider: "token-factory", model: stage === "signoff" ? SIGNOFF_MODEL : PINNED_MODEL, reasoning: false };
    } else {
      role = { provider: "ollama", model: stage === "gold" ? "glm-5.3-flash:cloud" : stage === "second-coder" ? "nemotron-3-super:cloud" : "nemotron-3-ultra:cloud", reasoning: stage === "gold" ? "low" : stage === "full-confirm" ? fullSetting! : false };
      client = ollamaClient({ budget: opened.budget, concurrency: 2, maxRetries: 1, onUsage, stage,
        splitNemotronThinking,
        onThinkingEnvelope: splitNemotronThinking ? audit => {
          const auditPath = path.join(validation, "thinking-envelope-audit.jsonl");
          let parsedResult: unknown = null;
          let jsonParseValid = false;
          try { parsedResult = JSON.parse(audit.content); jsonParseValid = true; } catch {}
          fs.appendFileSync(auditPath, JSON.stringify({ ...audit, parsedResult, jsonParseValid, stage, at: new Date().toISOString() }) + "\n", { mode: 0o600 });
          fs.chmodSync(auditPath, 0o600);
        } : undefined,
      });
    }
    if (stage === "signoff") {
      const records = fs.existsSync(signoffPath) ? fs.readFileSync(signoffPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
      const { createHash } = await import("node:crypto");
      fs.mkdirSync(path.dirname(signoffPath), { recursive: true, mode: 0o700 });
      let success = 0;
      for (const [proposal, items, doc] of [[a9Section(protocol), A9_ITEMS, "A9"], [a10Section(protocol), A10_ITEMS, "A10"]] as const) {
      if (!proposal) throw new Error(`${doc} proposal missing`);
      const context = protocol.slice(0, protocol.indexOf(proposal));
      const digest = createHash("sha256").update(proposal).digest("hex");
      for (const item of items) {
        const existing = records.filter(r => r.item === item && r.docDigest === digest);
        if (existing.some(r => r.decision === "rejected")) throw new Error("A9 has an existing rejection for this digest");
        if (!existing.some(r => r.decision === "approved")) {
          const record = { doc, ...(await signOff(client, proposal, context, item)) };
          fs.appendFileSync(signoffPath, JSON.stringify(record) + "\n", { mode: 0o600 });
          log(`SIGNOFF: ${JSON.stringify({ item, decision: record.decision, digest: record.docDigest })}`);
          if (record.decision !== "approved") throw new Error("A9 signoff rejected; review the private decision record");
        }
        success++;
      }
      }
      assertA9Signed({ protocolPath, signoffPath });
      assertA10Signed({ protocolPath, signoffPath });
      const total = A9_ITEMS.length + A10_ITEMS.length;
      log(`ACCOUNTING: ${JSON.stringify({ stage, total, success, ok: success === total, complete: true })}`);
    } else {
      const entries = JSON.parse(fs.readFileSync(path.join(dataDir, "pipeline", "sample-projects.json"), "utf8"));
      const subsets = JSON.parse(fs.readFileSync(path.join(dataDir, "pipeline", "sample-subsets.json"), "utf8"));
      const secondIds = new Set(subsets.secondModel.map(String));
      let selected = stage === "second-coder" ? entries.filter((e: { hn_id: string }) => secondIds.has(String(e.hn_id))) : entries;
      if (stage === "gold" || stage === "second-coder") selected = sortPilotCandidates(selected.map((e: { hn_id: string }) => ({ ...e, id: String(e.hn_id) })), stage === "gold" ? GOLD_SEED : SECOND_MODEL_SEED);
      if (entries.length !== 300 || (stage === "second-coder" && selected.length !== 100)) throw new Error("approved sample size mismatch");
      const gateFile = loadGateFile(resolveGatesPath());
      db = getDb();
      const accounting = stage === "full-confirm"
        ? await runApprovedConfirmation({ db, dataDir, client, codebook: loadCodebook(), model: role.model, reasoning: fullSetting!, entries: selected, goldOrder: sortPilotCandidates(entries.map((e: { hn_id: string }) => ({ ...e, id: String(e.hn_id) })), GOLD_SEED).map(e => e.id), log })
        : await runApprovedStage({ stage, concurrency: stage === "recode" ? 1 : 2, dataDir, db, entries: selected, codebook: loadCodebook(), contract: buildContract(gateFile.checkIds), gateFile, client, role, log });
      if (!accounting.ok) throw new Error(`stage incomplete: ${accounting.reason ?? accounting.failed}`);
    }
    if ("counters" in client) log(formatOllamaSummary(client.counters));
  } catch (error) {
    log(`STOP: ${JSON.stringify({ stage, error: (error as Error).name, reason: (error as Error).message })}`);
    log(`ACCOUNTING: ${JSON.stringify({ stage, ok: false, complete: false, reason: (error as Error).message })}`);
    process.exitCode = 1;
  } finally {
    try {
    log(opened.budget.budgetLine());
    log(`HOST_BUDGET: ${JSON.stringify({ host: opened.host, ...opened.parent.snapshot() })}`);
    const rows: UsageObservation[] = fs.existsSync(usageFile) ? fs.readFileSync(usageFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    const summary = summarizeCacheUsage(rows);
    fs.writeFileSync(path.join(validation, "cache-pricing.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
    for (const row of summary) log(`CACHE: ${JSON.stringify(row)}`);
    } finally {
      opened.release();
      if (db) await db.destroy();
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stage = process.argv[2];
  if (!["signoff", "recode", "gold", "second-coder", "spike", "full-confirm"].includes(stage)) throw new Error("explicit approved stage required");
  await runApproved(stage as ApprovedStage);
}
