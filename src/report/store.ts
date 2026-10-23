// The materialized ReportView rows the app reads (research Pattern 3): one
// row per (project, view), JSON stored as written, read back unchanged.

import type { Kysely } from "kysely";

import type { DeidentifiedView } from "./deidentify.ts";
import type { ReportView } from "./view.ts";

type AnyView = ReportView | DeidentifiedView;

export async function ensureReportViewSchema(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("app_report_view")
    .ifNotExists()
    .addColumn("project_ref", "text", (c) => c.notNull())
    .addColumn("view", "text", (c) => c.notNull())
    .addColumn("json", "text", (c) => c.notNull())
    .addColumn("fixture", "integer", (c) => c.notNull())
    .addColumn("generated_at", "text", (c) => c.notNull())
    .addPrimaryKeyConstraint("app_report_view_pk", ["project_ref", "view"])
    .execute();
  await db.schema
    .createTable("app_snapshot")
    .ifNotExists()
    .addColumn("project_ref", "text", (c) => c.notNull())
    .addColumn("hash", "text", (c) => c.notNull())
    .addColumn("url", "text", (c) => c.notNull())
    .addColumn("archived_at", "text", (c) => c.notNull())
    .addColumn("text", "text", (c) => c.notNull())
    .addColumn("fixture", "integer", (c) => c.notNull())
    .addPrimaryKeyConstraint("app_snapshot_pk", ["project_ref", "hash"])
    .execute();
}

/** One archived page's extracted text, identifiable view only (07-UI-SPEC "Snapshot view", plan 07-08). */
export interface Snapshot {
  projectRef: string;
  hash: string;
  url: string;
  archivedAt: string;
  text: string;
  fixture: boolean;
}

export async function upsertSnapshot(db: Kysely<any>, s: Snapshot): Promise<void> {
  await db
    .replaceInto("app_snapshot")
    .values({ project_ref: s.projectRef, hash: s.hash, url: s.url, archived_at: s.archivedAt, text: s.text, fixture: s.fixture ? 1 : 0 })
    .execute();
}

/** Keyed by project and hash together, so a hash never opens another project's page (T-07-31). */
export async function readSnapshot(db: Kysely<any>, projectRef: string, hash: string): Promise<Snapshot | null> {
  const r = await db
    .selectFrom("app_snapshot")
    .selectAll()
    .where("project_ref", "=", projectRef)
    .where("hash", "=", hash)
    .executeTakeFirst();
  return r ? { projectRef: r.project_ref, hash: r.hash, url: r.url, archivedAt: r.archived_at, text: r.text, fixture: r.fixture === 1 } : null;
}

export async function upsertReportView(db: Kysely<any>, v: AnyView): Promise<void> {
  await db
    .replaceInto("app_report_view")
    .values({ project_ref: v.projectRef, view: v.view, json: JSON.stringify(v), fixture: v.fixture ? 1 : 0, generated_at: v.generatedAt })
    .execute();
}

export async function readReportView(db: Kysely<any>, projectRef: string, view: AnyView["view"]): Promise<AnyView | null> {
  const row = await db.selectFrom("app_report_view").select("json").where("project_ref", "=", projectRef).where("view", "=", view).executeTakeFirst();
  return row ? JSON.parse(row.json) : null;
}

export async function listReportViews(db: Kysely<any>, view: AnyView["view"]): Promise<AnyView[]> {
  const rows = await db.selectFrom("app_report_view").select("json").where("view", "=", view).orderBy("project_ref").execute();
  return rows.map((r) => JSON.parse(r.json));
}

/** What the project list shows for one stored view, read from its JSON (no gate run at request time). */
export interface ReportSummary {
  /** Project id (identifiable) or pseudonym (de-identified). */
  projectRef: string;
  view: AnyView["view"];
  /** Identifiable views only. */
  title: string | null;
  /** Decisions whose gate status is PASS, of 5. */
  passCount: number;
  generatedAt: string;
  collectedAt: string;
  fixture: boolean;
}

export async function listReportSummaries(db: Kysely<any>): Promise<ReportSummary[]> {
  const rows = await db.selectFrom("app_report_view").select("json").orderBy("project_ref").orderBy("view").execute();
  return rows.map((r) => {
    const v: AnyView = JSON.parse(r.json);
    return {
      projectRef: v.projectRef,
      view: v.view,
      title: v.view === "identifiable" ? v.title : null,
      passCount: v.decisions.filter((d) => d.status === "PASS").length,
      generatedAt: v.generatedAt,
      collectedAt: v.collection.collectedAt,
      fixture: v.fixture,
    };
  });
}
