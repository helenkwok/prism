// PUB-03: the export boundary. The only module that writes a release.
//
//   node src/publish/export.ts --store <fixture.json> --out <dir>
//
// aggregate -> one release model -> closure + exact audit (protocol section 6) ->
// sections and statements -> wording lint (PUB-04) -> serialize -> identifier scan
// (6.6) -> release.json + manifest.json per version and ledger.json at the top,
// written into a temp sibling of <dir> and renamed into place. Every refusal
// happens before anything is written. Prints one EXPORT or EXPORT REFUSED line.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FLOOR, MIN_VALUES, auditRelease, buildRelease, solverVersion } from "../../protocol/disclosure/audit.mjs";
import { loadCodebook } from "../pipeline/coding/codebook-prompt.ts";
import { wilson } from "../pipeline/validate/agreement.ts";
import { ADDENDUM, PROCESS_FIGURES } from "./a11.ts";
import { failingCells } from "./closure-audit.ts";
import {
  includedProjects,
  inconsistentDecisions,
  loadDecisionLabels,
  loadDecisionRules,
  loadFixture,
  tupleId,
  type AggregateInput,
  type LedgerEntry,
} from "./aggregate.ts";
import { h2Permutation, testHypotheses } from "./hypotheses.ts";
import { scanTexts, buildIdentifierSet } from "./identifiers.ts";
import { lintStatements } from "./lint.ts";
import {
  PARTITION_LABEL,
  NOT_ESTIMABLE_NOTE,
  QUARTERS,
  SOURCES,
  buildModel,
  buildTables,
  decTuple,
  renderFigures,
  rowResolver,
  type Constraint,
  type Model,
  type Release,
  type Row,
  type RowOf,
  type Truth,
} from "./release-model.ts";
import * as S from "./statements.ts";

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

/**
 * Split a release into independent parts. Published tuples are constants, so only suppressed tuples
 * link rows: a part is a set of suppressed tuples that share rows, with every row naming one of them
 * and every tuple those rows name. Rows naming no suppressed tuple belong to no part.
 */
export function components(release: Release): Release[] {
  const byId = new Map(release.tuples.map((t) => [t.id, t]));
  const parent = new Map<string, string>();
  for (const t of release.tuples) if (t.c === null) parent.set(t.id, t.id);
  const find = (x: string): string => {
    while (parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  const live = (r: Constraint) => [...r.terms.map((t) => t.id), ...(r.requires ?? [])].filter((id) => parent.has(id));
  const rows = [...release.constraints, ...release.previous.flat()];
  for (const r of rows) {
    const ids = live(r);
    for (const id of ids.slice(1)) parent.set(find(id), find(ids[0]!));
  }
  const groups = new Map<string, { ids: Set<string>; constraints: Constraint[]; previous: Constraint[] }>();
  for (const id of parent.keys()) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, { ids: new Set(), constraints: [], previous: [] });
    groups.get(root)!.ids.add(id);
  }
  const place = (r: Constraint, into: "constraints" | "previous") => {
    const ids = live(r);
    if (!ids.length) return;
    const g = groups.get(find(ids[0]!))!;
    g[into].push(r);
    for (const t of r.terms) g.ids.add(t.id);
  };
  for (const r of release.constraints) place(r, "constraints");
  for (const r of release.previous.flat()) place(r, "previous");
  return [...groups.values()].map((g) => ({
    tuples: [...g.ids].map((id) => structuredClone(byId.get(id)!)),
    constraints: g.constraints,
    previous: [g.previous],
  }));
}

const one = (id: string, sense: "<=" | ">=" | "=", rhs: number): Constraint => ({ terms: [{ id, coef: 1 }], sense, rhs });
export interface Secured {
  release: Release;
  display: Display;
  added: string[];
  components: number;
}

/**
 * Primary rule, then closure (protocol 6.5) under the interior prior with display rows (a shown "<10" is
 * c <= 9, a shown "suppressed" is c >= 10; research Pitfall 2), then the reference audit under both priors.
 * Ledger entries become previous equality rows; a pinned tuple that would be suppressed refuses.
 *
 * Closure is one global loop with closeRelease's rule: suppress the published tuple with the smallest count
 * in a row with a failing cell (ties by id), then test again. Suppressing a published tuple only widens what
 * the reader can complete (its true value stays possible), so a passing cell keeps passing and each step
 * re-tests only the failing cells and the new one. With split, cells are tested inside their independent
 * part (published tuples are constants, so only suppressed tuples link rows); the result is the same as the
 * whole model and the solves are smaller. The final pass of every part is the reference auditRelease.
 */
export async function secure(
  truth: Truth,
  { ledger = [] as LedgerEntry[], display: withDisplay = true, split = true } = {},
): Promise<Secured> {
  let base: Release;
  try {
    base = structuredClone(buildRelease(truth));
  } catch (err) {
    throw new RefusalError("inconsistent-input", (err as Error).message);
  }
  const trueC = new Map(truth.tuples.map((t) => [t.id, t.c]));
  const display: Display = new Map();
  for (const t of base.tuples) if (t.c === null) display.set(t.id, trueC.get(t.id)! < 10 ? "lt10" : "suppressed");

  const byId = new Map(base.tuples.map((t) => [t.id, t]));
  const ledgerIds = new Set(ledger.map((e) => e.id));
  const pinned = [...ledgerIds].filter((id) => byId.has(id) && byId.get(id)!.c == null).sort();
  if (pinned.length) throw new RefusalError("ledger-pinned", pinned.join(","));
  base.previous = [ledger.filter((e) => byId.has(e.id)).map((e) => one(e.id, "=", e.c))];
  const addDisplay = (id: string) => {
    if (withDisplay) base.constraints.push(display.get(id) === "lt10" ? one(id, "<=", 9) : one(id, ">=", 10));
  };
  for (const t of base.tuples) if (t.c === null) addDisplay(t.id);

  const guard = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (err) {
      const msg = (err as Error).message;
      const hit = [...ledgerIds].filter((id) => msg.includes(id));
      if (hit.length) throw new RefusalError("ledger-pinned", hit.sort().join(","));
      throw new RefusalError("audit-failed", msg);
    }
  };
  const parts = () => (split ? components(base) : [base]);
  /** Failing cells among `ids` (every suppressed cell when omitted), each tested in its own part. */
  const check = async (ids?: Set<string>) => {
    const out: string[] = [];
    for (const part of parts()) {
      const want = part.tuples.filter((t) => t.c === null && (!ids || ids.has(t.id))).map((t) => t.id);
      if (want.length) out.push(...(await guard(() => failingCells(part, { complementaryPrior: "interior", ids: want }))));
    }
    return out;
  };
  // the JS signature's inferred options type omits complementaryPrior (06-01 deviation 2)
  const audit = auditRelease as (r: Release, o?: object) => ReturnType<typeof auditRelease>;

  // rows naming each tuple (display rows name only suppressed tuples, so they never hold a candidate)
  const rowsOf = new Map<string, Constraint[]>();
  for (const r of [...base.constraints, ...base.previous.flat()]) for (const t of r.terms) rowsOf.set(t.id, [...(rowsOf.get(t.id) ?? []), r]);
  const usable = (r: Constraint) => !(r.requires ?? []).some((id) => byId.get(id)?.c === null);

  // failing: every cell that may still fail (a superset: cells only ever go from failing to passing);
  // known: cells re-tested since the last suppression in their part, so known to fail now
  const failing = new Set(await check());
  const known = new Set(failing);
  const added: string[] = [];
  let final: Release[] = [];
  for (;;) {
    while (failing.size) {
      const candidates = new Set<string>();
      for (const id of failing) for (const r of rowsOf.get(id) ?? []) if (usable(r)) for (const t of r.terms) if (byId.get(t.id)!.c !== null) candidates.add(t.id);
      let pick: string | undefined;
      // the smallest candidate whose rows hold a cell that really fails is the rule's pick: it is the
      // smallest over a superset of the true candidates and is itself a true candidate
      for (const x of [...candidates].sort((a, b) => byId.get(a)!.c! - byId.get(b)!.c! || (a < b ? -1 : 1))) {
        const cells = new Set<string>();
        for (const r of rowsOf.get(x)!) if (usable(r)) for (const t of r.terms) if (failing.has(t.id)) cells.add(t.id);
        const unsure = [...cells].filter((id) => !known.has(id));
        if (unsure.length) {
          const still = new Set(await check(new Set(unsure)));
          for (const id of unsure) {
            if (still.has(id)) known.add(id);
            else failing.delete(id);
          }
        }
        if ([...cells].some((id) => failing.has(id))) {
          pick = x;
          break;
        }
      }
      if (!pick) {
        // no candidate is justified: re-test what is left; anything still failing cannot be closed
        const still = await check(new Set(failing));
        if (still.length) throw new RefusalError("audit-failed", `cannot close release: ${still.join(", ")}`);
        failing.clear();
        break;
      }
      if (ledgerIds.has(pick)) throw new RefusalError("ledger-pinned", pick);
      Object.assign(byId.get(pick)!, { c: null, suppression: "complementary" });
      display.set(pick, "suppressed");
      addDisplay(pick);
      added.push(pick);
      // cells in the pick's part may now pass; the new cell may fail
      const near = (split ? components(base) : [base]).find((p) => p.tuples.some((t) => t.id === pick))!;
      for (const t of near.tuples) known.delete(t.id);
      failing.add(pick);
    }
    // the reference audit decides, part by part, under both priors; a disagreement closes on its cells
    final = parts();
    for (const part of final) {
      const interior = await guard(() => audit(part, { complementaryPrior: "interior" }));
      if (!interior.pass) {
        for (const id of interior.failing) failing.add(id), known.add(id);
        continue;
      }
      const all = await guard(() => audit(part));
      if (!all.pass) throw new RefusalError("audit-failed", all.failing.join(","));
    }
    if (!failing.size) break;
  }

  // keep the input tuple order so output does not depend on the split
  const order = new Map(truth.tuples.map((t, i) => [t.id, i]));
  base.tuples.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return { release: base, display, added, components: final.length };
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
export function refuseInput(input: AggregateInput, outDir: string, rules = loadDecisionRules()): void {
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
  const absent = (["validation", "screening", "roles"] as const).filter((k) => !input[k]);
  if (absent.length) throw new RefusalError("input-missing", absent.join(","));
  const inconsistent = inconsistentDecisions(input, rules);
  if (inconsistent.length) throw new RefusalError("inconsistent-input", `${inconsistent.length} decision(s) contradict a required check`);
}

const json = (x: unknown) => `${JSON.stringify(x, null, 2)}\n`;
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const r1 = (x: number) => Math.round(10 * x) / 10;
const r2 = (x: number) => Math.round(100 * x) / 100;
const r3 = (x: number) => Math.round(1000 * x) / 1000;

function readLedger(outDir: string): LedgerEntry[] {
  const f = path.join(outDir, "ledger.json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : [];
}

const PRISMA_LABEL: Record<string, string> = {
  identified: "Records identified in the sampling frame",
  screened: "Records screened",
  assessed: "Assessed on the text of their own page",
  included: "Included",
  "included-insufficient-text": "Included with too little page text to judge",
  other: "Other reasons (each under ten, merged)",
};
const prismaLabel = (k: string) =>
  PRISMA_LABEL[k] ?? (k.startsWith("not-collectable:") ? `Not collectable: ${k.slice(16)}` : `Excluded at stage ${k.slice(5, 6)}: ${k.slice(7)}`);

/** Everything in release.json besides schema, kind, version, date and n. */
function sections(input: AggregateInput, model: Model, row: RowOf, version: string) {
  const codebook = loadCodebook(path.join(REPO, "codebook.md"));
  const lab = input.labels ?? {};
  const labels = Object.fromEntries(Object.entries(codebook.checks).map(([id, c]) => [id, lab[id] ?? c.label]));
  const checkDecision = Object.fromEntries(Object.entries(codebook.checks).map(([id, c]) => [id, c.decision]));
  const decisionLabels = Object.fromEntries(Object.entries(loadDecisionLabels()).map(([id, l]) => [id, lab[`decision:${id}`] ?? l]));
  const { tables, n } = model;
  const statements: S.Statement[] = [];
  const say = (...s: S.Statement[]) => statements.push(...s);
  const released = (r: Row) => r.state === "released";

  const figures = renderFigures(model, row, labels, checkDecision, decisionLabels);

  // findings sentences for released rows only
  for (const c of tables.checkIds.filter((id) => tables.publishable.has(id))) {
    const pass = row(tupleId(c, "pass", "all"), labels[c]!);
    const claimed = row(tupleId(c, "claimed", "all"), labels[c]!);
    if (released(pass)) say(S.shareSentence({ c: pass.c!, n: pass.n!, checkId: c, pct: pass.pct!, ci: pass.ci! }));
    if (released(pass) && released(claimed)) say(S.claimsSentence({ c: claimed.c!, x: pass.c!, n: pass.n!, checkId: c, p: claimed.pct!, q: pass.pct! }));
  }
  for (const d of model.decisionIds) {
    const r = row(decTuple(d, "all"), decisionLabels[d]!);
    if (released(r)) say(S.decisionSentence({ c: r.c!, n: r.n!, pct: r.pct!, ci: r.ci!, decisionId: d }));
  }

  // hypotheses (section 8): Holm across what was tested, R09 with the measured supported recall
  const v = input.validation!;
  const recall = v.collectionRecall.supportedFound / v.collectionRecall.supported;
  const passSet = new Set(input.published.filter((s) => s.published === "pass").map((s) => `${s.projectN}|${s.checkId}`));
  const pubIds = tables.checkIds.filter((id) => tables.publishable.has(id));
  const h2 = h2Permutation({
    projects: includedProjects(input).map((p) => ({ group: p.source, passes: pubIds.map((c) => passSet.has(`${p.n}|${c}`)) })),
    seed: input.seed ?? version,
    groups: SOURCES.map((p) => p.slice(4)),
  });
  const tested = testHypotheses({ h1: model.h1, h2, h3: model.h3, recall });
  const result = (id: string) => tested.tests.find((t) => t.id === id) as any;
  const HLABEL = { h1: "Launches that claim at least one check without linking an artefact", h3: "Launches that publicly evidence at least one rely-decision check" };
  const binomial = (id: "h1" | "h3") => {
    const t = result(id);
    const r = row(`${id}|all`, HLABEL[id]);
    if (released(r)) {
      say(S.hypothesisSentence(id, t));
      return {
        row: r,
        test: {
          p: t.p,
          pAdjusted: t.pAdjusted,
          rejected: t.rejected,
          sensitivity: { c: t.sensitivity.c, p: t.sensitivity.p, pAdjusted: t.sensitivity.pAdjusted, rejected: t.sensitivity.rejected },
          supported: t.supported,
        },
        statementId: `hypothesis:${id}`,
      };
    }
    // the count is suppressed: publish the decision only, no p value that could reveal it
    say(S.hypothesisWithheldSentence(id, t.supported));
    return { row: r, test: { rejected: t.rejected, sensitivity: { rejected: t.sensitivity.rejected }, supported: t.supported }, statementId: `hypothesis:${id}` };
  };
  let h2Out;
  if (h2.tested) {
    const t = result("h2");
    say(S.hypothesisSentence("h2", t));
    h2Out = { test: { tested: true, groups: h2.groups, p: t.p, pAdjusted: t.pAdjusted, rejected: t.rejected, V: r3(h2.V), B: h2.B, supported: t.supported }, statementId: "hypothesis:h2" };
  } else {
    say(S.h2DescriptiveLine());
    h2Out = { test: { tested: false, reason: h2.reason }, statementId: "method:h2-descriptive" };
  }
  const hypotheses = { alpha: tested.alpha, recall: r3(recall), h1: binomial("h1"), h2: h2Out, h3: binomial("h3") };

  // protocol section 3 sensitivity: excluding launches whose site could not be read
  const sensLabel = (id: string) => `${id.split("|").slice(0, -1).join("|")} excluding launches whose site could not be read`;
  const sensitivity = { excluded: model.excluded, rows: Object.fromEntries(model.sensIds.map((id) => [id, row(id, sensLabel(id))])) };
  say(S.sensitivityLine({ excluded: model.excluded }));

  // page copy around the figures
  say(S.cohortBanner(), ...QUARTERS.map((q) => S.cohortCaption(PARTITION_LABEL[q])), S.sourceTypesOverlap());
  for (const p of SOURCES) {
    const reason = tables.absent.get(p);
    if (reason) say({ ...S.absentRow(PARTITION_LABEL[p], reason), id: `absent:${p.slice(4)}` });
  }

  // PRISMA (merged reasons only)
  const pr = model.prisma;
  const prisma = {
    boxes: [
      { id: "identified", label: prismaLabel("identified"), count: pr.identified },
      { id: "screened", label: prismaLabel("screened"), count: pr.screened },
      ...pr.boxes.map((b) => ({ id: b, label: prismaLabel(b), row: row(`prisma|${b}`, prismaLabel(b)) })),
    ],
    exclusions: pr.exclusions.map((k) => ({ id: k, label: prismaLabel(k), row: row(`prisma|${k}`, prismaLabel(k)) })),
  };

  // How we know (D-74); the confirmation total and the person-edit count are D-83 process figures
  const role = (name: string) => input.roles!.find((r) => r.role === name);
  const labeller = role("independent labeller");
  const confirmer = role("confirmer");
  const agreement = Object.fromEntries(
    tables.checkIds.map((c) => {
      const g = tables.gate.get(c) as any;
      const shown = tables.publishable.has(c) && released(row(tupleId(c, "pass", "all"), ""));
      const notEstimable = g.status === "released-not-estimable";
      const precision = model.precision.includes(c)
        ? row(`prec|${c}`, `Pass precision: ${labels[c]}`)
        : ({ id: `prec|${c}`, label: `Pass precision: ${labels[c]}`, state: "not-estimable", reason: notEstimable ? NOT_ESTIMABLE_NOTE : "pass precision not estimable for this check" } as Row);
      return [c, { ac1: shown && g.ac1 != null ? r2(g.ac1) : null, ac1CI: shown && g.ac1CI ? g.ac1CI.map(r2) : null, precision, ...(notEstimable ? { status: "not-estimable", note: NOT_ESTIMABLE_NOTE } : {}) }];
    }),
  );
  const cf = model.confirmation;
  const edits = { count: input.edits?.length ?? 0, total: n * tables.checkIds.length };
  const howWeKnow = {
    n,
    labeller: { modelId: labeller?.modelId ?? null, host: labeller?.host ?? null, wording: "agreement with an independent labeller" },
    confirmer: { modelId: confirmer?.modelId ?? null, host: confirmer?.host ?? null },
    agreement,
    confirmation: {
      total: { changed: cf.changed, proposed: cf.proposed, pct: cf.proposed ? r1((100 * cf.changed) / cf.proposed) : 0 },
      rejected: row("conf|rejected", "Proposed positives rejected at confirmation"),
      downgraded: row("conf|downgraded", "Proposed passes downgraded to claimed at confirmation"),
      perCheck: Object.fromEntries(tables.checkIds.map((c) => [c, row(`conf|chk|${c}`, `Changed at confirmation: ${labels[c]}`)])),
    },
    personEdits: edits,
  };
  say(S.personEdits(edits));

  // methods
  const methods = {
    frame: input.method?.frame ?? null,
    window: input.method?.window ?? null,
    roles: input.roles!.map(({ role, kind, modelId, host, manifest }) => ({ role, kind, modelId, host, manifest })),
    disclosure: { floor: FLOOR, minValues: MIN_VALUES, priors: ["all", "interior"] },
    ledgerVersion: version,
    codebook: tables.checkIds.map((c) => ({
      checkId: c,
      shortTitle: labels[c],
      decisionId: checkDecision[c],
      relations: Object.entries(codebook.checks[c]!.crosswalk).flatMap(([standard, edges]) =>
        edges.map((e) => ({ standard, clause: e.locator, relation: e.relation_type })),
      ),
    })),
  };
  say(...S.methodStatements({ frame: methods.frame ?? "not recorded", window: methods.window ?? "not recorded", floor: FLOOR, minValues: MIN_VALUES, alpha: tested.alpha }));

  // validation (D-76) and limitations; screening audit and collection recall are D-83 process figures
  const sa = v.screeningAudit;
  const cr = v.collectionRecall;
  const [lo, hi] = wilson(sa.errors, sa.audited);
  const screeningPct = r1((100 * sa.errors) / sa.audited);
  const remeasurePct = r1((100 * sa.remeasureErrors) / sa.audited);
  const vis = row("vis|provider-only", "Launches whose evidence came only from provider-extracted text");
  const validation = {
    screeningAudit: {
      errors: sa.errors,
      audited: sa.audited,
      pct: screeningPct,
      ci: [r1(100 * lo), r1(100 * hi)],
      bar: sa.bar,
      remeasure: { errors: sa.remeasureErrors, pct: remeasurePct, exploratory: true },
      statementIds: ["limitation:screening", "exploratory:screening-remeasure"],
    },
    collectionRecall: {
      supportedFound: cr.supportedFound,
      supported: cr.supported,
      recall: r3(recall),
      contributed: cr.contributed,
      projects: cr.projects,
      rawFound: cr.rawFound,
      raw: cr.raw,
      rawRecall: r3(cr.rawFound / cr.raw),
      gathered: cr.gathered,
      gatheredSupported: cr.gatheredSupported,
      unsupported: cr.unsupported,
      boilerplate: cr.boilerplate,
      statementIds: ["limitation:recall", "limitation:gathered-items"],
    },
    crossCheck: { ...v.crossCheck, exploratory: true, statementId: "exploratory:collector-cross-check" },
    spanDefect: { exploratory: true, statementId: "limitation:whole-page-spans" },
    visibility: { row: vis, statementId: "limitation:provider-visibility" },
  };
  say(
    S.screeningLimitation({ errors: sa.errors, audited: sa.audited, pct: screeningPct, ci: validation.screeningAudit.ci as [number, number], bar: sa.bar }),
    S.screeningRemeasure({ pct: remeasurePct, audited: sa.audited, sample: sa.sample }),
    S.recallLimitation({ ...validation.collectionRecall }),
    S.gatheredItemsLimitation({ gathered: cr.gathered, supported: cr.gatheredSupported, unsupported: cr.unsupported, boilerplate: cr.boilerplate }),
    S.collectorChange(),
    S.collectorCrossCheck(v.crossCheck),
    S.wholePageSpanDefect(),
    S.agentRoles(
      input.roles!.map((r) => ({ role: r.role, model: r.modelId, host: r.host })),
      { noHumanEdits: edits.count === 0 },
    ),
    S.providerVisibility(),
    S.cohortSurvivorship(),
    S.notDone(),
    S.samplingFrameBias(),
  );

  // exploratory: the A4 community layer as aggregate tuples, or a one-line note (D-77); no worked case
  const exploratory = model.community
    ? { community: { rows: model.community.map((k) => row(`comm|${k}|all`, k)) }, statementId: "exploratory:community" }
    : { community: null, statementId: "exploratory:community" };
  say(S.communityNote(model.community !== null));

  for (const note of input.notes ?? []) say(note as S.Statement);

  return { figures, hypotheses, sensitivity, prisma, howWeKnow, methods, validation, exploratory, statements };
}

export async function exportRelease({
  input,
  outDir,
  ledger,
  split = true,
  sourceMinGroup,
}: {
  input: AggregateInput;
  outDir: string;
  ledger?: LedgerEntry[];
  split?: boolean;
  sourceMinGroup?: number;
}) {
  const t0 = performance.now();
  const rules = loadDecisionRules();
  refuseInput(input, outDir, rules);
  // fast path: hand-written text is linted and scanned before the solve; the full release is checked again below
  const ids = buildIdentifierSet({ projects: input.projects });
  const early = lintStatements((input.notes ?? []) as S.Statement[]);
  if (early.length) throw new RefusalError("lint", [...new Set(early.map((e) => `${e.id}:${e.rule}`))].join(","));
  if (scanTexts([{ file: "input text", text: JSON.stringify([input.labels ?? {}, input.notes ?? []]) }], ids).length) throw new RefusalError("identifier", "input text");
  const prior = ledger ?? [...input.ledger, ...readLedger(outDir)];
  const tables = buildTables(input, sourceMinGroup === undefined ? {} : { sourceMinGroup });
  const model = buildModel(input, tables, rules);
  const secured = await secure(model.truth, { ledger: prior, split });
  const { version, date } = input.release;
  const kind = input.synthetic ? "fixture" : "findings";
  const row = rowResolver(secured.release, secured.display);
  const body = sections(input, model, row, version);

  // PUB-04: every sentence passes the wording lint before anything is serialized
  const lint = lintStatements(body.statements);
  if (lint.length) throw new RefusalError("lint", [...new Set(lint.map((e) => `${e.id}:${e.rule}`))].join(","));

  const release = { schema: 1, kind, version, date, n: model.n, ...body };
  const releaseText = json(release);
  const known = new Set(prior.map((e) => e.id));
  const ledgerOut: LedgerEntry[] = [
    ...prior,
    ...secured.release.tuples.filter((t) => t.c !== null && !known.has(t.id)).map((t) => ({ id: t.id, n: t.n, c: t.c as number, version })),
  ];
  const ledgerText = json(ledgerOut);
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
  const manifest = {
    version,
    kind,
    date,
    files: { "release.json": sha256(releaseText) },
    audit,
    processFigures: PROCESS_FIGURES.map((f) => ({ id: f.id, reason: f.reason, addendum: ADDENDUM })),
    lint: { statements: body.statements.length, findings: body.statements.filter((s) => s.kind === "finding").length, errors: 0 },
    scan: { files: 3, hits: 0 },
  };
  const manifestText = json(manifest);

  // protocol 6.6 / D-77: every byte that would be written passes the identifier scan
  const hits = scanTexts(
    [
      { file: `${version}/release.json`, text: releaseText },
      { file: `${version}/manifest.json`, text: manifestText },
      { file: "ledger.json", text: ledgerText },
    ],
    ids,
  );
  if (hits.length) throw new RefusalError("identifier", [...new Set(hits.map((h) => `${h.file}:${h.rule}`))].join(","));

  // Write: temp sibling first, then rename into place. A failure removes the temp dir.
  fs.mkdirSync(path.dirname(path.resolve(outDir)), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(path.dirname(path.resolve(outDir)), `.${path.basename(outDir)}.tmp-`));
  try {
    fs.mkdirSync(path.join(tmp, version));
    fs.writeFileSync(path.join(tmp, version, "release.json"), releaseText);
    fs.writeFileSync(path.join(tmp, version, "manifest.json"), manifestText);
    fs.writeFileSync(path.join(tmp, "ledger.json"), ledgerText);
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
    statements: body.statements.length,
    lint: 0,
    scan: 0,
    ms: Math.round(performance.now() - t0),
  };
  return { line, release, manifest, ledger: ledgerOut, model };
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
