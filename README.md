# PRISM

**Public-evidence Review of Innovation, Standards & Markets**

[![ci](https://github.com/helenkwok/prism/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/helenkwok/prism/actions/workflows/ci.yml)

Repository: https://github.com/helenkwok/prism

PRISM is an AI app, powered by NVIDIA Nemotron on Nebius Token Factory, that
reviews how publicly launched AI projects (on Show HN, subreddits and GitHub)
evidence their readiness, the way a systematic review paper would. It discovers
self-promoted projects, gathers evidence from each project's own website and
repository, and codes that evidence against a published codebook that joins
decision gates with ISO/IEC 42001, the NIST AI RMF, the EU AI Act and the OECD
AI Principles. The public output is aggregate statistics, trends and a written
review. Per-project analyses are private, in a signed-in web app that can also
run PRISM live on one project.

- Private analysis app: https://prism.helenkwok.dev (sign-in only; judges get a
  login through Devpost).
- Codebook: `codebook.md`. Protocol: `protocol/PROTOCOL.md`.

> **Branch note.** `main` holds the pipeline and app as of Phase 3. The current
> private app (as deployed), the spending guards and live runs are on the
> development branches and are merged into `main` before the submission
> deadline. The setup below matches the code on `main`.

## Audience

PRISM is a checklist for users, a tour guide for builders and a benchmark for
investors. Users get a checklist of the evidence to look for before trusting an
AI launch, and how often launches actually show it. Builders get a private
report showing where they stand and the next piece of evidence to add.
Investors get a benchmark of how launches evidence readiness against ISO/IEC
42001, the NIST AI RMF, the EU AI Act and the OECD AI Principles.

PRISM is not a promotion or listing service: nobody can pay, submit or apply
to be included, ranked or recommended. Projects are sampled from public
launches, evidence comes only from each project's own site and repositories
(never directories or listings), per-project results stay private, and the
public sees aggregates only.

## NVIDIA Nemotron on Nebius Token Factory

PRISM's model calls go to NVIDIA Nemotron models served by Nebius Token
Factory, through its OpenAI-compatible API (the standard `openai` SDK with
Token Factory's base URL). Each model is sized to its job:

| Role | Model | Why this size |
|------|-------|---------------|
| Screen launches: is this an AI product with its own site? | `nvidia/Nemotron-3_5-Lightning` (30B, 3B active), thinking off | Cheapest and fastest; screened 1,675 Show HN launches down to 300 |
| Confirm each positive finding against its quote | `nvidia/Nemotron-3-Ultra-550b-a55b` (550B, 55B active) | The accuracy-critical step; best of 12 tested configurations (schema-valid on 25 of 25 pages with `json_schema` output, thinking off) |
| Independent second coder, to measure agreement | Nemotron Super | A second Nemotron size the primary coder is checked against |

The bulk coder is an open model, DeepSeek-V4-Flash, also on Token Factory; it
coded all 300 projects for $2.46. Gold labels come from a third model family
(GLM) that neither codes nor confirms, so no model grades its own work.

Where Token Factory accelerated the work:

- **One API for every size.** The 12-configuration test (3 Nemotron models × 2
  output modes × thinking on/off, the same 25 pages each) took 377 calls and
  cost $1.22, so each role's model was chosen from measurements, not guesses.
- **Structured output.** `response_format: json_schema` makes every reply
  machine-checkable. Replies are still validated with Zod, retried once, and
  recorded as "unknown" if they fail.
- **Swappable providers.** Because the API is OpenAI-compatible, each model
  role and the evidence collector are configuration, not code. The same
  Nemotron models also run on a second host for the bulk validation runs.

The model never decides. It quotes and proposes; the deterministic gate (the
vendored ai-output-to-value claim gate in `vendor/ai-output-to-value`, run by
`src/pipeline/gate/run-gate.ts`) decides each claim, so swapping a provider
cannot change what counts as evidence. On the development branches, every
paid call passes a per-request token cap and a per-run dollar budget before it
is sent.

Evidence collection: the prototype collected each project's own site with
Tavily (`map` then `extract`, anchored to the project's domain, after a
`robots.txt` check). The published sample uses PRISM's own-site collector,
compared against Tavily on 142 projects (the same check result 91.5% of the
time; exploratory).

## Limitations and failure cases

- Nemotron Lightning stopped following the JSON schema with thinking on (4–8%
  of replies valid), so screening runs with thinking off.
- Even the best setting is not perfect: in a 50-call repeat of Ultra with
  `json_schema`, the longest run of consecutive valid replies was 23. Every
  reply is validated and retried once; if it is still invalid, it is recorded
  as "unknown".
- One early confirmation run sent whole pages as quotes: about 17M input tokens
  and $18.30 before it was stopped. Its results are archived and never
  published, and the run led to the per-request token cap and per-run budget
  that now sit in front of every paid call.
- Screening depends on how the model reads a title: in tests on another host,
  the same project was screened in on one server and out on another. Screening
  is audited (a sample of 50; error rate 12.2%).
- The free collector and Tavily agree on 91.5% of check results over 142
  projects, but they share only 44% of pages: an exploratory figure, not a
  validation.
- Collection recall against a separate gatherer is 0.887 on 10 projects.
- When evidence is thin, the gate says "insufficient evidence" instead of
  guessing, so many verdicts are "insufficient evidence": a finding about public
  evidence, not a verdict on the product.
- Reddit was not collected automatically, because its Data API needs
  pre-approval. The live app does not render pages that need JavaScript.

## Setup

Requires Node 24 or newer, and Python 3 for the gate's JSON-schema check.

```sh
git clone https://github.com/helenkwok/prism.git
cd prism
npm ci
python3 -m venv .venv-gate
.venv-gate/bin/pip install -r requirements-gate.txt
npm test
```

### Credentials

Keys are read from the environment, or from a mode-600 file in
`~/Library/Application Support/prism/` (set `PRISM_KEY_DIR` to use another
folder). Never put a key on the command line.

| Setting | Key file | Needed for |
|---------|----------|------------|
| `NEBIUS_API_KEY` | `nebius.key` | Every model call (Nebius Token Factory) |
| `TAVILY_API_KEY` | `tavily.key` | Evidence collection on `main` (Tavily) |
| `GITHUB_TOKEN` | | Repository evidence; falls back to `gh auth token` |
| `PRISM_DATA_DIR` | | Where private data lives; must be outside the repository (default `~/.prism-data`) |

To save a key from the clipboard without it appearing in the terminal:

```sh
mkdir -p "$HOME/Library/Application Support/prism"
pbpaste > "$HOME/Library/Application Support/prism/nebius.key"
chmod 600 "$HOME/Library/Application Support/prism/nebius.key"
```

### Run the pipeline

```sh
node src/pipeline/run.ts --slice <projects.json>
```

Results go to `PRISM_DATA_DIR`, never into the repository.

### Run the web app

```sh
export BETTER_AUTH_SECRET=<a long random secret> BETTER_AUTH_URL=http://localhost:3000
npm run build
npm start
```

There is no public sign-up. Accounts are created only with
`src/app/server/seed-account.ts`; its header lists the options.

## Layout

The repository is a single package with these folders. Folders appear as the
phases that need them land.

| Folder | Purpose |
|--------|---------|
| `src/pipeline` | Discovery, evidence collection and coding |
| `src/app` | The web application |
| `src/pipeline/gate` | Runs the deterministic gate |
| `protocol/` | The pre-registered review protocol |
| `spikes/` | Numbers-only records of the risk spikes |
| `vendor/` | Vendored, pinned third-party code |
| `public-data/` | Aggregate outputs that are safe to publish |
| `scripts/` | Repository checks and tooling |
| `.githooks/` | Tracked git hooks |

## Data separation

Per-project collected data and results live outside this repository, under the
directory named by `PRISM_DATA_DIR` (default `~/.prism-data`). The value must be
an absolute path. `scripts/check-data-dir.mjs` resolves it through symlinks and
fails when it lands inside the repository. The web app calls the same check at
boot, and CI runs it too.

```sh
PRISM_DATA_DIR=/absolute/path/outside/the/repo node scripts/check-data-dir.mjs
```

## Development

Requires Node 24 or newer.

```sh
npm ci
npm test
```

Git hooks are enabled by the `prepare` script.

## Licence

PRISM is licensed under the Apache License 2.0 (Apache-2.0). See `LICENSE` and
`NOTICE`.
