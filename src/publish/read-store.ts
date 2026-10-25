// PUB-01 / PUB-03: the private store -> the same AggregateInput the fixture loader produces.
// Reads only; refuses without a signed VAL-07 gate. Nothing here writes.
//
// Rules (protocol section 3, A7.8, A13, D-75, D-83):
// - N is every sample project; published states come from publishedStates (confirmed positives only).
// - A check enters shares, decisions, source types and visibility only when assertPublishable accepts it.
//   A withheld check is passed to the gate as unknown, so a decision needing it cannot be PASS.
// - Positives of a withheld check that confirmation never decided (A13) are left out of the input,
//   so they cannot reach the export; decided positives of withheld checks still count in the
//   confirmation process figures.
// - Reddit picks tagged context are passed through untouched so the export's context refusal stays the backstop.

import fs from "node:fs";
import path from "node:path";

import type { Kysely } from "kysely";

import { getDb } from "../app/server/db.ts";
import { buildClaimsForProject } from "../pipeline/claims/build-claims.ts";
import { loadCodebook } from "../pipeline/coding/codebook-prompt.ts";
import type { CheckEntry } from "../pipeline/coding/contract.ts";
import { PINNED_MODEL } from "../pipeline/coding/nebius-client.ts";
import { DEFAULT_TOKEN_CAP } from "../pipeline/coding/spend-guards.ts";
import { effectiveStates, publishedStates } from "../pipeline/confirm/confirm.ts";
import { runGate as realRunGate, type GateResult } from "../pipeline/gate/run-gate.ts";
import { assertPublishable, loadSignedGate } from "../pipeline/validate/gate.ts";
import { loadDecisionRules, type AggregateInput, type GateCheck, type Project, type RoleRecord } from "./aggregate.ts";
import { RefusalError } from "./export.ts";

const REPO = path.resolve(import.meta.dirname, "../..");
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
const LETTER: Record<string, string> = { PASS: "P", BLOCKED: "B", INSUFFICIENT_EVIDENCE: "I" };
const TF = "Nebius Token Factory";
const OLLAMA = "Ollama Cloud";

/** The signed gate, trying the release sign-off register first (where the final gate was signed). */
export function signedGate(dataDir: string, signoffPath?: string) {
  const gatePath = path.join(dataDir, "validation", "gate-v1.0.json");
  const paths = signoffPath ? [signoffPath] : ["release-signoff.jsonl", "signoff.jsonl"].map((f) => path.join(dataDir, "decisions", f));
  for (const p of paths) {
    const g = fs.existsSync(p) ? loadSignedGate(gatePath, p) : null;
    if (g) return g;
  }
  return null;
}

/** Source type of a cited page, from its URL host and path only. */
export function sourceType(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "other";
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  const p = u.pathname.replace(/\/+$/, "").toLowerCase();
  if (/(^|\.)(github\.com|gitlab\.com|codeberg\.org|bitbucket\.org)$/.test(host) || host === "raw.githubusercontent.com") {
    const parts = p.split("/").filter(Boolean);
    return parts.length <= 2 || /readme/.test(p) ? "repository-readme" : "repository-file";
  }
  if (/(^|\/)(privacy|terms|tos|legal|security|policy|policies|cookies?|gdpr|dpa|trust|license)([-_./]|$)/.test(p)) return "policy-page";
  if (/^docs?\./.test(host) || /(^|\/)(docs?|documentation|guides?|reference|api|manual|faq|help)([-_./]|$)/.test(p)) return "docs";
  if (p === "" || /^\/(index\.html?)?$/.test(p)) return "homepage";
  return "other";
}

const positive = (s: { published: string | null; basis: string }) => (s.basis === "confirmed" || s.basis === "downgraded") && (s.published === "pass" || s.published === "claimed");

function roles(dataDir: string, gate: any, screeningModel: string, codebookVersion: string): RoleRecord[] {
  const seeds = readJson(path.join(dataDir, "pipeline", "sample-subsets.json")).seeds ?? {};
  const audit = readJson(path.join(dataDir, "validation", "screening-audit.json"));
  const recall = readJson(path.join(dataDir, "validation", "recall.json"));
  const bare = (m: string) => String(m).replace(/:cloud$/, "");
  const host = (provider: string) => (provider === "ollama" ? OLLAMA : TF);
  const role = (r: string, modelId: string, h: string, promptVersion: string, seed: string): RoleRecord => ({
    role: r,
    kind: "agent",
    modelId: bare(modelId),
    host: h,
    manifest: { promptVersion, codebookVersion, seed, tokenCap: DEFAULT_TOKEN_CAP },
  });
  return [
    role("screener", screeningModel, TF, "inclusion rules (protocol section 2)", seeds.sampling ?? "not recorded"),
    role("coder", PINNED_MODEL, TF, "codebook prompt, guidance c1 on one check", "none (temperature 0)"),
    role("second coder", "nemotron-3-super", OLLAMA, "codebook prompt", seeds.secondModel ?? "not recorded"),
    role("independent labeller", gate.labeller.modelId, host(gate.labeller.provider), "codebook prompt", seeds.gold ?? "not recorded"),
    role("confirmer", "nemotron-3-ultra", OLLAMA, "confirmation prompt", "none (temperature 0)"),
    role("screening auditor", audit.model, host(audit.provider), "screening audit prompt", seeds.screeningAudit ?? "not recorded"),
    role("recall gatherer", recall.model, host(recall.provider), "recall gathering prompt", seeds.recall ?? "not recorded"),
  ];
}

export async function readStore(
  dataDir: string,
  {
    date,
    version = "v1",
    signoffPath,
    db,
    runGate = (r: object) => realRunGate(r),
    loadGate = () => signedGate(dataDir, signoffPath),
  }: {
    date: string;
    version?: string;
    signoffPath?: string;
    db?: Kysely<any>;
    runGate?: (r: object) => Promise<GateResult>;
    /** Tests only: the signed gate record (null = unsigned). */
    loadGate?: () => any;
  },
): Promise<AggregateInput> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RefusalError("input-missing", "release date");
  const gate = loadGate();
  if (!gate) throw new RefusalError("unsigned-gate");
  db ??= getDb();
  const codebook = loadCodebook(path.join(REPO, "codebook.md"));
  const checkIds: string[] = gate.checks.map((c: any) => c.checkId);
  const publishable = new Set(
    checkIds.filter((id) => {
      try {
        assertPublishable(gate, id);
        return true;
      } catch {
        return false;
      }
    }),
  );

  // projects: the Show HN sample, plus Reddit sample picks (D-75)
  const pipe = path.join(dataDir, "pipeline");
  const sample = readJson(path.join(pipe, "sample-projects.json")) as any[];
  const failed = new Set<number>(gate.collection?.projectNs ?? []);
  const projects: Project[] = sample.map((e) => ({ n: e.n, quarter: e.quarter, source: "show-hn", tag: "sample", hnId: String(e.hn_id), title: e.title, finalUrl: e.final_url, collectionFailed: failed.has(e.n) }));
  const picksFile = path.join(dataDir, "reddit", "picks.json");
  const picks = fs.existsSync(picksFile) ? (readJson(picksFile) as any[]) : [];
  for (const p of picks.filter((p) => p.tag === "sample")) {
    projects.push({ n: p.projectN, quarter: p.quarter ?? 0, source: "reddit", tag: "sample", hnId: "", title: p.title ?? "", finalUrl: p.url });
  }
  const ns = projects.map((p) => p.n);

  // published states; undecided positives of a withheld check stay out (A13)
  const all = await publishedStates(db, dataDir, codebook, ns, { allowedModelIds: ["nemotron-3-ultra"] });
  const published = all.filter((s) => publishable.has(s.checkId) || (s.basis !== "unconfirmed" && s.basis !== "stale"));
  const effective = await effectiveStates(db, ns);
  const spansOf = new Map(effective.map((e) => [`${e.projectN}|${e.checkId}`, e.spanIds]));

  // decisions: the deterministic gate over published states of publishable checks; everything else unknown
  const rules = loadDecisionRules();
  const byProject = new Map<number, typeof published>();
  for (const s of published) byProject.set(s.projectN, [...(byProject.get(s.projectN) ?? []), s]);
  for (const p of projects) {
    const states: CheckEntry[] = checkIds.map((checkId) => {
      const s = byProject.get(p.n)?.find((x) => x.checkId === checkId);
      const ok = publishable.has(checkId) && s && ["pass", "claimed", "fail"].includes(s.published ?? "");
      return { checkId, proposedState: (ok ? s!.published : "unknown") as CheckEntry["proposedState"], spanIds: [] };
    });
    const out = await buildClaimsForProject({ project: `project ${p.n}`, filteredStates: states, runGate: runGate as any, repoRoot: REPO });
    p.decisions = [...rules.keys()].map((d) => LETTER[(out as any)[d].gateResult.status]).join("");

    // source types and visibility of the confirmed positives of publishable checks
    const manifestFile = path.join(pipe, "manifests", `${p.n}.json`);
    const snaps: { url: string; visibility: string }[] = fs.existsSync(manifestFile) ? readJson(manifestFile).snapshots : [];
    const cited = (byProject.get(p.n) ?? []).filter((s) => publishable.has(s.checkId) && positive(s)).flatMap((s) => spansOf.get(`${p.n}|${s.checkId}`) ?? []);
    const pages = cited.map((id) => snaps[Number(/^p(\d+)-/.exec(id)?.[1] ?? 0) - 1]).filter(Boolean) as { url: string; visibility: string }[];
    p.sourceTypes = [...new Set(pages.map((s) => sourceType(s.url)))].sort();
    p.providerOnly = pages.length > 0 && pages.every((s) => s.visibility === "provider-extracted");
  }

  // gate per check: status from the signed record; precision as counts
  const gateChecks: GateCheck[] = gate.checks.map((c: any) => ({
    checkId: c.checkId,
    status: c.status,
    reason: c.reason,
    goldPasses: c.goldPasses,
    ac1: c.ac1,
    ac1CI: c.ac1CI,
    ...(typeof c.precision === "number" && c.coderPasses > 0 ? { precision: { c: Math.round(c.precision * c.coderPasses), m: c.coderPasses } } : {}),
  }));

  // validation (D-76) and the D-83 process figures
  const sa = gate.screeningAudit.figure;
  const action = fs.readFileSync(path.join(dataDir, "decisions", "screening-audit-action-a7.10.md"), "utf8");
  const remeasure = /Remeasured errors:\s*(\d+)/.exec(action);
  if (!remeasure) throw new RefusalError("input-missing", "screening re-measure");
  const rc = readJson(path.join(dataDir, "validation", "recall.json"));
  const cross = readJson(path.join(dataDir, "validation", "tavily-vs-free-142.json"));
  let both = 0, either = 0;
  for (const p of cross.projects) for (const q of p.checks.pairs) {
    const a = ["pass", "claimed"].includes(q.tavily), b = ["pass", "claimed"].includes(q.free);
    if (a && b) both++;
    if (a || b) either++;
  }
  const screeningLog = readJson(path.join(pipe, "sample-screening-log.json"));
  const frame = readJson(path.join(pipe, "frame.json"));
  const day = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);

  // person edits: (project, check) whose latest edit was made by a person
  const edits = (await db.selectFrom("pipeline_edits").select(["project_n", "check_id", "actor_kind", "edited_at"]).where("project_n", "in", ns).execute()) as any[];
  const latest = new Map<string, any>();
  for (const e of edits) {
    const k = `${e.project_n}|${e.check_id}`;
    if (!latest.has(k) || String(e.edited_at) > String(latest.get(k).edited_at)) latest.set(k, e);
  }

  return {
    synthetic: false,
    release: { version, date },
    checkIds,
    projects,
    published,
    gate: { checks: gateChecks },
    ledger: [],
    picks: picks.filter((p) => p.tag !== "sample"),
    method: { frame: "Show HN posts in the sampling window", window: `${day(frame.window.startEpoch)} to ${day(frame.window.endEpochExclusive - 86400)}` },
    validation: {
      screeningAudit: { errors: sa.errors, audited: sa.assessable, bar: Math.round(sa.bar * 100), remeasureErrors: Number(remeasure[1]), sample: projects.length },
      collectionRecall: {
        supportedFound: rc.support.supportedFound,
        supported: rc.support.supported,
        contributed: rc.figure.contributing,
        projects: rc.figure.projects,
        rawFound: rc.support.rawFound,
        raw: rc.support.rawItems,
        gathered: rc.support.itemsJudged,
        gatheredSupported: rc.support.supported,
        unsupported: rc.support.unsupported,
        boilerplate: rc.support.boilerplate,
      },
      crossCheck: { projects: cross.n, positiveAgreement: either ? (2 * both) / (2 * both + (either - both)) : 0, allStates: cross.checkAgreementRate },
    },
    screening: { identified: frame.posts.length, counts: screeningLog.counts },
    roles: roles(dataDir, gate, screeningLog.model, gate.codebookVersion),
    edits: [...latest.values()].filter((e) => e.actor_kind === "person").map((e) => ({ projectN: e.project_n, checkId: e.check_id })),
    community: null,
    notes: [...rules.values()].every((req) => req.some((c) => !publishable.has(c)))
      ? [
          {
            id: "limitation:decisions-need-withheld-checks",
            kind: "limitation",
            text: "Every decision requires at least one check that was withheld at validation. A withheld check enters the deterministic gate as unknown, so no launch can reach PASS for any decision on published states alone. The decision figures show what the released checks can support, not how far launches meet each decision.",
          },
        ]
      : [],
    labels: {},
  };
}
