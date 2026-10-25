// Plan 07-14 Task 3: the finished judge views cross from the Mac to the VM as one pack (SQLite), built from the
// private local database and loaded into the app database in one transaction. A pack holds every de-identified
// view, the method view and every access row, but identifiable views and snapshots only for projects whose
// access row has a basis and no sponsor hold. The load re-checks that, so a tampered pack writes nothing.

import type { Kysely } from "kysely";

import { ensureAccessSchema } from "../app/server/access-store.ts";
import { ensureReportViewSchema } from "./store.ts";

export interface PackCounts {
  deid: number;
  identifiable: number;
  snapshots: number;
  access: number;
  method: number;
}

async function eligible(db: Kysely<any>): Promise<Set<string>> {
  const rows = await db.selectFrom("app_project_access").select("project_id").where("basis", "is not", null).where("sponsor_hold", "=", 0).execute();
  return new Set(rows.map((r: any) => String(r.project_id)));
}

/** Copies the publishable rows of `from` (the local real-views database) into the empty pack `to`. */
export async function buildPack(from: Kysely<any>, to: Kysely<any>): Promise<PackCounts> {
  await ensureReportViewSchema(to);
  await ensureAccessSchema(to);
  const ok = await eligible(from);
  const views = (await from.selectFrom("app_report_view").selectAll().execute()).filter((v: any) => v.view === "deidentified" || ok.has(v.project_ref));
  const snaps = (await from.selectFrom("app_snapshot").selectAll().execute()).filter((s: any) => ok.has(s.project_ref));
  const access = await from.selectFrom("app_project_access").selectAll().execute();
  const method = await from.selectFrom("app_method_view").selectAll().execute();
  await to.transaction().execute(async (trx) => {
    for (const v of views) await trx.insertInto("app_report_view").values(v).execute();
    for (const s of snaps) await trx.insertInto("app_snapshot").values(s).execute();
    for (const a of access) await trx.insertInto("app_project_access").values(a).execute();
    for (const m of method) await trx.insertInto("app_method_view").values(m).execute();
  });
  return {
    deid: views.filter((v: any) => v.view === "deidentified").length,
    identifiable: views.filter((v: any) => v.view === "identifiable").length,
    snapshots: snaps.length,
    access: access.length,
    method: method.length,
  };
}

export class PackRefusal extends Error {}

/**
 * Loads a pack into the app database: refuses unless every identifiable view and snapshot belongs to a project
 * with a basis and no hold, and every de-identified view has an access row with its pseudonym. Then, in one
 * transaction, removes the fixture rows and the earlier sample rows (live-run own projects are not sample rows
 * and stay) and inserts the pack.
 */
export async function loadPack(pack: Kysely<any>, app: Kysely<any>): Promise<PackCounts> {
  const ok = await eligible(pack);
  const views = await pack.selectFrom("app_report_view").selectAll().execute();
  const snaps = await pack.selectFrom("app_snapshot").selectAll().execute();
  const access = await pack.selectFrom("app_project_access").selectAll().execute();
  const method = await pack.selectFrom("app_method_view").selectAll().execute();
  const pseudonyms = new Set(access.map((a: any) => a.pseudonym).filter(Boolean));
  for (const v of views) {
    if (v.view === "identifiable" && !ok.has(v.project_ref)) throw new PackRefusal("identifiable view without a basis or under a hold");
    if (v.view === "deidentified" && !pseudonyms.has(v.project_ref)) throw new PackRefusal("de-identified view without an access row");
    if (v.view !== "identifiable" && v.view !== "deidentified") throw new PackRefusal("unknown view kind");
  }
  for (const s of snaps) if (!ok.has(s.project_ref)) throw new PackRefusal("snapshot without a basis or under a hold");
  if (method.length !== 1) throw new PackRefusal("method view missing");
  if (views.some((v: any) => v.fixture === 1) || access.some((a: any) => a.fixture === 1)) throw new PackRefusal("fixture rows in pack");

  await ensureReportViewSchema(app);
  await ensureAccessSchema(app);
  await app.transaction().execute(async (trx) => {
    const sample = (await trx.selectFrom("app_project_access").select("project_id").where("in_sample", "=", 1).execute()).map((r: any) => r.project_id);
    await trx.deleteFrom("app_report_view").where((eb) => eb.or([eb("fixture", "=", 1), eb("view", "=", "deidentified"), ...(sample.length ? [eb("project_ref", "in", sample)] : [])])).execute();
    await trx.deleteFrom("app_snapshot").where((eb) => eb.or([eb("fixture", "=", 1), ...(sample.length ? [eb("project_ref", "in", sample)] : [])])).execute();
    await trx.deleteFrom("app_project_access").where((eb) => eb.or([eb("fixture", "=", 1), eb("in_sample", "=", 1)])).execute();
    await trx.deleteFrom("app_method_view").execute();
    for (const v of views) await trx.insertInto("app_report_view").values(v).execute();
    for (const s of snaps) await trx.insertInto("app_snapshot").values(s).execute();
    for (const a of access) await trx.insertInto("app_project_access").values(a).execute();
    for (const m of method) await trx.insertInto("app_method_view").values(m).execute();
  });
  return {
    deid: views.filter((v: any) => v.view === "deidentified").length,
    identifiable: views.filter((v: any) => v.view === "identifiable").length,
    snapshots: snaps.length,
    access: access.length,
    method: method.length,
  };
}
