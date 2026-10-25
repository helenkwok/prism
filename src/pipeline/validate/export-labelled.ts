// D-59: export confirmations, gold labels and edits as schema-valid JSONL
// under the private store. Data never enters the repo.
//
//   node src/pipeline/validate/export-labelled.ts [--sample sample-projects.json] [--version v1.0] [--out path]

import fs from "node:fs";
import path from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { Kysely } from "kysely";

import { resolveDataDir, getDb } from "../../app/server/db.ts";
import { assertOutsideRepo, resolveRepoRoot } from "../../../scripts/check-data-dir.mjs";
import { loadCodebook } from "../coding/codebook-prompt.ts";
import { confirmationMatches, effectiveStates, spansDigest, projectSpans } from "../confirm/confirm.ts";

const SCHEMA_PATH = path.join(process.cwd(), "protocol", "labelled-dataset.schema.json");

export type ExportLabelledOpts = {
  db: Kysely<any>;
  dataDir: string;
  sampleNs: number[];
  codebookVersion: string;
  version?: string;
  out?: string;
  schemaPath?: string;
};

export type ExportLabelledResult = {
  confirmation: number;
  gold: number;
  edit: number;
  path: string;
  excluded: {
    confirmationStale: number;
    goldStale: number;
    goldCodebook: number;
    goldNoGold: number;
    goldMissingOutcome: number;
  };
};

function compileValidator(schemaPath: string) {
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

function resolveOutPath(dataDir: string, version: string, out: string | undefined): string {
  const target = out ?? path.join(dataDir, "exports", `labelled-${version}.jsonl`);
  const resolved = path.resolve(target);
  const repoRoot = resolveRepoRoot(process.cwd());
  // Refuse any path inside the repo (T-04-27). assertOutsideRepo throws when nested under repo.
  assertOutsideRepo(path.dirname(resolved), repoRoot);
  return resolved;
}

function quotesFor(spanIds: string[], byId: Map<string, string>) {
  return spanIds.map((spanId) => ({ spanId, text: byId.get(spanId) ?? "" }));
}

function spanMap(dataDir: string, projectN: number): Map<string, string> {
  try {
    return new Map(projectSpans(dataDir, projectN).map((s) => [s.id, s.text]));
  } catch {
    return new Map();
  }
}

function confirmationProvider(row: any): string | null {
  if (row.confirmer_kind !== "agent") return null;
  if (row.confirmer_id.startsWith("agent:ollama:")) return "ollama";
  if (row.confirmer_id.startsWith("agent:nebius:") ||
      (row.confirmer_id === `agent:${row.model_id}` && row.model_id?.startsWith("nvidia/"))) return "nebius";
  return null;
}

export async function exportLabelled(opts: ExportLabelledOpts): Promise<ExportLabelledResult> {
  if (fs.realpathSync(opts.dataDir).split(path.sep).some(part => /^(?:backups?|archives?)$/i.test(part))) {
    throw new Error("refusing labelled export from an archived or backup store");
  }
  const codebook = loadCodebook();
  if (codebook.codebookVersion !== opts.codebookVersion) throw new Error("export codebook version is not current");
  const version = opts.version ?? "v1.0";
  const outPath = resolveOutPath(opts.dataDir, version, opts.out);
  const validate = compileValidator(opts.schemaPath ?? SCHEMA_PATH);
  const ns = opts.sampleNs.length ? opts.sampleNs : [-1];

  const lines: string[] = [];
  let confirmation = 0;
  let gold = 0;
  let edit = 0;
  const excluded = { confirmationStale: 0, goldStale: 0, goldCodebook: 0, goldNoGold: 0, goldMissingOutcome: 0 };

  const tables = await opts.db.introspection.getTables();
  const has = (name: string) => tables.some((t) => t.name === name);
  const states = has("pipeline_check_states") ? await effectiveStates(opts.db, ns) : [];
  const currentByCheck = new Map(states.map(state => [`${state.projectN}:${state.checkId}`, state]));
  const outcomes = has("pipeline_gold_outcomes")
    ? await opts.db.selectFrom("pipeline_gold_outcomes").selectAll().where("project_n", "in", ns).execute() : null;
  const flags = has("pipeline_injection_flags")
    ? await opts.db.selectFrom("pipeline_injection_flags").select(["project_n", "span_id"]).where("project_n", "in", ns).execute() : [];
  const flagsByProject = new Map<number, string[]>();
  for (const flag of flags as any[]) {
    const ids = flagsByProject.get(flag.project_n) ?? [];
    ids.push(flag.span_id);
    flagsByProject.set(flag.project_n, ids);
  }
  const spanCache = new Map<number, Map<string, string>>();
  const spansOf = (n: number) => {
    if (!spanCache.has(n)) spanCache.set(n, spanMap(opts.dataDir, n));
    return spanCache.get(n)!;
  };

  if (has("pipeline_confirmations")) {
    const rows = await opts.db
      .selectFrom("pipeline_confirmations")
      .selectAll()
      .where("project_n", "in", ns)
      .execute();
    for (const r of rows as any[]) {
      const byId = spansOf(r.project_n);
      const spanIds: string[] = JSON.parse(r.span_ids_json);
      const current = currentByCheck.get(`${r.project_n}:${r.check_id}`);
      const currentSpans = current?.spanIds.map(id => ({ id, text: byId.get(id) ?? "" })) ?? [];
      if (!current || !["pass", "claimed"].includes(current.filteredState) || currentSpans.some(span => !byId.has(span.id)) ||
          !confirmationMatches(r, { projectN: r.project_n, checkId: r.check_id, state: current.filteredState as "pass" | "claimed", spans: currentSpans,
            flaggedSpanIds: flagsByProject.get(r.project_n) ?? [] }, codebook, { editActorId: current.editActorId })) {
        excluded.confirmationStale += 1;
        continue;
      }
      const record = {
        kind: "confirmation" as const,
        projectN: r.project_n,
        checkId: r.check_id,
        spanIds,
        quotes: quotesFor(spanIds, byId),
        verdict: r.decision,
        state: r.confirmed_state,
        reason: r.reason ?? "",
        actor: {
          id: r.confirmer_id,
          kind: r.confirmer_kind === "person" ? ("person" as const) : ("agent" as const),
          provider: confirmationProvider(r),
          modelId: r.model_id,
        },
        timestamp: r.decided_at,
        codebookVersion: opts.codebookVersion,
        inputDigest: r.input_digest,
      };
      if (!validate(record)) {
        throw new Error(`confirmation record failed schema: ${JSON.stringify(validate.errors)}`);
      }
      lines.push(JSON.stringify(record));
      confirmation += 1;
    }
  }

  if (has("pipeline_gold_labels")) {
    const rows = await opts.db.selectFrom("pipeline_gold_labels").selectAll().where("project_n", "in", ns).execute();
    for (const r of rows as any[]) {
      const byId = spansOf(r.project_n);
      const spanIds: string[] = JSON.parse(r.span_ids_json);
      if (r.codebook_version !== opts.codebookVersion) { excluded.goldCodebook += 1; continue; }
      if (!byId.size || r.input_digest !== spansDigest([...byId].map(([id, text]) => ({ id, text }))) || spanIds.some(id => !byId.has(id))) {
        excluded.goldStale += 1;
        continue;
      }
      if (outcomes) {
        const outcome = outcomes.find((o: any) => o.project_n === r.project_n && o.codebook_version === r.codebook_version && o.labeller_id === r.labeller_id && o.input_digest === r.input_digest);
        if (!outcome) { excluded.goldMissingOutcome += 1; continue; }
        if (outcome.outcome !== "labelled") { excluded.goldNoGold += 1; continue; }
      }
      const record = {
        kind: "gold" as const,
        projectN: r.project_n,
        checkId: r.check_id,
        spanIds,
        quotes: quotesFor(spanIds, byId),
        verdict: r.filtered_state,
        state: r.filtered_state,
        reason: "",
        actor: {
          id: r.labeller_id,
          kind: r.labeller_kind === "person" ? ("person" as const) : ("agent" as const),
          provider: r.labeller_kind === "person" ? null : r.provider,
          modelId: r.model_id,
        },
        timestamp: r.labelled_at,
        codebookVersion: r.codebook_version,
        inputDigest: r.input_digest,
      };
      if (!validate(record)) {
        throw new Error(`gold record failed schema: ${JSON.stringify(validate.errors)}`);
      }
      lines.push(JSON.stringify(record));
      gold += 1;
    }
  }

  if (has("pipeline_edits")) {
    const rows = await opts.db.selectFrom("pipeline_edits").selectAll().where("project_n", "in", ns).execute();
    for (const r of rows as any[]) {
      const byId = spansOf(r.project_n);
      const spanIds: string[] = JSON.parse(r.span_ids_json);
      const record = {
        kind: "edit" as const,
        projectN: r.project_n,
        checkId: r.check_id,
        spanIds,
        quotes: quotesFor(spanIds, byId),
        verdict: r.filtered_state,
        state: r.filtered_state,
        reason: r.reason ?? "",
        actor: {
          id: r.actor_id,
          kind: r.actor_kind === "person" ? ("person" as const) : ("agent" as const),
          provider: null,
          modelId: null,
        },
        timestamp: r.edited_at,
        codebookVersion: opts.codebookVersion,
        inputDigest: r.input_digest,
      };
      if (!validate(record)) {
        throw new Error(`edit record failed schema: ${JSON.stringify(validate.errors)}`);
      }
      lines.push(JSON.stringify(record));
      edit += 1;
    }
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(outPath, lines.length ? lines.join("\n") + "\n" : "", { mode: 0o600 });
  fs.chmodSync(outPath, 0o600);
  return { confirmation, gold, edit, path: outPath, excluded };
}

function parseArgs(argv: string[]) {
  const out: { sample?: string; version?: string; out?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--sample" && argv[i + 1]) out.sample = argv[++i];
    else if (argv[i] === "--version" && argv[i + 1]) out.version = argv[++i];
    else if (argv[i] === "--out" && argv[i + 1]) out.out = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = resolveDataDir();
  const db = getDb();
  let sampleNs: number[] = [];
  const samplePath = args.sample ?? path.join(dataDir, "pipeline", "sample-projects.json");
  if (fs.existsSync(samplePath)) {
    sampleNs = (JSON.parse(fs.readFileSync(samplePath, "utf8")) as { n: number }[]).map((e) => e.n);
  }
  const codebook = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "codebook.md"), "utf8").match(/```json\s*\n([\s\S]*?)\n```/)?.[1] ?? "{}",
  );
  const result = await exportLabelled({
    db,
    dataDir,
    sampleNs,
    codebookVersion: codebook.codebookVersion ?? "v1.0",
    version: args.version ?? "v1.0",
    out: args.out,
  });
  console.log(`EXPORT: ${JSON.stringify(result)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
}
