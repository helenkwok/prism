# PRISM Codebook v0

This is codebook v0: a draft pass (per decision D-31) covering all 24 ai-output-to-value
decision-gate checks. One check — `acceptance-criteria-met` — is fully authored as this phase's
tracer; the other 23 are schema-complete placeholders (their `operationalDefinition` is prefixed
`DRAFT PLACEHOLDER: `) to be filled with real content in later Phase 3 plans. This file is pending
Helen's review and correction before it is frozen (CDB-05); nothing in it should be treated as a
settled citation until then.

## Purpose and scope

PRISM codes public evidence from an AI project's own website and repository against the 24 checks
that ai-output-to-value's Claim Gate requires across its five decisions (explore, rely, operate,
measure-outcome, scale-renew-stop). For each check, this codebook gives an operational definition —
what counts as evidence the check passed, failed, or was only claimed — and crosswalks that
definition to five external standards: ISO/IEC 42001, GAICC's AI Management System (AIMS)
artefacts, NIST AI RMF / AI 600-1, the EU AI Act (informational only), and the OECD AI Principles.

## How to read this document

Each of the 24 checks below is one entry in the single fenced `json` block at the end of this file
(never split into per-check files, per D-33). Prose before the block documents the shared policies
every check follows; the block itself holds every check's operational definition, pass/fail/claimed
rules, anchor examples, and standards crosswalk.

## Check states

Every check is coded into one of four states: `pass`, `fail`, `unknown`, or `claimed`.

- **pass** — the project's own page or repository shows, with a verbatim quotable sentence and a
  resolvable span, that the check's criterion was met.
- **fail** — the project's own page or repository explicitly states the criterion was not met.
- **unknown** — no quotable, resolvable evidence either way. This is also what any
  `pass`/`fail`/`claimed` proposal downgrades to when its cited span does not resolve (the
  quote-or-unknown filter, `src/pipeline/coding/filter.ts`'s `applyQuoteOrUnknownFilter`).
- **claimed** — the project asserts the criterion was met (a badge, logo, certification mark, or
  bare claim) without evidence that would otherwise support `pass`. See "Self-claim rule" below.

This is a check-level state. It is distinct from the **snapshot-level `missing-data` marker**: a
project whose site returned empty or JS-only content after the pipeline's one advanced-depth retry
is marked `missing-data` at the snapshot/project level, separate from every individual check being
coded `unknown` for a project whose site is real but simply silent on a given check.

**Claimed-to-unknown gate projection.** The deterministic Claim Gate's `gateChecks` enum has no
`claimed` value. A `claimed` state is projected to `unknown` before it reaches the gate — this
policy is already implemented in `src/pipeline/claims/build-claims.ts`'s `projectToGateState`, and
is documented here, not reimplemented.

**Not-applicable policy.** A check is never independently marked not-applicable by the coder. The
gate itself derives `not-applicable` at the decision level — for example `operate`'s
`deliverable-gate-passed` check is overridden from `rely`'s own gate result, becoming
`not-applicable` when `rely` was `INSUFFICIENT_EVIDENCE` — per the gate's own existing
`INSUFFICIENT_EVIDENCE`/not-applicable handling. This codebook documents that behaviour where
relevant; it does not add a second not-applicable mechanism.

## Crosswalk relation types

Every crosswalk edge — one check mapped to one standard's clause, control, or principle — carries a
`relation_type` drawn from exactly three values, used identically across all 24 checks and all 5
standards:

- **addresses** — the check's intent maps closely to the clause's intent.
- **supports** — the evidence a check requires is weaker or partial support for the clause.
- **partial** — only part of the clause is touched by the check.

There is no fourth relation type. In particular, the EU AI Act's informational-only status (its
crosswalk is advisory, never load-bearing for the review's statistics) is recorded as a separate
`informational: true` field on that standard's edges, never as a distinct relation type. A
crosswalk entry never asserts a check "satisfies" a clause — standards compliance is not something
public-evidence coding can establish, and the relation-type vocabulary above exists precisely to
avoid that overreach.

Crosswalk locators cite the clause or control ID plus its official title only (for example
"ISO/IEC 42001:2023, Annex A.6.2.4, Verification and validation") — never a quote of normative
text. Each edge's own `qualification` field is PRISM's paraphrase of why the mapping holds, kept
short and in its own words, separate from the ID+title citation.

## Self-claim rule

Per decision D-38 (COD-03): a badge, logo, or certification mark on a project's own page with no
adjacent certificate ID or verifiable register URL is coded `claimed`, never `pass`, regardless of
whether its span resolves. This pipeline does not fetch or verify any external certificate
register — doing so would also cross EVD-01's own-source evidence boundary. Whether a linked
register URL actually resolves to a real, valid certificate is Helen's judgment at Phase 4
confirmation (COD-08), not an automated check.

## The 24 checks

```json
{
  "codebookVersion": "v0",
  "relationTypes": [
    "addresses",
    "supports",
    "partial"
  ],
  "checks": {
    "output-reproducible": {
      "decision": "explore",
      "label": "The artefact or action can be reproduced or inspected.",
      "operationalDefinition": "Whether a party other than the project's own team can reproduce the artefact's reported behaviour or inspect how it works, using only what the project itself has published.",
      "passRule": "Coded pass when the project's own page or repository gives a verbatim quotable sentence plus a linked, usable artefact — published source code with build/run instructions, a public live demo, or published model weights/data — that lets an independent party run or inspect the same artefact.",
      "failRule": "Coded fail when the project's own page or repository explicitly states the artefact cannot be reproduced or inspected by outsiders (for example source withheld, demo access restricted to paying customers only, no public endpoint).",
      "claimedRule": "Coded claimed — never pass — when the project asserts reproducibility or openness (for example an \"Open Source\" badge or a bare \"fully reproducible\" statement) with no linked repository, demo, or artefact a reader can actually use.",
      "notApplicableNote": "No legitimate not-applicable case: every project that publishes an artefact or action makes reproducibility a coded question, even if the answer is unknown rather than not-applicable.",
      "anchors": {
        "positive": [
          "Our full source code and a step-by-step setup guide are published at our public repository under an MIT licence, and a live demo at demo.example.com requires no signup.",
          "The trained model checkpoint and the evaluation notebook we used to produce our reported numbers are both published on a public model hub."
        ],
        "negative": [
          "Our underlying model and pipeline are proprietary and are not shared with the public under any circumstances.",
          "API access is granted only to enterprise customers after a signed NDA; there is no public demo or endpoint."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "iso-42001-annex-a-6.2.7-output-reproducible",
            "title": "ISO/IEC 42001:2023 Annex A.6.2.7 — Technical documentation",
            "locator": "Annex A.6.2.7",
            "source_version": "ISO/IEC 42001:2023",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "gaicc": [
          {
            "source_id": "gaicc-aims-operational-documentation-output-reproducible",
            "title": "GAICC AIMS — Operational documentation",
            "locator": "AIMS artefact: Operational documentation",
            "source_version": "GAICC 12-Week Challenge AIMS artefact list",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "nist-ai-rmf-govern-1-output-reproducible",
            "title": "NIST AI RMF 1.0, GOVERN 1 — Policies, processes, procedures, and practices",
            "locator": "GOVERN 1",
            "source_version": "NIST AI RMF 1.0 (2023), as profiled by AI 600-1",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "euAiAct": [
          {
            "source_id": "eu-ai-act-article-11-output-reproducible",
            "title": "Regulation (EU) 2024/1689, Article 11 — Technical documentation",
            "locator": "Article 11",
            "source_version": "Regulation (EU) 2024/1689, consolidated text of 2026-07-27",
            "relation_type": "supports",
            "informational": true,
            "qualification": "[ASSUMED] article numbering not verified against the 2026-07-27 consolidated text (03-RESEARCH.md Open Question 2)"
          }
        ],
        "oecd": [
          {
            "source_id": "oecd-ai-principle-transparency-output-reproducible",
            "title": "OECD AI Principles — Transparency and explainability",
            "locator": "Principle 1.3",
            "source_version": "OECD Recommendation on AI, as updated May 2024",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ]
      }
    },
    "assumptions-catalogued": {
      "decision": "explore",
      "label": "Important supplied context, assumptions, and inferences are visible.",
      "operationalDefinition": "Whether the project's own page or repository makes visible the context it was given, the assumptions it made, and the inferences it drew, rather than leaving them implicit.",
      "passRule": "Coded pass when the project's own page or repository names, with a verbatim quotable sentence, a specific assumption, input context, or inference it relied on (for example stated data assumptions, scope assumptions, or model-behaviour inferences), with a linked artefact where one exists (a design doc, model card, or README section).",
      "failRule": "Coded fail when the project's own page or repository explicitly disclaims having catalogued its assumptions (for example stating assumptions are undocumented or were not tracked).",
      "claimedRule": "Coded claimed — never pass — when the project asserts its assumptions are documented (for example \"we document all our assumptions\") with no visible list, model card, or linked artefact naming any specific assumption.",
      "notApplicableNote": "No legitimate not-applicable case: any project built on some input or context has assumptions a reader could ask about, even if none are visible.",
      "anchors": {
        "positive": [
          "Our model card states the training data assumes English-language text only, and that user queries are assumed to be well-formed sentences, not fragments.",
          "Section 4 of our design document lists the three inferences we made about typical usage volume and flags them as assumptions to revisit."
        ],
        "negative": [
          "We don't publish our internal assumptions about user behaviour; they're considered proprietary.",
          "No assumptions document exists for this release."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "iso-42001-annex-a-6.2.3-assumptions-catalogued",
            "title": "ISO/IEC 42001:2023 Annex A.6.2.3 — Documentation of design and development",
            "locator": "Annex A.6.2.3",
            "source_version": "ISO/IEC 42001:2023",
            "relation_type": "addresses",
            "qualification": "[CITED] This control covers documenting design/development assumptions and context."
          }
        ],
        "gaicc": [
          {
            "source_id": "gaicc-aims-scope-assumptions-catalogued",
            "title": "GAICC AIMS — Scope",
            "locator": "AIMS artefact: Scope",
            "source_version": "GAICC 12-Week Challenge AIMS artefact list",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "nist-ai-rmf-map-1-assumptions-catalogued",
            "title": "NIST AI RMF 1.0, MAP 1 — Context is established and understood",
            "locator": "MAP 1",
            "source_version": "NIST AI RMF 1.0 (2023), as profiled by AI 600-1",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "euAiAct": [
          {
            "source_id": "eu-ai-act-article-13-assumptions-catalogued",
            "title": "Regulation (EU) 2024/1689, Article 13 — Transparency and information to users",
            "locator": "Article 13",
            "source_version": "Regulation (EU) 2024/1689, consolidated text of 2026-07-27",
            "relation_type": "supports",
            "informational": true,
            "qualification": "[ASSUMED] article numbering not verified against the 2026-07-27 consolidated text (03-RESEARCH.md Open Question 2)"
          }
        ],
        "oecd": [
          {
            "source_id": "oecd-ai-principle-transparency-assumptions-catalogued",
            "title": "OECD AI Principles — Transparency and explainability",
            "locator": "Principle 1.3",
            "source_version": "OECD Recommendation on AI, as updated May 2024",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ]
      }
    },
    "intended-use-defined": {
      "decision": "rely",
      "label": "The intended use and boundaries are explicit.",
      "operationalDefinition": "Whether the project's own page or repository states, for the specific use it is promoted for, what that use is and where its boundaries lie.",
      "passRule": "Coded pass when the project's own page or repository gives a verbatim quotable sentence naming the intended use and its boundaries (for example named supported use cases, explicitly excluded use cases, or a stated target user/domain), with a linked artefact (a docs page or README section) where one exists.",
      "failRule": "Coded fail when the project's own page or repository explicitly states it has not defined an intended use or boundary (for example \"use at your own discretion for any purpose\" framed as an explicit absence of scoping).",
      "claimedRule": "Coded claimed — never pass — when the project asserts it has a defined intended use (for example \"built for enterprise workflows\") with no further detail on what that use is or where its boundaries lie.",
      "notApplicableNote": "No legitimate not-applicable case: any project promoted for some use has an intended use a reader could ask about, even if none is stated.",
      "anchors": {
        "positive": [
          "This tool is intended for drafting internal meeting summaries from recorded audio; it is not intended for medical, legal, or financial transcription.",
          "Our docs page states the assistant is designed for customer-support ticket triage only and should not be used for making final refund decisions without human review."
        ],
        "negative": [
          "You can use this for anything you like.",
          "No stated use case; the README only lists installation steps."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "iso-42001-annex-a-9.4-intended-use-defined",
            "title": "ISO/IEC 42001:2023 Annex A.9.4 — Intended use of the AI system",
            "locator": "Annex A.9.4",
            "source_version": "ISO/IEC 42001:2023",
            "relation_type": "addresses",
            "qualification": "[CITED] This control directly addresses stating the AI system's intended use."
          }
        ],
        "gaicc": [
          {
            "source_id": "gaicc-aims-scope-intended-use-defined",
            "title": "GAICC AIMS — Scope",
            "locator": "AIMS artefact: Scope",
            "source_version": "GAICC 12-Week Challenge AIMS artefact list",
            "relation_type": "addresses",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "nist-ai-rmf-map-3-intended-use-defined",
            "title": "NIST AI RMF 1.0, MAP 3 — AI capabilities, targeted usage, goals, benefits/costs vs. benchmarks are understood",
            "locator": "MAP 3",
            "source_version": "NIST AI RMF 1.0 (2023), as profiled by AI 600-1",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "euAiAct": [
          {
            "source_id": "eu-ai-act-article-13-intended-use-defined",
            "title": "Regulation (EU) 2024/1689, Article 13 — Transparency and information to users",
            "locator": "Article 13",
            "source_version": "Regulation (EU) 2024/1689, consolidated text of 2026-07-27",
            "relation_type": "supports",
            "informational": true,
            "qualification": "[ASSUMED] article numbering not verified against the 2026-07-27 consolidated text (03-RESEARCH.md Open Question 2)"
          }
        ],
        "oecd": [
          {
            "source_id": "oecd-ai-principle-accountability-intended-use-defined",
            "title": "OECD AI Principles — Accountability",
            "locator": "Principle 1.5",
            "source_version": "OECD Recommendation on AI, as updated May 2024",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ]
      }
    },
    "acceptance-criteria-defined": {
      "decision": "rely",
      "label": "Acceptance criteria are explicit and testable enough for the use.",
      "operationalDefinition": "Whether the project's own page or repository states acceptance criteria for its stated use that are specific and testable, rather than a vague claim of quality.",
      "passRule": "Coded pass when the project's own page or repository gives a verbatim quotable sentence naming a specific, testable acceptance criterion for its stated use (for example a named metric with a numeric threshold, a pass/fail test suite, or a named benchmark), with a linked artefact (a spec, test file, or benchmark page) where one exists.",
      "failRule": "Coded fail when the project's own page or repository explicitly states it has no defined acceptance criteria (for example \"we have not set a formal bar for this release\").",
      "claimedRule": "Coded claimed — never pass — when the project asserts it has acceptance criteria (for example \"meets our quality bar\") with no named metric, threshold, or test that a reader could check.",
      "notApplicableNote": "No legitimate not-applicable case: any project claiming fitness for a use implies some bar for that fitness, even if the bar is never stated.",
      "anchors": {
        "positive": [
          "We require at least 95% exact-match accuracy on our published 500-document test set before a release ships; the current build scores 96.2%.",
          "Our acceptance test suite (linked below) defines 42 pass/fail scenarios that a release must clear before deployment."
        ],
        "negative": [
          "We hold ourselves to a high quality bar.",
          "The team is confident in the results."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "iso-42001-annex-a-6.2.2-acceptance-criteria-defined",
            "title": "ISO/IEC 42001:2023 Annex A.6.2.2 — AI system requirements and specification",
            "locator": "Annex A.6.2.2",
            "source_version": "ISO/IEC 42001:2023",
            "relation_type": "addresses",
            "qualification": "[CITED] This control covers specifying testable requirements, the closest fit here."
          }
        ],
        "gaicc": [
          {
            "source_id": "gaicc-aims-objectives-acceptance-criteria-defined",
            "title": "GAICC AIMS — Objectives",
            "locator": "AIMS artefact: Objectives",
            "source_version": "GAICC 12-Week Challenge AIMS artefact list",
            "relation_type": "addresses",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "nist-ai-rmf-measure-1-acceptance-criteria-defined",
            "title": "NIST AI RMF 1.0, MEASURE 1 — Appropriate methods and metrics are identified and applied",
            "locator": "MEASURE 1",
            "source_version": "NIST AI RMF 1.0 (2023), as profiled by AI 600-1",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "euAiAct": [
          {
            "source_id": "eu-ai-act-article-9-acceptance-criteria-defined",
            "title": "Regulation (EU) 2024/1689, Article 9 — Risk management system",
            "locator": "Article 9",
            "source_version": "Regulation (EU) 2024/1689, consolidated text of 2026-07-27",
            "relation_type": "supports",
            "informational": true,
            "qualification": "[ASSUMED] article numbering not verified against the 2026-07-27 consolidated text (03-RESEARCH.md Open Question 2)"
          }
        ],
        "oecd": [
          {
            "source_id": "oecd-ai-principle-robustness-acceptance-criteria-defined",
            "title": "OECD AI Principles — Robustness, security and safety",
            "locator": "Principle 1.4",
            "source_version": "OECD Recommendation on AI, as updated May 2024",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ]
      }
    },
    "acceptance-criteria-met": {
      "decision": "rely",
      "label": "Evidence shows the acceptance criteria were met.",
      "operationalDefinition": "Whether the project's own published pages or repository show that the acceptance criteria it defined for its stated intended use were actually met — not merely asserted, planned, or in progress.",
      "passRule": "Coded pass when a page or repository artefact names a specific acceptance criterion (or a linked test/evaluation report) and states, with a verbatim quotable sentence plus a linked artefact (a report, benchmark table, or test-suite result), that the criterion was met.",
      "failRule": "Coded fail when the project's own page or repository states, in a verbatim quotable sentence, that a named acceptance criterion was NOT met, or that an evaluation surfaced a criterion failure that was not subsequently resolved.",
      "claimedRule": "Coded claimed — never pass — when the only evidence is a self-asserted badge, logo, or certification mark (for example a \"SOC 2 Type II\" badge image) with no adjacent certificate ID or verifiable register URL. This applies regardless of whether the badge's own span resolves to a real span in the page; whether a linked register URL actually resolves is Helen's judgment at Phase 4 confirmation (COD-08), never fetched or verified by this pipeline.",
      "notApplicableNote": "A project with no stated intended use or acceptance criteria at all is not separately marked not-applicable by the coder for this check; the gate's own INSUFFICIENT_EVIDENCE / not-applicable handling applies at the decision level instead.",
      "anchors": {
        "positive": [
          "Our v2.1 benchmark report (linked below) shows the parser achieves 98% field-extraction accuracy against our published 500-document acceptance test set, exceeding our stated 95% criterion.",
          "The attached evaluation harness output confirms all 42 acceptance scenarios defined in our spec passed on the 2026-08 release build."
        ],
        "negative": [
          "We're proud to be SOC 2 Type II certified.",
          "Acceptance testing is planned for our next release."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "iso-42001-annex-a-6.2.4",
            "title": "ISO/IEC 42001:2023 Annex A.6.2.4 — Verification and validation",
            "locator": "Annex A.6.2.4",
            "source_version": "ISO/IEC 42001:2023",
            "relation_type": "addresses",
            "qualification": "[CITED] This control covers verification activity closest to testing whether criteria were met."
          }
        ],
        "gaicc": [
          {
            "source_id": "gaicc-aims-evidence-of-implementation",
            "title": "GAICC AIMS — Evidence of implementation",
            "locator": "AIMS artefact: Evidence of implementation",
            "source_version": "GAICC 12-Week Challenge AIMS artefact list",
            "relation_type": "addresses",
            "qualification": "[CITED] This artefact most directly addresses demonstrated evidence that criteria were met."
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "nist-ai-rmf-measure-2",
            "title": "NIST AI RMF 1.0, MEASURE 2 — AI systems are evaluated for trustworthy characteristics",
            "locator": "MEASURE 2",
            "source_version": "NIST AI RMF 1.0 (2023), as profiled by AI 600-1",
            "relation_type": "supports",
            "qualification": "[CITED] Evaluation for trustworthy characteristics supports but does not fully establish criteria were met."
          }
        ],
        "euAiAct": [
          {
            "source_id": "eu-ai-act-article-15",
            "title": "Regulation (EU) 2024/1689, Article 15 — Accuracy, robustness and cybersecurity",
            "locator": "Article 15",
            "source_version": "Regulation (EU) 2024/1689, consolidated text of 2026-07-27",
            "relation_type": "supports",
            "informational": true,
            "qualification": "[ASSUMED] article numbering not verified against the 2026-07-27 consolidated text (03-RESEARCH.md Open Question 2)"
          }
        ],
        "oecd": [
          {
            "source_id": "oecd-ai-principle-transparency",
            "title": "OECD AI Principles — Transparency and explainability",
            "locator": "Principle 1.3",
            "source_version": "OECD Recommendation on AI, as updated May 2024",
            "relation_type": "partial",
            "qualification": "[CITED] This only partially touches the broader transparency principle's intent."
          }
        ]
      }
    },
    "failure-modes-tested": {
      "decision": "rely",
      "label": "Relevant failure modes and fallback behaviour were evaluated.",
      "operationalDefinition": "Whether the project's own page or repository shows that it identified plausible failure modes for its stated use and evaluated how the system behaves under them.",
      "passRule": "Coded pass when the project's own page or repository gives a verbatim quotable sentence naming a specific failure mode it tested (for example adversarial inputs, edge cases, malformed data, or a named failure scenario) and states the observed behaviour, with a linked report or test log where one exists.",
      "failRule": "Coded fail when the project's own page or repository explicitly states a known failure mode was identified but not evaluated, or that evaluation surfaced a failure that remains unresolved.",
      "claimedRule": "Coded claimed — never pass — when the project asserts it tests for failure modes (for example \"robust to edge cases\") with no named failure mode or linked report describing what was tested.",
      "notApplicableNote": "No legitimate not-applicable case: any deployed system has at least plausible failure modes a reader could ask whether were tested.",
      "anchors": {
        "positive": [
          "We tested the parser against 200 deliberately malformed documents and our failure log (linked below) shows it degrades to a clear error message rather than a silent wrong answer.",
          "Our red-team report documents five adversarial prompt categories we evaluated and how the assistant responded to each."
        ],
        "negative": [
          "The system is robust and handles edge cases gracefully.",
          "We haven't gotten around to stress-testing unusual inputs yet."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "iso-42001-annex-a-6.2.4-failure-modes-tested",
            "title": "ISO/IEC 42001:2023 Annex A.6.2.4 — Verification and validation",
            "locator": "Annex A.6.2.4",
            "source_version": "ISO/IEC 42001:2023",
            "relation_type": "supports",
            "qualification": "[CITED] This control covers verifying behaviour under tested conditions, including failures."
          }
        ],
        "gaicc": [
          {
            "source_id": "gaicc-aims-ai-risk-assessment-failure-modes-tested",
            "title": "GAICC AIMS — AI risk assessment",
            "locator": "AIMS artefact: AI risk assessment",
            "source_version": "GAICC 12-Week Challenge AIMS artefact list",
            "relation_type": "addresses",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "nist-ai-rmf-measure-2-failure-modes-tested",
            "title": "NIST AI RMF 1.0, MEASURE 2 — AI systems are evaluated for trustworthy characteristics",
            "locator": "MEASURE 2",
            "source_version": "NIST AI RMF 1.0 (2023), as profiled by AI 600-1",
            "relation_type": "addresses",
            "qualification": "[CITED] Evaluation for trustworthy characteristics includes tested failure-mode behaviour."
          }
        ],
        "euAiAct": [
          {
            "source_id": "eu-ai-act-article-9-failure-modes-tested",
            "title": "Regulation (EU) 2024/1689, Article 9 — Risk management system",
            "locator": "Article 9",
            "source_version": "Regulation (EU) 2024/1689, consolidated text of 2026-07-27",
            "relation_type": "supports",
            "informational": true,
            "qualification": "[ASSUMED] article numbering not verified against the 2026-07-27 consolidated text (03-RESEARCH.md Open Question 2)"
          }
        ],
        "oecd": [
          {
            "source_id": "oecd-ai-principle-robustness-failure-modes-tested",
            "title": "OECD AI Principles — Robustness, security and safety",
            "locator": "Principle 1.4",
            "source_version": "OECD Recommendation on AI, as updated May 2024",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ]
      }
    },
    "limitations-stated": {
      "decision": "rely",
      "label": "Known limitations and out-of-scope conditions are stated.",
      "operationalDefinition": "Whether the project's own page or repository names known limitations or conditions under which the system should not be relied on, rather than presenting the system as limitation-free.",
      "passRule": "Coded pass when the project's own page or repository gives a verbatim quotable sentence naming a specific limitation or out-of-scope condition (for example unsupported languages, data types, scale limits, or known failure conditions), with a linked artefact (a docs page or model card) where one exists.",
      "failRule": "Coded fail when the project's own page or repository explicitly denies having any limitations (for example a statement that the system works correctly in all conditions with no exceptions named).",
      "claimedRule": "Coded claimed — never pass — when the project asserts limitations are documented (for example \"see our limitations section\") with no visible limitation actually named.",
      "notApplicableNote": "No legitimate not-applicable case: any real system has some boundary condition a reader could ask whether was disclosed.",
      "anchors": {
        "positive": [
          "Our model card states the summarizer is not suitable for documents longer than 50 pages and may omit minority viewpoints in multi-author texts.",
          "The docs note this integration does not support non-Latin scripts in its current release."
        ],
        "negative": [
          "This solution works reliably in every scenario.",
          "No limitations section is published for this product."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "iso-42001-annex-a-8.2-limitations-stated",
            "title": "ISO/IEC 42001:2023 Annex A.8.2 — System documentation and information for users",
            "locator": "Annex A.8.2",
            "source_version": "ISO/IEC 42001:2023",
            "relation_type": "addresses",
            "qualification": "[CITED] This control covers informing users of system limitations in documentation."
          }
        ],
        "gaicc": [
          {
            "source_id": "gaicc-aims-statement-of-applicability-limitations-stated",
            "title": "GAICC AIMS — Statement of Applicability",
            "locator": "AIMS artefact: Statement of Applicability",
            "source_version": "GAICC 12-Week Challenge AIMS artefact list",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "nist-ai-rmf-measure-4-limitations-stated",
            "title": "NIST AI RMF 1.0, MEASURE 4 — Feedback about efficacy of measurement is gathered and assessed",
            "locator": "MEASURE 4",
            "source_version": "NIST AI RMF 1.0 (2023), as profiled by AI 600-1",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "euAiAct": [
          {
            "source_id": "eu-ai-act-article-13-limitations-stated",
            "title": "Regulation (EU) 2024/1689, Article 13 — Transparency and information to users",
            "locator": "Article 13",
            "source_version": "Regulation (EU) 2024/1689, consolidated text of 2026-07-27",
            "relation_type": "supports",
            "informational": true,
            "qualification": "[ASSUMED] article numbering not verified against the 2026-07-27 consolidated text (03-RESEARCH.md Open Question 2)"
          }
        ],
        "oecd": [
          {
            "source_id": "oecd-ai-principle-transparency-limitations-stated",
            "title": "OECD AI Principles — Transparency and explainability",
            "locator": "Principle 1.3",
            "source_version": "OECD Recommendation on AI, as updated May 2024",
            "relation_type": "addresses",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ]
      }
    },
    "deliverable-gate-passed": {
      "decision": "operate",
      "label": "The Deliverable gate for the intended use has passed.",
      "operationalDefinition": "Whether the project's own rely-decision gate result (PASS / BLOCKED / INSUFFICIENT_EVIDENCE) carries forward to operate. This check's value is never independently coded by Nemotron for the operate decision: it is overridden in code from the rely decision's own gate outcome (src/pipeline/claims/build-claims.ts's buildClaimsForProject), so a reader should not expect this entry's pass/fail/claimed rules to describe span-based evidence the way the other 23 checks' rules do.",
      "passRule": "Means the rely decision's gate result was PASS — every one of rely's five required checks (intended-use-defined, acceptance-criteria-defined, acceptance-criteria-met, failure-modes-tested, limitations-stated) was coded pass. Set by code (buildClaimsForProject), not proposed by Nemotron for the operate decision.",
      "failRule": "Means the rely decision's gate result was BLOCKED — at least one of rely's five required checks was coded fail. Set by code, not proposed by Nemotron.",
      "claimedRule": "Not applicable to this check: because its value is overridden from rely's gate result rather than coded from evidence, there is no self-claim case for deliverable-gate-passed.",
      "notApplicableNote": "Coded not-applicable when the rely decision's gate result was INSUFFICIENT_EVIDENCE — at least one of rely's required checks was missing, unknown, or not-applicable with no explicit fail. This is the one check among these thirteen whose not-applicable state is set directly from another decision's own gate outcome, not left to the gate's own decision-level derivation.",
      "anchors": {
        "positive": [
          "All five of the rely decision's required checks — intended use, acceptance criteria, evidence they were met, failure-mode testing, and stated limitations — were each coded pass from the project's own published evidence.",
          "The rely decision's gate returned PASS: no required check failed and none was missing or unknown."
        ],
        "negative": [
          "The rely decision's gate returned BLOCKED because the project's own page explicitly stated an acceptance criterion was not met.",
          "The rely decision's gate returned INSUFFICIENT_EVIDENCE because no acceptance criteria could be found on the project's published pages."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "iso-42001-clause-9-deliverable-gate-passed",
            "title": "ISO/IEC 42001:2023, Clause 9 — Performance evaluation",
            "locator": "Clause 9",
            "source_version": "ISO/IEC 42001:2023",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "gaicc": [
          {
            "source_id": "gaicc-aims-management-review-deliverable-gate-passed",
            "title": "GAICC AIMS — Management review",
            "locator": "AIMS artefact: Management review",
            "source_version": "GAICC 12-Week Challenge AIMS artefact list",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "nist-ai-rmf-govern-1-deliverable-gate-passed",
            "title": "NIST AI RMF 1.0, GOVERN 1 — Policies, processes, procedures, and practices",
            "locator": "GOVERN 1",
            "source_version": "NIST AI RMF 1.0 (2023), as profiled by AI 600-1",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "euAiAct": [
          {
            "source_id": "eu-ai-act-article-17-deliverable-gate-passed",
            "title": "Regulation (EU) 2024/1689, Article 17 — Quality management system",
            "locator": "Article 17",
            "source_version": "Regulation (EU) 2024/1689, consolidated text of 2026-07-27",
            "relation_type": "supports",
            "informational": true,
            "qualification": "[ASSUMED] article numbering not verified against the 2026-07-27 consolidated text (03-RESEARCH.md Open Question 2)"
          }
        ],
        "oecd": [
          {
            "source_id": "oecd-ai-principle-accountability-deliverable-gate-passed",
            "title": "OECD AI Principles — Accountability",
            "locator": "Principle 1.5",
            "source_version": "OECD Recommendation on AI, as updated May 2024",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ]
      }
    },
    "operational-owner-assigned": {
      "decision": "operate",
      "label": "Operational ownership is explicit.",
      "operationalDefinition": "Whether the project's own page or repository names a specific role, team, or party responsible for operating the system day to day, rather than leaving operational responsibility unstated.",
      "passRule": "Coded pass when the project's own page or repository gives a verbatim quotable sentence naming a specific role, team, or contact responsible for operating the system (for example a named on-call team, support contact, or operations lead), with a linked artefact (a support page or status page) where one exists.",
      "failRule": "Coded fail when the project's own page or repository explicitly states no one is responsible for ongoing operation (for example an archived project with an explicit \"unmaintained, no owner\" notice).",
      "claimedRule": "Coded claimed — never pass — when the project asserts it has operational ownership (for example \"actively maintained\") with no named role, team, or contact.",
      "notApplicableNote": "No legitimate not-applicable case: any system in operation has someone, even if unnamed, actually doing the operating; whether that is disclosed is always coded, not excused.",
      "anchors": {
        "positive": [
          "Our on-call rotation (listed on our status page) owns incident response for this service, and the support team listed in our docs handles day-to-day operation.",
          "This repository is maintained by the Platform team; see MAINTAINERS.md for the current owner and escalation contact."
        ],
        "negative": [
          "This project is actively maintained.",
          "Archived: this repository is no longer maintained and has no assigned owner."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "iso-42001-annex-a-3.2-operational-owner-assigned",
            "title": "ISO/IEC 42001:2023 Annex A.3.2 — AI roles and responsibilities",
            "locator": "Annex A.3.2",
            "source_version": "ISO/IEC 42001:2023",
            "relation_type": "addresses",
            "qualification": "[CITED] This control directly addresses naming AI roles and responsibilities."
          }
        ],
        "gaicc": [
          {
            "source_id": "gaicc-aims-roles-operational-owner-assigned",
            "title": "GAICC AIMS — Roles",
            "locator": "AIMS artefact: Roles",
            "source_version": "GAICC 12-Week Challenge AIMS artefact list",
            "relation_type": "addresses",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "nist-ai-rmf-govern-2-operational-owner-assigned",
            "title": "NIST AI RMF 1.0, GOVERN 2 — Accountability structures",
            "locator": "GOVERN 2",
            "source_version": "NIST AI RMF 1.0 (2023), as profiled by AI 600-1",
            "relation_type": "addresses",
            "qualification": "[CITED] Accountability structures map closely to naming an operational owner."
          }
        ],
        "euAiAct": [
          {
            "source_id": "eu-ai-act-article-14-operational-owner-assigned",
            "title": "Regulation (EU) 2024/1689, Article 14 — Human oversight",
            "locator": "Article 14",
            "source_version": "Regulation (EU) 2024/1689, consolidated text of 2026-07-27",
            "relation_type": "supports",
            "informational": true,
            "qualification": "[ASSUMED] article numbering not verified against the 2026-07-27 consolidated text (03-RESEARCH.md Open Question 2)"
          }
        ],
        "oecd": [
          {
            "source_id": "oecd-ai-principle-accountability-operational-owner-assigned",
            "title": "OECD AI Principles — Accountability",
            "locator": "Principle 1.5",
            "source_version": "OECD Recommendation on AI, as updated May 2024",
            "relation_type": "addresses",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ]
      }
    },
    "assurance-defined": {
      "decision": "operate",
      "label": "The assurance mechanism is defined for the important failure modes.",
      "operationalDefinition": "Whether the project's own page or repository states a specific, ongoing mechanism (monitoring, review, or audit) for catching important failure modes during operation, rather than a one-time test.",
      "passRule": "Coded pass when the project's own page or repository gives a verbatim quotable sentence naming a specific ongoing assurance mechanism (for example automated monitoring with alerting, scheduled human review, or a recurring audit) tied to a named failure mode, with a linked artefact (a runbook or monitoring description) where one exists.",
      "failRule": "Coded fail when the project's own page or repository explicitly states no ongoing assurance mechanism exists for a named failure mode (for example \"we do not currently monitor for this\").",
      "claimedRule": "Coded claimed — never pass — when the project asserts it has assurance in place (for example \"continuously monitored\") with no named mechanism or linked process document.",
      "notApplicableNote": "No legitimate not-applicable case: any system with a stated failure mode has a coded question of whether an assurance mechanism exists for it, even if the answer is unknown.",
      "anchors": {
        "positive": [
          "Our monitoring dashboard (linked below) tracks the hallucination-rate metric hourly and pages the on-call engineer when it exceeds our threshold.",
          "A human reviewer audits a random 5% sample of outputs weekly, as described in our quality-assurance process document."
        ],
        "negative": [
          "We're confident in our system's reliability.",
          "No monitoring is currently in place for this failure mode."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "iso-42001-annex-a-6.2.6-assurance-defined",
            "title": "ISO/IEC 42001:2023 Annex A.6.2.6 — Operation and monitoring",
            "locator": "Annex A.6.2.6",
            "source_version": "ISO/IEC 42001:2023",
            "relation_type": "addresses",
            "qualification": "[CITED] This control covers ongoing operational monitoring, the core of assurance."
          }
        ],
        "gaicc": [
          {
            "source_id": "gaicc-aims-evidence-of-implementation-assurance-defined",
            "title": "GAICC AIMS — Evidence of implementation",
            "locator": "AIMS artefact: Evidence of implementation",
            "source_version": "GAICC 12-Week Challenge AIMS artefact list",
            "relation_type": "addresses",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "nist-ai-rmf-govern-1-assurance-defined",
            "title": "NIST AI RMF 1.0, GOVERN 1 — Policies, processes, procedures, and practices",
            "locator": "GOVERN 1",
            "source_version": "NIST AI RMF 1.0 (2023), as profiled by AI 600-1",
            "relation_type": "addresses",
            "qualification": "[CITED] Governance policies and practices map to defining an assurance mechanism."
          }
        ],
        "euAiAct": [
          {
            "source_id": "eu-ai-act-article-9-assurance-defined",
            "title": "Regulation (EU) 2024/1689, Article 9 — Risk management system",
            "locator": "Article 9",
            "source_version": "Regulation (EU) 2024/1689, consolidated text of 2026-07-27",
            "relation_type": "supports",
            "informational": true,
            "qualification": "[ASSUMED] article numbering not verified against the 2026-07-27 consolidated text (03-RESEARCH.md Open Question 2)"
          }
        ],
        "oecd": [
          {
            "source_id": "oecd-ai-principle-robustness-assurance-defined",
            "title": "OECD AI Principles — Robustness, security and safety",
            "locator": "Principle 1.4",
            "source_version": "OECD Recommendation on AI, as updated May 2024",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ]
      }
    },
    "fallback-defined": {
      "decision": "operate",
      "label": "Fallback or escalation is defined.",
      "operationalDefinition": "Whether the project's own page or repository states what happens when the system cannot handle a case — a fallback path or escalation to a human — rather than leaving failure handling unspecified.",
      "passRule": "Coded pass when the project's own page or repository gives a verbatim quotable sentence naming a specific fallback or escalation path (for example routing low-confidence outputs to a human reviewer, a documented degraded mode, or an explicit escalation contact), with a linked artefact (a runbook or support flow) where one exists.",
      "failRule": "Coded fail when the project's own page or repository explicitly states no fallback or escalation path exists (for example \"the system has no human-in-the-loop option\" stated as a known gap).",
      "claimedRule": "Coded claimed — never pass — when the project asserts it has fallback handling (for example \"gracefully degrades\") with no named fallback path or escalation mechanism.",
      "notApplicableNote": "No legitimate not-applicable case: any system that can fail has a coded question of whether a fallback exists, even when none is named.",
      "anchors": {
        "positive": [
          "When confidence falls below 80%, the response is routed to a human agent instead of being shown directly to the end user, as described in our escalation flow.",
          "If the primary model endpoint is unavailable, our system falls back to a simpler rules-based responder, documented in our architecture page."
        ],
        "negative": [
          "The system handles failures gracefully.",
          "There is currently no fallback if the model produces a low-confidence answer."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "iso-42001-annex-a-6.2.6-fallback-defined",
            "title": "ISO/IEC 42001:2023 Annex A.6.2.6 — Operation and monitoring",
            "locator": "Annex A.6.2.6",
            "source_version": "ISO/IEC 42001:2023",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "gaicc": [
          {
            "source_id": "gaicc-aims-risk-treatment-fallback-defined",
            "title": "GAICC AIMS — Risk treatment",
            "locator": "AIMS artefact: Risk treatment",
            "source_version": "GAICC 12-Week Challenge AIMS artefact list",
            "relation_type": "addresses",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "nist-ai-rmf-manage-2-fallback-defined",
            "title": "NIST AI RMF 1.0, MANAGE 2 — Strategies to maximize benefits and minimize negative impacts",
            "locator": "MANAGE 2",
            "source_version": "NIST AI RMF 1.0 (2023), as profiled by AI 600-1",
            "relation_type": "addresses",
            "qualification": "[CITED] Strategies to minimize negative impacts map to defining a fallback path."
          }
        ],
        "euAiAct": [
          {
            "source_id": "eu-ai-act-article-14-fallback-defined",
            "title": "Regulation (EU) 2024/1689, Article 14 — Human oversight",
            "locator": "Article 14",
            "source_version": "Regulation (EU) 2024/1689, consolidated text of 2026-07-27",
            "relation_type": "supports",
            "informational": true,
            "qualification": "[ASSUMED] article numbering not verified against the 2026-07-27 consolidated text (03-RESEARCH.md Open Question 2)"
          }
        ],
        "oecd": [
          {
            "source_id": "oecd-ai-principle-robustness-fallback-defined",
            "title": "OECD AI Principles — Robustness, security and safety",
            "locator": "Principle 1.4",
            "source_version": "OECD Recommendation on AI, as updated May 2024",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ]
      }
    },
    "recovery-tested": {
      "decision": "operate",
      "label": "Recovery or rollback has been tested where failure consequence warrants it.",
      "operationalDefinition": "Whether the project's own page or repository shows it actually exercised a recovery or rollback procedure, not merely that one is documented on paper.",
      "passRule": "Coded pass when the project's own page or repository gives a verbatim quotable sentence describing an actual recovery or rollback event or drill (for example a documented incident postmortem, a rollback log entry, or a stated disaster-recovery drill date), with a linked artefact (an incident report or changelog entry) where one exists.",
      "failRule": "Coded fail when the project's own page or repository explicitly states recovery or rollback has never been tested despite a stated high-consequence failure mode (for example \"we have not yet tested our rollback procedure\").",
      "claimedRule": "Coded claimed — never pass — when the project asserts recovery capability (for example \"can roll back instantly\") with no record of an actual test, drill, or incident.",
      "notApplicableNote": "Legitimately not-applicable when the project's own page states failure consequence for this system is low enough that a recovery drill was deliberately not warranted (for example a read-only demo with no state to recover) — the one check among these thirteen where a genuine not-applicable case plausibly exists, distinct from the gate's own decision-level derivation.",
      "anchors": {
        "positive": [
          "Our postmortem from the March incident (linked below) documents the rollback to the previous model version and the time it took to restore service.",
          "We run a quarterly disaster-recovery drill restoring from backup, logged in our ops changelog."
        ],
        "negative": [
          "We have a rollback plan ready to go if needed.",
          "Our rollback procedure has never actually been exercised, even in testing."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "iso-42001-clause-8-recovery-tested",
            "title": "ISO/IEC 42001:2023, Clause 8 — Operation",
            "locator": "Clause 8",
            "source_version": "ISO/IEC 42001:2023",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "gaicc": [
          {
            "source_id": "gaicc-aims-internal-audit-recovery-tested",
            "title": "GAICC AIMS — Internal audit",
            "locator": "AIMS artefact: Internal audit",
            "source_version": "GAICC 12-Week Challenge AIMS artefact list",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "nist-ai-rmf-manage-4-recovery-tested",
            "title": "NIST AI RMF 1.0, MANAGE 4 — Risk treatments, response and recovery, communication plans",
            "locator": "MANAGE 4",
            "source_version": "NIST AI RMF 1.0 (2023), as profiled by AI 600-1",
            "relation_type": "addresses",
            "qualification": "[CITED] Response-and-recovery plans map directly to a tested recovery procedure."
          }
        ],
        "euAiAct": [
          {
            "source_id": "eu-ai-act-article-72-recovery-tested",
            "title": "Regulation (EU) 2024/1689, Article 72 — Post-market monitoring",
            "locator": "Article 72",
            "source_version": "Regulation (EU) 2024/1689, consolidated text of 2026-07-27",
            "relation_type": "supports",
            "informational": true,
            "qualification": "[ASSUMED] article numbering not verified against the 2026-07-27 consolidated text (03-RESEARCH.md Open Question 2)"
          }
        ],
        "oecd": [
          {
            "source_id": "oecd-ai-principle-robustness-recovery-tested",
            "title": "OECD AI Principles — Robustness, security and safety",
            "locator": "Principle 1.4",
            "source_version": "OECD Recommendation on AI, as updated May 2024",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ]
      }
    },
    "support-maintenance-defined": {
      "decision": "operate",
      "label": "Support, maintenance, debugging, and change responsibility are defined.",
      "operationalDefinition": "Whether the project's own page or repository names who is responsible for ongoing support, maintenance, debugging, and making changes, rather than leaving that responsibility unstated.",
      "passRule": "Coded pass when the project's own page or repository gives a verbatim quotable sentence naming a specific support channel, maintenance cadence, or change-approval process (for example a stated SLA, a release-cadence policy, or a named maintainer group), with a linked artefact (a support page or contributing guide) where one exists.",
      "failRule": "Coded fail when the project's own page or repository explicitly states no support or maintenance process exists (for example \"issues will not be triaged\").",
      "claimedRule": "Coded claimed — never pass — when the project asserts it is supported and maintained (for example \"actively supported\") with no named channel, cadence, or process.",
      "notApplicableNote": "No legitimate not-applicable case: any system in operation implies some party does or does not maintain it, which is always a coded question even when the answer is unknown.",
      "anchors": {
        "positive": [
          "Bug reports go through our public issue tracker with a stated 48-hour triage SLA, and our contributing guide names the maintainer group that approves changes.",
          "Our support page lists email and chat channels with business-hours response times, and our changelog shows a monthly release cadence."
        ],
        "negative": [
          "We're here to help if you need anything.",
          "No support channel or maintenance schedule is published."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "iso-42001-annex-a-4.6-support-maintenance-defined",
            "title": "ISO/IEC 42001:2023 Annex A.4.6 — Human resources",
            "locator": "Annex A.4.6",
            "source_version": "ISO/IEC 42001:2023",
            "relation_type": "addresses",
            "qualification": "[CITED] Human-resource provisioning maps to staffing for support and maintenance."
          }
        ],
        "gaicc": [
          {
            "source_id": "gaicc-aims-operational-documentation-support-maintenance-defined",
            "title": "GAICC AIMS — Operational documentation",
            "locator": "AIMS artefact: Operational documentation",
            "source_version": "GAICC 12-Week Challenge AIMS artefact list",
            "relation_type": "addresses",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "nist-ai-rmf-govern-6-support-maintenance-defined",
            "title": "NIST AI RMF 1.0, GOVERN 6 — Third-party risk management",
            "locator": "GOVERN 6",
            "source_version": "NIST AI RMF 1.0 (2023), as profiled by AI 600-1",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "euAiAct": [
          {
            "source_id": "eu-ai-act-article-17-support-maintenance-defined",
            "title": "Regulation (EU) 2024/1689, Article 17 — Quality management system",
            "locator": "Article 17",
            "source_version": "Regulation (EU) 2024/1689, consolidated text of 2026-07-27",
            "relation_type": "supports",
            "informational": true,
            "qualification": "[ASSUMED] article numbering not verified against the 2026-07-27 consolidated text (03-RESEARCH.md Open Question 2)"
          }
        ],
        "oecd": [
          {
            "source_id": "oecd-ai-principle-accountability-support-maintenance-defined",
            "title": "OECD AI Principles — Accountability",
            "locator": "Principle 1.5",
            "source_version": "OECD Recommendation on AI, as updated May 2024",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ]
      }
    },
    "operating-cost-known": {
      "decision": "operate",
      "label": "The relevant operating-cost boundary is known well enough for the decision.",
      "operationalDefinition": "Whether the project's own page or repository states what it costs to keep the system running at the scale it is promoted for, rather than leaving operating cost unaddressed.",
      "passRule": "Coded pass when the project's own page or repository gives a verbatim quotable sentence naming a specific operating-cost figure or boundary (for example a stated per-request compute cost, an infrastructure spend figure, or a pricing page tied to usage volume), with a linked artefact (a pricing or cost-transparency page) where one exists.",
      "failRule": "Coded fail when the project's own page or repository explicitly states operating cost is unknown or has not been estimated (for example \"we don't yet know what this costs to run at scale\").",
      "claimedRule": "Coded claimed — never pass — when the project asserts cost awareness (for example \"cost-efficient to operate\") with no named figure, boundary, or linked cost breakdown.",
      "notApplicableNote": "No legitimate not-applicable case: any system in operation has some real resource cost, which is always a coded question even when the answer is unknown.",
      "anchors": {
        "positive": [
          "Our pricing page states the inference cost is approximately $0.004 per request at our current model size, based on our published usage-based pricing tier.",
          "Our infrastructure cost breakdown (linked below) shows monthly hosting spend scales roughly linearly with active users."
        ],
        "negative": [
          "Our pricing is designed to be cost-effective for everyone.",
          "We haven't calculated what it costs us to run this at scale."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "iso-42001-annex-a-4.5-operating-cost-known",
            "title": "ISO/IEC 42001:2023 Annex A.4.5 — System and computing resources",
            "locator": "Annex A.4.5",
            "source_version": "ISO/IEC 42001:2023",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "gaicc": [
          {
            "source_id": "gaicc-aims-ai-risk-assessment-operating-cost-known",
            "title": "GAICC AIMS — AI risk assessment",
            "locator": "AIMS artefact: AI risk assessment",
            "source_version": "GAICC 12-Week Challenge AIMS artefact list",
            "relation_type": "partial",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "nist-ai-rmf-map-3-operating-cost-known",
            "title": "NIST AI RMF 1.0, MAP 3 — AI capabilities, targeted usage, goals, benefits/costs vs. benchmarks are understood",
            "locator": "MAP 3",
            "source_version": "NIST AI RMF 1.0 (2023), as profiled by AI 600-1",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "euAiAct": [
          {
            "source_id": "eu-ai-act-article-17-operating-cost-known",
            "title": "Regulation (EU) 2024/1689, Article 17 — Quality management system",
            "locator": "Article 17",
            "source_version": "Regulation (EU) 2024/1689, consolidated text of 2026-07-27",
            "relation_type": "partial",
            "informational": true,
            "qualification": "[ASSUMED] article numbering not verified against the 2026-07-27 consolidated text (03-RESEARCH.md Open Question 2)"
          }
        ],
        "oecd": [
          {
            "source_id": "oecd-ai-principle-inclusive-growth-operating-cost-known",
            "title": "OECD AI Principles — Inclusive growth, sustainable development and well-being",
            "locator": "Principle 1.1",
            "source_version": "OECD Recommendation on AI, as updated May 2024",
            "relation_type": "partial",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ]
      }
    },
    "outcome-measure-defined": {
      "decision": "measure-outcome",
      "label": "The outcome measure is defined.",
      "operationalDefinition": "Whether the project's own page or repository names the specific outcome measure used to judge the initiative, stated before or alongside its claim that the outcome changed — not an output metric (what the system produced) but an outcome (the real-world result the initiative was meant to cause).",
      "passRule": "Coded pass when the project's own page or repository states, in a verbatim quotable sentence, exactly which outcome measure it tracks (for example a named metric, its unit, and how it is captured), with a linked artefact (a dashboard, report, or methodology note) where one exists.",
      "failRule": "Coded fail when the project's own page or repository explicitly states no outcome measure was settled on, or that the measure used was later disavowed as the wrong one to have tracked.",
      "claimedRule": "Coded claimed — never pass — when the project asserts an outcome was achieved (for example \"this made a real difference\") without ever naming the specific measure used to judge it.",
      "notApplicableNote": "No legitimate not-applicable case: a project presenting any outcome claim has, by definition, something in mind that it is measuring — absence of a stated measure is coded fail or unknown, not not-applicable.",
      "anchors": {
        "positive": [
          "We judge this initiative's success by the drop in median first-response time, tracked through our existing support-desk analytics.",
          "The outcome measure is 30-day retention of users who completed onboarding, pulled from our product analytics the same way both before and after rollout."
        ],
        "negative": [
          "We're still figuring out the right way to measure whether this actually helped.",
          "Customers tell us it's made a real difference."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "iso-42001-clause-9-outcome-measure-defined",
            "title": "ISO/IEC 42001:2023, Clause 9 — Performance evaluation",
            "locator": "Clause 9",
            "source_version": "ISO/IEC 42001:2023",
            "relation_type": "addresses",
            "qualification": "[CITED] Performance evaluation covers naming what is monitored and measured."
          }
        ],
        "gaicc": [
          {
            "source_id": "gaicc-aims-objectives-outcome-measure-defined",
            "title": "GAICC AIMS — Objectives",
            "locator": "AIMS artefact: Objectives",
            "source_version": "GAICC 12-Week Challenge AIMS artefact list",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "nist-ai-rmf-measure-1-outcome-measure-defined",
            "title": "NIST AI RMF 1.0, MEASURE 1 — Appropriate methods and metrics are identified and applied",
            "locator": "MEASURE 1",
            "source_version": "NIST AI RMF 1.0 (2023), as profiled by AI 600-1",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "euAiAct": [
          {
            "source_id": "eu-ai-act-article-72-outcome-measure-defined",
            "title": "Regulation (EU) 2024/1689, Article 72 — Post-market monitoring",
            "locator": "Article 72",
            "source_version": "Regulation (EU) 2024/1689, consolidated text of 2026-07-27",
            "relation_type": "supports",
            "informational": true,
            "qualification": "[ASSUMED] article numbering not verified against the 2026-07-27 consolidated text (03-RESEARCH.md Open Question 2)"
          }
        ],
        "oecd": [
          {
            "source_id": "oecd-ai-principle-wellbeing-outcome-measure-defined",
            "title": "OECD AI Principles — Inclusive growth, sustainable development and well-being",
            "locator": "Principle 1.1",
            "source_version": "OECD Recommendation on AI, as updated May 2024",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ]
      }
    },
    "baseline-defined": {
      "decision": "measure-outcome",
      "label": "A comparable baseline or counterfactual is defined.",
      "operationalDefinition": "Whether the project's own page or repository states what the outcome measure's value was, or would have been, before or absent the initiative — a comparable prior period, a control group, or another explicit counterfactual — against which the after-measurement is judged.",
      "passRule": "Coded pass when the project's own page or repository gives, in a verbatim quotable sentence, the baseline value or counterfactual used (for example a stated pre-launch metric, a held-out control group, or a prior period's figure), with a linked artefact where one exists.",
      "failRule": "Coded fail when the project's own page or repository explicitly states no baseline or counterfactual was captured before comparing against the outcome measure.",
      "claimedRule": "Coded claimed — never pass — when the project asserts an improvement over \"before\" without stating what the before value actually was.",
      "notApplicableNote": "No legitimate not-applicable case: any before/after outcome comparison requires something to compare against — a genuinely new metric with no prior period is still a form of baseline (zero, or undefined), which should be stated rather than left unaddressed.",
      "anchors": {
        "positive": [
          "Before this change, average checkout time was 4.2 minutes across the prior quarter; that is the baseline this release is compared against.",
          "We held out 10% of traffic as a control group that did not receive the new flow, giving us a concurrent baseline rather than a prior-period one."
        ],
        "negative": [
          "We didn't track this metric before, so there's no real baseline to compare to, but it feels better now.",
          "Users are more engaged than before."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "iso-42001-clause-6-baseline-defined",
            "title": "ISO/IEC 42001:2023, Clause 6 — Planning",
            "locator": "Clause 6",
            "source_version": "ISO/IEC 42001:2023",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "gaicc": [
          {
            "source_id": "gaicc-aims-scope-baseline-defined",
            "title": "GAICC AIMS — Scope",
            "locator": "AIMS artefact: Scope",
            "source_version": "GAICC 12-Week Challenge AIMS artefact list",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "nist-ai-rmf-map-1-baseline-defined",
            "title": "NIST AI RMF 1.0, MAP 1 — Context is established and understood",
            "locator": "MAP 1",
            "source_version": "NIST AI RMF 1.0 (2023), as profiled by AI 600-1",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "euAiAct": [
          {
            "source_id": "eu-ai-act-article-9-baseline-defined",
            "title": "Regulation (EU) 2024/1689, Article 9 — Risk management system",
            "locator": "Article 9",
            "source_version": "Regulation (EU) 2024/1689, consolidated text of 2026-07-27",
            "relation_type": "supports",
            "informational": true,
            "qualification": "[ASSUMED] article numbering not verified against the 2026-07-27 consolidated text (03-RESEARCH.md Open Question 2)"
          }
        ],
        "oecd": [
          {
            "source_id": "oecd-ai-principle-accountability-baseline-defined",
            "title": "OECD AI Principles — Accountability",
            "locator": "Principle 1.5",
            "source_version": "OECD Recommendation on AI, as updated May 2024",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ]
      }
    },
    "outcome-measured": {
      "decision": "measure-outcome",
      "label": "The outcome was measured after the intervention.",
      "operationalDefinition": "Whether the project's own page or repository shows the outcome measure was actually captured after the initiative ran — not merely defined in advance, but recorded with a real value once the intervention had time to take effect.",
      "passRule": "Coded pass when the project's own page or repository states, with a verbatim quotable sentence, a specific after-the-fact value for the outcome measure, with a linked artefact (a report, dashboard snapshot, or dataset) where one exists.",
      "failRule": "Coded fail when the project's own page or repository explicitly states the outcome was never actually re-measured after launch, despite stating an intent to.",
      "claimedRule": "Coded claimed — never pass — when the project asserts the outcome improved without giving any post-intervention figure for the measure it defined.",
      "notApplicableNote": "No legitimate not-applicable case: a project claiming to know whether the initiative worked has, by definition, measured something after the fact — an unmeasured outcome is coded fail or unknown, not not-applicable.",
      "anchors": {
        "positive": [
          "Three months after rollout, median first-response time had fallen to 2.1 minutes, measured the same way as our pre-launch baseline.",
          "Our Q3 cohort analysis (linked below) shows day-30 retention at 42%, captured through the same analytics pipeline used for the baseline."
        ],
        "negative": [
          "We never went back and checked the numbers after launch.",
          "It's clearly working better now."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "iso-42001-annex-a-6.2.8-outcome-measured",
            "title": "ISO/IEC 42001:2023 Annex A.6.2.8 — Recording of event logs",
            "locator": "Annex A.6.2.8",
            "source_version": "ISO/IEC 42001:2023",
            "relation_type": "addresses",
            "qualification": "[CITED] Event-log recording is the basis for an actual post-intervention measurement."
          }
        ],
        "gaicc": [
          {
            "source_id": "gaicc-aims-evidence-of-implementation-outcome-measured",
            "title": "GAICC AIMS — Evidence of implementation",
            "locator": "AIMS artefact: Evidence of implementation",
            "source_version": "GAICC 12-Week Challenge AIMS artefact list",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "nist-ai-rmf-measure-3-outcome-measured",
            "title": "NIST AI RMF 1.0, MEASURE 3 — Mechanisms for tracking identified AI risks over time are in place",
            "locator": "MEASURE 3",
            "source_version": "NIST AI RMF 1.0 (2023), as profiled by AI 600-1",
            "relation_type": "addresses",
            "qualification": "[CITED] Tracking mechanisms over time directly support an actual after-the-fact measurement."
          }
        ],
        "euAiAct": [
          {
            "source_id": "eu-ai-act-article-72-outcome-measured",
            "title": "Regulation (EU) 2024/1689, Article 72 — Post-market monitoring",
            "locator": "Article 72",
            "source_version": "Regulation (EU) 2024/1689, consolidated text of 2026-07-27",
            "relation_type": "addresses",
            "informational": true,
            "qualification": "[ASSUMED] article numbering not verified against the 2026-07-27 consolidated text (03-RESEARCH.md Open Question 2)"
          }
        ],
        "oecd": [
          {
            "source_id": "oecd-ai-principle-wellbeing-outcome-measured",
            "title": "OECD AI Principles — Inclusive growth, sustainable development and well-being",
            "locator": "Principle 1.1",
            "source_version": "OECD Recommendation on AI, as updated May 2024",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ]
      }
    },
    "measurement-definition-consistent": {
      "decision": "measure-outcome",
      "label": "Before/after measurements use the same relevant definition.",
      "operationalDefinition": "Whether the project's own page or repository shows the outcome measure was defined and captured the same way both before and after the initiative — the same metric, unit, population, and collection method — so the comparison is not comparing two different things.",
      "passRule": "Coded pass when the project's own page or repository states, in a verbatim quotable sentence, that the before and after figures used the same definition, method, or population (for example naming an unchanged analytics query or cohort definition), with a linked artefact where one exists.",
      "failRule": "Coded fail when the project's own page or repository explicitly states the before and after measurements used different definitions, populations, or methods (for example a metric redefinition mid-comparison, or comparing a sampled cohort to a full population).",
      "claimedRule": "Coded claimed — never pass — when the project asserts the comparison is apples-to-apples without describing how the measurement method stayed the same.",
      "notApplicableNote": "No legitimate not-applicable case: any before/after comparison either used a consistent definition or did not — this is always an answerable question about the comparison's own method, not one that can be sidestepped as not-applicable.",
      "anchors": {
        "positive": [
          "Both the pre- and post-launch figures use the identical cohort definition and the same 30-day retention query against our production database.",
          "We re-ran the exact same support-ticket query, unchanged since before the rollout, to produce both numbers."
        ],
        "negative": [
          "We changed how we calculate this metric partway through, so the before and after numbers aren't directly comparable, but the trend still looks good.",
          "The new number looks better than the old one."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "iso-42001-annex-a-6.2.8-measurement-definition-consistent",
            "title": "ISO/IEC 42001:2023 Annex A.6.2.8 — Recording of event logs",
            "locator": "Annex A.6.2.8",
            "source_version": "ISO/IEC 42001:2023",
            "relation_type": "supports",
            "qualification": "[CITED] Consistent event-log recording is what keeps a before/after definition comparable."
          }
        ],
        "gaicc": [
          {
            "source_id": "gaicc-aims-operational-documentation-measurement-definition-consistent",
            "title": "GAICC AIMS — Operational documentation",
            "locator": "AIMS artefact: Operational documentation",
            "source_version": "GAICC 12-Week Challenge AIMS artefact list",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "nist-ai-rmf-measure-1-measurement-definition-consistent",
            "title": "NIST AI RMF 1.0, MEASURE 1 — Appropriate methods and metrics are identified and applied",
            "locator": "MEASURE 1",
            "source_version": "NIST AI RMF 1.0 (2023), as profiled by AI 600-1",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "euAiAct": [
          {
            "source_id": "eu-ai-act-article-12-measurement-definition-consistent",
            "title": "Regulation (EU) 2024/1689, Article 12 — Record-keeping",
            "locator": "Article 12",
            "source_version": "Regulation (EU) 2024/1689, consolidated text of 2026-07-27",
            "relation_type": "supports",
            "informational": true,
            "qualification": "[ASSUMED] article numbering not verified against the 2026-07-27 consolidated text (03-RESEARCH.md Open Question 2)"
          }
        ],
        "oecd": [
          {
            "source_id": "oecd-ai-principle-transparency-measurement-definition-consistent",
            "title": "OECD AI Principles — Transparency and explainability",
            "locator": "Principle 1.3",
            "source_version": "OECD Recommendation on AI, as updated May 2024",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ]
      }
    },
    "important-confounds-named": {
      "decision": "measure-outcome",
      "label": "Material confounds, uncertainty, or attribution limits are named.",
      "operationalDefinition": "Whether the project's own page or repository names the other factors that could plausibly explain the measured change besides the initiative itself (seasonality, a concurrent change, a different user mix) — or otherwise states the uncertainty or attribution limits of the comparison, rather than presenting a single number as unambiguous proof the initiative caused it.",
      "passRule": "Coded pass when the project's own page or repository names, in a verbatim quotable sentence, at least one plausible confound, caveat, or attribution limit relevant to the comparison (for example a concurrent marketing campaign, a seasonal effect, or a stated confidence interval), with a linked artefact where one exists.",
      "failRule": "Coded fail when the project's own page or repository explicitly states that no other explanation was considered despite a known concurrent change that could plausibly account for the result.",
      "claimedRule": "Coded claimed — never pass — when the project asserts the result is \"definitely caused by\" the initiative with no acknowledgement that anything else could have contributed.",
      "notApplicableNote": "Legitimately not-applicable when the project's own page states the comparison used a randomized controlled or held-out design specifically built to rule out confounds, making a separate confounds discussion unnecessary — one of the two checks among these ten where a genuine not-applicable state plausibly exists, distinct from the gate's own decision-level derivation.",
      "anchors": {
        "positive": [
          "This quarter also coincided with a seasonal traffic increase, so some of the retention gain may not be attributable to the new onboarding flow alone.",
          "Our 95% confidence interval on the measured improvement is ±3 percentage points, reflecting the sample size available."
        ],
        "negative": [
          "This number is definitely caused by the redesign and nothing else.",
          "Retention went up 10% after launch."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "iso-42001-annex-a-5.3-important-confounds-named",
            "title": "ISO/IEC 42001:2023 Annex A.5.3 — Documentation of AI system impact assessments",
            "locator": "Annex A.5.3",
            "source_version": "ISO/IEC 42001:2023",
            "relation_type": "partial",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "gaicc": [
          {
            "source_id": "gaicc-aims-ai-risk-assessment-important-confounds-named",
            "title": "GAICC AIMS — AI risk assessment",
            "locator": "AIMS artefact: AI risk assessment",
            "source_version": "GAICC 12-Week Challenge AIMS artefact list",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "nist-ai-rmf-measure-4-important-confounds-named",
            "title": "NIST AI RMF 1.0, MEASURE 4 — Feedback about efficacy of measurement is gathered and assessed",
            "locator": "MEASURE 4",
            "source_version": "NIST AI RMF 1.0 (2023), as profiled by AI 600-1",
            "relation_type": "addresses",
            "qualification": "[CITED] Assessing measurement efficacy covers naming what else could explain the result."
          }
        ],
        "euAiAct": [
          {
            "source_id": "eu-ai-act-article-9-important-confounds-named",
            "title": "Regulation (EU) 2024/1689, Article 9 — Risk management system",
            "locator": "Article 9",
            "source_version": "Regulation (EU) 2024/1689, consolidated text of 2026-07-27",
            "relation_type": "supports",
            "informational": true,
            "qualification": "[ASSUMED] article numbering not verified against the 2026-07-27 consolidated text (03-RESEARCH.md Open Question 2)"
          }
        ],
        "oecd": [
          {
            "source_id": "oecd-ai-principle-transparency-important-confounds-named",
            "title": "OECD AI Principles — Transparency and explainability",
            "locator": "Principle 1.3",
            "source_version": "OECD Recommendation on AI, as updated May 2024",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ]
      }
    },
    "outcome-evidence-available": {
      "decision": "scale-renew-stop",
      "label": "Outcome evidence relevant to the decision is available.",
      "operationalDefinition": "Whether, at the point of deciding to scale, renew, expand, or stop, the project's own page or repository still has the outcome evidence from the measure-outcome decision available and referenced — not that the outcome itself was necessarily positive, but that the evidence a scale/stop decision needs has not gone missing or stale.",
      "passRule": "Coded pass when the project's own page or repository references or links the specific outcome evidence (the measured result and its baseline) it is relying on for this scale/renew/stop decision, with a verbatim quotable sentence.",
      "failRule": "Coded fail when the project's own page or repository explicitly states the outcome evidence it would need for this decision is no longer available (for example a report that was lost, a dashboard that was discontinued, or a measurement window that was never completed).",
      "claimedRule": "Coded claimed — never pass — when the project asserts the decision is \"backed by the data\" without linking or quoting the actual outcome evidence being relied on.",
      "notApplicableNote": "No legitimate not-applicable case: a scale/renew/stop decision always rests on some outcome evidence, even if that evidence is thin — thin or missing evidence is coded fail or unknown, not not-applicable.",
      "anchors": {
        "positive": [
          "This expansion decision is based on the retention results linked in our Q3 report, the same figures referenced in our outcome-measurement update.",
          "We're renewing this program on the strength of the cost-per-resolution data published last quarter, still current as of this review."
        ],
        "negative": [
          "The team that ran the original measurement has since left and we don't have the original report anymore, but we're moving ahead anyway.",
          "The data supports this."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "iso-42001-clause-9-outcome-evidence-available",
            "title": "ISO/IEC 42001:2023, Clause 9 — Performance evaluation",
            "locator": "Clause 9",
            "source_version": "ISO/IEC 42001:2023",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "gaicc": [
          {
            "source_id": "gaicc-aims-evidence-of-implementation-outcome-evidence-available",
            "title": "GAICC AIMS — Evidence of implementation",
            "locator": "AIMS artefact: Evidence of implementation",
            "source_version": "GAICC 12-Week Challenge AIMS artefact list",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "nist-ai-rmf-measure-1-outcome-evidence-available",
            "title": "NIST AI RMF 1.0, MEASURE 1 — Appropriate methods and metrics are identified and applied",
            "locator": "MEASURE 1",
            "source_version": "NIST AI RMF 1.0 (2023), as profiled by AI 600-1",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "euAiAct": [
          {
            "source_id": "eu-ai-act-article-72-outcome-evidence-available",
            "title": "Regulation (EU) 2024/1689, Article 72 — Post-market monitoring",
            "locator": "Article 72",
            "source_version": "Regulation (EU) 2024/1689, consolidated text of 2026-07-27",
            "relation_type": "supports",
            "informational": true,
            "qualification": "[ASSUMED] article numbering not verified against the 2026-07-27 consolidated text (03-RESEARCH.md Open Question 2)"
          }
        ],
        "oecd": [
          {
            "source_id": "oecd-ai-principle-accountability-outcome-evidence-available",
            "title": "OECD AI Principles — Accountability",
            "locator": "Principle 1.5",
            "source_version": "OECD Recommendation on AI, as updated May 2024",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ]
      }
    },
    "full-cost-accounted": {
      "decision": "scale-renew-stop",
      "label": "The full relevant cost boundary is accounted for.",
      "operationalDefinition": "Whether the project's own page or repository states a cost figure for the decision that covers the relevant cost boundary — not just the headline or most visible cost, but the other material costs a scale/renew/stop decision should weigh (for example ongoing compute, support staffing, or maintenance, alongside the upfront build cost).",
      "passRule": "Coded pass when the project's own page or repository states, in a verbatim quotable sentence, a cost figure that explicitly names more than one component of the relevant cost boundary (for example build cost plus ongoing operating cost), with a linked artefact where one exists.",
      "failRule": "Coded fail when the project's own page or repository explicitly states a known material cost component was left out of the figure used for this decision (for example \"this total excludes our support costs\").",
      "claimedRule": "Coded claimed — never pass — when the project asserts the initiative is \"cheap to run\" or \"cost-effective\" without stating what cost components were actually counted.",
      "notApplicableNote": "No legitimate not-applicable case: a scale/renew/stop decision always implies some cost boundary, even a narrow one — a narrow or undisclosed boundary is coded fail or unknown, not not-applicable.",
      "anchors": {
        "positive": [
          "Our total cost of ownership figure includes both the one-time migration cost and the ongoing monthly compute and support-staff time, broken down in the linked spreadsheet.",
          "The $40k figure quoted above covers build, hosting, and the first year of maintenance; it does not include sales cost, which is tracked separately."
        ],
        "negative": [
          "This only cost us $500 to build.",
          "It's basically free to run."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "iso-42001-annex-a-4.2-full-cost-accounted",
            "title": "ISO/IEC 42001:2023 Annex A.4.2 — Resource documentation",
            "locator": "Annex A.4.2",
            "source_version": "ISO/IEC 42001:2023",
            "relation_type": "partial",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "gaicc": [
          {
            "source_id": "gaicc-aims-management-review-full-cost-accounted",
            "title": "GAICC AIMS — Management review",
            "locator": "AIMS artefact: Management review",
            "source_version": "GAICC 12-Week Challenge AIMS artefact list",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "nist-ai-rmf-map-3-full-cost-accounted",
            "title": "NIST AI RMF 1.0, MAP 3 — AI capabilities, targeted usage, goals, benefits/costs vs. benchmarks are understood",
            "locator": "MAP 3",
            "source_version": "NIST AI RMF 1.0 (2023), as profiled by AI 600-1",
            "relation_type": "partial",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "euAiAct": [
          {
            "source_id": "eu-ai-act-article-17-full-cost-accounted",
            "title": "Regulation (EU) 2024/1689, Article 17 — Quality management system",
            "locator": "Article 17",
            "source_version": "Regulation (EU) 2024/1689, consolidated text of 2026-07-27",
            "relation_type": "supports",
            "informational": true,
            "qualification": "[ASSUMED] article numbering not verified against the 2026-07-27 consolidated text (03-RESEARCH.md Open Question 2)"
          }
        ],
        "oecd": [
          {
            "source_id": "oecd-ai-principle-accountability-full-cost-accounted",
            "title": "OECD AI Principles — Accountability",
            "locator": "Principle 1.5",
            "source_version": "OECD Recommendation on AI, as updated May 2024",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ]
      }
    },
    "risk-tradeoffs-assessed": {
      "decision": "scale-renew-stop",
      "label": "Material risks and trade-offs are assessed.",
      "operationalDefinition": "Whether the project's own page or repository names the material risks or trade-offs of scaling, renewing, expanding, or stopping — not just the expected benefit, but what could go wrong, what is given up, or what gets harder at a larger scale.",
      "passRule": "Coded pass when the project's own page or repository states, in a verbatim quotable sentence, at least one material risk or trade-off considered as part of this decision (for example a stated scaling risk, an opportunity cost, or a dependency that gets riskier at volume), with a linked artefact where one exists.",
      "failRule": "Coded fail when the project's own page or repository explicitly states a known material risk was identified but was not factored into the scale/renew/stop decision.",
      "claimedRule": "Coded claimed — never pass — when the project asserts the decision was \"carefully risk-assessed\" without naming any specific risk or trade-off considered.",
      "notApplicableNote": "No legitimate not-applicable case: scaling, renewing, expanding, or stopping always carries some risk or trade-off, even if judged small — an unexamined decision is coded fail or unknown, not not-applicable.",
      "anchors": {
        "positive": [
          "Scaling this to our full user base risks overloading our current support team, which is why we're phasing the rollout over two quarters.",
          "Stopping this program frees budget but means giving up the retention gains documented in our outcome report — we judged the trade-off worth it given the cost."
        ],
        "negative": [
          "We thought it through carefully and decided to scale.",
          "There's no real downside to expanding this."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "iso-42001-annex-a-5.2-risk-tradeoffs-assessed",
            "title": "ISO/IEC 42001:2023 Annex A.5.2 — AI system impact assessment process",
            "locator": "Annex A.5.2",
            "source_version": "ISO/IEC 42001:2023",
            "relation_type": "addresses",
            "qualification": "[CITED] The impact assessment process directly covers weighing material risks and trade-offs."
          }
        ],
        "gaicc": [
          {
            "source_id": "gaicc-aims-ai-risk-assessment-risk-tradeoffs-assessed",
            "title": "GAICC AIMS — AI risk assessment",
            "locator": "AIMS artefact: AI risk assessment",
            "source_version": "GAICC 12-Week Challenge AIMS artefact list",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "nist-ai-rmf-map-5-risk-tradeoffs-assessed",
            "title": "NIST AI RMF 1.0, MAP 5 — Impacts to individuals, groups, communities, organizations, society are characterized",
            "locator": "MAP 5",
            "source_version": "NIST AI RMF 1.0 (2023), as profiled by AI 600-1",
            "relation_type": "addresses",
            "qualification": "[CITED] Characterizing impacts is the basis for naming material risks and trade-offs."
          }
        ],
        "euAiAct": [
          {
            "source_id": "eu-ai-act-article-9-risk-tradeoffs-assessed",
            "title": "Regulation (EU) 2024/1689, Article 9 — Risk management system",
            "locator": "Article 9",
            "source_version": "Regulation (EU) 2024/1689, consolidated text of 2026-07-27",
            "relation_type": "addresses",
            "informational": true,
            "qualification": "[ASSUMED] article numbering not verified against the 2026-07-27 consolidated text (03-RESEARCH.md Open Question 2)"
          }
        ],
        "oecd": [
          {
            "source_id": "oecd-ai-principle-robustness-risk-tradeoffs-assessed",
            "title": "OECD AI Principles — Robustness, security and safety",
            "locator": "Principle 1.4",
            "source_version": "OECD Recommendation on AI, as updated May 2024",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ]
      }
    },
    "alternatives-compared": {
      "decision": "scale-renew-stop",
      "label": "Reasonable alternatives or the status quo are compared.",
      "operationalDefinition": "Whether the project's own page or repository shows that scaling, renewing, expanding, or stopping was compared against at least one reasonable alternative — including simply continuing the status quo — rather than being the only option considered.",
      "passRule": "Coded pass when the project's own page or repository states, in a verbatim quotable sentence, a specific alternative that was considered and why it was not chosen (for example staying at current scale, a different vendor, or a cheaper rollout path), with a linked artefact where one exists.",
      "failRule": "Coded fail when the project's own page or repository explicitly states no alternative to the chosen path was considered.",
      "claimedRule": "Coded claimed — never pass — when the project asserts it \"evaluated the options\" without naming any specific alternative that was actually considered.",
      "notApplicableNote": "No legitimate not-applicable case: continuing the status quo is itself always an available alternative to compare against — there is no scale/renew/stop decision with zero alternatives, even when the comparison concludes the chosen path is clearly best.",
      "anchors": {
        "positive": [
          "We considered keeping the current manual process instead of scaling this tool, but the support-ticket backlog data made the status quo clearly worse.",
          "A cheaper, lower-accuracy vendor was evaluated and rejected because its error rate would have doubled our support load."
        ],
        "negative": [
          "We looked at our options and this was the clear winner.",
          "There wasn't really another way to do this."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "iso-42001-annex-a-5.2-alternatives-compared",
            "title": "ISO/IEC 42001:2023 Annex A.5.2 — AI system impact assessment process",
            "locator": "Annex A.5.2",
            "source_version": "ISO/IEC 42001:2023",
            "relation_type": "partial",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "gaicc": [
          {
            "source_id": "gaicc-aims-risk-treatment-alternatives-compared",
            "title": "GAICC AIMS — Risk treatment",
            "locator": "AIMS artefact: Risk treatment",
            "source_version": "GAICC 12-Week Challenge AIMS artefact list",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "nist-ai-rmf-manage-2-alternatives-compared",
            "title": "NIST AI RMF 1.0, MANAGE 2 — Strategies to maximize benefits and minimize negative impacts",
            "locator": "MANAGE 2",
            "source_version": "NIST AI RMF 1.0 (2023), as profiled by AI 600-1",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "euAiAct": [
          {
            "source_id": "eu-ai-act-article-9-alternatives-compared",
            "title": "Regulation (EU) 2024/1689, Article 9 — Risk management system",
            "locator": "Article 9",
            "source_version": "Regulation (EU) 2024/1689, consolidated text of 2026-07-27",
            "relation_type": "supports",
            "informational": true,
            "qualification": "[ASSUMED] article numbering not verified against the 2026-07-27 consolidated text (03-RESEARCH.md Open Question 2)"
          }
        ],
        "oecd": [
          {
            "source_id": "oecd-ai-principle-accountability-alternatives-compared",
            "title": "OECD AI Principles — Accountability",
            "locator": "Principle 1.5",
            "source_version": "OECD Recommendation on AI, as updated May 2024",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ]
      }
    },
    "value-rule-explicit": {
      "decision": "scale-renew-stop",
      "label": "The rule for scale, renew, expand, or stop is explicit.",
      "operationalDefinition": "Whether the project's own page or repository states the actual rule or threshold used to decide between scaling, renewing, expanding, or stopping — not just that a decision was made, but what outcome or cost level would have triggered a different choice.",
      "passRule": "Coded pass when the project's own page or repository states, in a verbatim quotable sentence, the specific rule or threshold applied (for example \"we scale if retention stays above 35%\" or a pre-registered stop condition), with a linked artefact where one exists.",
      "failRule": "Coded fail when the project's own page or repository explicitly states no rule or threshold was set before the decision was made — the outcome was judged after the fact with no pre-stated criterion.",
      "claimedRule": "Coded claimed — never pass — when the project asserts the decision followed \"clear criteria\" without stating what those criteria actually were.",
      "notApplicableNote": "No legitimate not-applicable case: every scale/renew/expand/stop decision implies some rule, even an informal or after-the-fact one — an unstated rule is coded fail or unknown, not not-applicable.",
      "anchors": {
        "positive": [
          "We set the rule in advance: if day-30 retention stayed above 35% after the pilot, we would scale to all regions; it came in at 38%, so we scaled.",
          "Our pre-registered stop condition was a cost-per-resolution above $12; it landed at $9.50, so we renewed."
        ],
        "negative": [
          "We decided it was worth continuing based on how things felt overall.",
          "The results were good enough to scale."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "iso-42001-clause-9-value-rule-explicit",
            "title": "ISO/IEC 42001:2023, Clause 9 — Performance evaluation",
            "locator": "Clause 9",
            "source_version": "ISO/IEC 42001:2023",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "gaicc": [
          {
            "source_id": "gaicc-aims-management-review-value-rule-explicit",
            "title": "GAICC AIMS — Management review",
            "locator": "AIMS artefact: Management review",
            "source_version": "GAICC 12-Week Challenge AIMS artefact list",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "nist-ai-rmf-govern-1-value-rule-explicit",
            "title": "NIST AI RMF 1.0, GOVERN 1 — Policies, processes, procedures, and practices",
            "locator": "GOVERN 1",
            "source_version": "NIST AI RMF 1.0 (2023), as profiled by AI 600-1",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ],
        "euAiAct": [
          {
            "source_id": "eu-ai-act-article-17-value-rule-explicit",
            "title": "Regulation (EU) 2024/1689, Article 17 — Quality management system",
            "locator": "Article 17",
            "source_version": "Regulation (EU) 2024/1689, consolidated text of 2026-07-27",
            "relation_type": "supports",
            "informational": true,
            "qualification": "[ASSUMED] article numbering not verified against the 2026-07-27 consolidated text (03-RESEARCH.md Open Question 2)"
          }
        ],
        "oecd": [
          {
            "source_id": "oecd-ai-principle-accountability-value-rule-explicit",
            "title": "OECD AI Principles — Accountability",
            "locator": "Principle 1.5",
            "source_version": "OECD Recommendation on AI, as updated May 2024",
            "relation_type": "supports",
            "qualification": "[ASSUMED] no direct research candidate for this check; nearest structural fit, needs Helen's review"
          }
        ]
      }
    }
  }
}
```
