// VAL-04 / D-58: per-project review trail for a person — read, edit, decide, blind-label.
// Plain .ts: db and dataDir as parameters, testable with in-memory Kysely.

import crypto from "node:crypto";
import path from "node:path";

import type { Kysely } from "kysely";

import { checkPromptText, loadCodebook, type Codebook } from "../coding/codebook-prompt.ts";
import { loadGateFile, resolveGatesPath, PROPOSED_STATES, type ProposedState } from "../coding/contract.ts";
import { applyQuoteOrUnknownFilter } from "../coding/filter.ts";
import {
  confirmedStateFor,
  ensureConfirmationSchema,
  ensureEditsSchema,
  inputDigest,
  projectSpans,
  publishedStates,
  recordConfirmation,
  spansDigest,
  type ConfirmDecisionKind,
} from "../confirm/confirm.ts";
import { ensureGoldSchema } from "../validate/gold.ts";

const STATES = new Set<string>(PROPOSED_STATES);

export type TrailOpts = { blind?: boolean; codebook?: Codebook; codebookPath?: string };

export type TrailCheck = {
  checkId: string;
  rule: string;
  spans: { id: string; text: string }[];
  model?: { proposed: string; filtered: string; spanIds: string[] };
  second?: { proposed: string; filtered: string; spanIds: string[]; modelId: string } | null;
  confirmations?: {
    decision: string;
    confirmedState: string | null;
    reason: string;
    actor: string;
    kind: string;
    decidedAt: string;
    inputDigest: string;
  }[];
  edits?: {
    state: string;
    filteredState: string;
    spanIds: string[];
    reason: string;
    actorId: string;
    editedAt: string;
    inputDigest: string;
  }[];
  gold?: {
    filteredState: string;
    spanIds: string[];
    labellerId: string;
    labellerKind: string;
  } | null;
  published?: { published: string | null; basis: string };
};

async function requireGoldUnlock(db: Kysely<any>, dataDir: string, projectN: number): Promise<string> {
  const digest = spansDigest(projectSpans(dataDir, projectN));
  const tables = await db.introspection.getTables();
  if (!tables.some((t) => t.name === "pipeline_gold_outcomes")) {
    throw new Error("awaiting gold");
  }
  const row = await db
    .selectFrom("pipeline_gold_outcomes")
    .select(["project_n", "input_digest", "outcome"])
    .where("project_n", "=", projectN)
    .where("input_digest", "=", digest)
    .executeTakeFirst();
  if (!row || (row as any).outcome === "no-gold" || (row as any).outcome === "excluded-a3") {
    throw new Error("awaiting gold");
  }
  return digest;
}

function editDigest(checkId: string, state: string, spanIds: string[], spans: { id: string; text: string }[]): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ checkId, state, spanIds, spans }))
    .digest("hex");
}

function loadCb(opts?: TrailOpts): Codebook {
  if (opts?.codebook) return opts.codebook;
  return loadCodebook(opts?.codebookPath ?? path.join(process.cwd(), "codebook.md"));
}

/** Per-check trail: blind mode omits model/second/confirmations/edits/gold/published keys entirely. */
export async function readTrail(
  db: Kysely<any>,
  dataDir: string,
  projectN: number,
  opts: TrailOpts = {},
): Promise<{ projectN: number; blind: boolean; checks: TrailCheck[] }> {
  const codebook = loadCb(opts);
  const gate = loadGateFile(resolveGatesPath());
  const spans = projectSpans(dataDir, projectN);
  const byId = new Map(spans.map((s) => [s.id, s.text]));
  const blind = Boolean(opts.blind);

  const modelRows = await db
    .selectFrom("pipeline_check_states")
    .selectAll()
    .where("project_n", "=", projectN)
    .execute()
    .catch(() => [] as any[]);

  const modelByCheck = new Map((modelRows as any[]).map((r) => [r.check_id as string, r]));

  let secondByCheck = new Map<string, any>();
  let confByCheck = new Map<string, any[]>();
  let editsByCheck = new Map<string, any[]>();
  let goldByCheck = new Map<string, any>();
  let publishedByCheck = new Map<string, { published: string | null; basis: string }>();

  if (!blind) {
    const tables = await db.introspection.getTables();
    if (tables.some((t) => t.name === "pipeline_second_coder_states")) {
      const seconds = await db
        .selectFrom("pipeline_second_coder_states")
        .selectAll()
        .where("project_n", "=", projectN)
        .execute();
      secondByCheck = new Map((seconds as any[]).map((r) => [r.check_id, r]));
    }
    if (tables.some((t) => t.name === "pipeline_confirmations")) {
      const confs = await db
        .selectFrom("pipeline_confirmations")
        .selectAll()
        .where("project_n", "=", projectN)
        .execute();
      for (const c of confs as any[]) {
        if (!confByCheck.has(c.check_id)) confByCheck.set(c.check_id, []);
        confByCheck.get(c.check_id)!.push(c);
      }
    }
    if (tables.some((t) => t.name === "pipeline_edits")) {
      const edits = await db
        .selectFrom("pipeline_edits")
        .selectAll()
        .where("project_n", "=", projectN)
        .execute();
      for (const e of edits as any[]) {
        if (!editsByCheck.has(e.check_id)) editsByCheck.set(e.check_id, []);
        editsByCheck.get(e.check_id)!.push(e);
      }
    }
    if (tables.some((t) => t.name === "pipeline_gold_labels")) {
      const golds = await db
        .selectFrom("pipeline_gold_labels")
        .selectAll()
        .where("project_n", "=", projectN)
        .execute();
      for (const g of golds as any[]) {
        goldByCheck.set(g.check_id, g);
      }
    }
    const published = await publishedStates(db, dataDir, codebook, [projectN]).catch(() => []);
    publishedByCheck = new Map(published.map((p) => [p.checkId, { published: p.published, basis: p.basis }]));
  }

  const checks: TrailCheck[] = gate.checkIds.map((checkId) => {
    const m = modelByCheck.get(checkId);
    const spanIds: string[] = m ? JSON.parse(m.span_ids_json) : [];
    const base: TrailCheck = {
      checkId,
      rule: checkPromptText(codebook, checkId),
      spans: spanIds.map((id) => ({ id, text: byId.get(id) ?? "" })),
    };
    if (blind) return base;

    const s = secondByCheck.get(checkId);
    const confs = confByCheck.get(checkId) ?? [];
    const edits = (editsByCheck.get(checkId) ?? []).sort((a, b) => String(a.edited_at).localeCompare(String(b.edited_at)));
    const g = goldByCheck.get(checkId);
    return {
      ...base,
      model: m
        ? {
            proposed: m.proposed_state,
            filtered: m.filtered_state,
            spanIds,
          }
        : { proposed: "unknown", filtered: "unknown", spanIds: [] },
      second: s
        ? {
            proposed: s.proposed_state,
            filtered: s.filtered_state,
            spanIds: JSON.parse(s.span_ids_json),
            modelId: s.model_id,
          }
        : null,
      confirmations: confs.map((c) => ({
        decision: c.decision,
        confirmedState: c.confirmed_state,
        reason: c.reason,
        actor: c.confirmer_id,
        kind: c.confirmer_kind,
        decidedAt: c.decided_at,
        inputDigest: c.input_digest,
      })),
      edits: edits.map((e) => ({
        state: e.state,
        filteredState: e.filtered_state,
        spanIds: JSON.parse(e.span_ids_json),
        reason: e.reason ?? "",
        actorId: e.actor_id,
        editedAt: e.edited_at,
        inputDigest: e.input_digest,
      })),
      gold: g
        ? {
            filteredState: g.filtered_state,
            spanIds: JSON.parse(g.span_ids_json),
            labellerId: g.labeller_id,
            labellerKind: g.labeller_kind,
          }
        : null,
      published: publishedByCheck.get(checkId) ?? { published: null, basis: "unconfirmed" },
    };
  });

  return { projectN, blind, checks };
}

export async function recordEdit(
  db: Kysely<any>,
  dataDir: string,
  input: {
    projectN: number;
    checkId: string;
    state: string;
    spanIds: string[];
    reason?: string;
    actorId: string;
  },
): Promise<{ filteredState: string; spanIds: string[]; inputDigest: string }> {
  await requireGoldUnlock(db, dataDir, input.projectN);
  const gate = loadGateFile(resolveGatesPath());
  if (!gate.checkIds.includes(input.checkId)) throw new Error(`unknown check id: ${input.checkId}`);
  if (!STATES.has(input.state)) throw new Error(`invalid state: ${input.state}`);

  const known = projectSpans(dataDir, input.projectN);
  const knownIds = new Set(known.map((s) => s.id));
  for (const id of input.spanIds) {
    if (!knownIds.has(id)) throw new Error(`unknown span id: ${id}`);
  }

  const [filtered] = applyQuoteOrUnknownFilter(
    [{ checkId: input.checkId, proposedState: input.state as ProposedState, spanIds: input.spanIds }],
    [...knownIds],
  );

  const spanTexts = input.spanIds.map((id) => ({ id, text: known.find((s) => s.id === id)?.text ?? "" }));
  const digest = editDigest(input.checkId, input.state, input.spanIds, spanTexts);

  await ensureEditsSchema(db);
  await db
    .insertInto("pipeline_edits")
    .values({
      project_n: input.projectN,
      check_id: input.checkId,
      state: input.state,
      filtered_state: filtered.proposedState,
      span_ids_json: JSON.stringify(filtered.spanIds),
      reason: input.reason ?? "",
      actor_id: input.actorId,
      actor_kind: "person",
      input_digest: digest,
      edited_at: new Date().toISOString(),
    })
    .execute();

  return { filteredState: filtered.proposedState, spanIds: filtered.spanIds, inputDigest: digest };
}

export async function recordPersonDecision(
  db: Kysely<any>,
  dataDir: string,
  input: {
    projectN: number;
    checkId: string;
    decision: ConfirmDecisionKind;
    reason: string;
    actorId: string;
    codebook?: Codebook;
  },
): Promise<void> {
  await requireGoldUnlock(db, dataDir, input.projectN);
  const codebook = input.codebook ?? loadCb();
  const gate = loadGateFile(resolveGatesPath());
  if (!gate.checkIds.includes(input.checkId)) throw new Error(`unknown check id: ${input.checkId}`);

  // Effective state: latest edit else model filtered.
  await ensureEditsSchema(db);
  await ensureConfirmationSchema(db);

  const model = await db
    .selectFrom("pipeline_check_states")
    .selectAll()
    .where("project_n", "=", input.projectN)
    .where("check_id", "=", input.checkId)
    .executeTakeFirst();
  if (!model) throw new Error(`no model state for ${input.checkId}`);

  const edits = await db
    .selectFrom("pipeline_edits")
    .selectAll()
    .where("project_n", "=", input.projectN)
    .where("check_id", "=", input.checkId)
    .execute();
  let latest: any = null;
  for (const e of edits as any[]) {
    if (!latest || String(e.edited_at) > String(latest.edited_at)) latest = e;
  }

  const state = (latest ? latest.filtered_state : (model as any).filtered_state) as "pass" | "claimed";
  const spanIds: string[] = JSON.parse(latest ? latest.span_ids_json : (model as any).span_ids_json);
  const editActorId = latest ? (latest.actor_id as string) : null;

  if (editActorId && editActorId === input.actorId) {
    throw new Error("cannot decide on own edit");
  }
  if (input.decision === "downgraded" && state !== "pass") {
    throw new Error("downgrade only from pass");
  }
  if (state !== "pass" && state !== "claimed") {
    throw new Error(`not a positive: ${state}`);
  }

  const known = projectSpans(dataDir, input.projectN);
  const byId = new Map(known.map((s) => [s.id, s.text]));
  const positive = {
    projectN: input.projectN,
    checkId: input.checkId,
    state,
    spans: spanIds.map((id) => ({ id, text: byId.get(id) ?? "" })),
  };
  const digest = inputDigest(codebook, positive);

  await recordConfirmation(db, {
    projectN: input.projectN,
    checkId: input.checkId,
    decision: input.decision,
    confirmedState: confirmedStateFor(input.decision, state),
    reason: input.reason,
    confirmerId: input.actorId,
    confirmerKind: "person",
    modelId: null,
    decidedAt: new Date().toISOString(),
    inputDigest: digest,
    spanIds,
  });
}

export async function recordPersonGold(
  db: Kysely<any>,
  dataDir: string,
  input: {
    projectN: number;
    labels: { checkId: string; state: string; spanIds: string[]; reason?: string }[];
    actorId: string;
    codebookVersion: string;
  },
): Promise<void> {
  // Never reads model proposals — blind by construction.
  const gate = loadGateFile(resolveGatesPath());
  if (input.labels.length !== gate.checkIds.length) {
    throw new Error(`expected ${gate.checkIds.length} labels, got ${input.labels.length}`);
  }
  const byCheck = new Map(input.labels.map((l) => [l.checkId, l]));
  for (const id of gate.checkIds) {
    if (!byCheck.has(id)) throw new Error(`missing label for ${id}`);
  }

  const known = projectSpans(dataDir, input.projectN);
  const knownIds = [...new Set(known.map((s) => s.id))];
  const knownSet = new Set(knownIds);
  const digest = spansDigest(known);

  await ensureGoldSchema(db);
  const decidedAt = new Date().toISOString();

  await db.transaction().execute(async (trx) => {
    for (const checkId of gate.checkIds) {
      const label = byCheck.get(checkId)!;
      if (!STATES.has(label.state)) throw new Error(`invalid state: ${label.state}`);
      for (const id of label.spanIds) {
        if (!knownSet.has(id)) throw new Error(`unknown span id: ${id}`);
      }
      const [filtered] = applyQuoteOrUnknownFilter(
        [{ checkId, proposedState: label.state as ProposedState, spanIds: label.spanIds }],
        knownIds,
      );
      await trx
        .insertInto("pipeline_gold_labels")
        .values({
          project_n: input.projectN,
          check_id: checkId,
          codebook_version: input.codebookVersion,
          labeller_id: input.actorId,
          labeller_kind: "person",
          provider: null,
          model_id: null,
          reasoning: null,
          raw_state: label.state,
          filtered_state: filtered.proposedState,
          span_ids_json: JSON.stringify(filtered.spanIds),
          input_digest: digest,
          labelled_at: decidedAt,
        })
        .execute();
    }
    await trx
      .insertInto("pipeline_gold_outcomes")
      .values({
        project_n: input.projectN,
        codebook_version: input.codebookVersion,
        labeller_id: input.actorId,
        input_digest: digest,
        outcome: "labelled",
        reason: null,
        decided_at: decidedAt,
      })
      .execute();
  });
}
