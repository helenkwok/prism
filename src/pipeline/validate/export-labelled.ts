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
import { projectSpans } from "../confirm/confirm.ts";

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

export async function exportLabelled(opts: ExportLabelledOpts): Promise<ExportLabelledResult> {
  const version = opts.version ?? "v1.0";
  const outPath = resolveOutPath(opts.dataDir, version, opts.out);
  const validate = compileValidator(opts.schemaPath ?? SCHEMA_PATH);
  const ns = opts.sampleNs.length ? opts.sampleNs : [-1];

  const lines: string[] = [];
  let confirmation = 0;
  let gold = 0;
  let edit = 0;

  const tables = await opts.db.introspection.getTables();
  const has = (name: string) => tables.some((t) => t.name === name);

  if (has("pipeline_confirmations")) {
    const rows = await opts.db
      .selectFrom("pipeline_confirmations")
      .selectAll()
      .where("project_n", "in", ns)
      .execute();
    for (const r of rows as any[]) {
      const byId = spanMap(opts.dataDir, r.project_n);
      const spanIds: string[] = JSON.parse(r.span_ids_json);
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
          provider: r.confirmer_kind === "agent" ? "nebius" : null,
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
    let q = opts.db.selectFrom("pipeline_gold_labels").selectAll().where("project_n", "in", ns);
    q = q.where("codebook_version", "=", opts.codebookVersion) as typeof q;
    const rows = await q.execute();
    for (const r of rows as any[]) {
      const byId = spanMap(opts.dataDir, r.project_n);
      const spanIds: string[] = JSON.parse(r.span_ids_json);
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
          provider: r.provider,
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
      const byId = spanMap(opts.dataDir, r.project_n);
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
  return { confirmation, gold, edit, path: outPath };
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
