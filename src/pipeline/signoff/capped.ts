// A persisted request allowance prevents restarts from buying the same review twice.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient, PINNED_BASE_URL } from "../coding/nebius-client.ts";
import { DEFAULT_TOKEN_CAP, DollarBudget, estimateMessagesTokens, estimateCostUsd, reservationInputTokens, type UsageObservation } from "../coding/spend-guards.ts";
import { buildSignoffBody, signOff, signoffMessages, SIGNOFF_MODEL } from "./signoff.ts";

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export function projectSignoff(doc: string, context: string, item: string) {
  const inputTokens = estimateMessagesTokens(signoffMessages(doc, context, item));
  if (inputTokens > DEFAULT_TOKEN_CAP) throw new Error(`sign-off input ${inputTokens} exceeds ${DEFAULT_TOKEN_CAP}; preserve the full evidence and obtain a specific exception`);
  const upperBoundUsd = estimateCostUsd(SIGNOFF_MODEL, reservationInputTokens(buildSignoffBody(doc, context, item)), 2048);
  if (upperBoundUsd > .50) throw new Error("sign-off request exceeds its approved allowance");
  return { inputTokens, outputTokens: 2048, inputDigest: sha(JSON.stringify({ doc, context, item })), cap: .50, upperBoundUsd };
}

export async function cappedSignoff(o: { dataDir: string; doc: string; context: string; item: string; apiKey: string; fetchImpl?: typeof fetch; recordFile?: string }) {
  const plan = projectSignoff(o.doc, o.context, o.item);
  const recordFile = o.recordFile ?? "signoff.jsonl";
  if (path.basename(recordFile) !== recordFile) throw new Error("review record must be a decisions filename");
  const dir = path.join(o.dataDir, "decisions", "capped");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, plan.inputDigest + ".json");
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  if (saved) {
    if (saved.record?.inputDigest !== plan.inputDigest || saved.state !== "complete" || (saved.recordFile ?? "signoff.jsonl") !== recordFile) throw new Error("retained review attempt requires inspection before another call");
    console.log(`SIGNOFF: ${JSON.stringify({ item: o.item, decision: saved.record.decision, cached: true, inputDigest: plan.inputDigest })}`);
    console.log(`BUDGET: ${JSON.stringify(saved.budget)}`);
    console.log('ACCOUNTING: {"stage":"signoff","total":1,"valid":1,"failed":0,"complete":true}');
    return saved.record;
  }
  const evidence: any = { state: "prepared", plan, recordFile, usage: [] };
  const persist = () => fs.writeFileSync(file, JSON.stringify(evidence) + "\n", { mode: 0o600 });
  const budget = new DollarBudget(plan.cap, { onChange: state => { evidence.budget = state; persist(); } });
  const fetchImpl: typeof fetch = async (input, init) => {
    const response = await (o.fetchImpl ?? fetch)(input, init);
    evidence.raw = await response.clone().text(); persist();
    return response;
  };
  const underlying = createClient({ baseUrl: PINNED_BASE_URL, apiKey: o.apiKey, fetchImpl, maxRetries: 0, concurrency: 1, budget, onUsage: (usage: UsageObservation) => { evidence.usage.push(usage); persist(); }, stage: "signoff" });
  persist();
  const client = { request: async (url: string, init: { method: string; body: unknown }) => {
    const upperBoundUsd = estimateCostUsd(SIGNOFF_MODEL, reservationInputTokens(init.body), 2048);
    if (upperBoundUsd > plan.cap) throw new Error("sign-off request exceeds its approved allowance");
    console.log(`COST_PLAN: ${JSON.stringify({ stage: "signoff", provider: "token-factory", ...plan, upperBoundUsd })}`);
    evidence.state = "started"; evidence.requestDigest = sha(JSON.stringify(init.body)); persist();
    const response = await underlying.request(url, init);
    evidence.raw = response.text; persist();
    if (response.ok) {
      const value = JSON.parse((response.json as any)?.choices?.[0]?.message?.content);
      if (!value || Array.isArray(value) || Object.keys(value).sort().join(",") !== "decision,narrowsWhatPasses,reason" || !["approved", "rejected"].includes(value.decision) || typeof value.narrowsWhatPasses !== "boolean" || typeof value.reason !== "string") throw new Error("off-contract sign-off reply; raw response retained");
    }
    return response;
  } };
  try {
    const record = await signOff(client, o.doc, o.context, o.item);
    fs.appendFileSync(path.join(o.dataDir, "decisions", recordFile), JSON.stringify(record) + "\n", { mode: 0o600 });
    evidence.record = record; evidence.state = "complete"; evidence.budget = budget.snapshot(); persist();
    console.log(`SIGNOFF: ${JSON.stringify({ item: record.item, decision: record.decision, cached: false, inputDigest: record.inputDigest })}`);
    console.log('ACCOUNTING: {"stage":"signoff","total":1,"valid":1,"failed":0,"complete":true}');
    return record;
  } catch (error) {
    evidence.state = "failed"; persist();
    console.log('ACCOUNTING: {"stage":"signoff","total":1,"valid":0,"failed":1,"complete":false}');
    throw error;
  } finally { console.log(budget.budgetLine()); }
}
