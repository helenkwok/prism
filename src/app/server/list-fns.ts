// APP-01 / 07-UI-SPEC "Project list": the role-scoped list every signed-in user
// lands on. projectListFor is pure and applies the one access rule
// (decideAccess) per row, so a role is sent only the rows it may open. A judge's
// de-identified rows carry the pseudonym only: no project id, no title, no hold
// (T-07-24). The server function filters; the client never does.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { decideAccess, requireRole } from "./access.ts";
import type { Basis, Role } from "./access.ts";
import type { ProjectAccessRow } from "./access-store.ts";
import type { ReportSummary } from "../../report/store.ts";

export const PAGE_SIZE = 50;

export interface IdentifiableRow {
  projectId: string;
  title: string;
  /** null: the judge would see it de-identified only. Admin rows only. */
  basis?: Basis | null;
  /** Admin rows only. */
  sponsorHold?: boolean;
  /** /review/$projectN for sample projects. Admin rows only. */
  reviewN?: number | null;
  /** Decisions publicly evidenced, of 5; null when no view is stored yet. */
  passCount: number | null;
  /** Date the view was generated (YYYY-MM-DD). */
  updated: string | null;
}

export interface DeidentifiedRow {
  pseudonym: string;
  passCount: number | null;
  /** Collection date (YYYY-MM-DD). */
  collected: string | null;
}

export interface Section<R> {
  rows: R[];
  total: number;
}

export interface ProjectList {
  role: Role;
  page: number;
  pages: number;
  /** Any shown row is synthetic test data: the fixture notice shows. */
  fixture: boolean;
  /** admin: all, company: own grants. */
  identifiable: Section<IdentifiableRow>;
  /** judge only. */
  deidentified: Section<DeidentifiedRow> | null;
}

const day = (iso: string | undefined | null) => (iso ? iso.slice(0, 10) : null);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ponytail: project ids "P12" / "12" map to the review route's number; any other id gets no review link.
function reviewNumber(projectId: string): number | null {
  const m = /^P?0*(\d+)$/.exec(projectId);
  return m ? Number(m[1]) : null;
}

/** Pure: the rows a role may see, sorted and cut to one page of 50. */
export function projectListFor(
  role: Role,
  grants: readonly string[],
  accessRows: readonly ProjectAccessRow[],
  summaries: readonly ReportSummary[],
  page: number,
): ProjectList {
  const ident = new Map(summaries.filter((s) => s.view === "identifiable").map((s) => [s.projectRef, s]));
  const deid = new Map(summaries.filter((s) => s.view === "deidentified").map((s) => [s.projectRef, s]));
  let fixture = false;

  const identRows: { sortKey: string; row: IdentifiableRow }[] = [];
  const deidRows: { sortKey: string; row: DeidentifiedRow }[] = [];
  for (const a of accessRows) {
    if (role === "admin" || decideAccess(role, grants, a, "identifiable")) {
      const s = ident.get(a.projectId);
      const title = s?.title ?? a.displayTitle ?? a.title ?? a.projectId;
      const row: IdentifiableRow = { projectId: a.projectId, title, passCount: s?.passCount ?? null, updated: day(s?.generatedAt) };
      if (role === "admin") {
        row.basis = a.basis;
        row.sponsorHold = a.sponsorHold;
        row.reviewN = a.inSample ? reviewNumber(a.projectId) : null;
      }
      fixture ||= a.fixture === true || s?.fixture === true;
      identRows.push({ sortKey: `${title}\u0000${a.projectId}`, row });
    } else if (role === "judge" && a.pseudonym && decideAccess(role, grants, a, "deidentified")) {
      const s = deid.get(a.pseudonym);
      fixture ||= a.fixture === true || s?.fixture === true;
      // The project id only orders ties; it never leaves this function.
      deidRows.push({ sortKey: `${a.pseudonym}\u0000${a.projectId}`, row: { pseudonym: a.pseudonym, passCount: s?.passCount ?? null, collected: day(s?.collectedAt) } });
    }
  }

  const pages = Math.max(1, Math.ceil(identRows.length / PAGE_SIZE), Math.ceil(deidRows.length / PAGE_SIZE));
  const p = Math.min(Math.max(1, Math.trunc(page) || 1), pages);
  const cut = <R,>(list: { sortKey: string; row: R }[]): Section<R> => ({
    rows: list
      .sort((x, y) => cmp(x.sortKey, y.sortKey))
      .slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE)
      .map((x) => x.row),
    total: list.length,
  });
  return {
    role,
    page: p,
    pages,
    fixture,
    identifiable: cut(identRows),
    deidentified: role === "judge" ? cut(deidRows) : null,
  };
}

const pageSchema = z.number().int().min(1).max(100_000);

export const listProjects = createServerFn({ method: "GET" })
  .validator((d: { page?: number } | undefined) => ({ page: pageSchema.parse(d?.page ?? 1) }))
  .handler(async ({ data }) => {
    const session = await requireRole("admin", "judge", "company");
    const { getDb } = await import("./db.ts");
    const { grantsOf, listProjectAccess } = await import("./access-store.ts");
    const { listReportSummaries } = await import("../../report/store.ts");
    const db = getDb();
    const role = session.user.role as Role;
    const [accessRows, summaries, grants] = await Promise.all([
      listProjectAccess(db),
      listReportSummaries(db),
      role === "company" ? grantsOf(db, session.user.id) : Promise.resolve([] as string[]),
    ]);
    return projectListFor(role, grants, accessRows, summaries, data.page);
  });
