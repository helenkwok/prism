# Screening spike (DSC-02, addendum A5)

Numbers only. Candidate titles, URLs and page text stay in the private store (D-21).

```json
{
  "record": "screening",
  "status": "final",
  "updated": "2026-10-19",
  "model": "nvidia/Nemotron-3_5-Lightning",
  "settings": { "temperature": 0, "output": "json_schema (include, reasonCode)", "stage1_max_tokens": 256, "thinking_max_tokens": 8192 },
  "stage1_title_url": {
    "sample": "300 frame posts, seeded draw (seed 'screen-spike'), plus the 20 pilot posts",
    "no_thinking": { "valid_replies": "340/340, no retries", "seconds": 27, "tokens_in": 142677, "tokens_out": 4532, "sample_include_rate": 0.573, "sample_counts": { "include": 172, "not-ai": 120, "library-no-product-claim": 6, "model-or-paper": 2 } },
    "thinking": { "valid_replies": "319/320", "seconds": 906, "tokens_in": 113631, "tokens_out": 1010677, "sample_include_rate": 0.427, "decisions_changed": { "include_to_exclude": 63, "exclude_to_include": 19 } },
    "chosen": "no thinking: stage 1 must include when unsure; thinking excluded borderline AI tools that stage 2 would never see"
  },
  "stage2_page_text": {
    "sample": "the 20 pilot projects, collected text capped at 12000 characters",
    "variants_include_sets": {
      "lightning_no_thinking": "7 included; 3 of them have pages with no mention of AI; 1 AI product excluded",
      "lightning_thinking": "3 included (the 3 AI products)",
      "super_vl_no_thinking": "6 included",
      "super_vl_thinking": "3 included, the same 3"
    },
    "lightning_vs_super_vl_thinking": "identical include sets; differ only in the exclusion code for 4 projects",
    "seconds_lightning_thinking": 41,
    "chosen": "Lightning with thinking"
  },
  "insufficient_text": "3 pilot pages had 0 characters and one a loading screen; every variant excluded some of them, so stage 2 does not decide below 500 characters (A5)",
  "pilot_finding": "the first pilot was drawn from the unscreened frame: about 3 of its 20 projects are AI products"
}
```
