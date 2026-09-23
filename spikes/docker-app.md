# Docker app spike (FND-07)

Numbers only. No project URL, key or raw output; the image built and ran, its
results are the record below.

```json
{
  "record": "docker-app",
  "status": "final",
  "updated": "2026-09-23",
  "base_image": {
    "tag": "node:24.21.0-trixie-slim",
    "digest": "sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe"
  },
  "image_bytes": 299381271,
  "build_seconds": 33,
  "smoke": {
    "sign_in_200": true,
    "seeded_sign_in": true,
    "session_page": true,
    "pdf_magic": true,
    "sign_up_disabled": true,
    "gate_in_image": true,
    "non_root": true,
    "boot_fails_without_secret": true
  },
  "verifier": {
    "kind": "ci",
    "run_id": "35867504963"
  },
  "versions": {
    "node": "v24.21.0",
    "python": "Python 3.13.5"
  },
  "takumi_fallback_needed": false
}
```

## Commentary

- Base image resolved once by tag and digest against the Docker Hub registry API (an OCI image index for `node:24.21.0-trixie-slim`); both `FROM` lines in the Dockerfile pin the same `tag@digest`, so the build and runtime stages share one base family (research Pitfall 12).
- Image size 299,381,271 bytes (about 285 MiB); build completed in 33 seconds on the CI runner.
- All 8 smoke booleans true on the first CI run: no takumi or better-sqlite3 fallback was needed (research Pitfall 12 did not trigger; the D-17 contingency was not applied).
- `pdf_magic: true`: the server route rendered a real PDF inside the container after a SQLite read, proving the native module transferred cleanly to `linux/amd64` with no build-stage compiler toolchain added.
- `gate_in_image: true`: the vendored Python gate, run through `/opt/gate/bin/python` against the conformance fixture's `baseRecord`, returned `PASS` status and exit 0 inside a fresh, short-lived container (research Pitfall 4).
- `boot_fails_without_secret: true`: the built server, started with `PRISM_DATA_DIR` set but no `BETTER_AUTH_SECRET`, exited non-zero within the 20-second timeout rather than serving.
- `non_root: true`: `docker exec ... id -u` inside the running container returned a non-zero uid (the image's built-in `node` user).
- Verifier: CI run id 35867504963 on the public remote, `docker-smoke` job, concluded `success`.
- No local Docker daemon was used to verify this record (research Pitfall 13): the local daemon on this machine remains unreachable, and CI is the verifier of record, per the 01-09 decision (`docker=ci`). The same `scripts/docker-smoke.sh` runs unchanged when a local daemon does answer.
