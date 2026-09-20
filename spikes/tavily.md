# Tavily spike (FND-06)

Numbers only. Project URLs, page text and keys stay in the private store (D-21).

```json
{
  "record": "tavily",
  "status": "final",
  "updated": "2026-09-20",
  "credit_balance_checked": {
    "checked_on": "2026-09-20",
    "credits_or_usd": 1000,
    "unit": "credits",
    "source": "Tavily dashboard as reported by Helen; free monthly allowance",
    "api_plan_limit": 1500,
    "hackathon_credit": "UNCONFIRMED: not seen on the account, so nothing here relies on it (D-16)"
  },
  "criterion": {
    "id": "A",
    "outcome": "met",
    "definition": "ceiling of 40 credits per project (D-16) plus binding median at most 10 and p95 at most 40 on the 5 projects; Phase 2 cap derived from remaining credits divided by projects still to collect",
    "measured": {
      "median_credits": 9,
      "p95_credits": 9,
      "max_credits": 9,
      "by": "per-call usage reported by the API, the larger of that and the account delta when one was read",
      "formula_median_credits": 9,
      "formula_p95_credits": 11,
      "formula_max_credits": 11,
      "ceiling": 40,
      "ceiling_held": true
    }
  },
  "projects": [
    {
      "type_class": "own-domain",
      "preflight": {
        "robots_blocked": false,
        "redirect_hops": 0,
        "boundary_ok": true
      },
      "map": {
        "urls_returned": 50,
        "in_boundary": 50,
        "robots_blocked_urls": 2
      },
      "extract": {
        "results": 20,
        "failed": 0,
        "empty": 0,
        "advanced_retries": 0,
        "recovered_by_advanced": 0,
        "still_failed": 0,
        "still_empty": 0,
        "pages_kept": 20
      },
      "leakage": {
        "raw_offsite_in_map": 0,
        "raw_offsite_in_results": 0,
        "after_filter": 0,
        "offsite_classes": {}
      },
      "credits": {
        "per_call": 9,
        "formula": 9,
        "account_delta": null,
        "account_delta_lagged": true,
        "total": 9,
        "by_call": [
          {
            "kind": "map",
            "per_call": 5,
            "formula": 5
          },
          {
            "kind": "extract-basic",
            "per_call": 4,
            "formula": 4
          }
        ],
        "projected_full_extract_formula": 15
      },
      "usage_zero_below_5": {
        "calls_below_5": 0,
        "reported_zero": 0
      },
      "wall_ms": 16748
    },
    {
      "type_class": "shared-host",
      "preflight": {
        "robots_blocked": false,
        "redirect_hops": 0,
        "boundary_ok": true
      },
      "map": {
        "urls_returned": 0,
        "in_boundary": 0,
        "robots_blocked_urls": 0
      },
      "extract": {
        "results": 1,
        "failed": 0,
        "empty": 0,
        "advanced_retries": 0,
        "recovered_by_advanced": 0,
        "still_failed": 0,
        "still_empty": 0,
        "pages_kept": 1
      },
      "leakage": {
        "raw_offsite_in_map": 0,
        "raw_offsite_in_results": 0,
        "after_filter": 0,
        "offsite_classes": {}
      },
      "credits": {
        "per_call": 0,
        "formula": 1,
        "account_delta": null,
        "account_delta_lagged": true,
        "total": 0,
        "by_call": [
          {
            "kind": "map",
            "per_call": 0,
            "formula": 0
          },
          {
            "kind": "extract-basic",
            "per_call": 0,
            "formula": 1
          }
        ],
        "projected_full_extract_formula": 5
      },
      "usage_zero_below_5": {
        "calls_below_5": 1,
        "reported_zero": 1
      },
      "wall_ms": 1776
    },
    {
      "type_class": "repo-only",
      "preflight": {
        "robots_blocked": false,
        "redirect_hops": 0,
        "boundary_ok": true
      },
      "map": {
        "urls_returned": 50,
        "in_boundary": 50,
        "robots_blocked_urls": 14
      },
      "extract": {
        "results": 20,
        "failed": 0,
        "empty": 0,
        "advanced_retries": 0,
        "recovered_by_advanced": 0,
        "still_failed": 0,
        "still_empty": 0,
        "pages_kept": 20
      },
      "leakage": {
        "raw_offsite_in_map": 0,
        "raw_offsite_in_results": 0,
        "after_filter": 0,
        "offsite_classes": {}
      },
      "credits": {
        "per_call": 9,
        "formula": 9,
        "account_delta": null,
        "account_delta_lagged": true,
        "total": 9,
        "by_call": [
          {
            "kind": "map",
            "per_call": 5,
            "formula": 5
          },
          {
            "kind": "extract-basic",
            "per_call": 4,
            "formula": 4
          }
        ],
        "projected_full_extract_formula": 13
      },
      "usage_zero_below_5": {
        "calls_below_5": 0,
        "reported_zero": 0
      },
      "wall_ms": 17827
    },
    {
      "type_class": "spa",
      "preflight": {
        "robots_blocked": false,
        "redirect_hops": 0,
        "boundary_ok": true
      },
      "map": {
        "urls_returned": 0,
        "in_boundary": 0,
        "robots_blocked_urls": 0
      },
      "extract": {
        "results": 1,
        "failed": 0,
        "empty": 0,
        "advanced_retries": 0,
        "recovered_by_advanced": 0,
        "still_failed": 0,
        "still_empty": 0,
        "pages_kept": 1
      },
      "leakage": {
        "raw_offsite_in_map": 0,
        "raw_offsite_in_results": 0,
        "after_filter": 0,
        "offsite_classes": {}
      },
      "credits": {
        "per_call": 1,
        "formula": 1,
        "account_delta": null,
        "account_delta_lagged": true,
        "total": 1,
        "by_call": [
          {
            "kind": "map",
            "per_call": 0,
            "formula": 0
          },
          {
            "kind": "extract-basic",
            "per_call": 1,
            "formula": 1
          }
        ],
        "projected_full_extract_formula": 5
      },
      "usage_zero_below_5": {
        "calls_below_5": 1,
        "reported_zero": 0
      },
      "wall_ms": 13727
    },
    {
      "type_class": "redirect",
      "preflight": {
        "robots_blocked": false,
        "redirect_hops": 1,
        "boundary_ok": false
      },
      "map": {
        "urls_returned": 50,
        "in_boundary": 50,
        "robots_blocked_urls": 26
      },
      "extract": {
        "results": 18,
        "failed": 2,
        "empty": 0,
        "advanced_retries": 1,
        "recovered_by_advanced": 2,
        "still_failed": 0,
        "still_empty": 0,
        "pages_kept": 20
      },
      "leakage": {
        "raw_offsite_in_map": 0,
        "raw_offsite_in_results": 0,
        "after_filter": 0,
        "offsite_classes": {}
      },
      "credits": {
        "per_call": 9,
        "formula": 11,
        "account_delta": null,
        "account_delta_lagged": true,
        "total": 9,
        "by_call": [
          {
            "kind": "map",
            "per_call": 5,
            "formula": 5
          },
          {
            "kind": "extract-basic",
            "per_call": 3,
            "formula": 4
          },
          {
            "kind": "extract-advanced",
            "per_call": 1,
            "formula": 2
          }
        ],
        "projected_full_extract_formula": 10
      },
      "usage_zero_below_5": {
        "calls_below_5": 1,
        "reported_zero": 0
      },
      "wall_ms": 24212
    }
  ],
  "controls": {
    "allow_external_true": {
      "urls_returned": 50,
      "offsite_urls_returned": 0,
      "offsite_classes": {},
      "credits_per_call": 5,
      "credits_formula": 5
    },
    "selectors_off_allow_false": {
      "urls_returned": 50,
      "offsite_urls_returned": 0,
      "offsite_classes": {},
      "credits_per_call": 5,
      "credits_formula": 5
    },
    "naive_defaults": {
      "urls_returned": 50,
      "offsite_urls_returned": 0,
      "offsite_classes": {},
      "credits_per_call": 5,
      "credits_formula": 5
    },
    "search_fallback": {
      "results": 5,
      "offsite_results": 0,
      "after_filter": 0,
      "credits_per_call": 1,
      "credits_formula": 1
    },
    "redirect_entry_extract": {
      "results": 1,
      "failed": 0,
      "result_url_equals_requested": true,
      "result_url_equals_final": false,
      "result_fields": [
        "images",
        "raw_content",
        "title",
        "url"
      ],
      "response_fields": [
        "failed_results",
        "request_id",
        "response_time",
        "results",
        "usage"
      ],
      "failed_fields": [],
      "credits_per_call": 0,
      "credits_formula": 1,
      "usage_zero_below_5": true
    },
    "repo_only_project": {
      "type_class": "repo-only",
      "naive_defaults": {
        "urls_returned": 50,
        "offsite_urls_returned": 37,
        "offsite_same_host_other_path": 37,
        "offsite_classes": {
          "code-host": 37
        },
        "credits_per_call": 5,
        "credits_formula": 5
      },
      "allow_external_true": {
        "urls_returned": 50,
        "offsite_urls_returned": 0,
        "offsite_same_host_other_path": 0,
        "offsite_classes": {},
        "credits_per_call": 5,
        "credits_formula": 5
      }
    },
    "account_delta": null
  },
  "account_reconciliation": {
    "lag_note": "the usage endpoint did not move for many minutes after spend, so a per-project read taken seconds later was always stale",
    "main_run": {
      "account_counter_absolute": 80,
      "settle_wait_s": 519,
      "spend_logged_per_call_through_main_run": 71,
      "spend_logged_formula_through_main_run": 76,
      "derivation": "sum of per-call and formula credits over every Tavily call made from the first tracer run through the main run"
    },
    "final_counter": {
      "plan_usage": 80,
      "map_usage": 50,
      "extract_usage": 29,
      "search_usage": 1,
      "expected_per_call_total": 104,
      "expected_formula_total": 110,
      "caught_up": false,
      "waited_min": 0
    },
    "calibration": {
      "workload": [
        "redirect",
        "shared-host"
      ],
      "per_call_sum": 9,
      "formula_sum": 10,
      "account_delta": 0,
      "baseline_stable": true,
      "end_stable": false,
      "settle_wait_s": 1181
    }
  },
  "aggregate": {
    "median_credits": 9,
    "p95_credits": 9,
    "max_credits": 9,
    "p95_method": "nearest rank over 5 projects (equals the maximum)",
    "total_credits": 28
  },
  "phase2_budget": {
    "basis": "free monthly allowance only; the hackathon credit is unconfirmed",
    "plan_limit": 1500,
    "spent_all_spike_calls_per_call": 104,
    "remaining_credits": 1396,
    "projects_still_to_collect": 295,
    "derived_cap_per_project": 4.7,
    "observed_mean_per_project": 5.6,
    "observed_median_per_project": 9,
    "projected_300_at_mean": 1680,
    "projected_300_at_median": 2700,
    "fits_free_allowance": false
  },
  "blocks_phase2_collector": false,
  "corpus_pages": 87,
  "corpus_target": 75,
  "topup": {
    "topup_requested": 25,
    "topup_urls": 25,
    "topup_pages_kept": 25,
    "per_call": 5,
    "formula": 5
  },
  "limits": {
    "dns_answer_not_pinned_to_socket": true,
    "meta_and_script_redirects_not_followed": true,
    "extract_cap_per_project": 20,
    "map_limit": 50,
    "map_depth": 2
  }
}
```

## Commentary

- Criterion A (ceiling 40 plus median at most 10 and p95 at most 40): met. Measured median 9, p95 9, max 9 credits per project. p95 over five projects is the maximum by nearest rank.
- Credits per project, by method. Per-call usage: 9, 0, 9, 1, 9. Documented formula: 9, 1, 9, 1, 11. Account usage delta: not attributable per project (stale reads). A project's total is its per-call usage.
- Reconciliation: per-call and formula disagree on at least one project (=, 0 vs 1, =, =, 9 vs 11). Every per-project account read was stale, because the usage endpoint moved only after several minutes, so per-project account deltas are null.
- Billing calibration: two projects re-run back to back with no reads in between, then a wait for the counter to settle (1181 s, stable false). Per-call sum 9, formula sum 10, account delta 0.
- Extract usage below 5 successes read 0 on 1 of 3 such calls in the project runs; the single-URL control extract read 0 credits (formula 1) (research Pitfall 6).
- Final URL after a redirect: the single-URL extract of a pre-redirect link returned 1 result and 0 failed; result url equals requested: true, equals final: false. Result fields: images, raw_content, title, url. No field carries a final URL, so the redirect check is PRISM code (Pitfall 8).
- Leakage with allow_external false plus anchored selectors: 0 off-site URLs in map lists and 0 in extract results across the five projects; 0 after the code-side host filter.
- Controls on the own-domain project: allow_external true (selectors kept) returned 0 off-site of 50; selectors off with allow_external false returned 0 off-site of 50; naive defaults returned 0 off-site of 50. Restricted search returned 5 results, 0 off-site.
- Final account counter read: 80 credits (map 50, extract 29, search 1) against 104 logged by per-call usage and 110 by the formula; caught up with the logged spend: false, after waiting 0 minutes. The counter moves in lumps many minutes after spend.
- Controls on the repo-only project (shared host, path boundary): naive defaults returned 37 URLs outside the path boundary of 50 (37 on the same host under other paths); allow_external true with selectors kept returned 0 of 50.
- after_filter is zero by construction, because the code-side filter drops every URL outside the boundary; the informative leakage numbers are the raw counts in the map list and in the extract results.
- Phase 2 budget on the free allowance alone (the hackathon credit is unconfirmed): 1396 credits remain of 1500, so 295 projects leave a derived cap of 4.7 credits each. Observed mean 5.6 and median 9 per project would need about 1680 to 2700 credits for 300 projects; fits the free allowance: false.
- Corpus: 87 non-empty redacted pages against a target of 75.
- Phase 2 collector design is not blocked by leakage.
- Limits: the DNS answer checked in pre-flight is not pinned to the connecting socket, and only HTTP redirects are followed. Both are Phase 2 and Phase 7 work.
