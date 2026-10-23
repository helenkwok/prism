// PUB-03: the export boundary. The only module that writes a release.
//
//   node src/publish/export.ts --store <fixture.json> --out <dir>
//
// aggregate -> release model -> closure + exact audit (protocol section 6) ->
// release.json + manifest.json per version and ledger.json at the top, written
// into a temp sibling of <dir> and renamed into place. Every refusal happens
// before anything is written. Prints one EXPORT or EXPORT REFUSED line.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { auditRelease, buildRelease, closeRelease, solverVersion } from "../../protocol/disclosure/audit.mjs";
import { loadCodebook } from "../pipeline/coding/codebook-prompt.ts";
import { loadFixture, type AggregateInput, type LedgerEntry } from "./aggregate.ts";
import { buildTables, renderFigures, toTruth, type Constraint, type Release, type Truth } from "./release-model.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export class RefusalError extends Error {
  rule: string;
  detail: string;
  constructor(rule: string, detail = "") {
    super(`${rule} ${detail}`.trim());
    this.name = "RefusalError";
    this.rule = rule;
    this.detail = detail;
  }
}

type Display = Map<string, "lt10" | "suppressed">;

/** Split a release into row-connected components (no row crosses two of them). */
export function components(release: Release): Release[] {
  const parent = new Map(release.tuples.map((t) => [t.id, t.id]));
  const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
  const rows = [...release.constraints, ...release.previous.flat()];
  for (const r of rows) {
    const ids = [...r.terms.map((t) => t.id), ...(r.requires ?? [])];
    for (const id of ids.slice(1)) parent.set(find(id), find(ids[0]));
  }
  const groups = new Map<string, Release>();
  for (const t of release.tuples) {
    const root = find(t.id);
    if (!groups.has(root)) groups.set(root, { tuples: [], constraints: [], previous: [[]] });
    groups.get(root)!.tuples.push(t);
  }
  for (const r of release.constraints) groups.get(find(r.terms[0].id))!.constraints.push(r);
  for (const r of release.previous.flat()) groups.get(find(r.terms[0].id))!.previous[0].push(r);
  return [...groups.values()];
}

const one = (id: string, sense: "<=" | ">=" | "=", rhs: number): Constraint => ({ terms: [{ id, coef: 1 }], sense, rhs });

export interface Secured {
  release: Release;
  display: Display;
  added: string[];
  components: number;
}

/**
 * Primary rule, then closure under the interior prior with display rows (a shown "<10" is c <= 9, a shown
 * "suppressed" is c >= 10; research Pitfall 2) until stable, then the audit under both priors.
 * Ledger entries become previous equality rows; a pinned tuple that would be suppressed refuses.
 */
export async function secure(
  truth: Truth,
  { ledger = [] as LedgerEntry[], display: withDisplay = true, split = true } = {},
): Promise<Secured> {
  const base: Release = structuredClone(buildRelease(truth));
  const trueC = new Map(truth.tuples.map((t) => [t.id, t.c]));
  const display: Display = new Map();
  for (const t of base.tuples) if (t.c === null) display.set(t.id, trueC.get(t.id)! < 10 ? "lt10" : "suppressed");

  const byId = new Map(base.tuples.map((t) => [t.id, t]));
  const ledgerIds = new Set(ledger.map((e) => e.id));
  const pinned = [...ledgerIds].filter((id) => byId.get(id)?.c == null).sort();
  if (pinned.length) throw new RefusalError("ledger-pinned", pinned.join(","));
  base.previous = [ledger.map((e) => one(e.id, "=", e.c))];

  const parts = split ? components(base) : [base];
  const out: Release = { tuples: [], constraints: [], previous: [[]] };
  const added: string[] = [];
  for (const part of parts) {
    let model = part;
    const rowed = new Set<string>();
    let audit;
    for (;;) {
      if (withDisplay) {
        for (const t of model.tuples) {
          if (t.c !== null || rowed.has(t.id)) continue;
          rowed.add(t.id);
          model.constraints.push(display.get(t.id) === "lt10" ? one(t.id, "<=", 9) : one(t.id, ">=", 10));
        }
      }
      let closed;
      try {
        closed = await closeRelease(model, { complementaryPrior: "interior" });
      } catch (err) {
        const msg = (err as Error).message;
        const hit = [...ledgerIds].filter((id) => msg.includes(id));
        if (hit.length) throw new RefusalError("ledger-pinned", hit.sort().join(","));
        throw new RefusalError("audit-failed", msg);
      }
      for (const id of closed.added) display.set(id, "suppressed");
      const hit = closed.added.filter((id: string) => ledgerIds.has(id));
      if (hit.length) throw new RefusalError("ledger-pinned", hit.sort().join(","));
      added.push(...closed.added);
      model = closed.release;
      audit = closed.audit;
      if (!withDisplay || closed.added.length === 0) break;
    }
    const all = await auditRelease(model); // default prior "all"
    if (!audit.pass || !all.pass) throw new RefusalError("audit-failed", [...audit.failing, ...all.failing].join(","));
    out.tuples.push(...model.tuples);
    out.constraints.push(...model.constraints);
    out.previous[0].push(...model.previous.flat());
  }
  // keep the input tuple order so output does not depend on the split
  const order = new Map(truth.tuples.map((t, i) => [t.id, i]));
  out.tuples.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return { release: out, display, added, components: parts.length };
}

/** Realpath of p, resolving through the nearest existing ancestor when p does not exist yet. */
function real(p: string): string {
  const abs = path.resolve(p);
  if (fs.existsSync(abs)) return fs.realpathSync.native(abs);
  const parent = path.dirname(abs);
  return parent === abs ? abs : path.join(real(parent), path.basename(abs));
}

function hasContextTag(x: unknown): boolean {
  if (Array.isArray(x)) return x.some(hasContextTag);
  if (x && typeof x === "object") return (x as { tag?: unknown }).tag === "context" || Object.values(x).some(hasContextTag);
  return false;
}

/** Refusals that need no tuple: run before anything is aggregated. */
export function refuseInput(input: AggregateInput, outDir: string): void {
  if (input.synthetic) {
    const pd = real(path.join(REPO, "public-data"));
    const out = real(outDir);
    if (out === pd || out.startsWith(pd + path.sep)) throw new RefusalError("fixture-into-public-data", "synthetic store");
  }
  if (hasContextTag(input)) throw new RefusalError("context-record", "a record tagged context reached the export");
  const bad = input.published.filter((s) => s.basis === "unconfirmed" || s.basis === "stale");
  if (bad.length) throw new RefusalError("unconfirmed-positive", [...new Set(bad.map((s) => s.basis))].sort().join(","));
  const gated = new Set(input.gate.checks.map((g) => g.checkId));
  const missing = input.checkIds.filter((id) => !gated.has(id));
  if (missing.length) throw new RefusalError("gate-missing", missing.join(","));
}

const json = (x: unknown) => `${JSON.stringify(x, null, 2)}\n`;
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

function readLedger(outDir: string): LedgerEntry[] {
  const f = path.join(outDir, "ledger.json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : [];
}

export async function exportRelease({
  input,
  outDir,
  ledger,
  split = true,
}: {
  input: AggregateInput;
  outDir: string;
  ledger?: LedgerEntry[];
  split?: boolean;
}) {
  const t0 = performance.now();
  refuseInput(input, outDir);
  const prior = ledger ?? [...input.ledger, ...readLedger(outDir)];
  const tables = buildTables(input);
  const secured = await secure(toTruth(tables), { ledger: prior, split });
  const { version, date } = input.release;
  const kind = input.synthetic ? "fixture" : "findings";
  const codebook = loadCodebook(path.join(REPO, "codebook.md"));
  const labels = Object.fromEntries(Object.entries(codebook.checks).map(([id, c]) => [id, c.label]));
  const n = input.projects.filter((p) => p.tag === "sample").length;
  const release = { schema: 1, kind, version, date, n, figures: renderFigures(secured.release, secured.display, tables, labels) };
  const releaseText = json(release);
  const suppressed = secured.release.tuples.filter((t) => t.c === null);
  const audit = {
    tuples: secured.release.tuples.length,
    suppressed: suppressed.length,
    primary: suppressed.filter((t) => t.suppression !== "complementary").length,
    complementary: suppressed.filter((t) => t.suppression === "complementary").length,
    added: secured.added,
    priors: ["all", "interior"],
    pass: true,
    solver: solverVersion(),
    components: secured.components,
  };
  const manifest = { version, kind, date, files: { "release.json": sha256(releaseText) }, audit };
  const known = new Set(prior.map((e) => e.id));
  const ledgerOut: LedgerEntry[] = [
    ...prior,
    ...secured.release.tuples.filter((t) => t.c !== null && !known.has(t.id)).map((t) => ({ id: t.id, n: t.n, c: t.c as number, version })),
  ];

  // Write: temp sibling first, then rename into place. A failure removes the temp dir.
  fs.mkdirSync(path.dirname(path.resolve(outDir)), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(path.dirname(path.resolve(outDir)), `.${path.basename(outDir)}.tmp-`));
  try {
    fs.mkdirSync(path.join(tmp, version));
    fs.writeFileSync(path.join(tmp, version, "release.json"), releaseText);
    fs.writeFileSync(path.join(tmp, version, "manifest.json"), json(manifest));
    fs.writeFileSync(path.join(tmp, "ledger.json"), json(ledgerOut));
    fs.mkdirSync(outDir, { recursive: true });
    fs.rmSync(path.join(outDir, version), { recursive: true, force: true });
    fs.renameSync(path.join(tmp, version), path.join(outDir, version));
    fs.renameSync(path.join(tmp, "ledger.json"), path.join(outDir, "ledger.json"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const line = {
    version,
    kind,
    tuples: audit.tuples,
    suppressed: audit.suppressed,
    added: secured.added.length,
    audit: "pass(all,interior)",
    ms: Math.round(performance.now() - t0),
  };
  return { line, release, manifest, ledger: ledgerOut };
}

async function main(argv: string[]): Promise<number> {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const store = arg("--store");
  const out = arg("--out");
  if (!store || !out) {
    console.error("usage: node src/publish/export.ts --store <fixture.json> --out <dir>");
    return 2;
  }
  try {
    const { line } = await exportRelease({ input: loadFixture(store), outDir: out });
    console.log(`EXPORT: ${JSON.stringify(line)}`);
    return 0;
  } catch (err) {
    if (err instanceof RefusalError) {
      console.log(`EXPORT REFUSED: ${err.rule} ${err.detail}`);
      return 1;
    }
    throw err;
  }
}

if (process.argv[1] && fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
