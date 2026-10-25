#!/usr/bin/env bash
# PRISM deploy on the Oracle A1 VM prism-app (plan 07-12c). Runs ON the VM, with sudo:
#   sudo bash /srv/prism/src-<sha7>/scripts/vm-deploy.sh <command> [args]
#
#   secrets            data and secrets directories (uid 10001, mode 700); generates the
#                      better-auth secret and the fixture-only pseudonym key once, on the VM
#   build <sha7>       docker build -t prism-app:<sha7> /srv/prism/src-<sha7>
#   check <sha7>       checks that image before it serves; prints one CHECK line
#   up <sha7>          (re)starts prism-app on that image and starts or reloads prism-caddy;
#                      also the rollback: `up <older sha7>`
#   caddy <sha7>       that tree's Caddyfile and prism-caddy only (the findings site); the app untouched
#   op <node args>     node <args> in a one-off container from the current image, with the
#                      rsynced tracked tree at /app/ops (operator scripts: seed, backup, views)
#   status             the prism-* containers
#   session-ip-check   booleans about the newest session's stored address, never the address
#
# Secrets are never printed, never on argv: they are generated here into mode-600 files and
# reach the containers through --env-file or a read-only mount. Firewall rules are never saved.
set -euo pipefail

ROOT=/srv/prism
DATA=$ROOT/data
SECRETS=$ROOT/secrets
CADDY_DIR=$ROOT/caddy
FINDINGS=$ROOT/findings
APP_UID=10001
NET=prism-net
CADDY_IP=172.30.0.2
URL=https://prism.helenkwok.dev
# Docker Official Image, pinned by index digest after the 07-12c spike (07-12c-PROVENANCE.md).
CADDY_IMAGE=caddy:2.11.7-alpine@sha256:eb4d35b7452d1ab6171fbdbe8d9275b2301dad6dad92115d91e19fb9b24d510f

die() { echo "vm-deploy: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run with sudo"

sha_arg() {
  [[ "${1:-}" =~ ^[0-9a-f]{7,40}$ ]] || die "an explicit commit sha7 is required"
  [ -d "$ROOT/src-$1" ] || die "no source tree at $ROOT/src-$1"
}

ensure_net() {
  # Dynamic addresses come from .128/25 only, so Caddy's fixed .2 is never taken by another container.
  docker network inspect "$NET" >/dev/null 2>&1 ||
    docker network create --subnet 172.30.0.0/24 --ip-range 172.30.0.128/25 --gateway 172.30.0.1 "$NET" >/dev/null
}

current_sha() {
  local t
  t=$(readlink -f "$ROOT/current") || die "no current deployment"
  basename "$t" | sed 's/^src-//'
}

cmd_secrets() {
  install -d -o "$APP_UID" -g "$APP_UID" -m 700 "$DATA" "$SECRETS"
  umask 077
  if [ ! -f "$SECRETS/app-env" ]; then
    # printf is a builtin: the value is on no process argv.
    printf 'BETTER_AUTH_SECRET=%s\n' "$(openssl rand -hex 32)" >"$SECRETS/app-env"
  fi
  if [ ! -f "$SECRETS/pseudonym.key" ]; then
    printf '%s\n' "$(openssl rand -hex 32)" >"$SECRETS/pseudonym.key"
  fi
  chown "$APP_UID:$APP_UID" "$SECRETS/app-env" "$SECRETS/pseudonym.key"
  chmod 600 "$SECRETS/app-env" "$SECRETS/pseudonym.key"
  echo "SECRETS app-env=$(stat -c %a:%u "$SECRETS/app-env") pseudonym.key=$(stat -c %a:%u "$SECRETS/pseudonym.key")"
}

cmd_build() {
  sha_arg "${1:-}"
  # The one uncapped step, on a VM that runs nothing else.
  docker build -t "prism-app:$1" "$ROOT/src-$1"
}

cmd_check() {
  sha_arg "${1:-}"
  local sha=$1 src=$ROOT/src-$1 img=prism-app:$1 out
  docker image inspect "$img" >/dev/null 2>&1 || die "no image $img; run build $sha first"
  ensure_net

  local binding=fail
  docker run --rm --name "prism-check-bind-$$" --user "$APP_UID:$APP_UID" --cpus=1 --memory=512m --network none \
    -v "$src/docker/better-sqlite3:/check/bs3:ro" --entrypoint sh "$img" \
    -c 'cd /app && sha256sum -c "/check/bs3/linux-$(node -p process.arch).sha256"' >/dev/null 2>&1 && binding=ok

  out=$(docker run --rm --name "prism-check-assets-$$" --user "$APP_UID:$APP_UID" --cpus=1 --memory=512m --network none \
    -v "$src/scripts/check-built-assets.mjs:/check/check-built-assets.mjs:ro" -v "$src/src:/check/src:ro" \
    --entrypoint node "$img" /check/check-built-assets.mjs --dist /app/dist --src /check/src 2>&1 || true)
  local api missing
  api=$(sed -n 's/.*iconify_api_refs=\([0-9]*\).*/\1/p' <<<"$out" | head -1)
  missing=$(sed -n 's/.*missing_icon_rules=\([0-9]*\).*/\1/p' <<<"$out" | head -1)

  local uid non_root=fail
  uid=$(docker run --rm --name "prism-check-uid-$$" --user "$APP_UID:$APP_UID" --cpus=0.5 --memory=128m --network none \
    --entrypoint id "$img" -u 2>/dev/null || true)
  [ "$uid" = "$APP_UID" ] && non_root=ok

  local boot=served code
  set +e
  out=$(timeout 30 docker run --rm --name "prism-check-boot-$$" --user "$APP_UID:$APP_UID" --cpus=1 --memory=512m --network none \
    --tmpfs "/data:rw,size=16m,uid=$APP_UID,gid=$APP_UID" "$img" 2>&1)
  code=$?
  set -e
  docker rm -f "prism-check-boot-$$" >/dev/null 2>&1 || true
  if [ "$code" -ne 0 ] && [ "$code" -ne 124 ] && grep -q BETTER_AUTH_SECRET <<<"$out"; then boot=refused; fi

  local gate
  gate=$(docker run --rm --name "prism-check-gate-$$" --user "$APP_UID:$APP_UID" --cpus=1 --memory=512m --network none \
    -v "$src/vendor/ai-output-to-value/tests/fixtures/claim-gate-conformance.json:/check/conformance.json:ro" \
    --entrypoint node "$img" -e '
      const fs = require("node:fs"), cp = require("node:child_process");
      fs.writeFileSync("/tmp/base-record.json", JSON.stringify(JSON.parse(fs.readFileSync("/check/conformance.json", "utf8")).baseRecord));
      const r = cp.spawnSync("/opt/gate/bin/python", ["vendor/ai-output-to-value/scripts/claim_gate.py", "/tmp/base-record.json", "--json"], { encoding: "utf8" });
      let s = "error"; try { s = r.status === 0 ? JSON.parse(r.stdout).status || "none" : `exit-${r.status}`; } catch {}
      process.stdout.write(s);' 2>/dev/null || echo error)

  local outbound
  outbound=$(docker run --rm --name "prism-check-out-$$" --user "$APP_UID:$APP_UID" --cpus=0.5 --memory=256m --network "$NET" \
    --entrypoint node "$img" -e 'fetch("https://example.com").then((r) => process.stdout.write(String(r.status)), () => process.stdout.write("error"))' 2>/dev/null || echo error)

  echo "CHECK binding=$binding iconify_api_refs=${api:-none} missing_icon_rules=${missing:-none} non_root=$non_root boot_without_secret=$boot gate=$gate outbound=$outbound"
  [ "$binding" = ok ] && [ "$api" = 0 ] && [ "$missing" = 0 ] && [ "$non_root" = ok ] &&
    [ "$boot" = refused ] && [ "$gate" = PASS ] && [ "$outbound" = 200 ]
}

cmd_up() {
  sha_arg "${1:-}"
  local sha=$1 img=prism-app:$1
  docker image inspect "$img" >/dev/null 2>&1 || die "no image $img; run build and check first"
  [ -f "$SECRETS/app-env" ] || die "no secrets; run secrets first"
  ensure_net

  docker rm -f prism-app >/dev/null 2>&1 || true
  # PRISM_LIVE_RUNNER is deliberately not set: production never runs the fixture runner.
  docker run -d --name prism-app --user "$APP_UID:$APP_UID" --network "$NET" --restart unless-stopped \
    --cpus=2 --memory=2g --log-driver local \
    -v "$DATA:/data" --env-file "$SECRETS/app-env" \
    -e BETTER_AUTH_URL=$URL -e TRUSTED_ORIGINS=$URL \
    -e PRISM_TRUSTED_PROXY_HEADER=x-forwarded-for -e PRISM_TRUSTED_PROXY_IPS=$CADDY_IP \
    "$img" >/dev/null

  local up=false i
  for i in $(seq 1 60); do
    if docker exec prism-app node -e 'fetch("http://127.0.0.1:3000/sign-in").then((r) => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))' 2>/dev/null; then
      up=true; break
    fi
    sleep 1
  done
  [ "$up" = true ] || { docker logs --tail 20 prism-app >&2 || true; die "prism-app did not answer /sign-in within 60 s"; }

  ln -sfn "$ROOT/src-$sha" "$ROOT/current"
  start_caddy "$sha"
  echo "UP prism-app:$sha caddy=$(docker inspect -f '{{.State.Running}}' prism-caddy)"
}

# Installs that tree's Caddyfile, then reloads prism-caddy, or recreates it when its image or its read-only
# findings mount (plan 06-08) differs. The certificate volumes are kept either way.
start_caddy() {
  install -d -m 755 "$CADDY_DIR"
  install -d -o ubuntu -g ubuntu -m 755 "$FINDINGS" "$FINDINGS/releases"
  install -m 644 "$ROOT/src-$1/deploy/Caddyfile" "$CADDY_DIR/Caddyfile"

  if [ "$(docker inspect -f '{{.State.Running}}' prism-caddy 2>/dev/null)" = true ] &&
    [ "$(docker inspect -f '{{.Config.Image}}' prism-caddy)" = "$CADDY_IMAGE" ] &&
    docker inspect -f '{{range .Mounts}}{{.Destination}} {{end}}' prism-caddy | grep -qw /srv/findings; then
    docker exec prism-caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
  else
    docker rm -f prism-caddy >/dev/null 2>&1 || true
    docker run -d --name prism-caddy --network "$NET" --ip "$CADDY_IP" -p 443:443/tcp \
      --cpus=0.5 --memory=256m --restart unless-stopped --log-driver local \
      -v "$CADDY_DIR:/etc/caddy:ro" -v "$FINDINGS:/srv/findings:ro" -v prism-caddy-data:/data -v prism-caddy-config:/config \
      "$CADDY_IMAGE" >/dev/null
  fi
}

# Findings site only: that tree's Caddyfile and prism-caddy, the app untouched. Run after site/scripts/deploy.mjs
# has copied a build and pointed $FINDINGS/current at it.
cmd_caddy() {
  sha_arg "${1:-}"
  ensure_net
  start_caddy "$1"
  echo "CADDY caddy=$(docker inspect -f '{{.State.Running}}' prism-caddy) findings=$(readlink "$FINDINGS/current" || echo none)"
}

cmd_op() {
  [ $# -gt 0 ] || die "usage: op <node args>"
  local sha
  sha=$(current_sha)
  docker run --rm -i --name "prism-op-$$" --user "$APP_UID:$APP_UID" --network none --cpus=1 --memory=1g \
    -e PRISM_DATA_DIR=/data -v "$DATA:/data" \
    -v "$ROOT/src-$sha:/app/ops:ro" -w /app/ops \
    -v "$SECRETS/pseudonym.key:/run/prism/pseudonym.key:ro" --env-file "$SECRETS/app-env" \
    "prism-app:$sha" node "$@"
}

cmd_status() {
  docker ps -a --filter name=^prism- --format '{{.Names}} {{.Image}} {{.Status}}'
}

# Reads the newest session's address and prints only booleans about it.
SESSION_IP_JS='
const Database = require("better-sqlite3");
const net = require("node:net");
const db = new Database("/data/prism.sqlite", { readonly: true, fileMustExist: true });
const row = db.prepare("SELECT ipAddress FROM session ORDER BY createdAt DESC LIMIT 1").get();
const ip = row?.ipAddress ?? "";
const bl = new net.BlockList();
for (const [a, p] of [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["0.0.0.0", 8], ["192.0.2.0", 24], ["198.51.100.0", 24], ["203.0.113.0", 24]]) bl.addSubnet(a, p, "ipv4");
for (const [a, p] of [["::1", 128], ["fc00::", 7], ["fe80::", 10], ["2001:db8::", 32], ["::", 128]]) bl.addSubnet(a, p, "ipv6");
const v = net.isIP(ip);
const pub = v !== 0 && !bl.check(ip, v === 4 ? "ipv4" : "ipv6");
console.log(`SESSION_IP set=${v !== 0} spoofed=${ip === "203.0.113.9"} proxy_or_gateway=${ip === "172.30.0.2" || ip === "172.30.0.1"} public=${pub}`);
'

cmd_session_ip_check() {
  cmd_op -e "$SESSION_IP_JS"
}

case "${1:-}" in
  secrets) cmd_secrets ;;
  build) shift; cmd_build "$@" ;;
  check) shift; cmd_check "$@" ;;
  up) shift; cmd_up "$@" ;;
  caddy) shift; cmd_caddy "$@" ;;
  op) shift; cmd_op "$@" ;;
  status) cmd_status ;;
  session-ip-check) cmd_session_ip_check ;;
  *) die "usage: vm-deploy.sh secrets|build <sha7>|check <sha7>|up <sha7>|caddy <sha7>|op <node args>|status|session-ip-check" ;;
esac
