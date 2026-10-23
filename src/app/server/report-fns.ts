// APP-04 / APP-01: the identifiable report's server functions. Each opens with
// requireProjectAccess("identifiable", ...), so a company sees only its granted
// projects; a missing row is the same 403 as a forbidden one (no existence leak).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { AccessError, requireProjectAccess } from "./access.ts";
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
