// PUB-01: the three confirmatory hypotheses (protocol section 8, rows R08, R09).
// Pure: counts in, p values and decisions out.
//
// H1: one-sided exact binomial, null share <= 0.5, p = P(X >= c | n, 0.5).
// H3: one-sided exact binomial, null share >= 0.5, p = P(X <= c | n, 0.5).
// Holm across the tested hypotheses at a family-wise 0.05 (section 8).
//
// R09 sensitivity, applied in the adverse direction with the measured
// supported recall r (missed evidence pushes H1 and H3 the same way):
//   H1 recomputes with floor(c x r) claimed launches (a missed artefact link
//      could turn a claimed check into pass);
//   H3 recomputes with min(n, ceil(c / r)) evidencing launches (missed
//      evidence could hide more evidencing launches);
//   H2 scales every group by the same r, which leaves the test unchanged, so
//      its sensitivity p equals its primary p.
// The sensitivity p values go through Holm over the same set; a hypothesis is
// supported only when rejected in both analyses.

export type Side = "upper" | "lower";

const logFact: number[] = [0];
function lf(n: number): number {
  for (let i = logFact.length; i <= n; i++) logFact[i] = logFact[i - 1]! + Math.log(i);
  return logFact[n]!;
}

/** Exact tail at p = 0.5: upper = P(X >= k), lower = P(X <= k). Summed in log space. */
export function binomialTail(n: number, k: number, side: Side): number {
  const lo = side === "upper" ? Math.max(k, 0) : 0;
  const hi = side === "upper" ? n : Math.min(k, n);
  if (lo > hi) return 0;
  if (lo === 0 && hi === n) return 1;
  const terms: number[] = [];
  for (let i = lo; i <= hi; i++) terms.push(lf(n) - lf(i) - lf(n - i) - n * Math.LN2);
  const m = Math.max(...terms);
  let s = 0;
  for (const t of terms) s += Math.exp(t - m);
  return Math.min(1, Math.exp(m + Math.log(s)));
}

// Guards against c x r landing a hair above or below an integer (100 x 0.9).
const EPS = 1e-9;

export interface Counts {
  c: number;
  n: number;
}

export interface BinomialResult {
  id: "h1" | "h3";
  c: number;
  n: number;
  share: number;
  p: number;
  sensitivity: { c: number; p: number };
}

export function h1({ c, n, recall }: Counts & { recall: number }): BinomialResult {
  const cs = Math.floor(c * recall + EPS);
  return { id: "h1", c, n, share: n ? c / n : 0, p: binomialTail(n, c, "upper"), sensitivity: { c: cs, p: binomialTail(n, cs, "upper") } };
}

export function h3({ c, n, recall }: Counts & { recall: number }): BinomialResult {
  const cs = Math.min(n, Math.ceil(c / recall - EPS));
  return { id: "h3", c, n, share: n ? c / n : 0, p: binomialTail(n, c, "lower"), sensitivity: { c: cs, p: binomialTail(n, cs, "lower") } };
}

/** Holm step-down; adjusted p made monotone, returned in input order. Rejects when pAdjusted <= alpha. */
export function holm<T extends { id: string; p: number }>(tests: T[], alpha = 0.05) {
  const m = tests.length;
  const order = tests.map((_, i) => i).sort((a, b) => tests[a]!.p - tests[b]!.p || a - b);
  const adj: number[] = new Array(m);
  let run = 0;
  order.forEach((idx, j) => {
    run = Math.max(run, Math.min(1, (m - j) * tests[idx]!.p));
    adj[idx] = run;
  });
  return tests.map((t, i) => ({ ...t, pAdjusted: adj[i]!, rejected: adj[i]! <= alpha }));
}

export type H2Result =
  | { id: "h2"; tested: false; reason: string; groups: Record<string, number> }
  | { id: "h2"; tested: true; groups: Record<string, number>; T: number; p: number; V: number; B: number };

export function testHypotheses({
  h1: c1,
  h2,
  h3: c3,
  recall,
  alpha = 0.05,
}: {
  h1: Counts;
  h2: H2Result;
  h3: Counts;
  recall: number;
  alpha?: number;
}) {
  const r1 = h1({ ...c1, recall });
  const r3 = h3({ ...c3, recall });
  const primary: { id: string; p: number }[] = [{ id: "h1", p: r1.p }];
  const sens: { id: string; p: number }[] = [{ id: "h1", p: r1.sensitivity.p }];
  if (h2.tested) {
    primary.push({ id: "h2", p: h2.p });
    sens.push({ id: "h2", p: h2.p });
  }
  primary.push({ id: "h3", p: r3.p });
  sens.push({ id: "h3", p: r3.sensitivity.p });
  const hp = holm(primary, alpha);
  const hs = holm(sens, alpha);
  const detail: Record<string, object> = { h1: r1, h2, h3: r3 };
  const tests = hp.map((t, i) => ({
    ...detail[t.id],
    id: t.id,
    p: t.p,
    pAdjusted: t.pAdjusted,
    rejected: t.rejected,
    sensitivity: { ...(t.id === "h2" ? {} : (detail[t.id] as BinomialResult).sensitivity), p: hs[i]!.p, pAdjusted: hs[i]!.pAdjusted, rejected: hs[i]!.rejected },
    supported: t.rejected && hs[i]!.rejected,
  }));
  return { alpha, recall, tests, descriptive: h2.tested ? [] : [h2] };
}
