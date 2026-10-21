#!/usr/bin/env bash
# The operation modules live with the site (~/aggregator/server/ops). The router hosts a copy of them in
# lib/xgas/ops, so one quote endpoint knows every venue. This script takes that copy and rebuilds the list the
# Lambda loads (lib/xgas/ops-registry.ts).
#
#   scripts/sync-ops.sh              copy the site's modules in, check each one, rebuild the list
#   scripts/sync-ops.sh --check      check what is already here and rebuild the list, copy nothing
#   scripts/sync-ops.sh --push-arb   also copy this repo's arb.mjs out to the site (the router's copy is the source)
#
# What is copied: every *.mjs in the site's folder except index.mjs (its Express binding), arb.mjs / arb.test.mjs
# (written here) and files that start with an underscore (somebody's work in progress). A module that does not
# load, or cannot be bundled for the Lambda, is left out of the list and named, so one bad file never takes the
# others with it. Nothing here deploys anything.
set -euo pipefail

SRC="${OPS_SRC:-$HOME/aggregator/server/ops}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DST="$ROOT/lib/xgas/ops"
[ -d /opt/homebrew/opt/node@22/bin ] && export PATH="/opt/homebrew/opt/node@22/bin:$PATH"

MODE="sync"
PUSH_ARB=0
for arg in "$@"; do
  case "$arg" in
    --check) MODE="check" ;;
    --push-arb) PUSH_ARB=1 ;;
    *) echo "unknown option $arg" >&2; exit 2 ;;
  esac
done

mkdir -p "$DST"
if [ ! -d "$DST/node_modules/viem" ]; then
  echo "installing the modules' one dependency (viem) in lib/xgas/ops"
  (cd "$DST" && npm ci --ignore-scripts --no-audit --no-fund >/dev/null)
fi

if [ "$MODE" = "sync" ]; then
  if [ ! -d "$SRC" ]; then echo "no site modules at $SRC (set OPS_SRC)" >&2; exit 1; fi
  for f in "$SRC"/*.mjs; do
    name="$(basename "$f")"
    case "$name" in index.mjs|arb.mjs|arb.test.mjs|_*) continue ;; esac
    if ! cmp -s "$f" "$DST/$name"; then cp "$f" "$DST/$name"; echo "copied $name"; fi
  done
fi

node "$ROOT/scripts/ops-registry.mjs" "$DST" "$ROOT/lib/xgas/ops-registry.ts" "$SRC/index.mjs"

if [ "$PUSH_ARB" = "1" ]; then
  if [ ! -d "$SRC" ]; then echo "no site folder at $SRC to copy arb.mjs to" >&2; exit 1; fi
  for name in arb.mjs arb.test.mjs; do
    [ -f "$DST/$name" ] || continue
    if ! cmp -s "$DST/$name" "$SRC/$name"; then cp "$DST/$name" "$SRC/$name"; echo "pushed $name to the site"; fi
  done
fi
