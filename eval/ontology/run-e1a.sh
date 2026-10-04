#!/usr/bin/env bash
# E1a (plan § E1): both Kev-0.8B models × arms A0–A3 on calibration+dev+test, through the unchanged eval/run/run.ts.
# Judges must already be served: ft on $FT_URL, released on $REL_URL (scripts/kev-serve.sh with KEV_RUN/KEV_PORT).
# Failed calls: eval/ontology/retry-failed.ts, at most 3 passes, arm-blind.
set -euo pipefail
cd "$(dirname "$0")/../.."
FT_URL="${FT_URL:-http://127.0.0.1:8021}"; REL_URL="${REL_URL:-http://127.0.0.1:8022}"
FT_RUN="$PWD/runs/ft-kev-0.8b-2026-09-28/model"
run_model() {  # $1 url  $2 expect  $3 outdir
  for pass in 0 1 2 3; do
    for a in A0 A1 A2 A3; do
      node eval/run/run.ts --judge "$1" --expect "$2" --label "$a" --splits calibration,dev,test --items runs/onto-e1a-items/items-$a.jsonl --out "$3"
    done
    [ "$pass" = 3 ] && break
    for a in A0 A1 A2 A3; do node eval/ontology/retry-failed.ts "$3/predictions-$a.jsonl"; done
  done
}
run_model "$FT_URL" "$FT_RUN" runs/onto-e1a-kev-0.8b-ft
run_model "$REL_URL" jaredpalmer/kev-0.8b runs/onto-e1a-kev-0.8b
