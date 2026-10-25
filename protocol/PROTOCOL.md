# PRISM Protocol v1

**Status:** SIGNED. Every row of the section 13 register is signed. The commit that introduces this text is tagged `protocol-v1`; that commit's date is the pre-registration timestamp.

## 0. Status and pre-registration

- Version: 1 (drafted 2026-09-20 UTC; signed 2026-09-23 UTC).
- Gate tag: `v0.1.0-rc.1`
- Gate commit: `d8ffa8be1436dd9a36ebf91e10ca548bce82edcb`
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

**Seeds.** Five seeds, generated on 2026-09-20 (UTC) before any draw exists, each from eight random bytes written as 16 hexadecimal characters (`node -e "console.log(require('node:crypto').randomBytes(8).toString('hex'))"`):

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
| `duplicate` | the same project was already included from an earlier post |
| `unreachable-at-screening` | the site or repository could not be reached at the time of screening |

Two operational codes, `duplicate` and `unreachable-at-screening`, are added to the five classes above (register row R13, signed).

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

Estimators (register rows R06 and R07, signed):

- Proportions carry Wilson intervals.
- Agreement statistics carry percentile bootstrap intervals over projects, with 2,000 resamples. The resampling draws the i-th uniform number from the SHA-256 of `<seed>:bootstrap:<i>`, using the seed of the sample being analysed, so every interval is reproducible.
- Gwet's AC1 for two raters is (pa - pe) / (1 - pe), where pa is the observed proportion of agreement and pe is the chance-agreement term. For a binary outcome, pe = 2 pi (1 - pi), with pi the mean of the two raters' proportions of `pass`. The primary figure treats each check as binary, `pass` against not-`pass`, because `pass` is what is published. The four-state figure is secondary. This formula was verified against Gwet (2008) and a maintained implementation's documentation (the irrCAC package), which agree that at k = 2 categories the general form pe = [1/(k-1)] sum(pi_j (1 - pi_j)) reduces to pe = 2 pi (1 - pi); a worked toy example (pi = 0.55, pe = 0.495, pa = 0.8, AC1 ~= 0.60) confirms the reduction (row R06, signed).
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

The reference fixtures show the rule working in both directions: a release where two counts can be narrowed to 4 values each fails, and the same release passes after one further tuple is suppressed. Register row R02 (signed) sets the minimum feasible values per suppressed cell to 5, and the audit is additionally run under the stricter assumption that the released table may reveal which suppressed cells are complementary.

## 7. Launch cohorts and interpretation limits

Results are reported by launch cohort, meaning the quarter of the Show HN post. Each cohort is a set of launches, evidenced as they are today. The review states present-day public evidence only. It makes no claim that evidence is improving or worsening over time, and no comparison between cohorts is worded as a trend.

## 8. Confirmatory hypotheses

There are exactly three confirmatory hypotheses. Everything else is labelled exploratory. The denominator is all included projects (section 3).

- **H1.** A majority of launches make at least one standard-mapped claim without linking an artefact (at least one `claimed` check).
- **H2.** The per-check share of projects with evidence differs by source (Show HN, Reddit, GitHub-only).
- **H3.** The share of launches evidencing at least one `rely`-decision check is below 50%.

Tests (row R08, signed): a one-sided exact binomial test for H1 (null: share at most 0.5) and for H3 (null: share at least 0.5), and a permutation test of an omnibus statistic for H2, reported with Cramér's V. H2 is tested only when each compared group has at least 30 included projects; otherwise it is reported descriptively and the correction is applied across the remaining tests.

Multiplicity: Holm across the three, at a family-wise level of 0.05.

A hypothesis is reported as supported only if it holds in the primary analysis AND in the sensitivity analysis that applies the measured collection recall as a bound (row R09).

## 9. Bulk-size rule

Decision date: 2026-09-30, from the pilot's measured confirmation load.

Projected confirmation hours = (mean number of `pass` plus `claimed` states per project in the pilot) x N x (measured mean seconds per confirmation) / 3600.

Budget H = 30 hours (register row R11, signed).

If the projected hours exceed H, N is reduced from about 300 to 200 by keeping the first 50 projects per quarter in seed order and dropping the rest. The choice of which projects are dropped is fixed here, before the pilot runs.

## 10. Reddit trigger

On the same decision date and from the same measured load: if the projected hours exceed H, Reddit picks stop entering any statistic and become context only, and only if the projected hours still exceed H is the rule in section 9 applied. The order follows the descope order in the roadmap (register row R12, signed).

## 11. Well-known company rule

A company counts as well known when it has 50 or more employees, OR is publicly listed, OR has raised $10M or more. This is determined only from the company's own public site or press page. No founder data is collected. This is the rule that decides which companies may be identified in the judge-only records (requirement APP-03).

## 12. Amendments

After tagging, a change is made only by appending a dated addendum below this section. The tagged text is never edited, and `scripts/check-protocol-order.mjs` fails when it is. An addendum states the date, the changed rule, the reason, and whether any result had been seen when it was written.

## 13. Sign-off register

Every row below is signed. A row records the options considered with the criterion that eliminates each, then the recommendation, then Helen's signed value. Helen signed every row at its recommended value, with no amendments (resume signal: `sign-as-drafted bulk_n_hours_budget=30`).

| ID | Item | Options considered | Recommended | Status | Signed value |
|---|---|---|---|---|---|
| R01 | Complement clause of the cell floor | (a) count only: eliminated by PUB-03, since the cohort size is public and 70 of 75 discloses that 5 did not (the complement-floor fixture); (b) count, complement and cohort size under 10: meets PUB-03; (c) do nothing beyond the count rule: eliminated by PUB-03 | (b) | SIGNED | (b) count, complement and cohort-size-under-10 |
| R02 | Minimum feasible values in the audit, and whether the table reveals which suppressed cells are complementary | Minimum: 3 (eliminated: the planted release has 4 feasible values per cell and would pass, but the test requires it to fail); 5 (fails the planted release, passes after one further suppression); 8 (not eliminated by the fixtures, costs more complementary suppression, amount not measured); exact recovery only (eliminated: a window of 4 values on a count under 10 still reveals whether it is 0 or 3, which the floor exists to hide). Display: distinguish complementary cells (audit with the stricter prior, closure fixture leaves 6 feasible values against the minimum of 5); make them indistinguishable (default prior) | 5; audit under the stricter prior as well | SIGNED | Minimum feasible values = 5; the audit is also run under the stricter (complementary-cells-distinguishable) prior |
| R03 | Strata | Window-aligned quarters (matches the window, equal 75 per quarter); calendar quarters (eliminated: the window starts on 1 September, so the first quarter would hold one month); monthly strata (eliminated: about 25 per month puts more tuples under the floor of 10 and breaks the quarterly cohort framing) | Window-aligned quarters | SIGNED | Window-aligned quarters |
| R04 | The five seeds | Accept as generated; re-roll before any draw exists (allowed, never after the first draw); choose memorable numbers (eliminated: not random) | Accept as generated | SIGNED | Accept the five seeds as generated; no re-roll |
| R05 | Gold-sample design | (a) plain seeded random of about 30 (unbiased, may leave some checks not estimable); (b) oversample projects the model flags as likely passes, with weights (eliminated: it needs model output before labelling, which breaks blind labelling, and it puts weights into every metric); (c) random 30 plus a separately reported positives-enriched batch (feasible, costs extra labelling hours that are not yet measured) | (a) | SIGNED | (a) plain seeded random of about 30 |
| R06 | AC1 categories and formula | Binary `pass` against not-`pass` as primary with four-state secondary; four-state as primary (eliminated: `pass` is what is published, and sparse states make it unstable); kappa as the gate (eliminated by D-01). The formula in section 4 is from the literature and is verified against the source before signing | Binary primary, four-state secondary | SIGNED | Binary primary, four-state secondary. Verified against Gwet (2008) and the irrCAC package's documentation (metricgate.com), which confirm the k-category chance-agreement term pe = [1/(k-1)] sum(pi_j(1-pi_j)) reduces to pe = 2 pi(1-pi) at k = 2, matching section 4 exactly; worked toy example pi = 0.55, pe = 0.495, pa = 0.8, AC1 ~= 0.60 |
| R07 | Interval estimators | Wilson for proportions with a percentile bootstrap over projects (2,000 resamples, seeded); exact (Clopper-Pearson) intervals, wider and not eliminated; a bias-corrected bootstrap (eliminated: more machinery than about 30 gold projects support) | Wilson plus percentile bootstrap | SIGNED | Wilson intervals for proportions; percentile bootstrap (2,000 resamples, seeded) for agreement statistics |
| R08 | Hypothesis wording, tests, definition of source and minimum group size | Wording and tests as in section 8; "source" defined as the channel through which the launch was found (Show HN, Reddit pick, or GitHub-only when a repository is the only own source); a minimum of 30 included projects per group; fewer groups or no H2 (eliminated by D-13, which fixes three hypotheses) | As in section 8 | SIGNED | As written in section 8; source = the channel the launch was found through (Show HN, Reddit pick, or GitHub-only); minimum 30 included projects per group |
| R09 | "At least X of N" wording and the recall-bound sensitivity rule | Word every check-level finding "at least X of N" because published shares are lower bounds when evidence is missed; apply the measured collection recall as a bound in the adverse direction and require a hypothesis to hold in both analyses; report the primary analysis alone (eliminated: H1 and H3 are pushed by missed evidence in the same direction) | "At least X of N", with the bound analysis | SIGNED | "At least X of N" wording, with the recall-bound sensitivity analysis required |
| R10 | Checks that are not estimable (under about 10 gold passes) | Publish labelled "validated by confirmation only; agreement not estimable"; withhold (safe, drops every rare check); publish unlabelled (eliminated by VAL-03) | Publish labelled | SIGNED | Publish labelled "not estimable" for checks with fewer than about 10 gold passes |
| R11 | Bulk-N hours budget and reduction rule | Keep N at about 300 whatever the load (eliminated by the roadmap's schedule risk: Helen confirms every positive, COD-08); reduce to 200 by the first 50 per quarter (recommended); stop confirming (eliminated by COD-08). The budget H is a number only Helen can supply; nothing has been measured yet | Reduce to 200 by the first 50 per quarter; H from Helen | SIGNED | Budget H = 30 hours; if exceeded, reduce N to 200 by the first 50 projects per quarter in seed order (section 9) |
| R12 | Reddit trigger | Same measured load and date as R11; cut Reddit picks to context only first (recommended, second in the descope order); shrink to a cap (needs a number from Helen); keep whatever the load (eliminated by the roadmap's schedule risk) | Cut to context only first | SIGNED | Cut Reddit picks to context-only first, on the same trigger date and measured load as R11 (section 10) |
| R13 | Extra reason codes | Add `duplicate` and `unreachable-at-screening` to the five classes; only the five classes (eliminated: a duplicate or unreachable candidate would otherwise be counted under a reason that is not true) | Add both | SIGNED | Add `duplicate` and `unreachable-at-screening` (section 2) |
| R14 | Tag timing relative to the spikes | Tag after sign-off and before any `src/pipeline` file, spike numbers allowed to come first because spike inputs are outside the frame; hold spike numbers until after the tag (safe, slows the spikes); tag before the spikes (eliminated: the collector spike has already run, and the tag waits on sign-off) | Tag after sign-off and before any `src/pipeline` file | SIGNED | Tag after sign-off, before any `src/pipeline` file; spike numbers from plans 01-06/01-07/01-10 stand, consistent with this rule, not an exception to it |
| R15 | Confirmation of the locked thresholds D-01 to D-06 | Confirm as locked: AC1 at least 0.70 and pass precision at least 0.85 per check, screening audit of 50 with error at most 10%, collection recall at least 70%, second-model agreement reported and not a gate; change any of them (eliminated: locked in the phase context) | Confirm as locked | SIGNED | D-01 through D-06 confirmed as locked, unchanged |

## Addendum 2026-10-19 (A1, A2)

Signed by Helen on 2026-10-19. Results seen when this was written: the 20-project pilot's per-check tally and floor-effect report (Phase 3). No gold label, second-model coding or bulk-sample result existed.

### A1. Bulk size without a timing measurement (changes section 9 and row R11)

Changed rule: the measured mean seconds per confirmation is no longer collected. Section 9's formula is evaluated at its break-even instead: the time one confirmation would have to take for the projected hours to exceed H.

Break-even seconds = H x 3600 / (mean `pass` plus `claimed` per project x N). The pilot gave 17 `pass` plus `claimed` states over 20 projects, a mean of 0.85. With H = 30 and N = 300 the break-even is about 424 seconds (7 minutes) per confirmation, far above the time needed to check one state against one quoted span. N therefore stays at about 300.

If a pilot re-run under the frozen codebook changes the mean, the break-even is recomputed with the same formula and recorded. N changes only by a further addendum.

Reason: the timing measured one person's speed. It forecast that person's workload and was never a finding about the projects. A2 removes the premise that one person confirms every positive.

### A2. Role-neutral confirmation (changes section 3, and row R11's reasoning)

Changed rule: section 3's "Both `pass` and `claimed` are confirmed by Helen before publication" is replaced by:

- Every `pass` and `claimed` state is confirmed before publication by a confirmer, a person or an agent. The confirmer checks the state against the codebook's rule for that check and against the quoted span it cites, and records `confirmed` or `rejected`. A rejected positive enters no statistic, and neither does an unconfirmed one.
- A confirmer never confirms states it coded itself. The model that coded a project is not that project's confirmer.
- Every confirmation is logged: the project, the check, the confirmer's identity and kind (person or agent, with the model id for an agent), the time, the decision, and the span ids checked.
- Confirmation is a quality control, not the accuracy measure. Accuracy is measured as section 4 already sets out: against Helen's blind gold labels (section 5) and by second-model agreement.
- Helen signs off the protocol, its amendments and the published findings.

Reason: one standard for work by people and AI, judged by its process and evidence, not by who produced it (Helen's AI Output to Value stance). Requiring one named person to confirm every positive made her the bottleneck for every run, and the evidence that measures accuracy already exists independently of her confirmations.

## Addendum 2026-10-19 (A3, A4)

Signed by Helen on 2026-10-19. Results seen when this was written: ArtCraft's coding by several models, and aggregate activity statistics from its GitHub organization. The pilot results noted under A1/A2 had also been seen. No gold label existed.

### A3. ArtCraft as a worked case outside the statistics

ArtCraft (Show HN item 46838772, 2026-01-31, inside the frame) is analysed as a purposive worked case. It is used to calibrate the codebook, the collector, the coders and confirmation against a launch with plentiful public evidence. It enters no confirmatory statistic, estimate or agreement figure as a worked case. If a seeded sample draw selects it, it is included in that draw like any other project. If the gold-label draw selects it, the next project in gold-label seed order replaces it, because Helen has already seen its coding and so cannot label it blind.

Reason: the random pilot contained few launches with enough public evidence to test the harder checks. A case chosen for its rich evidence tests the method, but its being chosen means it can stand for nothing in a statistic.

### A4. A community layer from every channel (exploratory)

Coded check states continue to come only from a project's own sources: its own website and its own repository. Separately, comments about a project from every public channel are consolidated into a per-project community layer. The channels are its repository's issues and pull requests, Hacker News, Reddit, Discord and others. This layer is set against what the launch claims, for example a support claim against how often people get a reply. It is exploratory: it enters no confirmatory statistic, and it is reported in aggregate only, with no usernames or other personal data.

Each channel is used only within its own terms: official APIs where they exist (GitHub, the Hacker News Algolia API); for Reddit, the Data API once approved, otherwise manual or pasted context; for Discord, existing aggregate syntheses only, with no new automated collection unless Helen decides otherwise.

Reason: people comment about a launch everywhere, so any one channel gives a partial picture of what it delivers.

## Addendum 2026-10-19 (A5)

Signed by Helen on 2026-10-19. Results seen when this was written: the 20-project pilot (drawn from the unscreened frame, so most of it was not AI products), the pilot's coding by two models, and a screening spike of Nemotron-3.5-Lightning on 300 frame posts and the 20 pilot projects. No gold label existed.

### A5. A `not-ai` reason code, and screening in two stages (changes section 2 and row R13)

Changed rule: section 2 gains one exclusion code, `not-ai`: the candidate has no AI or machine-learning model in the product at all. The six content codes are `not-ai`, `ai-adjacent`, `library-no-product-claim`, `model-or-paper`, `dataset` and `demo-no-site`; `duplicate` and `unreachable-at-screening` stay as R13 set them.

Screening runs in two stages, as title-and-abstract and full-text screening do in a systematic review:

- Stage 1 reads a candidate's title and URL. It excludes only what they clearly show; when unsure it includes.
- Stage 2 reads the text of the candidate's own page and decides. With fewer than 500 characters of page text, stage 2 does not decide: the candidate is included and marked `insufficient-text`, so a page that has not rendered is never excluded for saying nothing.
- Candidates are screened in seeded draw order until the draw has enough inclusions. The PRISMA counts cover every record screened, each with exactly one outcome. A candidate that is reachable but cannot be collected within its terms or boundary (robots.txt disallows it, or it redirects off its own boundary) is counted as not collectable, not as a screening exclusion.
- The screener is Nemotron-3.5-Lightning, deterministic (temperature 0), with a schema-constrained reply. Stage 2 runs with reasoning on.

The screening audit (section 4, D-04) measures the exclusion error of both stages together.

Reason: the frame is every Show HN post in the window, most of which are not AI products, and section 2 had no true code for them. Without it a non-AI candidate could be excluded only under a code whose meaning is false for it.

## Addendum 2026-10-19 (A6)

Adopted on Helen's instruction of 2026-10-19 ("it needs to be scalable so my name should not be required"). Results seen when this was written: the screened pilot's coding by two models, its agent confirmation, and the redrawn floor-effect review. No gold label existed.

### A6. Roles, not a named person (changes sections 3, 4, 5, 12 and addenda A2, A3, A4)

Changed rule: every step this protocol assigned to Helen by name is a role. A person or an agent may fill any role, under the independence rules below, and every act in a role is a decision record: what was decided, the reasons, the digest of the input judged, the time, and the actor's identity and kind (person, or agent with its model id). Helen may fill any role; none requires her.

| Role | Replaces | Independence rule |
|---|---|---|
| Sign-off reviewer | Helen signing the protocol, its amendments, the codebook, floor-effect decisions and the published findings (sections 12 and 13, A2) | Did not draft what it signs. An agent reviewer is of a model family different from the drafter's and from every coder's of the projects involved. |
| Gold labeller | Helen's blind labels (sections 4 and 5) | Never sees a model proposal or confirmation for the projects it labels. Neither a coder nor the confirmer of those projects. An agent labeller is of a model family different from every coder's and the confirmer's. |
| Screening auditor | Helen re-screening 50 exclusions (section 4, D-04) | Not the screener model. |
| Collection-recall gatherer | Helen gathering evidence for about 10 projects (section 4, D-05) | Gathers from the project's own sources before seeing the pipeline's output for that project, and is not the collector. |
| Confirmer | as in A2 | as in A2 |

Two consequences for reporting:

- Every accuracy figure names the kind of labeller behind it. A figure from agent labels is reported as agreement with an independent labeller (with its model id), never as accuracy against expert or human labels. The thresholds in section 4 apply unchanged.
- A3's gold-label replacement rule now reads: a labeller that has seen a project's coding cannot label that project blind, so the next project in gold-label seed order replaces it. A4's Discord rule now reads: no new automated collection unless a signed amendment allows it.

Reason: a method that needs one named person at every gate cannot scale beyond what that person can review, and A2 already judges work by its process and evidence, not by who did it. The independence rules keep the separation between who produces a result and who checks it.

## Addendum 2026-10-20 (A7)

Adopted on Helen's 2026-10-20 decisions D-46 through D-65, through the A6 sign-off role. Results seen when this was written: the pilot's coding and confirmation, the GLM probes on two pilot chunks, and the labeller spike on 5 pilot projects. No gold label existed.

### A7.1 Gold labels on all 300

Changed rule (widens section 5): every project in the drawn sample of 300 is gold-labelled by an independent agent labeller (GLM-5.3 by its pinned provider and setting), in gold-seed order. A3 keeps ArtCraft out of gold. A gold outcome must exist before a project is confirmed or edited: `labelled`, `no-gold` after three off-contract replies, or `excluded-a3`. Labels are never changed once written. Figures are reported as agreement with an independent labeller (GLM-5.3), never as human accuracy.

Reason: more checks become estimable; independence and lock-before-confirm keep the gate meaningful.

### A7.2 Labeller and auditor configuration

Changed rule: the gold labeller's provider, model id and reasoning setting are the pin recorded in the gold-labeller spike record (Token Factory `zai-org/GLM-5.3-Flash`, reasoning `low`). Kimi-K3 fills the screening auditor and the collection-recall gatherer. Every decision record stores provider and model id. Routers that pick a random model are not used.

Reason: measured settings avoid token exhaustion; attribution makes every label auditable; a free-router id is never a valid model.

### A7.3 Rendered text as own-source evidence

Changed rule: pages under 500 characters of HTML text are rendered headless (about 1.5 s after network idle, scrolled) and snapshotted as own-source spans with visibility `rendered`.

Reason: thin pages that have not rendered must not be treated as empty of evidence when a short render recovers the text.

### A7.4 Shortfall step 1

Changed rule: when a check misses its gate, one correction is allowed, preferably coder guidance that leaves the rule text unchanged. A rule change is codebook v1.1 with its own signed amendment, and gold for that check is re-labelled under v1.1. Revalidation uses a fresh draw that continues each quarter's sampling-seed walk past its first 75 (about 19 per quarter, numbered 301+), gold-labelled the same way, and is never scored on the projects it was tuned on. When it passes, the corrected coding replaces only the corrected checks' states across the 300. A check not estimable on the fresh draw is withheld.

Reason: one pre-registered correction path; no scoring on the sample that taught the fix.

### A7.5 Shortfall step 2

Changed rule: if step 1 still fails, "human-code" means withhold unless a person codes that check across the full sample. The labeller's states are never published as the coding. There is no third agent.

Reason: the labeller measures agreement; it is not a substitute publisher of coded states.

### A7.6 Confirmer downgrade

Changed rule: a confirmer may downgrade `pass` to `claimed` (downward only). That decision counts as confirmed.

Reason: a state that is a claim rather than evidence should be recorded as claimed without a full reject.

### A7.7 Injection-flagged projects

Changed rule: injection-flagged projects are confirmed normally. Any positive that cites a flagged span is rejected. Flagged counts and decisions are reported.

Reason: the flag marks untrusted span text; confirmation still runs, but a positive that rests on flagged text does not stand.

### A7.8 Published state

Changed rule: person edits re-run the quote-or-unknown filter. A person decision on the current digest outranks an agent decision. Nobody confirms their own edit. Rejected or unconfirmed positives enter no statistic and count as not-pass in the secondary agreement figure.

Reason: the published state is the filtered, confirmed one; person overrides stay digest-bound.

### A7.9 Agreement details

Changed rule: the gate compares the primary coder's filtered proposals with gold per check. Published-state agreement is secondary. Bootstrap draws use one running counter i over resamples with the seed of the sample analysed (gold seed for the gate, second-model seed for the second-model figure). Projects without gold are excluded and counted.

Reason: the pre-registered gate stays on proposals against gold; resampling stays reproducible.

### A7.10 Screening audit

Changed rule: the audit pool is exclusions with a content reason code from either screening stage; `duplicate` and `unreachable-at-screening` are reported separately. The auditor reads title, final URL and own-page text (rendered when thin), never the screener's decision. Fewer than 500 characters is "not assessable". An error is an excluded candidate the auditor would include. The Wilson upper limit is reported. On a miss, the tightened rule re-screens the 50 audited exclusions once and the error is re-measured there; the drawn 300 is not redrawn; a remaining miss is a stated selection limitation with the count of candidates the tightened rule would include.

Reason: A6 independence for the auditor; operational codes are not content errors.

### A7.11 Collection recall

Changed rule: recall items are (check, URL, verbatim quote, pass or claimed) the gatherer finds on the project's own site and repository by its own fetches (robots.txt first, no third-party search API). An item whose quote is not verbatim in the gatherer's own fetched text is dropped and counted. An item is found when its redacted, case- and whitespace-normalised quote is a substring of the project's collected snapshot text. Both fetch dates and missed-page versus changed-text are recorded. On a miss, the collector's map and extract depth is widened once and re-measured on the same projects; the widened collector is applied to the whole sample only when the search-API balance covers it; otherwise (or if still under 70%) every unknown is worded "not found by the collector".

Reason: recall measures the collector against an independent gatherer that does not reuse the collector's fetches.

### A7.12 Strata and N

Changed rule: strata remain the window-aligned quarters already signed in register row R03 (equal 75 per quarter), walked in chronological order. Across quarters, a project already included from an earlier post is excluded under the existing \`duplicate\` reason code (R13 / section 2), using one shared set of included hosts so the same launch is not counted twice. N stays 300 (A1/A2). Robots-blocked at preflight is not collectable (A5), while a drawn project whose collection fails stays in N with a sensitivity line (section 3). Pilot rows are removed after a verified backup and statistics are limited to the sample list. Coding runs in real time because the Batch API was unavailable.

Reason: restates R03 and the pre-registered N for the bulk sample; pilot and sample must not share project numbers in one store.

## Addendum 2026-10-21 (A8)

Adopted on Helen's 2026-10-21 decision D-66 (Tavily usage-limit halt at 142/300; no new paid collection spend). Through the A6 sign-off role. No free-collector coded result counts until this addendum is signed digest-bound.

### A8.1 Free own-site collector for bulk coding

Changed rule: the bulk COD-07 run for all 300 projects uses one free own-site collector (homepage, sitemap.xml, and in-boundary links; about 20 pages per project; at most one request per second per host; robots.txt before any page; thin pages rendered as in A7.3; GitHub via the authenticated `gh` API). It does not call Tavily or any other paid search/extract API. Tavily remains available only as an explicit single-project / Phase 7 bonus path (`--use-tavily`), not for bulk.

Reason: the Tavily key hit its plan limit mid-sample; mixing collectors across quarters would confound cohort findings; the rules require a Token Factory runtime call and an NVIDIA open model, not Tavily, for coding.

### A8.2 Tavily-142 archive retained read-only

Changed rule: every Tavily-coded result from the halted run is kept forever as proof at `~/.prism-data/backups/2026-10-21-tavily-142/` (sqlite, snapshots, manifests, cache, SHA256SUMS, bulk log). No pipeline path may delete or overwrite that basename. The live store is recollected with the free collector.

Reason: the 142 are the only honest Tavily proof for this sample; discarding them would erase the halt evidence.

### A8.3 Tavily-vs-free cross-check is exploratory only

Changed rule: for each of the 142 archived projects, a per-project comparison of Tavily vs free-collector pages, spans, and check states is written under `validation/` and reported as exploratory. It never feeds `publishedStates`, gate statistics, or any published figure.

Reason: the cross-check shows what the free collector adds or misses without contaminating the pre-registered statistics.

## Addendum 2026-10-21 (A9)

Adopted on Helen's 2026-10-21 decision D-67 (whole-page spans from the free collector caused confirmer overspend). Through the A6 sign-off role. No post-fix coded, gold, or confirmation result counts until this addendum is signed digest-bound.

### A9.1 Span fix (collector, 1500-char cap, resegment)

Changed rule: the free own-site collector preserves block line breaks (does not flatten all whitespace). The segmenter hard-caps every span at 1,500 characters, preferring sentence boundaries, then the last whitespace before the cap, else a hard split at 1,500. All 300 projects are re-segmented from stored redacted snapshot text; prior content-addressed snapshot files are retained. Coding and confirmation after this addendum use only the re-segmented spans.

Helen approved on 2026-10-23: send exact-duplicate span text once per project for coding, gold and second coding, retaining the first occurrence's citation id. Preserve all original snapshot text, span ids and source metadata in storage; this changes request packing only. Keep the existing 40,000-character chunk size. Confirmation requests contain only the spans cited for the individual positive, never all project spans; repeated cited text may be sent once without changing the decision's complete citation record.

Reason: whole-page spans (max hundreds of thousands of characters) made confirmer prompts hit rate limits and spend money; fixed spans are a precondition for any further counting run.

### A9.2 Spending guards (20k token cap, per-run dollar budget, BUDGET lines)

Changed rule: every paid chat call, including Ollama Cloud, estimates prompt tokens before HTTP and refuses above a default 20,000-token cap, recording `too-large` without sending. Each bulk run has an explicit dollar budget shared across its requests; the run reserves the input estimate plus maximum output cost before sending, stops before exceeding the budget, and prints `BUDGET` lines with estimated, spent, and cap. Oversized items never reach the network.

Reason: the Ultra confirmation overspend must be structurally impossible on the next paid path.

### A9.3 Host defaults (Ollama bulk; Token Factory only with budget flag)

Changed rule: bulk gold, confirmation, and second-coder roles default to Ollama Cloud, billed per token against the Pro plan's $60/month included credit (correction 2026-10-23). Ollama calls use the same request cap and run budget, documented model prices, and concurrency 1–2 within the service's three-request limit. Token Factory client construction for bulk coding or confirmation requires an explicit `--budget` (or equivalent env) flag; without it the client refuses. Token Factory remains available for capped showcase and the hard-capped primary recode named in the phase plan. No paid call proceeds without an approved budget.

Helen approved on 2026-10-23: primary recode of 300 uses Token Factory `deepseek-ai/DeepSeek-V4-Flash-0731`, capped at $3.50. Gold uses Ollama `glm-5.3-flash`, capped at $4.50. The seeded 100-project second coder uses Ollama `nemotron-3-super` in place of Super-VL; substitution reason: cost, capped at $0.75, with model and reason recorded in decision metadata. This is a text-only substitution, not a claim of vision-model equivalence. A paired 30-positive confirmer spike compares Ollama `nemotron-3-ultra` with thinking on versus low, capped at $0.50 total; judge decisions by reading their cited spans, then report before full confirmation. Full confirmation uses the winning setting with a $5.00 cap. The combined Ollama hard cap across these roles is $10.75. Stop and report at each cap; never reset a budget on resume. Stable codebook prefixes and returned cache-token usage are measured on each host; guards assume uncached rates until a discount is supported by measured usage and published pricing.

Reason: both hosts incur usage charges; model and host selection cannot bypass spending controls.

### A9.4 Whole-page-spans archive is exploratory only

Changed rule: positives, confirmations, and gold labels produced on defective whole-page spans are archived read-only at `~/.prism-data/backups/2026-10-21-whole-page-spans/` (sqlite, COUNTS.json, SHA256SUMS). That archive is exploratory and not for publication: it must never feed `publishedStates`, agreement, gate statistics, or any published figure. Fresh gold and confirmation run only on re-segmented spans after this addendum.

Reason: the defect set is proof of the failure mode, not a cohort statistic.

## Addendum 2026-10-23 (A10)

Helen approved these corrections while primary recoding was underway. A9 remains the signed record of the original recovery rules; no fresh gold, second coding or confirmation had begun when these corrections were made. Through the independent sign-off role, with the original A9 digest retained.

### A10.1 Primary recode budget correction

Changed rule: raise the Token Factory primary recode hard cap from $3.50 to $3.80. Retain all spend and unresolved reservations already recorded; never reset the ledger on resume. Sign-off costs are conservatively included within the same $3.80 host ceiling. All other role caps and the combined $10.75 Ollama ceiling remain unchanged.

Reason: observed recode spend was approximately $0.0115 per project, projecting about $3.44 for 300; Helen explicitly approved the extra margin.

### A10.2 Paired confirmer settings correction

Changed rule: the 30-positive Ultra spike compares thinking on versus off, not low. The model advertises only boolean thinking settings. Keep the $0.50 combined spike cap, identical cited evidence in both conditions, and independent reading of every decision against its cited spans. Report the comparison before full confirmation; the latter retains its $5.00 cap and uses the winning setting.

Reason: compare supported settings without silently translating an unsupported setting.

## Addendum 2026-10-25 (A11)

Adopted on Helen's standing existing-balance instruction of 2026-10-25. This supersedes asking for separate spending approval within the protected envelope; evidence rules and agreement thresholds remain unchanged.

### A11.1 Existing balances and protected reserves

Changed rule: use existing balances only, with no top-up, credit purchase or new sign-in grant. Token Factory spending must leave at least $1.00 for judges' live runs. Ollama spending must leave at least $0.50 of included monthly credit; purchased credit is not usable. Verify starting balances, freeze the release allowance and retain every subsequent charge and unresolved reservation across stages and restarts. Each request reserves its complete bounded cost before transmission. Retain the default 20000-token prompt guard and the previously approved exact-nine confirmation exceptions only. Decisions within this envelope are autonomous and actual spend is reported afterwards. The fresh 76-project stage and the single extra guidance adjudication are authorized within this envelope.

Reason: shared remaining balances must fund completion while preserving live-run and included-credit reserves.

### A11.2 No-spend publication fallback

Changed rule: when a required correction, application or confirmation would exceed the remaining protected allowance, record its projection and a digest-bound copy of the budget evidence and withhold the affected unreleased checks under D-55b. A fresh passing result can remain withheld when application or confirmation is unaffordable; its fresh metrics remain reported. A correction without independent approval remains unapplied and its check is withheld. Preserve the original states, evidence, failed decisions and explicit limitation. The all-17 application scenario is not authorized. The original 300 never become the correction test set, and the labeller's states never replace primary coding.

Reason: a failed or unaffordable step must produce a truthful withheld result within the existing allowance.

### A11.3 Complete bounded gate review

Changed rule: keep every agreement number and project-bootstrap interval intact. Where the complete gate plus the full protocol exceeds the request limit, review complete agreement matrices as separate named JSON documents. The final gate manifest retains the primary release decisions and other metadata; each complete matrix is either supplied inline or named by an approved attachment's exact digest. Every review receives the full protocol. Loading the signed gate requires the final manifest approval, each attachment's latest matching approval, exact file digests and a lossless reconstruction matching the complete-gate digest. This changes only review representation; the statistics, scope and release thresholds are unchanged. All numbers and intervals remain readable and exact.

Reason: bounded review requests must preserve the full evidence and the existing publication input contract.
