#!/usr/bin/env bash
# Build the Docker image and prove the walking skeleton works inside it
# (FND-07, research Pitfalls 12 and 13). Runs the same way locally (when a
# Docker daemon answers) and in CI, which is the verifier of record.
#
#   bash scripts/docker-smoke.sh [--results <path>]
#
# Writes a JSON results file (booleans plus image/build facts) to --results,
# or to a temp file (path printed on stdout) when --results is omitted.
# Exits 0 only when every smoke assertion holds; non-zero and a FATAL line
# on stderr otherwise. Never prints a secret, an email or a page of app
# output beyond what the smoke checks themselves already print.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RESULTS_PATH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --results)
      RESULTS_PATH="$2"
      shift 2
      ;;
    *)
      echo "usage: docker-smoke.sh [--results <path>]" >&2
      exit 2
      ;;
  esac
done

RUN_ID="$$-$(date +%s)"
IMAGE_TAG="prism-docker-smoke:${RUN_ID}"
CONTAINER_NAME="prism-docker-smoke-${RUN_ID}"
DATA_DIR=""
TMP_FILES=()
CLEANED_UP=0

cleanup() {
  if [[ "$CLEANED_UP" -eq 1 ]]; then
    return
  fi
  CLEANED_UP=1
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  if [[ -n "$DATA_DIR" && -d "$DATA_DIR" ]]; then
    rm -rf "$DATA_DIR" || true
  fi
  for f in "${TMP_FILES[@]:-}"; do
    [[ -n "$f" && -f "$f" ]] && rm -f "$f"
  done
}
trap cleanup EXIT

log() {
  echo "[docker-smoke] $*" >&2
}

fatal() {
  echo "[docker-smoke] FATAL: $*" >&2
  exit 1
}

rand_hex() {
  node -e "process.stdout.write(require('node:crypto').randomBytes(${1}).toString('hex'))"
}

free_port() {
  node -e "
    const net = require('node:net');
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => process.stdout.write(String(port)));
    });
  "
}

# ---- 1. Build ---------------------------------------------------------
log "building ${IMAGE_TAG} from ${ROOT}"
BUILD_START=$SECONDS
docker build -t "$IMAGE_TAG" "$ROOT"
BUILD_SECONDS=$((SECONDS - BUILD_START))
IMAGE_BYTES=$(docker image inspect "$IMAGE_TAG" --format '{{.Size}}')

BASE_REF=$(grep -m1 -iE '^\s*FROM\s' Dockerfile | sed -E 's/^\s*FROM\s+//i' | sed -E 's/\s+AS\s+.*$//i' | tr -d '\r')
BASE_TAG="${BASE_REF%%@*}"
BASE_DIGEST=""
if [[ "$BASE_REF" == *"@"* ]]; then
  BASE_DIGEST="${BASE_REF#*@}"
fi
log "base image ${BASE_TAG} @ ${BASE_DIGEST}; built in ${BUILD_SECONDS}s, ${IMAGE_BYTES} bytes"

# ---- 2. Seed an account on the host, outside the repo ------------------
DATA_DIR=$(mktemp -d "${TMPDIR:-/tmp}/prism-docker-smoke-data.XXXXXX")
SEED_SECRET=$(rand_hex 32)
SMOKE_EMAIL="smoke-$(rand_hex 4)@example.test"
SMOKE_PASSWORD=$(rand_hex 16)

log "seeding an account into ${DATA_DIR} (host-side, outside the repo)"
PRISM_DATA_DIR="$DATA_DIR" BETTER_AUTH_SECRET="$SEED_SECRET" \
  node src/app/server/seed-account.ts --email "$SMOKE_EMAIL" --role admin --password "$SMOKE_PASSWORD" \
  || fatal "host-side seed script failed"

# The container's node user must be able to open and extend the SQLite files
# the host just created.
chmod -R a+rwX "$DATA_DIR"

# ---- 3. Negative case: no BETTER_AUTH_SECRET must refuse to boot -------
log "negative case: starting the image with no BETTER_AUTH_SECRET"
set +e
timeout 20 docker run --rm \
  -e PRISM_DATA_DIR=/data \
  -v "${DATA_DIR}:/data" \
  "$IMAGE_TAG" >/tmp/prism-docker-smoke-negative.log 2>&1
NEG_EXIT=$?
set -e
BOOT_FAILS_WITHOUT_SECRET=false
if [[ "$NEG_EXIT" -ne 0 && "$NEG_EXIT" -ne 124 ]]; then
  BOOT_FAILS_WITHOUT_SECRET=true
else
  cat /tmp/prism-docker-smoke-negative.log >&2 || true
  fatal "expected a non-zero, non-timeout exit with no BETTER_AUTH_SECRET (got ${NEG_EXIT})"
fi
rm -f /tmp/prism-docker-smoke-negative.log

# ---- 4. Run detached with a mapped loopback address ---------------------
HOST_PORT=$(free_port)
BASE_URL="http://127.0.0.1:${HOST_PORT}"
log "starting ${CONTAINER_NAME} on ${BASE_URL}"
docker run -d --name "$CONTAINER_NAME" \
  -p "127.0.0.1:${HOST_PORT}:3000" \
  -e BETTER_AUTH_SECRET="$SEED_SECRET" \
  -e BETTER_AUTH_URL="$BASE_URL" \
  -e TRUSTED_ORIGINS="$BASE_URL" \
  -v "${DATA_DIR}:/data" \
  "$IMAGE_TAG" >/dev/null

UP=false
DEADLINE=$((SECONDS + 60))
while [[ $SECONDS -lt $DEADLINE ]]; do
  if curl -fsS -o /dev/null "${BASE_URL}/sign-in"; then
    UP=true
    break
  fi
  sleep 1
done
if [[ "$UP" != true ]]; then
  docker logs "$CONTAINER_NAME" >&2 || true
  fatal "the container never answered GET /sign-in within 60 seconds"
fi

# ---- 5. app-smoke.mjs against the running container ---------------------
SMOKE_OUT=$(mktemp "${TMPDIR:-/tmp}/prism-docker-smoke-app.XXXXXX")
TMP_FILES+=("$SMOKE_OUT")
set +e
node scripts/app-smoke.mjs --base "$BASE_URL" --email "$SMOKE_EMAIL" --password "$SMOKE_PASSWORD" >"$SMOKE_OUT" 2>&1
SMOKE_EXIT=$?
set -e
cat "$SMOKE_OUT" >&2

smoke_passed() {
  grep -qF "PASS $1" "$SMOKE_OUT"
}

SIGN_IN_200=false
smoke_passed "GET /sign-in returns 200" && SIGN_IN_200=true
SIGN_UP_DISABLED=false
smoke_passed "public sign-up refused with EMAIL_PASSWORD_SIGN_UP_DISABLED" && SIGN_UP_DISABLED=true
SEEDED_SIGN_IN=false
smoke_passed "seeded sign-in returns 200" && SEEDED_SIGN_IN=true
SESSION_PAGE=false
smoke_passed "GET / with a session shows the signed-in email" && SESSION_PAGE=true
PDF_MAGIC=false
smoke_passed "PDF starts with %PDF-" && PDF_MAGIC=true

if [[ "$SMOKE_EXIT" -ne 0 ]]; then
  fatal "scripts/app-smoke.mjs --base reported at least one failure against the running container"
fi

# ---- 6. non-root check ---------------------------------------------------
CONTAINER_UID=$(docker exec "$CONTAINER_NAME" id -u)
NON_ROOT=false
if [[ "$CONTAINER_UID" != "0" ]]; then
  NON_ROOT=true
else
  fatal "the container is running as uid 0"
fi

# ---- 7. the vendored gate, run inside the image --------------------------
BASE_RECORD_FILE=$(mktemp "${TMPDIR:-/tmp}/prism-docker-smoke-record.XXXXXX.json")
TMP_FILES+=("$BASE_RECORD_FILE")
node -e "
  const fs = require('node:fs');
  const fixture = JSON.parse(fs.readFileSync('vendor/ai-output-to-value/tests/fixtures/claim-gate-conformance.json', 'utf8'));
  fs.writeFileSync(process.argv[1], JSON.stringify(fixture.baseRecord));
" "$BASE_RECORD_FILE"
chmod 0644 "$BASE_RECORD_FILE"

set +e
GATE_OUT=$(docker run --rm \
  -v "${BASE_RECORD_FILE}:/tmp/base-record.json:ro" \
  --entrypoint /opt/gate/bin/python \
  "$IMAGE_TAG" \
  vendor/ai-output-to-value/scripts/claim_gate.py /tmp/base-record.json --json)
GATE_EXIT=$?
set -e
GATE_STATUS=$(printf '%s' "$GATE_OUT" | node -e "
  let d = '';
  process.stdin.on('data', (c) => (d += c));
  process.stdin.on('end', () => {
    try {
      process.stdout.write(JSON.parse(d).status || '');
    } catch {
      process.stdout.write('');
    }
  });
")
GATE_IN_IMAGE=false
if [[ "$GATE_EXIT" -eq 0 && "$GATE_STATUS" == "PASS" ]]; then
  GATE_IN_IMAGE=true
else
  echo "$GATE_OUT" >&2
  fatal "the vendored gate did not return PASS for the conformance base record inside the image (exit ${GATE_EXIT}, status ${GATE_STATUS})"
fi

# ---- 8. versions and results ---------------------------------------------
NODE_VERSION=$(docker run --rm --entrypoint node "$IMAGE_TAG" --version | tr -d '\r\n')
PYTHON_VERSION=$(docker run --rm --entrypoint /opt/gate/bin/python "$IMAGE_TAG" --version 2>&1 | tr -d '\r\n')

VERIFIER_KIND="local"
if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  VERIFIER_KIND="ci"
fi
VERIFIER_RUN_ID="${GITHUB_RUN_ID:-local-${RUN_ID}}"

if [[ -z "$RESULTS_PATH" ]]; then
  RESULTS_PATH=$(mktemp "${TMPDIR:-/tmp}/prism-docker-smoke-results.XXXXXX.json")
fi

DS_BASE_TAG="$BASE_TAG" DS_BASE_DIGEST="$BASE_DIGEST" DS_IMAGE_BYTES="$IMAGE_BYTES" DS_BUILD_SECONDS="$BUILD_SECONDS" \
DS_SIGN_IN_200="$SIGN_IN_200" DS_SEEDED_SIGN_IN="$SEEDED_SIGN_IN" DS_SESSION_PAGE="$SESSION_PAGE" DS_PDF_MAGIC="$PDF_MAGIC" \
DS_SIGN_UP_DISABLED="$SIGN_UP_DISABLED" DS_GATE_IN_IMAGE="$GATE_IN_IMAGE" DS_NON_ROOT="$NON_ROOT" \
DS_BOOT_FAILS="$BOOT_FAILS_WITHOUT_SECRET" DS_VERIFIER_KIND="$VERIFIER_KIND" DS_VERIFIER_RUN_ID="$VERIFIER_RUN_ID" \
DS_NODE_VERSION="$NODE_VERSION" DS_PYTHON_VERSION="$PYTHON_VERSION" \
node -e "
  const e = process.env;
  const b = (v) => v === 'true';
  const out = {
    record: 'docker-app',
    generated_at: new Date().toISOString(),
    base_image: { tag: e.DS_BASE_TAG, digest: e.DS_BASE_DIGEST },
    image_bytes: Number(e.DS_IMAGE_BYTES),
    build_seconds: Number(e.DS_BUILD_SECONDS),
    smoke: {
      sign_in_200: b(e.DS_SIGN_IN_200),
      seeded_sign_in: b(e.DS_SEEDED_SIGN_IN),
      session_page: b(e.DS_SESSION_PAGE),
      pdf_magic: b(e.DS_PDF_MAGIC),
      sign_up_disabled: b(e.DS_SIGN_UP_DISABLED),
      gate_in_image: b(e.DS_GATE_IN_IMAGE),
      non_root: b(e.DS_NON_ROOT),
      boot_fails_without_secret: b(e.DS_BOOT_FAILS),
    },
    verifier: { kind: e.DS_VERIFIER_KIND, run_id: e.DS_VERIFIER_RUN_ID },
    versions: { node: e.DS_NODE_VERSION, python: e.DS_PYTHON_VERSION },
  };
  require('node:fs').writeFileSync(process.argv[1], JSON.stringify(out, null, 2) + '\n');
" "$RESULTS_PATH"

log "results written to ${RESULTS_PATH}"
cat "$RESULTS_PATH" >&2

ALL_TRUE=true
for key in "$SIGN_IN_200" "$SEEDED_SIGN_IN" "$SESSION_PAGE" "$PDF_MAGIC" "$SIGN_UP_DISABLED" "$GATE_IN_IMAGE" "$NON_ROOT" "$BOOT_FAILS_WITHOUT_SECRET"; do
  [[ "$key" == "true" ]] || ALL_TRUE=false
done
if [[ "$ALL_TRUE" != true ]]; then
  fatal "not every smoke boolean is true; see ${RESULTS_PATH}"
fi

log "all smoke checks passed"
