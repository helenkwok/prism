# Nebius spike (FND-05)

Numbers only. Keys, raw model output and batch files stay in the private store (D-21).

Status: final. Plan 01-10 completed the 12-config matrix, the escape probe, the D-15 pin and the 50-page streak.

```json
{
  "record": "nebius",
  "status": "final",
  "updated": "2026-09-23",
  "catalogue": [
    {
      "id": "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
      "host": "docs",
      "context_length": 262144,
      "quantization": "fp8",
      "pricing": {
        "prompt": "0.00000006",
        "completion": "0.00000024",
        "image": "0",
        "price_per_video_second": "0",
        "request": "0",
        "price_per_minute": "0"
      },
      "supported_features": [
        "tools",
        "reasoning"
      ],
      "regions": [
        "eu-north1"
      ],
      "status": "unknown"
    },
    {
      "id": "nvidia/Nemotron-3_5-Lightning",
      "host": "docs",
      "context_length": 1048576,
      "quantization": "bf16",
      "pricing": {
        "prompt": "0.00000006",
        "completion": "0.00000024",
        "image": "0",
        "price_per_video_second": "0",
        "request": "0",
        "price_per_minute": "0"
      },
      "supported_features": [
        "tools",
        "reasoning"
      ],
      "regions": [
        "eu-north1"
      ],
      "status": "unknown"
    },
    {
      "id": "nvidia/Nemotron-3-Ultra-550b-a55b",
      "host": "docs",
      "context_length": 1048576,
      "quantization": "fp4",
      "pricing": {
        "prompt": "0.000001",
        "completion": "0.000003",
        "image": "0",
        "price_per_video_second": "0",
        "request": "0",
        "price_per_minute": "0"
      },
      "supported_features": [
        "tools",
        "reasoning"
      ],
      "regions": [
        "us-central1"
      ],
      "status": "unknown"
    },
    {
      "id": "nvidia/nemotron-3-super-120b-a12b",
      "host": "docs",
      "context_length": 262144,
      "quantization": "fp4",
      "pricing": {
        "prompt": "0.0000003",
        "completion": "0.0000009",
        "image": "0",
        "price_per_video_second": "0",
        "request": "0",
        "price_per_minute": "0"
      },
      "supported_features": [
        "tools",
        "reasoning"
      ],
      "regions": [
        "us-central1"
      ],
      "status": "unknown"
    },
    {
      "id": "nvidia/Nemotron-3-Ultra-550b-a55b",
      "host": "regional",
      "context_length": 1048576,
      "quantization": "fp4",
      "pricing": {
        "prompt": "0.000001",
        "completion": "0.000003",
        "image": "0",
        "price_per_video_second": "0",
        "request": "0",
        "price_per_minute": "0"
      },
      "supported_features": [
        "tools",
        "reasoning"
      ],
      "regions": [
        "us-central1"
      ],
      "status": "unknown"
    },
    {
      "id": "nvidia/nemotron-3-super-120b-a12b",
      "host": "regional",
      "context_length": 262144,
      "quantization": "fp4",
      "pricing": {
        "prompt": "0.0000003",
        "completion": "0.0000009",
        "image": "0",
        "price_per_video_second": "0",
        "request": "0",
        "price_per_minute": "0"
      },
      "supported_features": [
        "tools",
        "reasoning"
      ],
      "regions": [
        "us-central1"
      ],
      "status": "unknown"
    },
    {
      "id": "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
      "host": "regional",
      "context_length": 262144,
      "quantization": "fp8",
      "pricing": {
        "prompt": "0.00000006",
        "completion": "0.00000024",
        "image": "0",
        "price_per_video_second": "0",
        "request": "0",
        "price_per_minute": "0"
      },
      "supported_features": [
        "tools",
        "reasoning"
      ],
      "regions": [
        "eu-north1"
      ],
      "status": "unknown"
    },
    {
      "id": "nvidia/Nemotron-3_5-Lightning",
      "host": "regional",
      "context_length": 1048576,
      "quantization": "bf16",
      "pricing": {
        "prompt": "0.00000006",
        "completion": "0.00000024",
        "image": "0",
        "price_per_video_second": "0",
        "request": "0",
        "price_per_minute": "0"
      },
      "supported_features": [
        "tools",
        "reasoning"
      ],
      "regions": [
        "eu-north1"
      ],
      "status": "unknown"
    }
  ],
  "catalogue_feature_vocabulary": [
    "reasoning",
    "tools"
  ],
  "catalogue_hosts_checked": [
    "docs",
    "regional"
  ],
  "rate_limits": {
    "observed_on": "2026-09-23",
    "model": "nvidia/Nemotron-3_5-Lightning",
    "headers": {
      "x-ratelimit-remaining-requests": "599",
      "x-ratelimit-remaining-tokens": "399647",
      "x-ratelimit-limit-requests": "600",
      "x-ratelimit-limit-tokens": "400000"
    }
  },
  "zdr": {
    "status": "on",
    "checked_on": "2026-09-23"
  },
  "credits": {
    "ai_cloud_coverage": "unknown",
    "checked_on": "2026-09-23",
    "balance_usd": 25,
    "trial_credit_usd": 1,
    "trial_credit_period_days": 29,
    "expected_total_usd": 50,
    "builders_program_status": "pending_review",
    "org_id": "aitenant-e00mr8cggt3r3bnh40",
    "org_name": "TAFE SA-rrr",
    "reconciliation": "open"
  },
  "batch": {
    "submitted_at": "2026-09-23T02:00:28.087Z",
    "completed_at": null,
    "final_status": "rejected",
    "per_model": {
      "nvidia/Nemotron-3-Ultra-550b-a55b": {
        "label": "ultra",
        "status": "rejected",
        "stage": "batch_create",
        "http_status": 403,
        "error_class": "forbidden",
        "detail": "Creating new batch job is temporarily unavailable"
      },
      "nvidia/nemotron-3-super-120b-a12b": {
        "label": "super",
        "status": "rejected",
        "stage": "batch_create",
        "http_status": 403,
        "error_class": "forbidden",
        "detail": "Creating new batch job is temporarily unavailable"
      },
      "nvidia/Nemotron-3_5-Lightning": {
        "label": "lightning",
        "status": "rejected",
        "stage": "batch_create",
        "http_status": 403,
        "error_class": "forbidden",
        "detail": "Creating new batch job is temporarily unavailable"
      }
    },
    "price_ratio": null
  },
  "fallbacks": {
    "batch": "triggered",
    "zdr": "not-needed"
  },
  "gate_file": {
    "path": "vendor/ai-output-to-value/schemas/v1/decision-gates.json",
    "sha256": "8d54a2f6cc3a19bb3c02a13bc28a92ac0f95cb2f7072a9f573f845be845d3881",
    "check_ids_count": 24
  },
  "matrix": [
    {
      "model": "nvidia/Nemotron-3-Ultra-550b-a55b",
      "output_mode": "json_schema",
      "thinking": "off",
      "n": 25,
      "json_parse_rate": 1,
      "zod_valid_rate": 1,
      "span_resolve_rate": 1,
      "schema_valid_rate": 1,
      "retry_rate": 0,
      "finish_reasons": {
        "stop": 25
      },
      "latency_ms": {
        "p50": 3707,
        "p95": 5496
      },
      "tokens": {
        "in": 54511,
        "out": 21837
      },
      "cost_usd": 0.120022,
      "status": "measured"
    },
    {
      "model": "nvidia/Nemotron-3-Ultra-550b-a55b",
      "output_mode": "json_schema",
      "thinking": "on",
      "n": 25,
      "json_parse_rate": 0.88,
      "zod_valid_rate": 0.88,
      "span_resolve_rate": 0.88,
      "schema_valid_rate": 0.88,
      "retry_rate": 0.2,
      "finish_reasons": {
        "stop": 22,
        "length": 3
      },
      "latency_ms": {
        "p50": 9029,
        "p95": 11931
      },
      "tokens": {
        "in": 69845,
        "out": 87798
      },
      "cost_usd": 0.333239,
      "status": "measured"
    },
    {
      "model": "nvidia/Nemotron-3-Ultra-550b-a55b",
      "output_mode": "json_object",
      "thinking": "off",
      "n": 25,
      "json_parse_rate": 1,
      "zod_valid_rate": 0.92,
      "span_resolve_rate": 0.92,
      "schema_valid_rate": 0.92,
      "retry_rate": 0.08,
      "finish_reasons": {
        "stop": 25
      },
      "latency_ms": {
        "p50": 3278,
        "p95": 4572
      },
      "tokens": {
        "in": 63727,
        "out": 21719
      },
      "cost_usd": 0.128884,
      "status": "measured"
    },
    {
      "model": "nvidia/Nemotron-3-Ultra-550b-a55b",
      "output_mode": "json_object",
      "thinking": "on",
      "n": 25,
      "json_parse_rate": 0.96,
      "zod_valid_rate": 0.88,
      "span_resolve_rate": 0.84,
      "schema_valid_rate": 0.84,
      "retry_rate": 0.24,
      "finish_reasons": {
        "stop": 24,
        "length": 1
      },
      "latency_ms": {
        "p50": 8428,
        "p95": 12612
      },
      "tokens": {
        "in": 71127,
        "out": 80676
      },
      "cost_usd": 0.313155,
      "status": "measured"
    },
    {
      "model": "nvidia/nemotron-3-super-120b-a12b",
      "output_mode": "json_schema",
      "thinking": "off",
      "n": 25,
      "json_parse_rate": 1,
      "zod_valid_rate": 1,
      "span_resolve_rate": 1,
      "schema_valid_rate": 1,
      "retry_rate": 0,
      "finish_reasons": {
        "stop": 25
      },
      "latency_ms": {
        "p50": 3148,
        "p95": 4323
      },
      "tokens": {
        "in": 54511,
        "out": 16937
      },
      "cost_usd": 0.031597,
      "status": "measured"
    },
    {
      "model": "nvidia/nemotron-3-super-120b-a12b",
      "output_mode": "json_schema",
      "thinking": "on",
      "n": 25,
      "json_parse_rate": 0.96,
      "zod_valid_rate": 0.96,
      "span_resolve_rate": 0.96,
      "schema_valid_rate": 0.96,
      "retry_rate": 0.04,
      "finish_reasons": {
        "stop": 23,
        "length": 2
      },
      "latency_ms": {
        "p50": 11875,
        "p95": 21582
      },
      "tokens": {
        "in": 59281,
        "out": 60455
      },
      "cost_usd": 0.072194,
      "status": "measured"
    },
    {
      "model": "nvidia/nemotron-3-super-120b-a12b",
      "output_mode": "json_object",
      "thinking": "off",
      "n": 25,
      "json_parse_rate": 1,
      "zod_valid_rate": 1,
      "span_resolve_rate": 1,
      "schema_valid_rate": 1,
      "retry_rate": 0,
      "finish_reasons": {
        "stop": 25
      },
      "latency_ms": {
        "p50": 3136,
        "p95": 5209
      },
      "tokens": {
        "in": 54511,
        "out": 16912
      },
      "cost_usd": 0.031574,
      "status": "measured"
    },
    {
      "model": "nvidia/nemotron-3-super-120b-a12b",
      "output_mode": "json_object",
      "thinking": "on",
      "n": 25,
      "json_parse_rate": 1,
      "zod_valid_rate": 1,
      "span_resolve_rate": 1,
      "schema_valid_rate": 1,
      "retry_rate": 0,
      "finish_reasons": {
        "stop": 25
      },
      "latency_ms": {
        "p50": 11889,
        "p95": 18115
      },
      "tokens": {
        "in": 54511,
        "out": 53015
      },
      "cost_usd": 0.064067,
      "status": "measured"
    },
    {
      "model": "nvidia/Nemotron-3_5-Lightning",
      "output_mode": "json_schema",
      "thinking": "off",
      "n": 25,
      "json_parse_rate": 1,
      "zod_valid_rate": 1,
      "span_resolve_rate": 1,
      "schema_valid_rate": 1,
      "retry_rate": 0,
      "finish_reasons": {
        "stop": 25
      },
      "latency_ms": {
        "p50": 3627,
        "p95": 6051
      },
      "tokens": {
        "in": 54511,
        "out": 16572
      },
      "cost_usd": 0.007248,
      "status": "measured"
    },
    {
      "model": "nvidia/Nemotron-3_5-Lightning",
      "output_mode": "json_schema",
      "thinking": "on",
      "n": 25,
      "json_parse_rate": 0.08,
      "zod_valid_rate": 0.08,
      "span_resolve_rate": 0.08,
      "schema_valid_rate": 0.08,
      "retry_rate": 1,
      "finish_reasons": {
        "length": 23,
        "stop": 2
      },
      "latency_ms": {
        "p50": 25851,
        "p95": 29592
      },
      "tokens": {
        "in": 109022,
        "out": 203886
      },
      "cost_usd": 0.055474,
      "status": "measured"
    },
    {
      "model": "nvidia/Nemotron-3_5-Lightning",
      "output_mode": "json_object",
      "thinking": "off",
      "n": 25,
      "json_parse_rate": 1,
      "zod_valid_rate": 0.6,
      "span_resolve_rate": 0.6,
      "schema_valid_rate": 0.6,
      "retry_rate": 0.52,
      "finish_reasons": {
        "stop": 25
      },
      "latency_ms": {
        "p50": 3300,
        "p95": 3826
      },
      "tokens": {
        "in": 83914,
        "out": 23900
      },
      "cost_usd": 0.010771,
      "status": "measured"
    },
    {
      "model": "nvidia/Nemotron-3_5-Lightning",
      "output_mode": "json_object",
      "thinking": "on",
      "n": 25,
      "json_parse_rate": 0.04,
      "zod_valid_rate": 0.04,
      "span_resolve_rate": 0.04,
      "schema_valid_rate": 0.04,
      "retry_rate": 1,
      "finish_reasons": {
        "length": 24,
        "stop": 1
      },
      "latency_ms": {
        "p50": 22822,
        "p95": 24658
      },
      "tokens": {
        "in": 109022,
        "out": 204360
      },
      "cost_usd": 0.055588,
      "status": "measured"
    }
  ],
  "escape_probe": [
    {
      "model": "nvidia/Nemotron-3-Ultra-550b-a55b",
      "output_mode": "json_schema",
      "survived": true,
      "json_parses": true,
      "finish_reason": "stop",
      "checked_on": "2026-09-23"
    },
    {
      "model": "nvidia/Nemotron-3-Ultra-550b-a55b",
      "output_mode": "json_object",
      "survived": true,
      "json_parses": true,
      "finish_reason": "stop",
      "checked_on": "2026-09-23"
    },
    {
      "model": "nvidia/nemotron-3-super-120b-a12b",
      "output_mode": "json_schema",
      "survived": true,
      "json_parses": true,
      "finish_reason": "stop",
      "checked_on": "2026-09-23"
    },
    {
      "model": "nvidia/nemotron-3-super-120b-a12b",
      "output_mode": "json_object",
      "survived": true,
      "json_parses": true,
      "finish_reason": "stop",
      "checked_on": "2026-09-23"
    },
    {
      "model": "nvidia/Nemotron-3_5-Lightning",
      "output_mode": "json_schema",
      "survived": false,
      "json_parses": true,
      "finish_reason": "stop",
      "checked_on": "2026-09-23"
    },
    {
      "model": "nvidia/Nemotron-3_5-Lightning",
      "output_mode": "json_object",
      "survived": false,
      "json_parses": true,
      "finish_reason": "stop",
      "checked_on": "2026-09-23"
    }
  ],
  "pinned": {
    "model": "nvidia/Nemotron-3-Ultra-550b-a55b",
    "output_mode": "json_schema",
    "thinking": "off",
    "base_url": "https://api.tokenfactory.nebius.com/v1",
    "mode": "real-time",
    "retry_rate": 0,
    "streak": {
      "n": 50,
      "max_consecutive_valid": 23
    }
  }
}
```

- **Task 1 (checkpoint:human-action), resolved by Helen through the orchestrator:** `done zdr=on credits_ai_cloud=unknown batch=unknown`. Zero Data Retention: on, confirmed in Organization settings, Other settings, "Enable zero data retention" checked. AI Cloud credit coverage: unknown from the console. Batch entitlement: unknown from the console (not skipped; Task 3 measures it directly).
- **Credits, as observed:** account balance $25.00, plus a separate $1.00 trial credit on a 29 day period. Expected total $50 (a $25 promo credit plus a $25 Builders Program credit) has not fully landed; the Builders Program application is still under review. Balance reconciliation is left open.
- **Catalogue:** 4 `nvidia/*` models found on each of the two hosts queried (docs: `api.tokenfactory.nebius.com`; regional: `api.tokenfactory.us-central1.nebius.com`), 8 entries total, both hosts serving an identical 4-model set. The `supported_features` vocabulary observed across all 4 models is `reasoning, tools` only: no explicit JSON-mode tag exists in the catalogue, so JSON-mode support is a measured property (Pitfall 10/A5), not a catalogue fact.
- **One real structured-output call:** Lightning (`nvidia/Nemotron-3_5-Lightning`), `response_format: json_schema`, `chat_template_kwargs.enable_thinking: false`, `max_tokens: 300`: status 200, `finish_reason: stop`, reply validated by zod, 14 completion tokens. With thinking left on (measured once, not recorded above), the same call exhausted `max_tokens: 200` on chain-of-thought text before emitting JSON (`finish_reason: length`), confirming the harness must set `enable_thinking: false` for a parseable reply on this model.
- **Task 3, Batch API round trip (measured, not left console-unknown):** submitted for all 3 candidate models (Ultra, Super, Lightning). The files endpoint accepted each 10-line JSONL upload (purpose batch, status 200), but batch creation itself returned HTTP 403 "Creating new batch job is temporarily unavailable" for all 3, identically, on the same submitted file ids. This is an account/service-level rejection at the `/batches` endpoint, not a per-model entitlement difference (the endpoint takes no model parameter; the rejection occurs before any per-line model is considered), so Pitfall 5's "batch access requires separate model entitlements" question resolves to: the service itself is unavailable for this account right now, upstream of any per-model check. All 3 submissions are therefore already terminal (rejected), `batch.final_status` is `rejected`, and `fallbacks.batch` is `triggered`: per D-17, Phase 2 falls back to real-time calls with p-limit under the rate limits, and the STACK.md Batch-at-50% budget line does not apply. `poll` was run once and read back the same 3 rejections (exit 0, nothing pending).

- **Plan 01-10, the 12-config matrix (25 real pages, same set for every config):** Ultra `json_schema`/thinking-off reached schema_valid_rate 1.0 (0 retries); its other 3 configs measured 0.88, 0.92 and 0.84. Super reached 1.0 on 3 of its 4 configs and 0.96 on the fourth (thinking on, json_schema). Lightning reached 1.0 on `json_schema`/thinking-off but collapsed under thinking-on (0.08 json_schema, 0.04 json_object) and degraded under `json_object`/thinking-off (0.60), consistent with the 01-07 finding that thinking exhausts `max_tokens` before JSON on this model. Total recorded matrix spend: $1.22 against the $10 budget (`--configs all --pages 25`, no config hit the API-rejection path, so all 12 entries are `status: measured`, none `unsupported`).
- **Escape probe (one free-text field, 2 output modes x 3 models):** Ultra and Super preserved the exact target sequence (`survived: true`) in both `json_schema` and `json_object` mode; Lightning did not (`survived: false` in both modes) while still returning parseable JSON (`json_parses: true`) — the string-escape defect is present on Lightning specifically, not model-wide. The output contract used in the matrix (span ids and enums only) cannot be corrupted by this defect; the probe only measures it.
- **Plan 01-10, the D-15 pin:** Ultra qualified first in preference order (>=0.95 schema-valid on >=20 pages, D-15) via `json_schema`/thinking-off; pinned `nvidia/Nemotron-3-Ultra-550b-a55b`, output_mode `json_schema`, thinking `off`, mode `real-time`, retry_rate 0, base_url the docs host.
- **50-page streak (pages disjoint from the matrix's 25):** n=50, max_consecutive_valid=23. **The STATE gate (>=50 consecutive schema-valid responses before any bulk run) is NOT met on this streak.** This is recorded as a measured shortfall, not a plan failure (D-15/STATE do not require the streak itself to reach 50 as a condition of pinning): Phase 2 must either re-run a fresh streak before any bulk coding pass, or treat the ~23-in-a-row ceiling as informing its own retry/backoff design before committing to an unattended bulk run.
- **Batch close-out (Task 3):** re-polled to a terminal state; `final_status` remains `rejected` (all 3 candidates, unchanged from the Task 3/01-07 submission). Fallbacks: batch `triggered`, zdr `not-needed` (ZDR is `on`).
