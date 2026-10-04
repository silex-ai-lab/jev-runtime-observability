#!/usr/bin/env bash
# v2 runs (plan § B, V5): Kev A0 on every held-out call, then stats-v2.ts and the independent recheck_v2.py.
# Judges must already be served: Kev-0.8B-ft on $FT_URL (primary), released Kev-0.8B on $REL_URL (secondary). Never :8009/:8010.
set -euo pipefail
cd "$(dirname "$0")/../../.."
FT_URL="${FT_URL:-http://127.0.0.1:8021}"; REL_URL="${REL_URL:-http://127.0.0.1:8022}"
FT_RUN="$PWD/runs/ft-kev-0.8b-2026-09-28/model"
node eval/ontology/arms.ts --exp e5 --obs runs/onto-v2-input/observations.jsonl --out runs/onto-v2-items
judge() {  # $1 url  $2 expect  $3 outdir   (A0 only; failed-call procedure as v1, at most 3 retry passes)
  for pass in 0 1 2 3; do
    node eval/run/run.ts --judge "$1" --expect "$2" --label A0 --splits test --items runs/onto-v2-items/items-A0.jsonl --out "$3"
    [ "$pass" = 3 ] && break
    node eval/ontology/retry-failed.ts "$3/predictions-A0.jsonl"
  done
}
judge "$FT_URL" "$FT_RUN" runs/onto-v2-kev-0.8b-ft
judge "$REL_URL" jaredpalmer/kev-0.8b runs/onto-v2-kev-0.8b
mkdir -p runs/onto-v2-stats
for m in kev-0.8b-ft kev-0.8b; do
  node eval/ontology/v2/stats-v2.ts --input runs/onto-v2-input --kev runs/onto-v2-$m/predictions-A0.jsonl --out runs/onto-v2-stats/stats-$m.json
  python3 eval/ontology/v2/recheck_v2.py --observations runs/onto-v2-input/observations.jsonl --labels runs/onto-v2-input/labels.jsonl \
    --snapshot eval/ontology/v2/frozen/snapshot.json --manifest eval/ontology/v2/frozen/tool-manifest-v2.json --binding eval/ontology/v2/frozen/binding-v2.json \
    --kev runs/onto-v2-$m/predictions-A0.jsonl --out runs/onto-v2-stats/recheck-$m.json
done
