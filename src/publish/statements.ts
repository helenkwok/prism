// PUB-04 / PUB-05 / R09: every sentence the release or the pages print comes from a template here,
// tagged with its kind so the lint can tell findings from methods text (research Pattern 5).
// Numbers are always arguments; the text holds no figure of its own.

export type Kind = "finding" | "method" | "definition" | "limitation" | "exploratory" | "title";

export interface Statement {
  id: string;
  kind: Kind;
  text: string;
}

/** Fixed display labels for the four check states (UI-SPEC copywriting contract). */
export const STATE_LABELS = {
  pass: "publicly evidenced (artefact linked)",
  claimed: "claimed, no artefact linked",
  unknown: "no public evidence found",
  fail: "own page shows the check is not met",
} as const;

const st = (id: string, kind: Kind, text: string): Statement => ({ id, kind, text });
const pctOf = (x: number, n: number) => (n ? Math.round((100 * x) / n) : 0);
const fmtP = (p: number) => (p < 0.001 ? "p < 0.001" : `p = ${p.toFixed(3)}`);
const verdict = (supported: boolean) => (supported ? "is supported" : "is not supported");

// ---------- findings ----------

/** R09: every check-level share reads "At least X of N". */
export function shareSentence(a: { c: number; n: number; checkId: string; pct: number; ci: [number, number] }): Statement {
  return st(
    `share:${a.checkId}`,
    "finding",
    `At least ${a.c} of ${a.n} launches publicly evidence \`${a.checkId}\` (${a.pct}%, 95% CI ${a.ci[0]}–${a.ci[1]}%).`,
  );
}

export function claimsSentence(a: { c: number; x: number; n: number; checkId: string; p: number; q: number }): Statement {
  return st(
    `claims:${a.checkId}`,
    "finding",
    `${a.c} of ${a.n} launches claim \`${a.checkId}\` without linking an artefact (${a.p}%); at least ${a.x} of ${a.n} publicly evidence it (${a.q}%).`,
  );
}

/** Share of launches whose confirmed check states let the deterministic gate support a decision. */
export function decisionSentence(a: { c: number; n: number; pct: number; ci: [number, number] }): Statement {
  return st(
    "decision:share",
    "finding",
    `At least ${a.c} of ${a.n} launches publicly evidence enough checks for the deterministic gate to support a decision on public evidence (${a.pct}%, 95% CI ${a.ci[0]}–${a.ci[1]}%).`,
  );
}

type BinomialTest = {
  c: number;
  n: number;
  pAdjusted: number;
  supported: boolean;
  sensitivity: { c: number; pAdjusted: number };
};
type H2Test = { groups: Record<string, number>; pAdjusted: number; supported: boolean; V: number; B: number };

/** H1 to H3 results from testHypotheses: supported or not, Holm-adjusted p, and the R09 recall bound. */
export function hypothesisSentence(id: "h1" | "h2" | "h3", r: BinomialTest | H2Test): Statement {
  if (id === "h2") {
    const t = r as H2Test;
    return st(
      "hypothesis:h2",
      "finding",
      `H2 (the per-check share of launches that publicly evidence each check differs by source) ${verdict(t.supported)}: permutation test over ${Object.keys(t.groups).length} sources (B = ${t.B}), Holm-adjusted ${fmtP(t.pAdjusted)}, Cramér's V = ${t.V.toFixed(2)}.`,
    );
  }
  const t = r as BinomialTest;
  const bound = `with the recall bound, ${t.sensitivity.c} of ${t.n}, Holm-adjusted ${fmtP(t.sensitivity.pAdjusted)}`;
  if (id === "h1") {
    return st(
      "hypothesis:h1",
      "finding",
      `H1 (a majority of launches claim at least one check without linking an artefact, so they do not publicly evidence it) ${verdict(t.supported)}: ${t.c} of ${t.n} launches (${pctOf(t.c, t.n)}%), one-sided exact binomial, Holm-adjusted ${fmtP(t.pAdjusted)}; ${bound}.`,
    );
  }
  return st(
    "hypothesis:h3",
    "finding",
    `H3 (fewer than half of launches publicly evidence at least one \`rely\`-decision check) ${verdict(t.supported)}: at least ${t.c} of ${t.n} launches (${pctOf(t.c, t.n)}%) publicly evidence one, one-sided exact binomial, Holm-adjusted ${fmtP(t.pAdjusted)}; ${bound}.`,
  );
}

// ---------- page copy ----------

/** A methods statement about cohorts; its id does not start with "cohort" because it names what the figures are not. */
export function cohortBanner(): Statement {
  return st(
    "method:cohort-banner",
    "method",
    "Each cohort is the launches of one quarter, described by what they publicly evidence today. Older launches have had longer to publish, and launches that disappeared are not in the sample, so these figures are not a trend and are not compared as one.",
  );
}

/** Cohort chart caption; ids starting with "cohort" are trend-linted. */
export function cohortCaption(quarter: string): Statement {
  return st(`cohort:${quarter}`, "title", `Launched in ${quarter}, as evidenced today.`);
}

export function h2DescriptiveLine(): Statement {
  return st(
    "method:h2-descriptive",
    "method",
    "Reported descriptively: at least one source has fewer than 30 included launches, so the pre-registered test was not run. The Holm correction covers the remaining hypotheses.",
  );
}

export function absentRow(source: string, reason?: string): Statement {
  return st(`absent:${source}`, "method", `not in this release: ${reason ?? `no ${source} launches met the inclusion criteria`}`);
}

export function withheldRow(reason: string): Statement {
  return st("withheld", "method", `withheld: ${reason}`);
}

export function emptyState(): Statement[] {
  return [
    st("empty:heading", "title", "Findings not yet released"),
    st(
      "empty:body",
      "method",
      "The figures appear here once the validation gate has been passed and the release has cleared disclosure control. The methods and the protocol are available now.",
    ),
  ];
}

// ---------- limitations (D-76, PUB-05) ----------

export function screeningLimitation(a: { errors: number; audited: number; pct: number; ci: [number, number]; bar: number }): Statement {
  return st(
    "limitation:screening",
    "limitation",
    `Screening missed its pre-registered target: ${a.pct}% of audited exclusions were in error (${a.errors} of ${a.audited}, 95% CI ${a.ci[0]}–${a.ci[1]}%) against a ${a.bar}% bar. This is a selection limitation.`,
  );
}

export function screeningRemeasure(a: { pct: number; audited: number; sample: number }): Statement {
  return st(
    "exploratory:screening-remeasure",
    "exploratory",
    `A re-measure at ${a.pct}% is exploratory: the rule was tightened on the same ${a.audited} cases and was not re-applied to the ${a.sample}.`,
  );
}

export function recallLimitation(a: {
  supportedFound: number;
  supported: number;
  recall: number;
  contributed: number;
  projects: number;
  rawFound: number;
  raw: number;
  rawRecall: number;
}): Statement {
  return st(
    "limitation:recall",
    "limitation",
    `Supported recall ${a.recall.toFixed(3)} (${a.supportedFound} of ${a.supported}; ${a.contributed} of ${a.projects} projects contributed); raw recall ${a.rawRecall.toFixed(3)} (${a.rawFound} of ${a.raw}).`,
  );
}

export function gatheredItemsLimitation(a: { gathered: number; supported: number; unsupported: number; boilerplate: number }): Statement {
  return st(
    "limitation:gathered-items",
    "limitation",
    `Of ${a.gathered} gathered items, ${a.supported} (${pctOf(a.supported, a.gathered)}%) were supported and ${a.unsupported} (${pctOf(a.unsupported, a.gathered)}%) unsupported, ${a.boilerplate} (${pctOf(a.boilerplate, a.gathered)}%) of them boilerplate such as calls to action.`,
  );
}

export function collectorChange(): Statement {
  return st(
    "limitation:collector-change",
    "limitation",
    "The paid search collector was replaced by a free own-site collector for all bulk coding (addendum A8), so every launch was collected the same way.",
  );
}

export function collectorCrossCheck(a: { projects: number; positiveAgreement: number; allStates: number }): Statement {
  return st(
    "exploratory:collector-cross-check",
    "exploratory",
    `Exploratory: on ${a.projects} projects the free and the paid collectors agree at a positive-level agreement of about ${a.positiveAgreement.toFixed(2)}. The all-states agreement of ${a.allStates.toFixed(3)} is raised by states both found nothing for and is not the headline.`,
  );
}

export function wholePageSpanDefect(): Statement {
  return st(
    "limitation:whole-page-spans",
    "limitation",
    "A collector defect produced whole-page evidence spans. Every project was re-segmented into spans of at most 1,500 characters, and the decisions made on the defective spans are archived as exploratory and feed no published figure (addendum A9).",
  );
}

export function agentRoles(roles: { role: string; model: string; host: string }[]): Statement {
  const list = roles.map((r) => `${r.role} (${r.model} on ${r.host})`).join("; ");
  return st(
    "limitation:agent-roles",
    "limitation",
    `Every role is an agent: ${list}. No human edited a label. Agreement figures are agreement with an independent labeller.`,
  );
}

export function providerVisibility(): Statement {
  return st(
    "limitation:provider-visibility",
    "limitation",
    "Evidence is read from text extracted from each launch's own pages. What the extractor could not see, such as pages behind a login or text inside images, does not count as public evidence.",
  );
}

export function cohortSurvivorship(): Statement {
  return st(
    "limitation:cohort-survivorship",
    "limitation",
    "Cohorts are described as they are evidenced today. Older launches have had longer to publish, and launches whose sites disappeared are not in the sample.",
  );
}

export function notDone(): Statement {
  return st("limitation:not-done", "limitation", "Not publicly evidenced does not mean not done.");
}

export function samplingFrameBias(): Statement {
  return st(
    "limitation:sampling-frame",
    "limitation",
    "The sampling frame is led by Show HN launches, so the figures describe launches posted there and not AI launches in general.",
  );
}
