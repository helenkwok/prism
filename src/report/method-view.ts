// APP-03 / SC4 / 07-UI-SPEC "Method audit": the judges' view of how the sample
// was coded. Built once at materialisation (one stored row), never per request.
// Agreement rows follow the Phase 4 gate record (04-11): a released check shows
// AC1 with its CI and pass precision c of m; every other state shows only the
// Phase 6 explicit-state words, never a number. Confirmation records carry both
// the project id and its pseudonym; the server decides per viewer which one a
// row may show (report-fns.ts getMethodView), so this module never filters.

import fs from "node:fs";

import type { Codebook } from "../pipeline/coding/codebook-prompt.ts";
import { CROSSWALK_ORDER, type CrosswalkChip, type GapTextFn, type ReportView, type RoleLine } from "./view.ts";

export type AgreementState = "released" | "withheld" | "not-estimable" | "person-coded";

/** One check's entry in the method input (the gate record's per-check status). */
export interface AgreementInput {
  checkId: string;
  status: string;
  ac1?: number;
  ac1CI?: [number, number];
  precision?: { c: number; m: number };
  reason?: string;
}

export interface MethodInput {
  synthetic?: boolean;
  generatedAt: string;
  labeller: RoleLine;
  agreement: AgreementInput[];
  prisma: { label: string; count: number }[];
}

export interface AgreementRow {
  checkId: string;
  label: string;
  state: AgreementState;
  ac1: number | null;
  ac1CI: [number, number] | null;
  precision: { c: number; m: number } | null;
  /** Explicit-state words for every state but released; null when released. */
  text: string | null;
}

export interface CodebookEntry {
  checkId: string;
  label: string;
  decision: string;
  decisionLabel: string;
  operationalDefinition: string;
  passRule: string;
  claimedRule: string;
  failRule: string;
  crosswalk: CrosswalkChip[];
  gapText: string;
}

export interface ConfirmationRecord {
  projectId: string;
  pseudonym: string | null;
  /** The product name (07-03 Q4); shown only to a viewer who may open the project identifiably. */
  title: string;
  checkId: string;
  checkLabel: string;
  /** Confirmation applies to proposed positives only, so this is always "pass". */
  proposed: "pass";
  decision: string;
  role: string;
  modelId: string | null;
  decidedAt: string;
}

export interface MethodView {
  version: 1;
  fixture: boolean;
  generatedAt: string;
  agreement: { labeller: RoleLine; rows: AgreementRow[] };
  prisma: { label: string; count: number }[];
  codebook: CodebookEntry[];
  confirmations: ConfirmationRecord[];
  howMade: { coding: RoleLine; confirmation: RoleLine; labeller: RoleLine; codebookVersion: string; gateSha: string };
}

// Phase 4 gate statuses (04-11) -> what the audit may show.
const STATE_OF: Record<string, AgreementState> = {
  released: "released",
  "corrected-revalidated": "released",
  "released-not-estimable": "not-estimable",
  withheld: "withheld",
  missed: "withheld",
  "person-coded": "person-coded",
};
const WORDS: Record<Exclude<AgreementState, "released">, string> = {
  withheld: "withheld",
  "not-estimable": "not estimable",
  "person-coded": "person-coded",
};

/** decision-gates.json decision id -> label. */
export function decisionLabelsOf(gatesPath: string): Record<string, string> {
  const g: { decisions: Record<string, { label: string }> } = JSON.parse(fs.readFileSync(gatesPath, "utf8"));
  return Object.fromEntries(Object.entries(g.decisions).map(([id, d]) => [id, d.label]));
}

/** The 24 codebook entries in codebook order; also what /method shows before any method row is stored. */
export function codebookEntries(codebook: Codebook, gapText: GapTextFn, decisionLabels: Record<string, string>): CodebookEntry[] {
  return Object.entries(codebook.checks).map(([id, c]) => ({
    checkId: id,
    label: c.label,
    decision: c.decision,
    decisionLabel: decisionLabels[c.decision] ?? c.decision,
    operationalDefinition: c.operationalDefinition,
    passRule: c.passRule,
    claimedRule: c.claimedRule,
    failRule: c.failRule,
    crosswalk: CROSSWALK_ORDER.flatMap((std) =>
      (c.crosswalk[std] ?? []).map((e) => ({ standard: std, locator: e.locator, relationType: e.relation_type, informational: e.informational === true })),
    ),
    gapText: gapText(id).text,
  }));
}

export function buildMethodView({
  method,
  codebook,
  gapText,
  decisionLabels,
  projects,
}: {
  method: MethodInput;
  codebook: Codebook;
  gapText: GapTextFn;
  decisionLabels: Record<string, string>;
  projects: { view: ReportView; pseudonym: string | null }[];
}): MethodView {
  const ids = Object.keys(codebook.checks);
  const byId = new Map(method.agreement.map((a) => [a.checkId, a]));

  const rows: AgreementRow[] = ids.map((id) => {
    const a = byId.get(id);
    if (!a) throw new Error(`method input: no agreement entry for ${id}`);
    const state = STATE_OF[a.status];
    if (!state) throw new Error(`method input: unknown agreement status "${a.status}" for ${id}`);
    const label = codebook.checks[id].label;
    if (state === "released") {
      if (typeof a.ac1 !== "number" || !a.ac1CI || !a.precision) throw new Error(`method input: released check ${id} needs ac1, ac1CI and precision`);
      return { checkId: id, label, state, ac1: a.ac1, ac1CI: a.ac1CI, precision: a.precision, text: null };
    }
    return { checkId: id, label, state, ac1: null, ac1CI: null, precision: null, text: `${WORDS[state]}: ${a.reason ?? "no reason recorded"}` };
  });

  const entries = codebookEntries(codebook, gapText, decisionLabels);

  const confirmations: ConfirmationRecord[] = projects.flatMap(({ view, pseudonym }) =>
    view.checks.flatMap((c) =>
      c.confirmations.map((r) => ({
        projectId: view.projectRef,
        pseudonym,
        title: view.title,
        checkId: c.checkId,
        checkLabel: c.label,
        proposed: "pass" as const,
        decision: r.decision,
        role: r.role,
        modelId: r.modelId,
        decidedAt: r.decidedAt,
      })),
    ),
  );

  const first = projects[0]?.view;
  const none: RoleLine = { role: "not recorded", modelId: null, host: null };
  return {
    version: 1,
    fixture: method.synthetic === true,
    generatedAt: method.generatedAt,
    agreement: { labeller: method.labeller, rows },
    prisma: method.prisma,
    codebook: entries,
    confirmations,
    howMade: {
      coding: first?.howMade.coding ?? none,
      confirmation: first?.howMade.confirmation ?? none,
      labeller: method.labeller,
      codebookVersion: codebook.codebookVersion,
      gateSha: first?.gateSha ?? "not recorded",
    },
  };
}
