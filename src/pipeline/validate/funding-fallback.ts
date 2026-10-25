// A funding stop is a registered publication action, never a fabricated validation result.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
const fail = (reason: string): never => { throw new Error(`funding fallback: ${reason}`); };
const amount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const equalScope = (a: any, b: any[]): boolean => Array.isArray(a) && a.length === b.length && new Set(a).size === a.length && a.every(v => b.includes(v));
export type FundingFallbackOptions = { policyPath: string; decisionPath: string };

function availableFromLedger(ledger: any): { tokenFactory: number; ollama: number } {
  const snapshot = ledger?.snapshot;
  if (ledger?.version !== 1 || !snapshot?.tokenFactory || !snapshot?.ollama || ledger.snapshotDigest !== sha(JSON.stringify(snapshot)) ||
      snapshot.tokenFactory.reserveUsd !== 1 || snapshot.ollama.reserveUsd !== .5 || !amount(snapshot.tokenFactory.remainingUsd) ||
      !amount(snapshot.ollama.remainingIncludedUsd) || snapshot.tokenFactory.remainingUsd < 1 || snapshot.ollama.remainingIncludedUsd < .5) fail("invalid frozen budget snapshot or reserves");
  for (const balance of [snapshot.tokenFactory, snapshot.ollama]) {
    if (!["verified-console", "verified-api", "user-verified-balance"].includes(balance.source) || !Number.isFinite(Date.parse(balance.observedAt))) fail("unverified budget balance");
  }
  if (!ledger.stages || typeof ledger.stages !== "object" || Array.isArray(ledger.stages)) fail("invalid budget stages");
  const caps = { "token-factory": snapshot.tokenFactory.remainingUsd - 1, ollama: snapshot.ollama.remainingIncludedUsd - .5 };
  const used = { "token-factory": 0, ollama: 0 };
  for (const stage of Object.values(ledger.stages) as any[]) {
    if (!stage || !["token-factory", "ollama"].includes(stage.host) || ![stage.cap, stage.spent, stage.reserved, stage.estimated].every(amount)) fail("invalid stage budget evidence");
    const host = stage.host as keyof typeof caps;
    if (stage.cap <= 0 || stage.cap > caps[host] + 1e-12 || stage.spent + stage.reserved > stage.cap + 1e-12) fail("stage exceeds funding bounds");
    used[host] += stage.spent + stage.reserved;
  }
  if (used["token-factory"] > caps["token-factory"] + 1e-12 || used.ollama > caps.ollama + 1e-12) fail("budget erodes a protected reserve");
  return { tokenFactory: Math.max(0, caps["token-factory"] - used["token-factory"]), ollama: Math.max(0, caps.ollama - used.ollama) };
}

/** Reads only explicitly named policy, decision and its hash-pinned financial evidence. */
export function loadFundingFallback(options: FundingFallbackOptions, dataDir: string, sampleNs: number[], checkIds: string[], actions: { checkId: string; action: string; applied?: boolean; basis?: string }[]) {
  const root = fs.realpathSync(path.join(dataDir, "validation"));
  const read = (file: unknown): { text: string; value: any } => {
    if (typeof file !== "string" || !file || path.extname(file) !== ".json") return fail("evidence must name a JSON document");
    const resolved = fs.realpathSync(path.resolve(root, file));
    if (path.dirname(resolved) !== root || fs.lstatSync(path.resolve(root, file)).isSymbolicLink()) fail("evidence escapes current validation directory");
    const text = fs.readFileSync(resolved, "utf8");
    return { text, value: JSON.parse(text) };
  };
  const policy = read(options.policyPath), decision = read(options.decisionPath);
  const p = policy.value, d = decision.value;
  if (p?.version !== 1 || p.source !== "standing-user-directive" || p.existingBalancesOnly !== true || p.topUpAllowed !== false ||
      p.tokenFactoryReserveUsd !== 1 || p.ollamaReserveUsd !== .5 || p.noSpendAction !== "withhold") fail("policy differs from the standing funding directive");
  if (d?.version !== 1 || d.policyDigest !== sha(policy.text) || !equalScope(d.sampleNs, sampleNs) || !Array.isArray(d.checkIds) || !d.checkIds.length ||
      new Set(d.checkIds).size !== d.checkIds.length || d.checkIds.some((id: unknown) => typeof id !== "string" || !checkIds.includes(id)) ||
      !["fresh-validation", "apply-correction", "confirmation"].includes(d.step) || d.reason !== "projection-exceeds-envelope" || !digest(d.budgetEvidenceDigest)) fail("invalid decision binding, scope or step");
  const evidence = read(d.budgetEvidencePath);
  if (sha(evidence.text) !== d.budgetEvidenceDigest) fail("budget evidence digest mismatch");
  const available = availableFromLedger(evidence.value);
  for (const values of [d.projectionUsd, d.availableUsd]) {
    if (!values || typeof values !== "object" || Array.isArray(values) || Object.keys(values).length !== 2 ||
        !Object.hasOwn(values, "tokenFactory") || !Object.hasOwn(values, "ollama")) fail("unknown or missing funding host");
  }
  for (const host of ["tokenFactory", "ollama"] as const) {
    if (!amount(d.projectionUsd?.[host]) || !amount(d.availableUsd?.[host]) || Math.abs(d.availableUsd[host] - available[host]) > 1e-12) fail("projected or available funding is invalid");
  }
  if (d.projectionUsd.tokenFactory <= available.tokenFactory && d.projectionUsd.ollama <= available.ollama) fail("projection does not exceed either host envelope");
  const fundingActions = actions.filter(a => a.basis === "funding-envelope");
  if (!equalScope(fundingActions.map(a => a.checkId), d.checkIds) || fundingActions.some(a => a.action !== "withhold" || a.applied !== true) ||
      d.checkIds.some((id: string) => actions.filter(a => a.checkId === id).length !== 1)) fail("explicit applied withholding actions do not match funding scope");
  return { source: "standing-user-directive", policyDigest: sha(policy.text), decisionDigest: sha(decision.text), budgetEvidenceDigest: d.budgetEvidenceDigest as string,
    checkIds: d.checkIds as string[], step: d.step as string, reason: d.reason as string, projectionUsd: d.projectionUsd as typeof available, availableUsd: available };
}
