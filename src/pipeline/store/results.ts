// COD-06: the durable per-project store and run manifest. Three new tables
// in the one shared PRISM_DATA_DIR-rooted prism.sqlite (src/app/server/db.ts's
// getDb()) — never a second store. `codingAllUnknown` is its own column
// precisely so a retry-exhausted result (every check `unknown` because
// retries were exhausted, per retry.ts's D-28 policy) is distinguishable
// later from a genuine model-coded unknown with the same filtered_state.

import type { Kysely } from "kysely";

export interface CheckStateRecord {
  checkId: string;
  proposedState: string;
  filteredState: string;
  spanIds: string[];
}

export interface ClaimRecord {
  decisionId: string;
  claimJson: unknown;
  gateStatus: string;
}

export interface ProjectResultInput {
  projectN: number;
  hnId: string;
  modelId: string;
  promptHash: string;
  codebookVersion: string;
  gateSha: string;
  /** Snapshot hashes in collection order (map order, then extract order) — never re-sorted. */
  snapshotHashesInCollectionOrder: string[];
  codingAttempts: number;
  codingAllUnknown: boolean;
  checkStates: CheckStateRecord[];
  claims: ClaimRecord[];
}

/** Idempotent: safe to call at every pipeline start. */
export async function ensurePipelineSchema(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("pipeline_project_results")
    .ifNotExists()
    .addColumn("project_n", "integer", (col) => col.primaryKey())
    .addColumn("hn_id", "text")
    .addColumn("model_id", "text")
    .addColumn("prompt_hash", "text")
    .addColumn("codebook_version", "text")
    .addColumn("gate_sha", "text")
    .addColumn("snapshot_hashes_json", "text")
    .addColumn("coding_attempts", "integer")
    .addColumn("coding_all_unknown", "integer")
    .addColumn("missing_data", "integer")
    .addColumn("completed_at", "text")
    .execute();

  // CREATE TABLE IF NOT EXISTS never alters a table made by an earlier schema, so columns added
  // later are added here when a database from an earlier phase lacks them.
  const resultsTable = (await db.introspection.getTables()).find((t) => t.name === "pipeline_project_results");
  if (resultsTable && !resultsTable.columns.some((c) => c.name === "missing_data")) {
    await db.schema.alterTable("pipeline_project_results").addColumn("missing_data", "integer").execute();
  }

  // D-41: per-span injection-detection flags, so a future confirmation queue
  // can point at the exact triggering span without Helen re-reading the page.
  await db.schema
    .createTable("pipeline_injection_flags")
    .ifNotExists()
    .addColumn("project_n", "integer")
    .addColumn("span_id", "text")
    .addPrimaryKeyConstraint("pipeline_injection_flags_pk", ["project_n", "span_id"])
    .execute();

  // D-45: confirmation-timing log (one row per project's confirmation pass).
  await db.schema
    .createTable("pipeline_confirmation_log")
    .ifNotExists()
    .addColumn("project_n", "integer", (col) => col.primaryKey())
    .addColumn("started_at", "text")
    .addColumn("ended_at", "text")
    .execute();

  await db.schema
    .createTable("pipeline_check_states")
    .ifNotExists()
    .addColumn("project_n", "integer")
    .addColumn("check_id", "text")
    .addColumn("proposed_state", "text")
    .addColumn("filtered_state", "text")
    .addColumn("span_ids_json", "text")
    .addPrimaryKeyConstraint("pipeline_check_states_pk", ["project_n", "check_id"])
    .execute();

  // The second coder's states (VAL agreement). Never read by the gate path.
  await db.schema
    .createTable("pipeline_second_coder_states")
    .ifNotExists()
    .addColumn("project_n", "integer")
    .addColumn("check_id", "text")
    .addColumn("model_id", "text")
    .addColumn("proposed_state", "text")
    .addColumn("filtered_state", "text")
    .addColumn("span_ids_json", "text")
    .addColumn("coding_all_unknown", "integer")
    .addPrimaryKeyConstraint("pipeline_second_coder_states_pk", ["project_n", "check_id"])
    .execute();

  await db.schema
    .createTable("pipeline_claims")
    .ifNotExists()
    .addColumn("project_n", "integer")
    .addColumn("decision_id", "text")
    .addColumn("claim_json", "text")
    .addColumn("gate_status", "text")
    .addPrimaryKeyConstraint("pipeline_claims_pk", ["project_n", "decision_id"])
    .execute();
}

/** One transaction: the project's manifest row, plus one row per check and one row per claim. */
export async function recordProjectResult(db: Kysely<any>, input: ProjectResultInput): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
      .replaceInto("pipeline_project_results")
      .values({
        project_n: input.projectN,
        hn_id: input.hnId,
        model_id: input.modelId,
        prompt_hash: input.promptHash,
        codebook_version: input.codebookVersion,
        gate_sha: input.gateSha,
        snapshot_hashes_json: JSON.stringify(input.snapshotHashesInCollectionOrder),
        coding_attempts: input.codingAttempts,
        coding_all_unknown: input.codingAllUnknown ? 1 : 0,
        completed_at: new Date().toISOString(),
      })
      .execute();

    for (const c of input.checkStates) {
      await trx
        .replaceInto("pipeline_check_states")
        .values({
          project_n: input.projectN,
          check_id: c.checkId,
          proposed_state: c.proposedState,
          filtered_state: c.filteredState,
          span_ids_json: JSON.stringify(c.spanIds),
        })
        .execute();
    }

    for (const claim of input.claims) {
      await trx
        .replaceInto("pipeline_claims")
        .values({
          project_n: input.projectN,
          decision_id: claim.decisionId,
          claim_json: JSON.stringify(claim.claimJson),
          gate_status: claim.gateStatus,
        })
        .execute();
    }
  });
}

/** Replace a project's second-coder states with exactly `input.checkStates`. */
export async function recordSecondCoding(
  db: Kysely<any>,
  projectN: number,
  input: { modelId: string; allUnknown: boolean; checkStates: CheckStateRecord[] },
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("pipeline_second_coder_states").where("project_n", "=", projectN).execute();
    for (const c of input.checkStates) {
      await trx
        .insertInto("pipeline_second_coder_states")
        .values({
          project_n: projectN,
          check_id: c.checkId,
          model_id: input.modelId,
          proposed_state: c.proposedState,
          filtered_state: c.filteredState,
          span_ids_json: JSON.stringify(c.spanIds),
          coding_all_unknown: input.allUnknown ? 1 : 0,
        })
        .execute();
    }
  });
}

/** EVD-05/CDB-02: set (or clear) the project-level missing-data flag. */
export async function recordMissingData(db: Kysely<any>, projectN: number, missingData: boolean): Promise<void> {
  await db
    .updateTable("pipeline_project_results")
    .set({ missing_data: missingData ? 1 : 0 })
    .where("project_n", "=", projectN)
    .execute();
}

/** D-41: replace a project's flagged spans with exactly `flags` (never accumulates across re-runs). */
export async function recordInjectionFlags(db: Kysely<any>, projectN: number, flags: { spanId: string }[]): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("pipeline_injection_flags").where("project_n", "=", projectN).execute();
    for (const f of flags) {
      await trx.replaceInto("pipeline_injection_flags").values({ project_n: projectN, span_id: f.spanId }).execute();
    }
  });
}

/** D-45: open a confirmation-timing window for a project. */
export async function startConfirmation(db: Kysely<any>, projectN: number): Promise<void> {
  await db
    .replaceInto("pipeline_confirmation_log")
    .values({ project_n: projectN, started_at: new Date().toISOString(), ended_at: null })
    .execute();
}

/** D-45: close the confirmation-timing window, leaving started_at untouched. */
export async function endConfirmation(db: Kysely<any>, projectN: number): Promise<void> {
  await db
    .updateTable("pipeline_confirmation_log")
    .set({ ended_at: new Date().toISOString() })
    .where("project_n", "=", projectN)
    .execute();
}

export type TallyCounts = { pass: number; fail: number; unknown: number; claimed: number };
export interface TallyRow {
  checkId: string;
  counts: TallyCounts;
  total: number;
}

/**
 * Per-check tally over recorded projects, iterated in `gateFile`'s own
 * canonical checkIds order (decisions object-key order, then requiredChecks
 * array order within each decision) — never an arbitrary SQL result order.
 * Optional `projectNs` scopes the count to that slice (real N for a bulk run).
 */
export async function readTally(
  db: Kysely<any>,
  gateFile: { checkIds: string[] },
  opts?: { projectNs?: number[] },
): Promise<TallyRow[]> {
  let query = db.selectFrom("pipeline_check_states").select(["check_id", "filtered_state", "project_n"]);
  if (opts?.projectNs && opts.projectNs.length > 0) {
    query = query.where("project_n", "in", opts.projectNs) as typeof query;
  }
  const rows = await query.execute();

  const byCheck = new Map<string, TallyCounts>();
  for (const checkId of gateFile.checkIds) byCheck.set(checkId, { pass: 0, fail: 0, unknown: 0, claimed: 0 });

  for (const row of rows) {
    const counts = byCheck.get(row.check_id as string);
    if (!counts) continue; // a check id from a stale/different gate file — not part of this tally
    const state = row.filtered_state as string;
    if (state === "pass" || state === "fail" || state === "unknown" || state === "claimed") {
      counts[state] += 1;
    }
  }

  return gateFile.checkIds.map((checkId) => {
    const counts = byCheck.get(checkId) as TallyCounts;
    const total = counts.pass + counts.fail + counts.unknown + counts.claimed;
    return { checkId, counts, total };
  });
}
