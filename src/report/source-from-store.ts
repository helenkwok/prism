// APP-03 / APP-04 store adapter (plan 07-06): one project in the real pipeline
// store becomes the same ReportSource the synthetic corpus gives, so plans
// 07-13 and 07-14 materialise real projects with the same builder. Published
// states, cited spans and confirmations come through readTrail (the Phase 4
// review trail), never a second query of the confirmation tables; pages, URLs
// and rendered visibility come from the manifest in collection order; injection
// flags from pipeline_injection_flags. What the store does not hold (title, HN
// id, collection time, model roles, renderer availability) the caller supplies.

import fs from "node:fs";
import path from "node:path";

import type { Kysely } from "kysely";

import type { Codebook } from "../pipeline/coding/codebook-prompt.ts";
import { loadGateFile, resolveGatesPath } from "../pipeline/coding/contract.ts";
import { projectSpans, type PublishedBasis } from "../pipeline/confirm/confirm.ts";
import { readTrail } from "../pipeline/review/trail.ts";
import type { ConfirmationLine, PublishedValue, ReportSource } from "./view.ts";

export interface StoreMeta {
  projectId: string;
  title: string;
  hnId: number | null;
  collectedAt: string;
  generatedAt: string;
  renderAvailable: boolean;
  roles: ReportSource["roles"];
  fixture?: boolean;
}

const VALUES = new Set(["pass", "claimed", "unknown", "fail"]);

async function injectionFlags(db: Kysely<any>, projectN: number): Promise<string[]> {
  const tables = await db.introspection.getTables();
  if (!tables.some((t) => t.name === "pipeline_injection_flags")) return [];
  const rows = await db.selectFrom("pipeline_injection_flags").select("span_id").where("project_n", "=", projectN).execute();
  return rows.map((r: any) => r.span_id);
}

export async function sourceFromStore(db: Kysely<any>, dataDir: string, codebook: Codebook, projectN: number, meta: StoreMeta): Promise<ReportSource> {
  const base = {
    projectId: meta.projectId,
    hnId: meta.hnId,
    title: meta.title,
    collectedAt: meta.collectedAt,
    codebookVersion: codebook.codebookVersion,
    generatedAt: meta.generatedAt,
    fixture: meta.fixture === true,
    renderAvailable: meta.renderAvailable,
    roles: meta.roles,
  };

  const manifestPath = path.join(dataDir, "pipeline", "manifests", `${projectN}.json`);
  if (!fs.existsSync(manifestPath)) {
    // Nothing was collected: no pages, no spans, and every check is unknown.
    const checkIds = loadGateFile(resolveGatesPath()).checkIds;
    return {
      ...base,
      pages: [],
      published: checkIds.map((checkId) => ({ checkId, published: "unknown" as const, basis: "not-positive" as const })),
      spans: {},
      cites: {},
      flaggedSpanIds: [],
      confirmations: {},
    };
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const hashes: string[] = manifest.snapshotHashesInCollectionOrder ?? [];
  const pages = hashes.map((h, i) => {
    const snap = JSON.parse(fs.readFileSync(path.join(dataDir, "pipeline", "snapshots", `${h}.json`), "utf8"));
    const m = manifest.snapshots?.[i];
    return { url: (snap.url ?? m?.url) as string, snapshotHash: h, rendered: m?.visibility === "rendered" };
  });

  const trail = await readTrail(db, dataDir, projectN, { codebook });
  const textOf = new Map(projectSpans(dataDir, projectN).map((s) => [s.id, s.text]));

  const published: ReportSource["published"] = [];
  const cites: ReportSource["cites"] = {};
  const spans: ReportSource["spans"] = {};
  const confirmations: Record<string, ConfirmationLine[]> = {};
  for (const c of trail.checks) {
    const p = c.published ?? { published: null, basis: "unconfirmed" };
    if (p.published !== null && !VALUES.has(p.published)) throw new Error(`project ${projectN}: ${c.checkId} has published state "${p.published}"`);
    published.push({ checkId: c.checkId, published: p.published as PublishedValue, basis: p.basis as PublishedBasis });

    // The cited spans are the latest edit's, else the model's (as effectiveStates reads them).
    const ids = c.edits?.length ? c.edits[c.edits.length - 1].spanIds : (c.model?.spanIds ?? []);
    cites[c.checkId] = ids;
    for (const id of ids) {
      const page = pages[Number(/^p(\d+)-/.exec(id)?.[1]) - 1];
      spans[id] = { text: textOf.get(id) ?? "", url: page?.url ?? null, snapshotHash: page?.snapshotHash ?? null };
    }

    confirmations[c.checkId] = (c.confirmations ?? [])
      .map((x) => ({
        decision: x.decision,
        role: x.kind === "agent" ? "confirmer" : "reviewer",
        actorKind: x.kind,
        // An agent confirmer's id is "agent:<model id>" (confirm.ts); a person has no model.
        modelId: x.kind === "agent" && x.actor.startsWith("agent:") ? x.actor.slice("agent:".length) : null,
        decidedAt: x.decidedAt,
      }))
      .sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));
  }

  return { ...base, pages, published, spans, cites, flaggedSpanIds: await injectionFlags(db, projectN), confirmations };
}
