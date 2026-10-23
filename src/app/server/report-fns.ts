// APP-04 / APP-01: the identifiable report's server functions. Each opens with
// requireProjectAccess("identifiable", ...), so a company sees only its granted
// projects; a missing row is the same 403 as a forbidden one (no existence leak).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { AccessError, requireProjectAccess } from "./access.ts";
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
