# Nebius spike (FND-05)

Numbers only. Keys, raw model output and batch files stay in the private store (D-21).

Status: pending. The 12-config matrix, escape probe, pinned model and the zdr fallback state are completed by plan 01-10; this plan records the catalogue, one real structured-output call, the ZDR/credits console facts and the Batch API submission.

```json
{
  "record": "nebius",
  "status": "pending",
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
      "model": "nvidia/Nemotron-3_5-Lightning",
      "output_mode": "json_schema",
      "thinking": "off",
      "n": 3,
      "json_parse_rate": 1,
      "zod_valid_rate": 1,
      "span_resolve_rate": 1,
      "schema_valid_rate": 1,
      "retry_rate": 0,
      "finish_reasons": {
        "stop": 3
      },
      "latency_ms": {
        "p50": 3147,
        "p95": 3265
      },
      "tokens": {
        "in": 4374,
        "out": 1807
      },
      "cost_usd": 0.000696,
      "status": "measured"
    }
  ]
}
```

- **Task 1 (checkpoint:human-action), resolved by Helen through the orchestrator:** `done zdr=on credits_ai_cloud=unknown batch=unknown`. Zero Data Retention: on, confirmed in Organization settings, Other settings, "Enable zero data retention" checked. AI Cloud credit coverage: unknown from the console. Batch entitlement: unknown from the console (not skipped; Task 3 measures it directly).
- **Credits, as observed:** account balance $25.00, plus a separate $1.00 trial credit on a 29 day period. Expected total $50 (a $25 promo credit plus a $25 Builders Program credit) has not fully landed; the Builders Program application is still under review. Balance reconciliation is left open.
- **Catalogue:** 4 `nvidia/*` models found on each of the two hosts queried (docs: `api.tokenfactory.nebius.com`; regional: `api.tokenfactory.us-central1.nebius.com`), 8 entries total, both hosts serving an identical 4-model set. The `supported_features` vocabulary observed across all 4 models is `reasoning, tools` only: no explicit JSON-mode tag exists in the catalogue, so JSON-mode support is a measured property (Pitfall 10/A5), not a catalogue fact.
- **One real structured-output call:** Lightning (`nvidia/Nemotron-3_5-Lightning`), `response_format: json_schema`, `chat_template_kwargs.enable_thinking: false`, `max_tokens: 300`: status 200, `finish_reason: stop`, reply validated by zod, 14 completion tokens. With thinking left on (measured once, not recorded above), the same call exhausted `max_tokens: 200` on chain-of-thought text before emitting JSON (`finish_reason: length`), confirming the harness must set `enable_thinking: false` for a parseable reply on this model.
- **Task 3, Batch API round trip (measured, not left console-unknown):** submitted for all 3 candidate models (Ultra, Super, Lightning). The files endpoint accepted each 10-line JSONL upload (purpose batch, status 200), but batch creation itself returned HTTP 403 "Creating new batch job is temporarily unavailable" for all 3, identically, on the same submitted file ids. This is an account/service-level rejection at the `/batches` endpoint, not a per-model entitlement difference (the endpoint takes no model parameter; the rejection occurs before any per-line model is considered), so Pitfall 5's "batch access requires separate model entitlements" question resolves to: the service itself is unavailable for this account right now, upstream of any per-model check. All 3 submissions are therefore already terminal (rejected), `batch.final_status` is `rejected`, and `fallbacks.batch` is `triggered`: per D-17, Phase 2 falls back to real-time calls with p-limit under the rate limits, and the STACK.md Batch-at-50% budget line does not apply. `poll` was run once and read back the same 3 rejections (exit 0, nothing pending).
