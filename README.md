# PRISM

**Public-evidence Review of Innovation, Standards & Markets**

[![ci](https://github.com/helenkwok/prism/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/helenkwok/prism/actions/workflows/ci.yml)

Repository: https://github.com/helenkwok/prism

PRISM is a systematic-review style study of how publicly launched AI projects
(on Show HN, subreddits and GitHub) evidence their readiness. It discovers
self-promoted projects, gathers evidence from each project's own website and
repository, and codes that evidence against a published codebook. The public
output is aggregate statistics, trends and a written review. Per-project
analyses are private.

## Layout

The repository is a single package with these folders. Folders appear as the
phases that need them land.

| Folder | Purpose |
|--------|---------|
| `src/pipeline` | Discovery, evidence collection and coding |
| `src/app` | The web application |
| `src/gate` | The deterministic gate |
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
