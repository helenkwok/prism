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
      "operationalDefinition": "DRAFT PLACEHOLDER: The Deliverable gate for the intended use has passed.",
      "passRule": "DRAFT PLACEHOLDER: pass rule for deliverable-gate-passed not yet authored.",
      "failRule": "DRAFT PLACEHOLDER: fail rule for deliverable-gate-passed not yet authored.",
      "claimedRule": "DRAFT PLACEHOLDER: claimed rule for deliverable-gate-passed not yet authored.",
      "notApplicableNote": "DRAFT PLACEHOLDER: not-applicable note for deliverable-gate-passed not yet authored.",
      "anchors": {
        "positive": [
          "DRAFT PLACEHOLDER: positive anchor for deliverable-gate-passed not yet authored."
        ],
        "negative": [
          "DRAFT PLACEHOLDER: negative anchor for deliverable-gate-passed not yet authored."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "draft-placeholder-deliverable-gate-passed-iso42001",
            "title": "DRAFT PLACEHOLDER: iso42001 crosswalk title for deliverable-gate-passed not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: iso42001 crosswalk qualification for deliverable-gate-passed not yet authored."
          }
        ],
        "gaicc": [
          {
            "source_id": "draft-placeholder-deliverable-gate-passed-gaicc",
            "title": "DRAFT PLACEHOLDER: gaicc crosswalk title for deliverable-gate-passed not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: gaicc crosswalk qualification for deliverable-gate-passed not yet authored."
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "draft-placeholder-deliverable-gate-passed-nistAiRmf",
            "title": "DRAFT PLACEHOLDER: nistAiRmf crosswalk title for deliverable-gate-passed not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: nistAiRmf crosswalk qualification for deliverable-gate-passed not yet authored."
          }
        ],
        "euAiAct": [
          {
            "source_id": "draft-placeholder-deliverable-gate-passed-euAiAct",
            "title": "DRAFT PLACEHOLDER: euAiAct crosswalk title for deliverable-gate-passed not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: euAiAct crosswalk qualification for deliverable-gate-passed not yet authored.",
            "informational": true
          }
        ],
        "oecd": [
          {
            "source_id": "draft-placeholder-deliverable-gate-passed-oecd",
            "title": "DRAFT PLACEHOLDER: oecd crosswalk title for deliverable-gate-passed not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: oecd crosswalk qualification for deliverable-gate-passed not yet authored."
          }
        ]
      }
    },
    "operational-owner-assigned": {
      "decision": "operate",
      "label": "Operational ownership is explicit.",
      "operationalDefinition": "DRAFT PLACEHOLDER: Operational ownership is explicit.",
      "passRule": "DRAFT PLACEHOLDER: pass rule for operational-owner-assigned not yet authored.",
      "failRule": "DRAFT PLACEHOLDER: fail rule for operational-owner-assigned not yet authored.",
      "claimedRule": "DRAFT PLACEHOLDER: claimed rule for operational-owner-assigned not yet authored.",
      "notApplicableNote": "DRAFT PLACEHOLDER: not-applicable note for operational-owner-assigned not yet authored.",
      "anchors": {
        "positive": [
          "DRAFT PLACEHOLDER: positive anchor for operational-owner-assigned not yet authored."
        ],
        "negative": [
          "DRAFT PLACEHOLDER: negative anchor for operational-owner-assigned not yet authored."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "draft-placeholder-operational-owner-assigned-iso42001",
            "title": "DRAFT PLACEHOLDER: iso42001 crosswalk title for operational-owner-assigned not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: iso42001 crosswalk qualification for operational-owner-assigned not yet authored."
          }
        ],
        "gaicc": [
          {
            "source_id": "draft-placeholder-operational-owner-assigned-gaicc",
            "title": "DRAFT PLACEHOLDER: gaicc crosswalk title for operational-owner-assigned not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: gaicc crosswalk qualification for operational-owner-assigned not yet authored."
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "draft-placeholder-operational-owner-assigned-nistAiRmf",
            "title": "DRAFT PLACEHOLDER: nistAiRmf crosswalk title for operational-owner-assigned not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: nistAiRmf crosswalk qualification for operational-owner-assigned not yet authored."
          }
        ],
        "euAiAct": [
          {
            "source_id": "draft-placeholder-operational-owner-assigned-euAiAct",
            "title": "DRAFT PLACEHOLDER: euAiAct crosswalk title for operational-owner-assigned not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: euAiAct crosswalk qualification for operational-owner-assigned not yet authored.",
            "informational": true
          }
        ],
        "oecd": [
          {
            "source_id": "draft-placeholder-operational-owner-assigned-oecd",
            "title": "DRAFT PLACEHOLDER: oecd crosswalk title for operational-owner-assigned not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: oecd crosswalk qualification for operational-owner-assigned not yet authored."
          }
        ]
      }
    },
    "assurance-defined": {
      "decision": "operate",
      "label": "The assurance mechanism is defined for the important failure modes.",
      "operationalDefinition": "DRAFT PLACEHOLDER: The assurance mechanism is defined for the important failure modes.",
      "passRule": "DRAFT PLACEHOLDER: pass rule for assurance-defined not yet authored.",
      "failRule": "DRAFT PLACEHOLDER: fail rule for assurance-defined not yet authored.",
      "claimedRule": "DRAFT PLACEHOLDER: claimed rule for assurance-defined not yet authored.",
      "notApplicableNote": "DRAFT PLACEHOLDER: not-applicable note for assurance-defined not yet authored.",
      "anchors": {
        "positive": [
          "DRAFT PLACEHOLDER: positive anchor for assurance-defined not yet authored."
        ],
        "negative": [
          "DRAFT PLACEHOLDER: negative anchor for assurance-defined not yet authored."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "draft-placeholder-assurance-defined-iso42001",
            "title": "DRAFT PLACEHOLDER: iso42001 crosswalk title for assurance-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: iso42001 crosswalk qualification for assurance-defined not yet authored."
          }
        ],
        "gaicc": [
          {
            "source_id": "draft-placeholder-assurance-defined-gaicc",
            "title": "DRAFT PLACEHOLDER: gaicc crosswalk title for assurance-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: gaicc crosswalk qualification for assurance-defined not yet authored."
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "draft-placeholder-assurance-defined-nistAiRmf",
            "title": "DRAFT PLACEHOLDER: nistAiRmf crosswalk title for assurance-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: nistAiRmf crosswalk qualification for assurance-defined not yet authored."
          }
        ],
        "euAiAct": [
          {
            "source_id": "draft-placeholder-assurance-defined-euAiAct",
            "title": "DRAFT PLACEHOLDER: euAiAct crosswalk title for assurance-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: euAiAct crosswalk qualification for assurance-defined not yet authored.",
            "informational": true
          }
        ],
        "oecd": [
          {
            "source_id": "draft-placeholder-assurance-defined-oecd",
            "title": "DRAFT PLACEHOLDER: oecd crosswalk title for assurance-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: oecd crosswalk qualification for assurance-defined not yet authored."
          }
        ]
      }
    },
    "fallback-defined": {
      "decision": "operate",
      "label": "Fallback or escalation is defined.",
      "operationalDefinition": "DRAFT PLACEHOLDER: Fallback or escalation is defined.",
      "passRule": "DRAFT PLACEHOLDER: pass rule for fallback-defined not yet authored.",
      "failRule": "DRAFT PLACEHOLDER: fail rule for fallback-defined not yet authored.",
      "claimedRule": "DRAFT PLACEHOLDER: claimed rule for fallback-defined not yet authored.",
      "notApplicableNote": "DRAFT PLACEHOLDER: not-applicable note for fallback-defined not yet authored.",
      "anchors": {
        "positive": [
          "DRAFT PLACEHOLDER: positive anchor for fallback-defined not yet authored."
        ],
        "negative": [
          "DRAFT PLACEHOLDER: negative anchor for fallback-defined not yet authored."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "draft-placeholder-fallback-defined-iso42001",
            "title": "DRAFT PLACEHOLDER: iso42001 crosswalk title for fallback-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: iso42001 crosswalk qualification for fallback-defined not yet authored."
          }
        ],
        "gaicc": [
          {
            "source_id": "draft-placeholder-fallback-defined-gaicc",
            "title": "DRAFT PLACEHOLDER: gaicc crosswalk title for fallback-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: gaicc crosswalk qualification for fallback-defined not yet authored."
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "draft-placeholder-fallback-defined-nistAiRmf",
            "title": "DRAFT PLACEHOLDER: nistAiRmf crosswalk title for fallback-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: nistAiRmf crosswalk qualification for fallback-defined not yet authored."
          }
        ],
        "euAiAct": [
          {
            "source_id": "draft-placeholder-fallback-defined-euAiAct",
            "title": "DRAFT PLACEHOLDER: euAiAct crosswalk title for fallback-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: euAiAct crosswalk qualification for fallback-defined not yet authored.",
            "informational": true
          }
        ],
        "oecd": [
          {
            "source_id": "draft-placeholder-fallback-defined-oecd",
            "title": "DRAFT PLACEHOLDER: oecd crosswalk title for fallback-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: oecd crosswalk qualification for fallback-defined not yet authored."
          }
        ]
      }
    },
    "recovery-tested": {
      "decision": "operate",
      "label": "Recovery or rollback has been tested where failure consequence warrants it.",
      "operationalDefinition": "DRAFT PLACEHOLDER: Recovery or rollback has been tested where failure consequence warrants it.",
      "passRule": "DRAFT PLACEHOLDER: pass rule for recovery-tested not yet authored.",
      "failRule": "DRAFT PLACEHOLDER: fail rule for recovery-tested not yet authored.",
      "claimedRule": "DRAFT PLACEHOLDER: claimed rule for recovery-tested not yet authored.",
      "notApplicableNote": "DRAFT PLACEHOLDER: not-applicable note for recovery-tested not yet authored.",
      "anchors": {
        "positive": [
          "DRAFT PLACEHOLDER: positive anchor for recovery-tested not yet authored."
        ],
        "negative": [
          "DRAFT PLACEHOLDER: negative anchor for recovery-tested not yet authored."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "draft-placeholder-recovery-tested-iso42001",
            "title": "DRAFT PLACEHOLDER: iso42001 crosswalk title for recovery-tested not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: iso42001 crosswalk qualification for recovery-tested not yet authored."
          }
        ],
        "gaicc": [
          {
            "source_id": "draft-placeholder-recovery-tested-gaicc",
            "title": "DRAFT PLACEHOLDER: gaicc crosswalk title for recovery-tested not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: gaicc crosswalk qualification for recovery-tested not yet authored."
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "draft-placeholder-recovery-tested-nistAiRmf",
            "title": "DRAFT PLACEHOLDER: nistAiRmf crosswalk title for recovery-tested not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: nistAiRmf crosswalk qualification for recovery-tested not yet authored."
          }
        ],
        "euAiAct": [
          {
            "source_id": "draft-placeholder-recovery-tested-euAiAct",
            "title": "DRAFT PLACEHOLDER: euAiAct crosswalk title for recovery-tested not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: euAiAct crosswalk qualification for recovery-tested not yet authored.",
            "informational": true
          }
        ],
        "oecd": [
          {
            "source_id": "draft-placeholder-recovery-tested-oecd",
            "title": "DRAFT PLACEHOLDER: oecd crosswalk title for recovery-tested not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: oecd crosswalk qualification for recovery-tested not yet authored."
          }
        ]
      }
    },
    "support-maintenance-defined": {
      "decision": "operate",
      "label": "Support, maintenance, debugging, and change responsibility are defined.",
      "operationalDefinition": "DRAFT PLACEHOLDER: Support, maintenance, debugging, and change responsibility are defined.",
      "passRule": "DRAFT PLACEHOLDER: pass rule for support-maintenance-defined not yet authored.",
      "failRule": "DRAFT PLACEHOLDER: fail rule for support-maintenance-defined not yet authored.",
      "claimedRule": "DRAFT PLACEHOLDER: claimed rule for support-maintenance-defined not yet authored.",
      "notApplicableNote": "DRAFT PLACEHOLDER: not-applicable note for support-maintenance-defined not yet authored.",
      "anchors": {
        "positive": [
          "DRAFT PLACEHOLDER: positive anchor for support-maintenance-defined not yet authored."
        ],
        "negative": [
          "DRAFT PLACEHOLDER: negative anchor for support-maintenance-defined not yet authored."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "draft-placeholder-support-maintenance-defined-iso42001",
            "title": "DRAFT PLACEHOLDER: iso42001 crosswalk title for support-maintenance-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: iso42001 crosswalk qualification for support-maintenance-defined not yet authored."
          }
        ],
        "gaicc": [
          {
            "source_id": "draft-placeholder-support-maintenance-defined-gaicc",
            "title": "DRAFT PLACEHOLDER: gaicc crosswalk title for support-maintenance-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: gaicc crosswalk qualification for support-maintenance-defined not yet authored."
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "draft-placeholder-support-maintenance-defined-nistAiRmf",
            "title": "DRAFT PLACEHOLDER: nistAiRmf crosswalk title for support-maintenance-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: nistAiRmf crosswalk qualification for support-maintenance-defined not yet authored."
          }
        ],
        "euAiAct": [
          {
            "source_id": "draft-placeholder-support-maintenance-defined-euAiAct",
            "title": "DRAFT PLACEHOLDER: euAiAct crosswalk title for support-maintenance-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: euAiAct crosswalk qualification for support-maintenance-defined not yet authored.",
            "informational": true
          }
        ],
        "oecd": [
          {
            "source_id": "draft-placeholder-support-maintenance-defined-oecd",
            "title": "DRAFT PLACEHOLDER: oecd crosswalk title for support-maintenance-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: oecd crosswalk qualification for support-maintenance-defined not yet authored."
          }
        ]
      }
    },
    "operating-cost-known": {
      "decision": "operate",
      "label": "The relevant operating-cost boundary is known well enough for the decision.",
      "operationalDefinition": "DRAFT PLACEHOLDER: The relevant operating-cost boundary is known well enough for the decision.",
      "passRule": "DRAFT PLACEHOLDER: pass rule for operating-cost-known not yet authored.",
      "failRule": "DRAFT PLACEHOLDER: fail rule for operating-cost-known not yet authored.",
      "claimedRule": "DRAFT PLACEHOLDER: claimed rule for operating-cost-known not yet authored.",
      "notApplicableNote": "DRAFT PLACEHOLDER: not-applicable note for operating-cost-known not yet authored.",
      "anchors": {
        "positive": [
          "DRAFT PLACEHOLDER: positive anchor for operating-cost-known not yet authored."
        ],
        "negative": [
          "DRAFT PLACEHOLDER: negative anchor for operating-cost-known not yet authored."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "draft-placeholder-operating-cost-known-iso42001",
            "title": "DRAFT PLACEHOLDER: iso42001 crosswalk title for operating-cost-known not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: iso42001 crosswalk qualification for operating-cost-known not yet authored."
          }
        ],
        "gaicc": [
          {
            "source_id": "draft-placeholder-operating-cost-known-gaicc",
            "title": "DRAFT PLACEHOLDER: gaicc crosswalk title for operating-cost-known not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: gaicc crosswalk qualification for operating-cost-known not yet authored."
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "draft-placeholder-operating-cost-known-nistAiRmf",
            "title": "DRAFT PLACEHOLDER: nistAiRmf crosswalk title for operating-cost-known not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: nistAiRmf crosswalk qualification for operating-cost-known not yet authored."
          }
        ],
        "euAiAct": [
          {
            "source_id": "draft-placeholder-operating-cost-known-euAiAct",
            "title": "DRAFT PLACEHOLDER: euAiAct crosswalk title for operating-cost-known not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: euAiAct crosswalk qualification for operating-cost-known not yet authored.",
            "informational": true
          }
        ],
        "oecd": [
          {
            "source_id": "draft-placeholder-operating-cost-known-oecd",
            "title": "DRAFT PLACEHOLDER: oecd crosswalk title for operating-cost-known not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: oecd crosswalk qualification for operating-cost-known not yet authored."
          }
        ]
      }
    },
    "outcome-measure-defined": {
      "decision": "measure-outcome",
      "label": "The outcome measure is defined.",
      "operationalDefinition": "DRAFT PLACEHOLDER: The outcome measure is defined.",
      "passRule": "DRAFT PLACEHOLDER: pass rule for outcome-measure-defined not yet authored.",
      "failRule": "DRAFT PLACEHOLDER: fail rule for outcome-measure-defined not yet authored.",
      "claimedRule": "DRAFT PLACEHOLDER: claimed rule for outcome-measure-defined not yet authored.",
      "notApplicableNote": "DRAFT PLACEHOLDER: not-applicable note for outcome-measure-defined not yet authored.",
      "anchors": {
        "positive": [
          "DRAFT PLACEHOLDER: positive anchor for outcome-measure-defined not yet authored."
        ],
        "negative": [
          "DRAFT PLACEHOLDER: negative anchor for outcome-measure-defined not yet authored."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "draft-placeholder-outcome-measure-defined-iso42001",
            "title": "DRAFT PLACEHOLDER: iso42001 crosswalk title for outcome-measure-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: iso42001 crosswalk qualification for outcome-measure-defined not yet authored."
          }
        ],
        "gaicc": [
          {
            "source_id": "draft-placeholder-outcome-measure-defined-gaicc",
            "title": "DRAFT PLACEHOLDER: gaicc crosswalk title for outcome-measure-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: gaicc crosswalk qualification for outcome-measure-defined not yet authored."
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "draft-placeholder-outcome-measure-defined-nistAiRmf",
            "title": "DRAFT PLACEHOLDER: nistAiRmf crosswalk title for outcome-measure-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: nistAiRmf crosswalk qualification for outcome-measure-defined not yet authored."
          }
        ],
        "euAiAct": [
          {
            "source_id": "draft-placeholder-outcome-measure-defined-euAiAct",
            "title": "DRAFT PLACEHOLDER: euAiAct crosswalk title for outcome-measure-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: euAiAct crosswalk qualification for outcome-measure-defined not yet authored.",
            "informational": true
          }
        ],
        "oecd": [
          {
            "source_id": "draft-placeholder-outcome-measure-defined-oecd",
            "title": "DRAFT PLACEHOLDER: oecd crosswalk title for outcome-measure-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: oecd crosswalk qualification for outcome-measure-defined not yet authored."
          }
        ]
      }
    },
    "baseline-defined": {
      "decision": "measure-outcome",
      "label": "A comparable baseline or counterfactual is defined.",
      "operationalDefinition": "DRAFT PLACEHOLDER: A comparable baseline or counterfactual is defined.",
      "passRule": "DRAFT PLACEHOLDER: pass rule for baseline-defined not yet authored.",
      "failRule": "DRAFT PLACEHOLDER: fail rule for baseline-defined not yet authored.",
      "claimedRule": "DRAFT PLACEHOLDER: claimed rule for baseline-defined not yet authored.",
      "notApplicableNote": "DRAFT PLACEHOLDER: not-applicable note for baseline-defined not yet authored.",
      "anchors": {
        "positive": [
          "DRAFT PLACEHOLDER: positive anchor for baseline-defined not yet authored."
        ],
        "negative": [
          "DRAFT PLACEHOLDER: negative anchor for baseline-defined not yet authored."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "draft-placeholder-baseline-defined-iso42001",
            "title": "DRAFT PLACEHOLDER: iso42001 crosswalk title for baseline-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: iso42001 crosswalk qualification for baseline-defined not yet authored."
          }
        ],
        "gaicc": [
          {
            "source_id": "draft-placeholder-baseline-defined-gaicc",
            "title": "DRAFT PLACEHOLDER: gaicc crosswalk title for baseline-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: gaicc crosswalk qualification for baseline-defined not yet authored."
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "draft-placeholder-baseline-defined-nistAiRmf",
            "title": "DRAFT PLACEHOLDER: nistAiRmf crosswalk title for baseline-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: nistAiRmf crosswalk qualification for baseline-defined not yet authored."
          }
        ],
        "euAiAct": [
          {
            "source_id": "draft-placeholder-baseline-defined-euAiAct",
            "title": "DRAFT PLACEHOLDER: euAiAct crosswalk title for baseline-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: euAiAct crosswalk qualification for baseline-defined not yet authored.",
            "informational": true
          }
        ],
        "oecd": [
          {
            "source_id": "draft-placeholder-baseline-defined-oecd",
            "title": "DRAFT PLACEHOLDER: oecd crosswalk title for baseline-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: oecd crosswalk qualification for baseline-defined not yet authored."
          }
        ]
      }
    },
    "outcome-measured": {
      "decision": "measure-outcome",
      "label": "The outcome was measured after the intervention.",
      "operationalDefinition": "DRAFT PLACEHOLDER: The outcome was measured after the intervention.",
      "passRule": "DRAFT PLACEHOLDER: pass rule for outcome-measured not yet authored.",
      "failRule": "DRAFT PLACEHOLDER: fail rule for outcome-measured not yet authored.",
      "claimedRule": "DRAFT PLACEHOLDER: claimed rule for outcome-measured not yet authored.",
      "notApplicableNote": "DRAFT PLACEHOLDER: not-applicable note for outcome-measured not yet authored.",
      "anchors": {
        "positive": [
          "DRAFT PLACEHOLDER: positive anchor for outcome-measured not yet authored."
        ],
        "negative": [
          "DRAFT PLACEHOLDER: negative anchor for outcome-measured not yet authored."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "draft-placeholder-outcome-measured-iso42001",
            "title": "DRAFT PLACEHOLDER: iso42001 crosswalk title for outcome-measured not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: iso42001 crosswalk qualification for outcome-measured not yet authored."
          }
        ],
        "gaicc": [
          {
            "source_id": "draft-placeholder-outcome-measured-gaicc",
            "title": "DRAFT PLACEHOLDER: gaicc crosswalk title for outcome-measured not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: gaicc crosswalk qualification for outcome-measured not yet authored."
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "draft-placeholder-outcome-measured-nistAiRmf",
            "title": "DRAFT PLACEHOLDER: nistAiRmf crosswalk title for outcome-measured not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: nistAiRmf crosswalk qualification for outcome-measured not yet authored."
          }
        ],
        "euAiAct": [
          {
            "source_id": "draft-placeholder-outcome-measured-euAiAct",
            "title": "DRAFT PLACEHOLDER: euAiAct crosswalk title for outcome-measured not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: euAiAct crosswalk qualification for outcome-measured not yet authored.",
            "informational": true
          }
        ],
        "oecd": [
          {
            "source_id": "draft-placeholder-outcome-measured-oecd",
            "title": "DRAFT PLACEHOLDER: oecd crosswalk title for outcome-measured not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: oecd crosswalk qualification for outcome-measured not yet authored."
          }
        ]
      }
    },
    "measurement-definition-consistent": {
      "decision": "measure-outcome",
      "label": "Before/after measurements use the same relevant definition.",
      "operationalDefinition": "DRAFT PLACEHOLDER: Before/after measurements use the same relevant definition.",
      "passRule": "DRAFT PLACEHOLDER: pass rule for measurement-definition-consistent not yet authored.",
      "failRule": "DRAFT PLACEHOLDER: fail rule for measurement-definition-consistent not yet authored.",
      "claimedRule": "DRAFT PLACEHOLDER: claimed rule for measurement-definition-consistent not yet authored.",
      "notApplicableNote": "DRAFT PLACEHOLDER: not-applicable note for measurement-definition-consistent not yet authored.",
      "anchors": {
        "positive": [
          "DRAFT PLACEHOLDER: positive anchor for measurement-definition-consistent not yet authored."
        ],
        "negative": [
          "DRAFT PLACEHOLDER: negative anchor for measurement-definition-consistent not yet authored."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "draft-placeholder-measurement-definition-consistent-iso42001",
            "title": "DRAFT PLACEHOLDER: iso42001 crosswalk title for measurement-definition-consistent not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: iso42001 crosswalk qualification for measurement-definition-consistent not yet authored."
          }
        ],
        "gaicc": [
          {
            "source_id": "draft-placeholder-measurement-definition-consistent-gaicc",
            "title": "DRAFT PLACEHOLDER: gaicc crosswalk title for measurement-definition-consistent not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: gaicc crosswalk qualification for measurement-definition-consistent not yet authored."
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "draft-placeholder-measurement-definition-consistent-nistAiRmf",
            "title": "DRAFT PLACEHOLDER: nistAiRmf crosswalk title for measurement-definition-consistent not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: nistAiRmf crosswalk qualification for measurement-definition-consistent not yet authored."
          }
        ],
        "euAiAct": [
          {
            "source_id": "draft-placeholder-measurement-definition-consistent-euAiAct",
            "title": "DRAFT PLACEHOLDER: euAiAct crosswalk title for measurement-definition-consistent not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: euAiAct crosswalk qualification for measurement-definition-consistent not yet authored.",
            "informational": true
          }
        ],
        "oecd": [
          {
            "source_id": "draft-placeholder-measurement-definition-consistent-oecd",
            "title": "DRAFT PLACEHOLDER: oecd crosswalk title for measurement-definition-consistent not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: oecd crosswalk qualification for measurement-definition-consistent not yet authored."
          }
        ]
      }
    },
    "important-confounds-named": {
      "decision": "measure-outcome",
      "label": "Material confounds, uncertainty, or attribution limits are named.",
      "operationalDefinition": "DRAFT PLACEHOLDER: Material confounds, uncertainty, or attribution limits are named.",
      "passRule": "DRAFT PLACEHOLDER: pass rule for important-confounds-named not yet authored.",
      "failRule": "DRAFT PLACEHOLDER: fail rule for important-confounds-named not yet authored.",
      "claimedRule": "DRAFT PLACEHOLDER: claimed rule for important-confounds-named not yet authored.",
      "notApplicableNote": "DRAFT PLACEHOLDER: not-applicable note for important-confounds-named not yet authored.",
      "anchors": {
        "positive": [
          "DRAFT PLACEHOLDER: positive anchor for important-confounds-named not yet authored."
        ],
        "negative": [
          "DRAFT PLACEHOLDER: negative anchor for important-confounds-named not yet authored."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "draft-placeholder-important-confounds-named-iso42001",
            "title": "DRAFT PLACEHOLDER: iso42001 crosswalk title for important-confounds-named not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: iso42001 crosswalk qualification for important-confounds-named not yet authored."
          }
        ],
        "gaicc": [
          {
            "source_id": "draft-placeholder-important-confounds-named-gaicc",
            "title": "DRAFT PLACEHOLDER: gaicc crosswalk title for important-confounds-named not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: gaicc crosswalk qualification for important-confounds-named not yet authored."
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "draft-placeholder-important-confounds-named-nistAiRmf",
            "title": "DRAFT PLACEHOLDER: nistAiRmf crosswalk title for important-confounds-named not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: nistAiRmf crosswalk qualification for important-confounds-named not yet authored."
          }
        ],
        "euAiAct": [
          {
            "source_id": "draft-placeholder-important-confounds-named-euAiAct",
            "title": "DRAFT PLACEHOLDER: euAiAct crosswalk title for important-confounds-named not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: euAiAct crosswalk qualification for important-confounds-named not yet authored.",
            "informational": true
          }
        ],
        "oecd": [
          {
            "source_id": "draft-placeholder-important-confounds-named-oecd",
            "title": "DRAFT PLACEHOLDER: oecd crosswalk title for important-confounds-named not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: oecd crosswalk qualification for important-confounds-named not yet authored."
          }
        ]
      }
    },
    "outcome-evidence-available": {
      "decision": "scale-renew-stop",
      "label": "Outcome evidence relevant to the decision is available.",
      "operationalDefinition": "DRAFT PLACEHOLDER: Outcome evidence relevant to the decision is available.",
      "passRule": "DRAFT PLACEHOLDER: pass rule for outcome-evidence-available not yet authored.",
      "failRule": "DRAFT PLACEHOLDER: fail rule for outcome-evidence-available not yet authored.",
      "claimedRule": "DRAFT PLACEHOLDER: claimed rule for outcome-evidence-available not yet authored.",
      "notApplicableNote": "DRAFT PLACEHOLDER: not-applicable note for outcome-evidence-available not yet authored.",
      "anchors": {
        "positive": [
          "DRAFT PLACEHOLDER: positive anchor for outcome-evidence-available not yet authored."
        ],
        "negative": [
          "DRAFT PLACEHOLDER: negative anchor for outcome-evidence-available not yet authored."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "draft-placeholder-outcome-evidence-available-iso42001",
            "title": "DRAFT PLACEHOLDER: iso42001 crosswalk title for outcome-evidence-available not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: iso42001 crosswalk qualification for outcome-evidence-available not yet authored."
          }
        ],
        "gaicc": [
          {
            "source_id": "draft-placeholder-outcome-evidence-available-gaicc",
            "title": "DRAFT PLACEHOLDER: gaicc crosswalk title for outcome-evidence-available not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: gaicc crosswalk qualification for outcome-evidence-available not yet authored."
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "draft-placeholder-outcome-evidence-available-nistAiRmf",
            "title": "DRAFT PLACEHOLDER: nistAiRmf crosswalk title for outcome-evidence-available not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: nistAiRmf crosswalk qualification for outcome-evidence-available not yet authored."
          }
        ],
        "euAiAct": [
          {
            "source_id": "draft-placeholder-outcome-evidence-available-euAiAct",
            "title": "DRAFT PLACEHOLDER: euAiAct crosswalk title for outcome-evidence-available not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: euAiAct crosswalk qualification for outcome-evidence-available not yet authored.",
            "informational": true
          }
        ],
        "oecd": [
          {
            "source_id": "draft-placeholder-outcome-evidence-available-oecd",
            "title": "DRAFT PLACEHOLDER: oecd crosswalk title for outcome-evidence-available not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: oecd crosswalk qualification for outcome-evidence-available not yet authored."
          }
        ]
      }
    },
    "full-cost-accounted": {
      "decision": "scale-renew-stop",
      "label": "The full relevant cost boundary is accounted for.",
      "operationalDefinition": "DRAFT PLACEHOLDER: The full relevant cost boundary is accounted for.",
      "passRule": "DRAFT PLACEHOLDER: pass rule for full-cost-accounted not yet authored.",
      "failRule": "DRAFT PLACEHOLDER: fail rule for full-cost-accounted not yet authored.",
      "claimedRule": "DRAFT PLACEHOLDER: claimed rule for full-cost-accounted not yet authored.",
      "notApplicableNote": "DRAFT PLACEHOLDER: not-applicable note for full-cost-accounted not yet authored.",
      "anchors": {
        "positive": [
          "DRAFT PLACEHOLDER: positive anchor for full-cost-accounted not yet authored."
        ],
        "negative": [
          "DRAFT PLACEHOLDER: negative anchor for full-cost-accounted not yet authored."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "draft-placeholder-full-cost-accounted-iso42001",
            "title": "DRAFT PLACEHOLDER: iso42001 crosswalk title for full-cost-accounted not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: iso42001 crosswalk qualification for full-cost-accounted not yet authored."
          }
        ],
        "gaicc": [
          {
            "source_id": "draft-placeholder-full-cost-accounted-gaicc",
            "title": "DRAFT PLACEHOLDER: gaicc crosswalk title for full-cost-accounted not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: gaicc crosswalk qualification for full-cost-accounted not yet authored."
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "draft-placeholder-full-cost-accounted-nistAiRmf",
            "title": "DRAFT PLACEHOLDER: nistAiRmf crosswalk title for full-cost-accounted not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: nistAiRmf crosswalk qualification for full-cost-accounted not yet authored."
          }
        ],
        "euAiAct": [
          {
            "source_id": "draft-placeholder-full-cost-accounted-euAiAct",
            "title": "DRAFT PLACEHOLDER: euAiAct crosswalk title for full-cost-accounted not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: euAiAct crosswalk qualification for full-cost-accounted not yet authored.",
            "informational": true
          }
        ],
        "oecd": [
          {
            "source_id": "draft-placeholder-full-cost-accounted-oecd",
            "title": "DRAFT PLACEHOLDER: oecd crosswalk title for full-cost-accounted not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: oecd crosswalk qualification for full-cost-accounted not yet authored."
          }
        ]
      }
    },
    "risk-tradeoffs-assessed": {
      "decision": "scale-renew-stop",
      "label": "Material risks and trade-offs are assessed.",
      "operationalDefinition": "DRAFT PLACEHOLDER: Material risks and trade-offs are assessed.",
      "passRule": "DRAFT PLACEHOLDER: pass rule for risk-tradeoffs-assessed not yet authored.",
      "failRule": "DRAFT PLACEHOLDER: fail rule for risk-tradeoffs-assessed not yet authored.",
      "claimedRule": "DRAFT PLACEHOLDER: claimed rule for risk-tradeoffs-assessed not yet authored.",
      "notApplicableNote": "DRAFT PLACEHOLDER: not-applicable note for risk-tradeoffs-assessed not yet authored.",
      "anchors": {
        "positive": [
          "DRAFT PLACEHOLDER: positive anchor for risk-tradeoffs-assessed not yet authored."
        ],
        "negative": [
          "DRAFT PLACEHOLDER: negative anchor for risk-tradeoffs-assessed not yet authored."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "draft-placeholder-risk-tradeoffs-assessed-iso42001",
            "title": "DRAFT PLACEHOLDER: iso42001 crosswalk title for risk-tradeoffs-assessed not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: iso42001 crosswalk qualification for risk-tradeoffs-assessed not yet authored."
          }
        ],
        "gaicc": [
          {
            "source_id": "draft-placeholder-risk-tradeoffs-assessed-gaicc",
            "title": "DRAFT PLACEHOLDER: gaicc crosswalk title for risk-tradeoffs-assessed not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: gaicc crosswalk qualification for risk-tradeoffs-assessed not yet authored."
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "draft-placeholder-risk-tradeoffs-assessed-nistAiRmf",
            "title": "DRAFT PLACEHOLDER: nistAiRmf crosswalk title for risk-tradeoffs-assessed not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: nistAiRmf crosswalk qualification for risk-tradeoffs-assessed not yet authored."
          }
        ],
        "euAiAct": [
          {
            "source_id": "draft-placeholder-risk-tradeoffs-assessed-euAiAct",
            "title": "DRAFT PLACEHOLDER: euAiAct crosswalk title for risk-tradeoffs-assessed not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: euAiAct crosswalk qualification for risk-tradeoffs-assessed not yet authored.",
            "informational": true
          }
        ],
        "oecd": [
          {
            "source_id": "draft-placeholder-risk-tradeoffs-assessed-oecd",
            "title": "DRAFT PLACEHOLDER: oecd crosswalk title for risk-tradeoffs-assessed not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: oecd crosswalk qualification for risk-tradeoffs-assessed not yet authored."
          }
        ]
      }
    },
    "alternatives-compared": {
      "decision": "scale-renew-stop",
      "label": "Reasonable alternatives or the status quo are compared.",
      "operationalDefinition": "DRAFT PLACEHOLDER: Reasonable alternatives or the status quo are compared.",
      "passRule": "DRAFT PLACEHOLDER: pass rule for alternatives-compared not yet authored.",
      "failRule": "DRAFT PLACEHOLDER: fail rule for alternatives-compared not yet authored.",
      "claimedRule": "DRAFT PLACEHOLDER: claimed rule for alternatives-compared not yet authored.",
      "notApplicableNote": "DRAFT PLACEHOLDER: not-applicable note for alternatives-compared not yet authored.",
      "anchors": {
        "positive": [
          "DRAFT PLACEHOLDER: positive anchor for alternatives-compared not yet authored."
        ],
        "negative": [
          "DRAFT PLACEHOLDER: negative anchor for alternatives-compared not yet authored."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "draft-placeholder-alternatives-compared-iso42001",
            "title": "DRAFT PLACEHOLDER: iso42001 crosswalk title for alternatives-compared not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: iso42001 crosswalk qualification for alternatives-compared not yet authored."
          }
        ],
        "gaicc": [
          {
            "source_id": "draft-placeholder-alternatives-compared-gaicc",
            "title": "DRAFT PLACEHOLDER: gaicc crosswalk title for alternatives-compared not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: gaicc crosswalk qualification for alternatives-compared not yet authored."
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "draft-placeholder-alternatives-compared-nistAiRmf",
            "title": "DRAFT PLACEHOLDER: nistAiRmf crosswalk title for alternatives-compared not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: nistAiRmf crosswalk qualification for alternatives-compared not yet authored."
          }
        ],
        "euAiAct": [
          {
            "source_id": "draft-placeholder-alternatives-compared-euAiAct",
            "title": "DRAFT PLACEHOLDER: euAiAct crosswalk title for alternatives-compared not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: euAiAct crosswalk qualification for alternatives-compared not yet authored.",
            "informational": true
          }
        ],
        "oecd": [
          {
            "source_id": "draft-placeholder-alternatives-compared-oecd",
            "title": "DRAFT PLACEHOLDER: oecd crosswalk title for alternatives-compared not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: oecd crosswalk qualification for alternatives-compared not yet authored."
          }
        ]
      }
    },
    "value-rule-explicit": {
      "decision": "scale-renew-stop",
      "label": "The rule for scale, renew, expand, or stop is explicit.",
      "operationalDefinition": "DRAFT PLACEHOLDER: The rule for scale, renew, expand, or stop is explicit.",
      "passRule": "DRAFT PLACEHOLDER: pass rule for value-rule-explicit not yet authored.",
      "failRule": "DRAFT PLACEHOLDER: fail rule for value-rule-explicit not yet authored.",
      "claimedRule": "DRAFT PLACEHOLDER: claimed rule for value-rule-explicit not yet authored.",
      "notApplicableNote": "DRAFT PLACEHOLDER: not-applicable note for value-rule-explicit not yet authored.",
      "anchors": {
        "positive": [
          "DRAFT PLACEHOLDER: positive anchor for value-rule-explicit not yet authored."
        ],
        "negative": [
          "DRAFT PLACEHOLDER: negative anchor for value-rule-explicit not yet authored."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "draft-placeholder-value-rule-explicit-iso42001",
            "title": "DRAFT PLACEHOLDER: iso42001 crosswalk title for value-rule-explicit not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: iso42001 crosswalk qualification for value-rule-explicit not yet authored."
          }
        ],
        "gaicc": [
          {
            "source_id": "draft-placeholder-value-rule-explicit-gaicc",
            "title": "DRAFT PLACEHOLDER: gaicc crosswalk title for value-rule-explicit not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: gaicc crosswalk qualification for value-rule-explicit not yet authored."
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "draft-placeholder-value-rule-explicit-nistAiRmf",
            "title": "DRAFT PLACEHOLDER: nistAiRmf crosswalk title for value-rule-explicit not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: nistAiRmf crosswalk qualification for value-rule-explicit not yet authored."
          }
        ],
        "euAiAct": [
          {
            "source_id": "draft-placeholder-value-rule-explicit-euAiAct",
            "title": "DRAFT PLACEHOLDER: euAiAct crosswalk title for value-rule-explicit not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: euAiAct crosswalk qualification for value-rule-explicit not yet authored.",
            "informational": true
          }
        ],
        "oecd": [
          {
            "source_id": "draft-placeholder-value-rule-explicit-oecd",
            "title": "DRAFT PLACEHOLDER: oecd crosswalk title for value-rule-explicit not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: oecd crosswalk qualification for value-rule-explicit not yet authored."
          }
        ]
      }
    }
  }
}
```
