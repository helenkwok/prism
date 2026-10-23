// The materialized ReportView rows the app reads (research Pattern 3): one
// row per (project, view), JSON stored as written, read back unchanged.

import type { Kysely } from "kysely";

import type { ReportView } from "./view.ts";

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
}

export async function upsertReportView(db: Kysely<any>, v: ReportView): Promise<void> {
  await db
    .replaceInto("app_report_view")
    .values({ project_ref: v.projectRef, view: v.view, json: JSON.stringify(v), fixture: v.fixture ? 1 : 0, generated_at: v.generatedAt })
    .execute();
}

export async function readReportView(db: Kysely<any>, projectRef: string, view: ReportView["view"]): Promise<ReportView | null> {
  const row = await db.selectFrom("app_report_view").select("json").where("project_ref", "=", projectRef).where("view", "=", view).executeTakeFirst();
  return row ? JSON.parse(row.json) : null;
}

export async function listReportViews(db: Kysely<any>, view: ReportView["view"]): Promise<ReportView[]> {
  const rows = await db.selectFrom("app_report_view").select("json").where("view", "=", view).orderBy("project_ref").execute();
  return rows.map((r) => JSON.parse(r.json));
}
