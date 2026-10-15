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
      "operationalDefinition": "DRAFT PLACEHOLDER: The artefact or action can be reproduced or inspected.",
      "passRule": "DRAFT PLACEHOLDER: pass rule for output-reproducible not yet authored.",
      "failRule": "DRAFT PLACEHOLDER: fail rule for output-reproducible not yet authored.",
      "claimedRule": "DRAFT PLACEHOLDER: claimed rule for output-reproducible not yet authored.",
      "notApplicableNote": "DRAFT PLACEHOLDER: not-applicable note for output-reproducible not yet authored.",
      "anchors": {
        "positive": [
          "DRAFT PLACEHOLDER: positive anchor for output-reproducible not yet authored."
        ],
        "negative": [
          "DRAFT PLACEHOLDER: negative anchor for output-reproducible not yet authored."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "draft-placeholder-output-reproducible-iso42001",
            "title": "DRAFT PLACEHOLDER: iso42001 crosswalk title for output-reproducible not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: iso42001 crosswalk qualification for output-reproducible not yet authored."
          }
        ],
        "gaicc": [
          {
            "source_id": "draft-placeholder-output-reproducible-gaicc",
            "title": "DRAFT PLACEHOLDER: gaicc crosswalk title for output-reproducible not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: gaicc crosswalk qualification for output-reproducible not yet authored."
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "draft-placeholder-output-reproducible-nistAiRmf",
            "title": "DRAFT PLACEHOLDER: nistAiRmf crosswalk title for output-reproducible not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: nistAiRmf crosswalk qualification for output-reproducible not yet authored."
          }
        ],
        "euAiAct": [
          {
            "source_id": "draft-placeholder-output-reproducible-euAiAct",
            "title": "DRAFT PLACEHOLDER: euAiAct crosswalk title for output-reproducible not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: euAiAct crosswalk qualification for output-reproducible not yet authored.",
            "informational": true
          }
        ],
        "oecd": [
          {
            "source_id": "draft-placeholder-output-reproducible-oecd",
            "title": "DRAFT PLACEHOLDER: oecd crosswalk title for output-reproducible not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: oecd crosswalk qualification for output-reproducible not yet authored."
          }
        ]
      }
    },
    "assumptions-catalogued": {
      "decision": "explore",
      "label": "Important supplied context, assumptions, and inferences are visible.",
      "operationalDefinition": "DRAFT PLACEHOLDER: Important supplied context, assumptions, and inferences are visible.",
      "passRule": "DRAFT PLACEHOLDER: pass rule for assumptions-catalogued not yet authored.",
      "failRule": "DRAFT PLACEHOLDER: fail rule for assumptions-catalogued not yet authored.",
      "claimedRule": "DRAFT PLACEHOLDER: claimed rule for assumptions-catalogued not yet authored.",
      "notApplicableNote": "DRAFT PLACEHOLDER: not-applicable note for assumptions-catalogued not yet authored.",
      "anchors": {
        "positive": [
          "DRAFT PLACEHOLDER: positive anchor for assumptions-catalogued not yet authored."
        ],
        "negative": [
          "DRAFT PLACEHOLDER: negative anchor for assumptions-catalogued not yet authored."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "draft-placeholder-assumptions-catalogued-iso42001",
            "title": "DRAFT PLACEHOLDER: iso42001 crosswalk title for assumptions-catalogued not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: iso42001 crosswalk qualification for assumptions-catalogued not yet authored."
          }
        ],
        "gaicc": [
          {
            "source_id": "draft-placeholder-assumptions-catalogued-gaicc",
            "title": "DRAFT PLACEHOLDER: gaicc crosswalk title for assumptions-catalogued not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: gaicc crosswalk qualification for assumptions-catalogued not yet authored."
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "draft-placeholder-assumptions-catalogued-nistAiRmf",
            "title": "DRAFT PLACEHOLDER: nistAiRmf crosswalk title for assumptions-catalogued not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: nistAiRmf crosswalk qualification for assumptions-catalogued not yet authored."
          }
        ],
        "euAiAct": [
          {
            "source_id": "draft-placeholder-assumptions-catalogued-euAiAct",
            "title": "DRAFT PLACEHOLDER: euAiAct crosswalk title for assumptions-catalogued not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: euAiAct crosswalk qualification for assumptions-catalogued not yet authored.",
            "informational": true
          }
        ],
        "oecd": [
          {
            "source_id": "draft-placeholder-assumptions-catalogued-oecd",
            "title": "DRAFT PLACEHOLDER: oecd crosswalk title for assumptions-catalogued not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: oecd crosswalk qualification for assumptions-catalogued not yet authored."
          }
        ]
      }
    },
    "intended-use-defined": {
      "decision": "rely",
      "label": "The intended use and boundaries are explicit.",
      "operationalDefinition": "DRAFT PLACEHOLDER: The intended use and boundaries are explicit.",
      "passRule": "DRAFT PLACEHOLDER: pass rule for intended-use-defined not yet authored.",
      "failRule": "DRAFT PLACEHOLDER: fail rule for intended-use-defined not yet authored.",
      "claimedRule": "DRAFT PLACEHOLDER: claimed rule for intended-use-defined not yet authored.",
      "notApplicableNote": "DRAFT PLACEHOLDER: not-applicable note for intended-use-defined not yet authored.",
      "anchors": {
        "positive": [
          "DRAFT PLACEHOLDER: positive anchor for intended-use-defined not yet authored."
        ],
        "negative": [
          "DRAFT PLACEHOLDER: negative anchor for intended-use-defined not yet authored."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "draft-placeholder-intended-use-defined-iso42001",
            "title": "DRAFT PLACEHOLDER: iso42001 crosswalk title for intended-use-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: iso42001 crosswalk qualification for intended-use-defined not yet authored."
          }
        ],
        "gaicc": [
          {
            "source_id": "draft-placeholder-intended-use-defined-gaicc",
            "title": "DRAFT PLACEHOLDER: gaicc crosswalk title for intended-use-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: gaicc crosswalk qualification for intended-use-defined not yet authored."
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "draft-placeholder-intended-use-defined-nistAiRmf",
            "title": "DRAFT PLACEHOLDER: nistAiRmf crosswalk title for intended-use-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: nistAiRmf crosswalk qualification for intended-use-defined not yet authored."
          }
        ],
        "euAiAct": [
          {
            "source_id": "draft-placeholder-intended-use-defined-euAiAct",
            "title": "DRAFT PLACEHOLDER: euAiAct crosswalk title for intended-use-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: euAiAct crosswalk qualification for intended-use-defined not yet authored.",
            "informational": true
          }
        ],
        "oecd": [
          {
            "source_id": "draft-placeholder-intended-use-defined-oecd",
            "title": "DRAFT PLACEHOLDER: oecd crosswalk title for intended-use-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: oecd crosswalk qualification for intended-use-defined not yet authored."
          }
        ]
      }
    },
    "acceptance-criteria-defined": {
      "decision": "rely",
      "label": "Acceptance criteria are explicit and testable enough for the use.",
      "operationalDefinition": "DRAFT PLACEHOLDER: Acceptance criteria are explicit and testable enough for the use.",
      "passRule": "DRAFT PLACEHOLDER: pass rule for acceptance-criteria-defined not yet authored.",
      "failRule": "DRAFT PLACEHOLDER: fail rule for acceptance-criteria-defined not yet authored.",
      "claimedRule": "DRAFT PLACEHOLDER: claimed rule for acceptance-criteria-defined not yet authored.",
      "notApplicableNote": "DRAFT PLACEHOLDER: not-applicable note for acceptance-criteria-defined not yet authored.",
      "anchors": {
        "positive": [
          "DRAFT PLACEHOLDER: positive anchor for acceptance-criteria-defined not yet authored."
        ],
        "negative": [
          "DRAFT PLACEHOLDER: negative anchor for acceptance-criteria-defined not yet authored."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "draft-placeholder-acceptance-criteria-defined-iso42001",
            "title": "DRAFT PLACEHOLDER: iso42001 crosswalk title for acceptance-criteria-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: iso42001 crosswalk qualification for acceptance-criteria-defined not yet authored."
          }
        ],
        "gaicc": [
          {
            "source_id": "draft-placeholder-acceptance-criteria-defined-gaicc",
            "title": "DRAFT PLACEHOLDER: gaicc crosswalk title for acceptance-criteria-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: gaicc crosswalk qualification for acceptance-criteria-defined not yet authored."
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "draft-placeholder-acceptance-criteria-defined-nistAiRmf",
            "title": "DRAFT PLACEHOLDER: nistAiRmf crosswalk title for acceptance-criteria-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: nistAiRmf crosswalk qualification for acceptance-criteria-defined not yet authored."
          }
        ],
        "euAiAct": [
          {
            "source_id": "draft-placeholder-acceptance-criteria-defined-euAiAct",
            "title": "DRAFT PLACEHOLDER: euAiAct crosswalk title for acceptance-criteria-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: euAiAct crosswalk qualification for acceptance-criteria-defined not yet authored.",
            "informational": true
          }
        ],
        "oecd": [
          {
            "source_id": "draft-placeholder-acceptance-criteria-defined-oecd",
            "title": "DRAFT PLACEHOLDER: oecd crosswalk title for acceptance-criteria-defined not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: oecd crosswalk qualification for acceptance-criteria-defined not yet authored."
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
      "operationalDefinition": "DRAFT PLACEHOLDER: Relevant failure modes and fallback behaviour were evaluated.",
      "passRule": "DRAFT PLACEHOLDER: pass rule for failure-modes-tested not yet authored.",
      "failRule": "DRAFT PLACEHOLDER: fail rule for failure-modes-tested not yet authored.",
      "claimedRule": "DRAFT PLACEHOLDER: claimed rule for failure-modes-tested not yet authored.",
      "notApplicableNote": "DRAFT PLACEHOLDER: not-applicable note for failure-modes-tested not yet authored.",
      "anchors": {
        "positive": [
          "DRAFT PLACEHOLDER: positive anchor for failure-modes-tested not yet authored."
        ],
        "negative": [
          "DRAFT PLACEHOLDER: negative anchor for failure-modes-tested not yet authored."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "draft-placeholder-failure-modes-tested-iso42001",
            "title": "DRAFT PLACEHOLDER: iso42001 crosswalk title for failure-modes-tested not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: iso42001 crosswalk qualification for failure-modes-tested not yet authored."
          }
        ],
        "gaicc": [
          {
            "source_id": "draft-placeholder-failure-modes-tested-gaicc",
            "title": "DRAFT PLACEHOLDER: gaicc crosswalk title for failure-modes-tested not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: gaicc crosswalk qualification for failure-modes-tested not yet authored."
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "draft-placeholder-failure-modes-tested-nistAiRmf",
            "title": "DRAFT PLACEHOLDER: nistAiRmf crosswalk title for failure-modes-tested not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: nistAiRmf crosswalk qualification for failure-modes-tested not yet authored."
          }
        ],
        "euAiAct": [
          {
            "source_id": "draft-placeholder-failure-modes-tested-euAiAct",
            "title": "DRAFT PLACEHOLDER: euAiAct crosswalk title for failure-modes-tested not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: euAiAct crosswalk qualification for failure-modes-tested not yet authored.",
            "informational": true
          }
        ],
        "oecd": [
          {
            "source_id": "draft-placeholder-failure-modes-tested-oecd",
            "title": "DRAFT PLACEHOLDER: oecd crosswalk title for failure-modes-tested not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: oecd crosswalk qualification for failure-modes-tested not yet authored."
          }
        ]
      }
    },
    "limitations-stated": {
      "decision": "rely",
      "label": "Known limitations and out-of-scope conditions are stated.",
      "operationalDefinition": "DRAFT PLACEHOLDER: Known limitations and out-of-scope conditions are stated.",
      "passRule": "DRAFT PLACEHOLDER: pass rule for limitations-stated not yet authored.",
      "failRule": "DRAFT PLACEHOLDER: fail rule for limitations-stated not yet authored.",
      "claimedRule": "DRAFT PLACEHOLDER: claimed rule for limitations-stated not yet authored.",
      "notApplicableNote": "DRAFT PLACEHOLDER: not-applicable note for limitations-stated not yet authored.",
      "anchors": {
        "positive": [
          "DRAFT PLACEHOLDER: positive anchor for limitations-stated not yet authored."
        ],
        "negative": [
          "DRAFT PLACEHOLDER: negative anchor for limitations-stated not yet authored."
        ]
      },
      "crosswalk": {
        "iso42001": [
          {
            "source_id": "draft-placeholder-limitations-stated-iso42001",
            "title": "DRAFT PLACEHOLDER: iso42001 crosswalk title for limitations-stated not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: iso42001 crosswalk qualification for limitations-stated not yet authored."
          }
        ],
        "gaicc": [
          {
            "source_id": "draft-placeholder-limitations-stated-gaicc",
            "title": "DRAFT PLACEHOLDER: gaicc crosswalk title for limitations-stated not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: gaicc crosswalk qualification for limitations-stated not yet authored."
          }
        ],
        "nistAiRmf": [
          {
            "source_id": "draft-placeholder-limitations-stated-nistAiRmf",
            "title": "DRAFT PLACEHOLDER: nistAiRmf crosswalk title for limitations-stated not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: nistAiRmf crosswalk qualification for limitations-stated not yet authored."
          }
        ],
        "euAiAct": [
          {
            "source_id": "draft-placeholder-limitations-stated-euAiAct",
            "title": "DRAFT PLACEHOLDER: euAiAct crosswalk title for limitations-stated not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: euAiAct crosswalk qualification for limitations-stated not yet authored.",
            "informational": true
          }
        ],
        "oecd": [
          {
            "source_id": "draft-placeholder-limitations-stated-oecd",
            "title": "DRAFT PLACEHOLDER: oecd crosswalk title for limitations-stated not yet authored",
            "locator": "DRAFT PLACEHOLDER: locator not yet authored",
            "source_version": "DRAFT PLACEHOLDER: source version not yet authored",
            "relation_type": "supports",
            "qualification": "DRAFT PLACEHOLDER: oecd crosswalk qualification for limitations-stated not yet authored."
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
