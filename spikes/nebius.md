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
  "batch": null,
  "fallbacks": {
    "batch": "not-needed",
    "zdr": "not-needed"
  }
}
```

- **Task 1 (checkpoint:human-action), resolved by Helen through the orchestrator:** `done zdr=on credits_ai_cloud=unknown batch=unknown`. Zero Data Retention: on, confirmed in Organization settings, Other settings, "Enable zero data retention" checked. AI Cloud credit coverage: unknown from the console. Batch entitlement: unknown from the console (not skipped; Task 3 measures it directly).
- **Credits, as observed:** account balance $25.00, plus a separate $1.00 trial credit on a 29 day period. Expected total $50 (a $25 promo credit plus a $25 Builders Program credit) has not fully landed; the Builders Program application is still under review. Balance reconciliation is left open.
- **Catalogue:** 4 `nvidia/*` models found on each of the two hosts queried (docs: `api.tokenfactory.nebius.com`; regional: `api.tokenfactory.us-central1.nebius.com`), 8 entries total, both hosts serving an identical 4-model set. The `supported_features` vocabulary observed across all 4 models is `reasoning, tools` only: no explicit JSON-mode tag exists in the catalogue, so JSON-mode support is a measured property (Pitfall 10/A5), not a catalogue fact.
- **One real structured-output call:** Lightning (`nvidia/Nemotron-3_5-Lightning`), `response_format: json_schema`, `chat_template_kwargs.enable_thinking: false`, `max_tokens: 300`: status 200, `finish_reason: stop`, reply validated by zod, 14 completion tokens. With thinking left on (measured once, not recorded above), the same call exhausted `max_tokens: 200` on chain-of-thought text before emitting JSON (`finish_reason: length`), confirming the harness must set `enable_thinking: false` for a parseable reply on this model.
