# PRISM Protocol v1

**Status:** DRAFT. Not signed off, not tagged. Section 13 lists every item that is still a proposal.

## 0. Status and pre-registration

- Version: 1 (draft dated 2026-09-21).
- Gate tag: `v0.1.0-rc.1`
- Gate commit: `66660cfde8fd06c7a9b5532e696255716b4b1f10`
- The gate tag and commit above are the pinned claim gate recorded in `vendor/ai-output-to-value/PIN.json`.
- No pipeline code exists at the time of writing. The directory `src/pipeline/` holds no file, and the check `scripts/check-protocol-order.mjs` fails if a file is added there before the tag `protocol-v1` exists.
- Spike inputs are outside the sampling frame by construction. Every project used to measure a model, the collector or the deployment is a Show HN post dated on or after 2026-09-01, and the frame in section 1 ends on 2026-08-31. Numbers from the spikes are therefore not results of this review.
- The pre-registration timestamp is the commit date of the commit that introduces the tagged text. After tagging, the tagged text is not edited (section 12).
- This protocol names no coding tool and contains no private data. Every count in the fixtures that support section 6 is synthetic.

## 1. Sample frame, window and seeds

**Primary frame.** Show HN posts from the Hacker News Algolia search API, collected in two-sided weekly windows (a start and an end time on every request, so no request reaches the 1,000-hit cap) and checked against the API's own exhaustiveness flag.

**Window.** 2025-09-01 to 2026-08-31 inclusive.

**Strata and size.** The window is cut into four quarters aligned to it: September to November 2025, December 2025 to February 2026, March to May 2026 and June to August 2026. The sample is equal per quarter, 4 x 75 = 300 included projects (about 300).

**Seeded draw.** For each stratum, sort the candidates ascending by the hexadecimal SHA-256 of the string `<seed>:<HN object id>` and take the first n. A new seed re-orders every list, and the same seed always reproduces the same order.

**Seeds.** Five seeds, generated on 2026-09-21 before any draw exists, each from eight random bytes written as 16 hexadecimal characters (`node -e "console.log(require('node:crypto').randomBytes(8).toString('hex'))"`):

| Use | Seed |
|---|---|
| Sampling | `ae0b3a26c3b17672` |
| Screening audit | `fa23e4fccbc39ce5` |
| Gold labels | `d1481ad50ed309ea` |
| Collection recall | `cc45c03dd0094b92` |
| Second-model subsample | `1a8a5e2c0f6afdcb` |

**Reddit frame, frozen verbatim.** Reddit is a supplementary channel chosen by a human, not a seeded frame. The subreddits are r/SideProject, r/IMadeThis, r/alphaandbetausers, r/vibecoding, r/indiehackers, r/LocalLLaMA, r/AI_Agents, r/LLMDevs, r/LangChain, r/ChatGPTCoding and r/MachineLearning. Posts older than the window are context only and enter no statistic.

## 2. Inclusion and exclusion

A candidate is included when it is a deployed product, service or agent whose core function is the output of an AI or machine-learning model, and it has its own website or repository.

Every exclusion records one reason code, and the codes are the PRISMA counts:

| Code | Excluded because |
|---|---|
| `library-no-product-claim` | a library or SDK with no product claim |
| `model-or-paper` | a model release or a paper |
| `dataset` | a dataset |
| `ai-adjacent` | AI is used only around the edges (for example, a chatbot was used only to write copy) |
| `demo-no-site` | a demo with no website |

Two operational codes are proposed: `duplicate` and `unreachable-at-screening`. They are PROPOSED (register row R13) until signed.

## 3. Check states, claimed rule and missing data

Each check takes one of four states: `pass`, `fail`, `unknown`, `claimed`.

- `pass`: the project's own page gives a verbatim quote AND links an artefact or a page that itself shows the thing.
- `claimed`: the project's own page asserts that a check is met, with a verbatim quote, but links no artefact, report, policy or third-party attestation.
- Both `pass` and `claimed` are confirmed by Helen before publication. An unconfirmed positive enters no statistic.
- `unknown`: no supported evidence was found. Missing data is `unknown`, never `fail`, and stays in the denominator of all N.
- A project whose extraction failed or whose site was blocked by robots.txt is reported as a separate count, and every headline share carries a sensitivity line that excludes those projects.
- The deterministic gate, not the model, decides the outcome of a decision from the check states.

## 4. Metrics, thresholds and shortfall actions

Per-check publication gate (decisions D-01, D-02). A check is publishable only when BOTH of the following hold against Helen's blind labels:

- `AC1 >= 0.70` (Gwet's AC1), and
- `pass precision >= 0.85`.

Both bars are applied to point estimates. Confidence intervals are reported next to them. A pooled figure across checks is reported but never rescues a failing check. Cohen's kappa and percent agreement are reported, not gated, because kappa is unstable at low prevalence. A check with fewer than about 10 gold passes is not estimable (section 13, row R10).

Shortfall ladder, with no discretion (D-03):

1. First miss on a check: correct the codebook or the prompt ONCE and revalidate on a fresh seeded subset. At most one iteration, so the correction is not tuned to the test set.
2. Second miss: human-code that check across the full sample if at most 4 checks are affected, otherwise withhold the estimate.

Publication rule: an estimate is released only when it is within threshold or its action above is recorded as applied. A release with neither is refused.

Screening audit (D-04). Helen re-screens `n = 50` excluded candidates drawn with the screening-audit seed. The bar is `exclusion error rate <= 10%`, and the upper 95% interval limit is reported. A miss means tightening the rule and re-screening once; if it still misses, the result is reported as a stated selection limitation.

Collection recall (D-05). Helen gathers evidence for about 10 projects, drawn with the collection-recall seed, from their own sources before seeing the pipeline's output. The bar is `>= 70%` of the evidence items Helen found. A miss means widening the collector's map and extract depth once and measuring again; if it is still under the bar, every `unknown` is worded "not found by the collector", never "absent".

Second-model agreement (D-06). A model from a different family codes about 100 projects drawn with the second-model seed. Its agreement is a reported robustness figure. It is NOT a gate; correctness is gated by human labels only.

Estimators (proposed, register rows R06 and R07):

- Proportions carry Wilson intervals.
- Agreement statistics carry percentile bootstrap intervals over projects, with 2,000 resamples. The resampling draws the i-th uniform number from the SHA-256 of `<seed>:bootstrap:<i>`, using the seed of the sample being analysed, so every interval is reproducible.
- Gwet's AC1 for two raters is (pa - pe) / (1 - pe), where pa is the observed proportion of agreement and pe is the chance-agreement term. For a binary outcome, pe = 2 pi (1 - pi), with pi the mean of the two raters' proportions of `pass`. The primary figure treats each check as binary, `pass` against not-`pass`, because `pass` is what is published. The four-state figure is secondary. Verify this formula against Gwet 2008 before sign-off (row R06).
- Pass precision is the number of model-proposed passes that Helen's blind label also marks `pass`, divided by the number of model-proposed passes, on the gold subset.

## 5. Gold-label sample design

Helen labels about 30 projects drawn at random with the gold-label seed from the included sample, in a view that never shows the model's proposals. Her labels are locked before any of those projects can be edited or confirmed. The design is a plain seeded random draw (the default; alternatives are in register row R05). The design is fixed before any model output exists for these projects.

## 6. Disclosure control

The rule is implemented and tested in `protocol/disclosure/audit.mjs`, and this section states it in prose.

1. **Tuples.** Every published statistic is one tuple (c, n) plus everything derived from it: a percentage, an interval, a chart bar, a tooltip. A tuple is published in full or not at all.
2. **Primary suppression.** k = 10. A tuple is suppressed when its count is under 10, or its complement (n - c) is under 10, or its cohort size n is under 10. The cohort size is public, so 70 of 75 would disclose that 5 did not; the complement clause closes that (row R01). Suppressed tuples are shown as "<10" only where the count is under 10.
3. **Release ledger.** Every tuple ever published is listed with its version, and the audit unions the rows of all versions.
4. **Exact audit.** For every suppressed tuple the audit counts the values that some completion of the release still allows, one candidate value at a time through an exact integer solver (HiGHS). The rows are the published totals, sums across overlapping tables, rounded percentages as two inequalities, and decision-level inequalities. The audit passes when every suppressed tuple has at least the minimum number of feasible values. Minimum feasible values per suppressed cell: 5 (`MIN_VALUES`). Cell floor: 10 (`FLOOR`). Both are exported constants of the reference audit and a test asserts that this text and the code agree.
5. **Closure.** If the audit fails, the published tuple with the smallest count among those in a row involving a failing cell is additionally suppressed (ties broken by identifier order), and the audit runs again. The loop ends because each step suppresses one more tuple.
6. **Identifier scan.** Every export is scanned for project names, URLs and hostnames from the private store.
7. **Small PRISMA reasons.** Any exclusion reason with fewer than 10 projects is merged into "other", and if "other" is still under 10 it is merged upward into the nearest larger reason.
8. **The inclusion list is never published.**

The reference fixtures show the rule working in both directions: a release where two counts can be narrowed to 4 values each fails, and the same release passes after one further tuple is suppressed. Whether the released table may reveal which suppressed cells are complementary is proposed in row R02; the audit can be run with the stricter assumption that it does.

## 7. Launch cohorts and interpretation limits

Results are reported by launch cohort, meaning the quarter of the Show HN post. Each cohort is a set of launches, evidenced as they are today. The review states present-day public evidence only. It makes no claim that evidence is improving or worsening over time, and no comparison between cohorts is worded as a trend.

## 8. Confirmatory hypotheses

There are exactly three confirmatory hypotheses. Everything else is labelled exploratory. The denominator is all included projects (section 3).

- **H1.** A majority of launches make at least one standard-mapped claim without linking an artefact (at least one `claimed` check).
- **H2.** The per-check share of projects with evidence differs by source (Show HN, Reddit, GitHub-only).
- **H3.** The share of launches evidencing at least one `rely`-decision check is below 50%.

Proposed tests (row R08): a one-sided exact binomial test for H1 (null: share at most 0.5) and for H3 (null: share at least 0.5), and a permutation test of an omnibus statistic for H2, reported with Cramér's V. H2 is tested only when each compared group has at least 30 included projects; otherwise it is reported descriptively and the correction is applied across the remaining tests.

Multiplicity: Holm across the three, at a family-wise level of 0.05.

A hypothesis is reported as supported only if it holds in the primary analysis AND in the sensitivity analysis that applies the measured collection recall as a bound (row R09).

## 9. Bulk-size rule

Decision date: 2026-09-30, from the pilot's measured confirmation load.

Projected confirmation hours = (mean number of `pass` plus `claimed` states per project in the pilot) x N x (measured mean seconds per confirmation) / 3600.

Budget H = to be supplied by Helen (hours). See register row R11.

If the projected hours exceed H, N is reduced from about 300 to 200 by keeping the first 50 projects per quarter in seed order and dropping the rest. The choice of which projects are dropped is fixed here, before the pilot runs.

## 10. Reddit trigger

On the same decision date and from the same measured load: if the projected hours exceed H, Reddit picks stop entering any statistic and become context only, and only if the projected hours still exceed H is the rule in section 9 applied. The order follows the descope order in the roadmap. See register row R12.

## 11. Well-known company rule

A company counts as well known when it has 50 or more employees, OR is publicly listed, OR has raised $10M or more. This is determined only from the company's own public site or press page. No founder data is collected. This is the rule that decides which companies may be identified in the judge-only records (requirement APP-03).

## 12. Amendments

After tagging, a change is made only by appending a dated addendum below this section. The tagged text is never edited, and `scripts/check-protocol-order.mjs` fails when it is. An addendum states the date, the changed rule, the reason, and whether any result had been seen when it was written.

## 13. Sign-off register

Every row is PROPOSED in this draft. A row records the options considered with the criterion that eliminates each, then the recommendation. Rows are resolved with Helen before the tag.

| ID | Item | Options considered | Recommended | Status | Signed value |
|---|---|---|---|---|---|
| R01 | Complement clause of the cell floor | (a) count only: eliminated by PUB-03, since the cohort size is public and 70 of 75 discloses that 5 did not (the complement-floor fixture); (b) count, complement and cohort size under 10: meets PUB-03; (c) do nothing beyond the count rule: eliminated by PUB-03 | (b) | PROPOSED | |
| R02 | Minimum feasible values in the audit, and whether the table reveals which suppressed cells are complementary | Minimum: 3 (eliminated: the planted release has 4 feasible values per cell and would pass, but the test requires it to fail); 5 (fails the planted release, passes after one further suppression); 8 (not eliminated by the fixtures, costs more complementary suppression, amount not measured); exact recovery only (eliminated: a window of 4 values on a count under 10 still reveals whether it is 0 or 3, which the floor exists to hide). Display: distinguish complementary cells (audit with the stricter prior, closure fixture leaves 6 feasible values against the minimum of 5); make them indistinguishable (default prior) | 5; audit under the stricter prior as well | PROPOSED | |
| R03 | Strata | Window-aligned quarters (matches the window, equal 75 per quarter); calendar quarters (eliminated: the window starts on 1 September, so the first quarter would hold one month); monthly strata (eliminated: about 25 per month puts more tuples under the floor of 10 and breaks the quarterly cohort framing) | Window-aligned quarters | PROPOSED | |
| R04 | The five seeds | Accept as generated; re-roll before any draw exists (allowed, never after the first draw); choose memorable numbers (eliminated: not random) | Accept as generated | PROPOSED | |
| R05 | Gold-sample design | (a) plain seeded random of about 30 (unbiased, may leave some checks not estimable); (b) oversample projects the model flags as likely passes, with weights (eliminated: it needs model output before labelling, which breaks blind labelling, and it puts weights into every metric); (c) random 30 plus a separately reported positives-enriched batch (feasible, costs extra labelling hours that are not yet measured) | (a) | PROPOSED | |
| R06 | AC1 categories and formula | Binary `pass` against not-`pass` as primary with four-state secondary; four-state as primary (eliminated: `pass` is what is published, and sparse states make it unstable); kappa as the gate (eliminated by D-01). The formula in section 4 is from the literature and is verified against the source before signing | Binary primary, four-state secondary | PROPOSED | |
| R07 | Interval estimators | Wilson for proportions with a percentile bootstrap over projects (2,000 resamples, seeded); exact (Clopper-Pearson) intervals, wider and not eliminated; a bias-corrected bootstrap (eliminated: more machinery than about 30 gold projects support) | Wilson plus percentile bootstrap | PROPOSED | |
| R08 | Hypothesis wording, tests, definition of source and minimum group size | Wording and tests as in section 8; "source" defined as the channel through which the launch was found (Show HN, Reddit pick, or GitHub-only when a repository is the only own source); a minimum of 30 included projects per group; fewer groups or no H2 (eliminated by D-13, which fixes three hypotheses) | As in section 8 | PROPOSED | |
| R09 | "At least X of N" wording and the recall-bound sensitivity rule | Word every check-level finding "at least X of N" because published shares are lower bounds when evidence is missed; apply the measured collection recall as a bound in the adverse direction and require a hypothesis to hold in both analyses; report the primary analysis alone (eliminated: H1 and H3 are pushed by missed evidence in the same direction) | "At least X of N", with the bound analysis | PROPOSED | |
| R10 | Checks that are not estimable (under about 10 gold passes) | Publish labelled "validated by confirmation only; agreement not estimable"; withhold (safe, drops every rare check); publish unlabelled (eliminated by VAL-03) | Publish labelled | PROPOSED | |
| R11 | Bulk-N hours budget and reduction rule | Keep N at about 300 whatever the load (eliminated by the roadmap's schedule risk: Helen confirms every positive, COD-08); reduce to 200 by the first 50 per quarter (recommended); stop confirming (eliminated by COD-08). The budget H is a number only Helen can supply; nothing has been measured yet | Reduce to 200 by the first 50 per quarter; H from Helen | PROPOSED | |
| R12 | Reddit trigger | Same measured load and date as R11; cut Reddit picks to context only first (recommended, second in the descope order); shrink to a cap (needs a number from Helen); keep whatever the load (eliminated by the roadmap's schedule risk) | Cut to context only first | PROPOSED | |
| R13 | Extra reason codes | Add `duplicate` and `unreachable-at-screening` to the five classes; only the five classes (eliminated: a duplicate or unreachable candidate would otherwise be counted under a reason that is not true) | Add both | PROPOSED | |
| R14 | Tag timing relative to the spikes | Tag after sign-off and before any `src/pipeline` file, spike numbers allowed to come first because spike inputs are outside the frame; hold spike numbers until after the tag (safe, slows the spikes); tag before the spikes (eliminated: the collector spike has already run, and the tag waits on sign-off) | Tag after sign-off and before any `src/pipeline` file | PROPOSED | |
| R15 | Confirmation of the locked thresholds D-01 to D-06 | Confirm as locked: AC1 at least 0.70 and pass precision at least 0.85 per check, screening audit of 50 with error at most 10%, collection recall at least 70%, second-model agreement reported and not a gate; change any of them (eliminated: locked in the phase context) | Confirm as locked | PROPOSED | |
