#!/usr/bin/env bash
# Outside port check for the PRISM VM (plan 07-12b): from this machine, TCP 22 and 443 must connect
# and none of a sample of other ports may. Port 80 stays closed (Caddy uses TLS-ALPN-01 on 443).
#   bash scripts/vm-port-check.sh <host>
# Prints one line per port and `PORTS host=<host> open_ok=<bool> closed_ok=<bool>`; exits non-zero
# unless both are true. Uses macOS/BSD nc (`-G` is the connect timeout).
set -u
HOST=${1:?usage: vm-port-check.sh <host>}
OPEN="22 443"
CLOSED="21 25 80 2375 2376 3000 5432 8080 8443 9000"

open_ok=true closed_ok=true
for p in $OPEN; do
  if nc -z -G 5 -w 5 "$HOST" "$p" 2>/dev/null; then echo "port $p open (want open)"; else echo "port $p closed (want open)"; open_ok=false; fi
done
for p in $CLOSED; do
  if nc -z -G 5 -w 5 "$HOST" "$p" 2>/dev/null; then echo "port $p open (want closed)"; closed_ok=false; else echo "port $p closed (want closed)"; fi
done
echo "PORTS host=$HOST open_ok=$open_ok closed_ok=$closed_ok"
[ "$open_ok" = true ] && [ "$closed_ok" = true ]
