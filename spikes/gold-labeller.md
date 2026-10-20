# Gold labeller spike (D-62, D-65)

Numbers only. Labels and span text stay under the private spike dir. Hosts named as Token Factory or the local Ollama daemon.

```json
{
  "record": "gold-labeller",
  "status": "final",
  "updated": "2026-10-20",
  "sample": "5 pilot projects with the most recorded positives (project_n 1..20)",
  "options": {
    "a-tf-glm-low": {
      "provider": "token-factory",
      "model": "zai-org/GLM-5.3",
      "reasoning": "low",
      "projects_ok": 4,
      "projects_retry_exhausted": 1,
      "positives_read": 29,
      "unsupported_positives": 0,
      "median_latency_ms_per_chunk": 6855,
      "schema_invalid_retries": 0,
      "cost": "Token Factory usage (full GLM-5.3 rates)",
      "quota_or_rate_errors": 0
    },
    "b-ollama-glm-low": {
      "provider": "ollama",
      "model": "glm-5.3:cloud",
      "reasoning": "low",
      "projects_ok": 3,
      "projects_retry_exhausted": 2,
      "positives_read": 26,
      "unsupported_positives": 1,
      "overlabel_note": "more pass labels than option a on shared projects; several weakly supported",
      "median_latency_ms_per_chunk": 5854,
      "schema_invalid_retries": 0,
      "cost": 0,
      "quota_or_rate_errors": 0,
      "ollama_cap_observations": "cloud pull succeeded; larger projects hit retry-exhausted more often than Token Factory"
    },
    "c-ollama-glm-medium": {
      "provider": "ollama",
      "model": "glm-5.3:cloud",
      "reasoning": "medium",
      "projects_ok": 0,
      "projects_retry_exhausted": 5,
      "positives_read": 0,
      "unsupported_positives": 0,
      "median_latency_ms_per_chunk": null,
      "cost": 0,
      "quota_or_rate_errors": 0,
      "ollama_cap_observations": "medium think exhausted the coding contract on every project (retry-exhausted)"
    },
    "d-tf-glm-flash": {
      "provider": "token-factory",
      "model": "zai-org/GLM-5.3-Flash",
      "reasoning": "low",
      "projects_ok": 5,
      "projects_retry_exhausted": 0,
      "positives_read": 51,
      "unsupported_positives": 0,
      "median_latency_ms_per_chunk": 9054,
      "schema_invalid_retries": 0,
      "cost": "Token Factory usage (Flash rates, below full GLM-5.3)",
      "quota_or_rate_errors": 0
    },
    "e-openrouter-free": {
      "skipped": true,
      "reason": "openrouter.key absent"
    }
  },
  "cross_host_glm": "GLM-5.3 on Token Factory and the local Ollama daemon both ran; Ollama low completed fewer projects and over-labelled relative to Token Factory low on shared projects",
  "auditor_smoke": {
    "model": "kimi-k3:cloud",
    "via": "ollama screenCandidate stage 1",
    "result": "include with null reasonCode"
  },
  "pinned": {
    "option": "d-tf-glm-flash",
    "provider": "token-factory",
    "model": "zai-org/GLM-5.3-Flash",
    "reasoning": "low",
    "why": "cheapest option whose positives were supported at least as well as full GLM-5.3 low on shared projects; completed all 5; Ollama low over-labelled and missed 2; Ollama medium failed all 5"
  },
  "gold_rows_written": 0
}
```
