#!/usr/bin/env bash
# E-PR run (plan R3), fail-closed: verify seal + inputs + judge fingerprint; sanitize; build the complete judge-item universe; score it with
# Kev-0.8B-ft (v1 failed-call procedure); verify the judge again; compute both statistics; require exact agreement; verify the seal again.
set -euo pipefail
cd "$(dirname "$0")/../../.."
SEAL="${SEAL:-$PWD/../silex-mockup/logs/2026-10-04_ONTOLOGY_PR_SEAL_HASHES.txt}"
INPUTS="${INPUTS:-runs/onto-pr-INPUT-MANIFEST.sha256}"
FT_URL="${FT_URL:-http://127.0.0.1:8021}"; FT_RUN="$PWD/runs/ft-kev-0.8b-2026-09-28/model"
SB=../silex-mockup/swm/experiments/ontology-value/pr/source-binding.json
seal() {
  (cd .. && shasum -a 256 -c --quiet "$SEAL") || { echo "SEAL MISMATCH: aborting" >&2; return 1; }
  shasum -a 256 -c --quiet "$INPUTS" || { echo "INPUT MISMATCH: aborting" >&2; return 1; }
  echo "seal and inputs verified"
}
judge_ok() { eval/ontology/v2/judge-fingerprint.sh --check eval/ontology/v2/frozen/judge-fingerprint.txt || { echo "JUDGE MISMATCH: aborting" >&2; return 1; }; }
seal || exit 1
judge_ok || exit 1
node eval/ontology/pr/sanitize.ts --in runs/onto-pr-input/observations.jsonl --out runs/onto-pr-input/observations.sanitized.jsonl
node eval/ontology/pr/judge-items.ts --obs runs/onto-pr-input/observations.sanitized.jsonl --out runs/onto-pr-items
for pass in 0 1 2 3; do
  node eval/run/run.ts --judge "$FT_URL" --expect "$FT_RUN" --label pr --splits test --items runs/onto-pr-items/items-pr.jsonl --out runs/onto-pr-judge
  [ "$pass" = 3 ] && break
  node eval/ontology/retry-failed.ts runs/onto-pr-judge/predictions-pr.jsonl
done
judge_ok || exit 1
seal || exit 1
mkdir -p runs/onto-pr-stats
node eval/ontology/pr/stats-pr.ts --sanitized runs/onto-pr-input/observations.sanitized.jsonl --labels runs/onto-pr-input/labels.jsonl \
  --labels-pr runs/onto-pr-input/labels-pr.jsonl --predictions runs/onto-pr-judge/predictions-pr.jsonl --source-binding "$SB" --out runs/onto-pr-stats/stats-pr.json
python3 eval/ontology/pr/recheck_pr.py --raw-observations runs/onto-pr-input/observations.jsonl --labels runs/onto-pr-input/labels.jsonl \
  --labels-pr runs/onto-pr-input/labels-pr.jsonl --predictions runs/onto-pr-judge/predictions-pr.jsonl \
  --snapshot eval/ontology/v2/frozen/snapshot.json --manifest eval/ontology/v2/frozen/tool-manifest-v2.json --binding eval/ontology/v2/frozen/binding-v2.json \
  --source-binding "$SB" --out runs/onto-pr-stats/recheck-pr.json
node eval/ontology/pr/compare-outputs.mjs runs/onto-pr-stats/stats-pr.json runs/onto-pr-stats/recheck-pr.json
seal || exit 1
shasum -a 256 runs/onto-pr-stats/*.json runs/onto-pr-items/items-pr.jsonl runs/onto-pr-judge/predictions-pr.jsonl
