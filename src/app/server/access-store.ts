// D-81 access tables: which projects the app knows, on what basis a judge may see
// them identifiably, and which projects each company account is granted.
// db is a parameter (trail.ts style), so tests use an in-memory Kysely.
import type { Kysely } from "kysely";
import type { Basis, ProjectAccess } from "./access.ts";

export const BASES: readonly Basis[] = ["own", "opt-in", "well-known"];

export interface ProjectAccessRow extends ProjectAccess {
  title?: string | null;
  pseudonym?: string | null;
  /** A6 decision record behind a well-known basis (own-site quote, URL, actor, time). */
  evidenceJson?: string | null;
  /** For own and opt-in projects: the boundary a live run may fetch. */
  liveBoundaryJson?: string | null;
  displayTitle?: string | null;
  fixture?: boolean;
}

/** Idempotent: safe at every server start. */
export async function ensureAccessSchema(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("app_project_access")
    .ifNotExists()
    .addColumn("project_id", "text", (c) => c.primaryKey())
    .addColumn("title", "text")
    .addColumn("basis", "text")
    .addColumn("sponsor_hold", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("in_sample", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("pseudonym", "text", (c) => c.unique())
    .addColumn("evidence_json", "text")
    .addColumn("live_boundary_json", "text")
    .addColumn("display_title", "text")
    .addColumn("fixture", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("updated_at", "text")
    .execute();
  await db.schema
    .createTable("app_user_projects")
    .ifNotExists()
    .addColumn("user_id", "text", (c) => c.notNull())
    .addColumn("project_id", "text", (c) => c.notNull())
    .addPrimaryKeyConstraint("app_user_projects_pk", ["user_id", "project_id"])
    .execute();
}

function fromRow(r: any): ProjectAccessRow {
  return {
    projectId: r.project_id,
    basis: BASES.includes(r.basis) ? r.basis : null,
    sponsorHold: r.sponsor_hold === 1,
    inSample: r.in_sample === 1,
    title: r.title,
    pseudonym: r.pseudonym,
    evidenceJson: r.evidence_json,
    liveBoundaryJson: r.live_boundary_json,
    displayTitle: r.display_title,
    fixture: r.fixture === 1,
  };
}

export async function loadProjectAccess(db: Kysely<any>, projectId: string): Promise<ProjectAccessRow | null> {
  const r = await db.selectFrom("app_project_access").selectAll().where("project_id", "=", projectId).executeTakeFirst();
  return r ? fromRow(r) : null;
}

export async function loadProjectAccessByPseudonym(db: Kysely<any>, pseudonym: string): Promise<ProjectAccessRow | null> {
  const r = await db.selectFrom("app_project_access").selectAll().where("pseudonym", "=", pseudonym).executeTakeFirst();
  return r ? fromRow(r) : null;
}

export async function listProjectAccess(db: Kysely<any>): Promise<ProjectAccessRow[]> {
  const rows = await db.selectFrom("app_project_access").selectAll().orderBy("project_id").execute();
  return rows.map(fromRow);
}

export async function grantsOf(db: Kysely<any>, userId: string): Promise<string[]> {
  const rows = await db.selectFrom("app_user_projects").select("project_id").where("user_id", "=", userId).execute();
  return rows.map((r: any) => r.project_id);
}

export async function grantProject(db: Kysely<any>, userId: string, projectId: string): Promise<void> {
  await db
    .insertInto("app_user_projects")
    .values({ user_id: userId, project_id: projectId })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

export async function upsertProjectAccess(db: Kysely<any>, row: ProjectAccessRow): Promise<void> {
  if (row.basis !== null && !BASES.includes(row.basis)) {
    throw new Error(`basis must be one of ${BASES.join(", ")} or null`);
  }
  const values = {
    project_id: row.projectId,
    title: row.title ?? null,
    basis: row.basis,
    sponsor_hold: row.sponsorHold ? 1 : 0,
    in_sample: row.inSample ? 1 : 0,
    pseudonym: row.pseudonym ?? null,
    evidence_json: row.evidenceJson ?? null,
    live_boundary_json: row.liveBoundaryJson ?? null,
    display_title: row.displayTitle ?? null,
    fixture: row.fixture ? 1 : 0,
    updated_at: new Date().toISOString(),
  };
  const { project_id: _id, ...rest } = values;
  await db
    .insertInto("app_project_access")
    .values(values)
    .onConflict((oc) => oc.column("project_id").doUpdateSet(rest))
    .execute();
}
