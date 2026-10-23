// APP-04 / APP-01: the identifiable report's server functions. Each opens with
// requireProjectAccess("identifiable", ...), so a company sees only its granted
// projects; a missing row is the same 403 as a forbidden one (no existence leak).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { AccessError, decideAccess, requireProjectAccess, requireRole } from "./access.ts";
import type { DeidentifiedView } from "../../report/deidentify.ts";
import type { ReportView } from "../../report/view.ts";

const projectIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

async function forbidden(): Promise<never> {
  const { setResponseStatus } = await import("@tanstack/react-start/server");
  setResponseStatus(403);
  throw new AccessError(403);
}

export const getIdentifiableReport = createServerFn({ method: "GET" })
  .validator((d: { projectId: string }) => ({ projectId: projectIdSchema.parse(d.projectId) }))
  .handler(async ({ data }) => {
    await requireProjectAccess("identifiable", data.projectId);
    const { getDb } = await import("./db.ts");
    const { readReportView } = await import("../../report/store.ts");
    const view = await readReportView(getDb(), data.projectId, "identifiable");
    if (!view || view.view !== "identifiable") return forbidden();
    return view as ReportView;
  });

/** Pseudonyms are 5 Crockford base32 characters (deidentify.ts pseudonymOf). */
const pseudonymSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{5}$/);

/**
 * D-81 / APP-03: a judge's (or admin's) de-identified record, addressed by
 * pseudonym only. A missing row is the same 403 as a refused one.
 */
export const getDeidentifiedReport = createServerFn({ method: "GET" })
  // A malformed pseudonym becomes one no row can carry, so it is the same 403 as an unknown one (not a 500).
  .validator((d: { pseudonym: string }) => ({ pseudonym: pseudonymSchema.safeParse(d?.pseudonym).success ? d.pseudonym : "-" }))
  .handler(async ({ data }) => {
    await requireProjectAccess("deidentified", data.pseudonym);
    const { getDb } = await import("./db.ts");
    const { readReportView } = await import("../../report/store.ts");
    const view = await readReportView(getDb(), data.pseudonym, "deidentified");
    if (!view || view.view !== "deidentified") return forbidden();
    return view as DeidentifiedView;
  });

/**
 * One archived page of a permitted project, with the spans its report cites
 * on that page. The hash is looked up together with the project id, so a hash
 * from another project is a 403 like any other refusal (T-07-31).
 */
export const getSnapshot = createServerFn({ method: "GET" })
  .validator((d: { projectId: string; hash: string }) => ({
    projectId: projectIdSchema.parse(d.projectId),
    hash: z.string().regex(/^[0-9a-f]{64}$/).parse(d.hash),
  }))
  .handler(async ({ data }) => {
    await requireProjectAccess("identifiable", data.projectId);
    const { getDb } = await import("./db.ts");
    const { readReportView, readSnapshot } = await import("../../report/store.ts");
    const snapshot = await readSnapshot(getDb(), data.projectId, data.hash);
    const view = await readReportView(getDb(), data.projectId, "identifiable");
    if (!snapshot || !view || view.view !== "identifiable") return forbidden();
    const spans = new Map<string, { spanId: string; text: string; checkIds: string[] }>();
    for (const c of view.checks) {
      for (const q of c.quotes) {
        if (q.snapshotHash !== data.hash) continue;
        const s = spans.get(q.spanId) ?? { spanId: q.spanId, text: q.text, checkIds: [] };
        s.checkIds.push(c.checkId);
        spans.set(q.spanId, s);
      }
    }
    return { ...snapshot, spans: [...spans.values()] };
  });

/** One confirmation row as a viewer sees it: a title only for a project the viewer may open identifiably. */
export interface MethodConfirmationRow {
  project: string;
  identifiable: boolean;
  checkLabel: string;
  proposed: "pass";
  decision: string;
  role: string;
  modelId: string | null;
  decidedAt: string;
}

export const METHOD_PAGE_SIZE = 50;

/**
 * APP-03 / SC4 method audit. Admin and judges only (07-03 Q3: hidden from
 * company accounts). The stored row holds every confirmation record with its
 * project id, title and pseudonym; this function joins each to the access row
 * and lets only one identity through per row (T-07-39): the title when
 * decideAccess allows this viewer the identifiable view, else the pseudonym.
 * Rows are sorted by what is shown, so their order says nothing about project ids.
 */
export const getMethodView = createServerFn({ method: "GET" })
  .validator((d: { page?: number } | undefined) => ({ page: z.number().int().min(1).max(100_000).catch(1).parse(d?.page ?? 1) }))
  .handler(async ({ data }) => {
    const session = await requireRole("admin", "judge");
    const { getDb } = await import("./db.ts");
    const { readMethodView } = await import("../../report/store.ts");
    const db = getDb();
    const method = await readMethodView(db);
    if (!method) {
      // Not loaded yet: the codebook still shows, read from the repository files the server ships with.
      const path = await import("node:path");
      const { loadCodebook } = await import("../../pipeline/coding/codebook-prompt.ts");
      const { loadGapText } = await import("../../report/view.ts");
      const { codebookEntries, decisionLabelsOf } = await import("../../report/method-view.ts");
      const codebook = loadCodebook();
      const gates = path.join(process.cwd(), "vendor", "ai-output-to-value", "schemas", "v1", "decision-gates.json");
      return { loaded: false as const, codebook: codebookEntries(codebook, loadGapText({ codebook }), decisionLabelsOf(gates)) };
    }
    const { listProjectAccess } = await import("./access-store.ts");
    const access = new Map((await listProjectAccess(db)).map((a) => [a.projectId, a]));
    const order = new Map(method.codebook.map((c, i) => [c.checkId, i]));
    const rows: (MethodConfirmationRow & { k: number })[] = method.confirmations.map((r) => {
      const a = access.get(r.projectId);
      const identifiable = !!a && decideAccess(session.user.role, [], a, "identifiable");
      const project = identifiable ? r.title : a?.pseudonym ? `Project ${a.pseudonym}` : "Project withheld";
      return {
        project,
        identifiable,
        checkLabel: r.checkLabel,
        proposed: r.proposed,
        decision: r.decision,
        role: r.role,
        modelId: r.modelId,
        decidedAt: r.decidedAt,
        k: order.get(r.checkId) ?? 0,
      };
    });
    rows.sort((x, y) => x.project.localeCompare(y.project) || x.k - y.k || x.decidedAt.localeCompare(y.decidedAt));
    const pages = Math.max(1, Math.ceil(rows.length / METHOD_PAGE_SIZE));
    const page = Math.min(data.page, pages);
    const slice = rows.slice((page - 1) * METHOD_PAGE_SIZE, page * METHOD_PAGE_SIZE).map(({ k: _k, ...r }) => r);
    const { confirmations: _all, ...rest } = method;
    return { loaded: true as const, ...rest, confirmations: { rows: slice, page, pages, total: rows.length } };
  });
