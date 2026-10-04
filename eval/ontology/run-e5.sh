#!/usr/bin/env bash
# E5 (plan § E5): Kev-0.8B-ft (primary) and released (secondary) × arms A0–A3 on every call of the 2 092 AgentDojo runs.
set -euo pipefail
cd "$(dirname "$0")/../.."
FT_URL="${FT_URL:-http://127.0.0.1:8021}"; REL_URL="${REL_URL:-http://127.0.0.1:8022}"
FT_RUN="$PWD/runs/ft-kev-0.8b-2026-09-28/model"
run_model() {
  for pass in 0 1 2 3; do
    for a in A0 A1 A2 A3; do
      node eval/run/run.ts --judge "$1" --expect "$2" --label "$a" --splits test --items runs/onto-e5-items/items-$a.jsonl --out "$3"
    done
    [ "$pass" = 3 ] && break
    for a in A0 A1 A2 A3; do node eval/ontology/retry-failed.ts "$3/predictions-$a.jsonl"; done
  done
}
run_model "$FT_URL" "$FT_RUN" runs/onto-e5-kev-0.8b-ft
run_model "$REL_URL" jaredpalmer/kev-0.8b runs/onto-e5-kev-0.8b
