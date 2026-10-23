#!/usr/bin/env bash
# Open TCP 443 on prism-app's security list with one guarded ingress rule (plan 07-12b, W1 guard).
#
#   bash scripts/oci-ingress.sh apply   save the ingress list to before.json, add one stateful TCP 443
#                                       rule from 0.0.0.0/0, re-read, and require after = before + 1,
#                                       every saved rule present and TCP 22 present; on any mismatch
#                                       write before.json back and exit non-zero
#   bash scripts/oci-ingress.sh check   read-only: the same fields from the saved state and the live list
#
# Uses the oci CLI with ~/.oci/config. Identifiers live only in shell variables and in mode-600 files
# inside a mode-700 state directory (~/temp-storage/scratch/prism/<YYYY-MM-DD>-oci-ingress); nothing
# printed contains one. oci's own stderr goes to a file there, because its errors can name resources.
set -euo pipefail
umask 077

MODE=${1:-}
case "$MODE" in apply|check) ;; *) echo "usage: oci-ingress.sh apply|check" >&2; exit 64 ;; esac

VM_NAME=${PRISM_VM_NAME:-prism-app}
CONFIG=${OCI_CLI_CONFIG_FILE:-$HOME/.oci/config}
PROFILE=${OCI_CLI_PROFILE:-DEFAULT}
STATE_ROOT=${PRISM_OCI_STATE_ROOT:-$HOME/temp-storage/scratch/prism}

mkdir -p "$STATE_ROOT"
if [ "$MODE" = apply ]; then
  SD="$STATE_ROOT/$(date +%Y-%m-%d)-oci-ingress"
  mkdir -p "$SD"
  chmod 700 "$SD"
else
  SD=$(ls -d "$STATE_ROOT"/*-oci-ingress 2>/dev/null | sort | tail -1 || true)
  [ -n "$SD" ] && [ -f "$SD/before.json" ] && [ -f "$SD/apply-result" ] || { echo "OCI_INGRESS no-saved-state"; exit 1; }
fi
ERR="$SD/oci-stderr.log"

# All JSON work in one node helper: j <op> [args]. Reads JSON on stdin where noted.
j() {
  node -e '
const fs = require("node:fs");
const [op, ...args] = process.argv.slice(1);
const stdin = () => JSON.parse(fs.readFileSync(0, "utf8"));
const camel = (v) => Array.isArray(v) ? v.map(camel) : v && typeof v === "object"
  ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), camel(x)])) : v;
// Comparable form: camelCase, nulls dropped, keys sorted.
const norm = (v) => Array.isArray(v) ? v.map(norm) : v && typeof v === "object"
  ? Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== null).map((k) => [k, norm(v[k])])) : v;
const key = (r) => JSON.stringify(norm(camel(r)));
const covers = (r, port, from) => {
  r = camel(r);
  if (r.protocol !== "6" || (from && r.source !== from)) return false;
  const d = r.tcpOptions && r.tcpOptions.destinationPortRange;
  return !d || (d.min <= port && port <= d.max);
};
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const out = (s) => process.stdout.write(s + "\n");
switch (op) {
  case "instance": { // single RUNNING instance with this display name
    const d = stdin().data || [];
    const m = d.filter((i) => i["display-name"] === args[0] && i["lifecycle-state"] === "RUNNING");
    if (m.length !== 1) { process.stderr.write(`expected 1 running instance named ${args[0]}, found ${m.length}\n`); process.exit(1); }
    out(m[0].id); break;
  }
  case "subnet": { const d = stdin().data || []; if (d.length !== 1) { process.stderr.write(`expected 1 VNIC, found ${d.length}\n`); process.exit(1); } out(d[0]["subnet-id"]); break; }
  case "seclist": { const ids = stdin().data["security-list-ids"] || []; if (ids.length !== 1) { process.stderr.write(`expected 1 security list on the subnet, found ${ids.length}\n`); process.exit(1); } out(ids[0]); break; }
  case "ingress": out(JSON.stringify(camel(stdin().data["ingress-security-rules"] || []))); break;
  case "has443": out(read(args[0]).some((r) => covers(r, 443, "0.0.0.0/0")) ? "yes" : "no"); break;
  case "add443": {
    const rules = read(args[0]);
    rules.push({ description: "PRISM HTTPS (Caddy, plan 07-12b)", isStateless: false, protocol: "6", source: "0.0.0.0/0",
      sourceType: "CIDR_BLOCK", tcpOptions: { destinationPortRange: { min: 443, max: 443 } } });
    out(JSON.stringify(rules)); break;
  }
  case "same": out(JSON.stringify(read(args[0]).map(key)) === JSON.stringify(read(args[1]).map(key)) ? "yes" : "no"); break;
  case "report": { // report <before> <after> <added 1|0>: prints the fields, exits 1 unless all hold
    const b = read(args[0]), a = read(args[1]), added = Number(args[2]);
    const ak = new Set(a.map(key));
    const saved = b.every((r) => ak.has(key(r)));
    const p22 = a.some((r) => covers(r, 22)), p443 = a.some((r) => covers(r, 443, "0.0.0.0/0"));
    out(`OCI_INGRESS ${added ? "" : "already-open "}before=${b.length} after=${a.length} saved_rules_present=${saved} port22=${p22 ? "present" : "missing"} port443=${p443 ? "present" : "missing"}`);
    process.exit(a.length === b.length + added && saved && p22 && p443 ? 0 : 1);
  }
  default: process.stderr.write("unknown op " + op + "\n"); process.exit(2);
}' "$@"
}

ocij() { # run oci, stdout to caller, stderr to the private log; on failure name the subcommand only
  if ! oci "$@" 2>>"$ERR"; then echo "OCI_INGRESS oci-failed cmd='$1 $2 $3' (stderr in state dir)" >&2; return 1; fi
}

TENANCY=$(awk -v p="[$PROFILE]" '$0==p{f=1;next} /^\[/{f=0} f && /^tenancy *=/{sub(/^tenancy *= */,"");print;exit}' "$CONFIG")
[ -n "$TENANCY" ] || { echo "OCI_INGRESS no tenancy in the $PROFILE profile" >&2; exit 1; }

INSTANCE=$(ocij compute instance list --compartment-id "$TENANCY" --display-name "$VM_NAME" --all | j instance "$VM_NAME")
SUBNET=$(ocij compute instance list-vnics --instance-id "$INSTANCE" | j subnet)
SECLIST=$(ocij network subnet get --subnet-id "$SUBNET" | j seclist)

read_ingress() { ocij network security-list get --security-list-id "$SECLIST" | j ingress > "$1"; }

if [ "$MODE" = check ]; then
  read_ingress "$SD/current.json"
  # apply-result says whether apply added the rule (+1 expected) or found it already open (unchanged expected)
  if [ "$(cat "$SD/apply-result")" = added ]; then n=1; else n=0; fi
  j report "$SD/before.json" "$SD/current.json" "$n"
  exit $?
fi

read_ingress "$SD/now.json"
if [ "$(j has443 "$SD/now.json")" = yes ]; then
  # Nothing to add. Keep the list as the baseline so check can prove it stays unchanged.
  mv "$SD/now.json" "$SD/before.json"
  echo already-open > "$SD/apply-result"
  j report "$SD/before.json" "$SD/before.json" 0
  exit $?
fi

mv "$SD/now.json" "$SD/before.json"
j add443 "$SD/before.json" > "$SD/desired.json"

restore() {
  ocij network security-list update --security-list-id "$SECLIST" \
    --ingress-security-rules "file://$SD/before.json" --force > /dev/null || true
  read_ingress "$SD/restored.json" || true
  if [ "$(j same "$SD/before.json" "$SD/restored.json")" = yes ]; then
    echo "OCI_INGRESS restored"; exit 1
  fi
  echo "OCI_INGRESS restore-failed: the security list does not match before.json; fix it by hand now" >&2
  exit 2
}

ocij network security-list update --security-list-id "$SECLIST" \
  --ingress-security-rules "file://$SD/desired.json" --force > /dev/null || restore
read_ingress "$SD/after.json" || restore
j report "$SD/before.json" "$SD/after.json" 1 || restore
echo added > "$SD/apply-result"
