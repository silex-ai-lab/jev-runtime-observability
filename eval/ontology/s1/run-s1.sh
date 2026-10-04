#!/usr/bin/env bash
# Stage-1 run (plan R3), fail-closed: verify seal + inputs; sanitize; compute both statistics; require exact agreement; verify the seal again.
# No judge.
set -euo pipefail
cd "$(dirname "$0")/../../.."
SEAL="${SEAL:-$PWD/../silex-mockup/logs/2026-10-04_ONTOLOGY_S1_SEAL_HASHES.txt}"
INPUTS="${INPUTS:-runs/onto-s1-INPUT-MANIFEST.sha256}"
IN=runs/onto-s1-input; OUT=runs/onto-s1-stats; FZ=eval/ontology/v2/frozen
seal() {
  (cd .. && shasum -a 256 -c --quiet "$SEAL") || { echo "SEAL MISMATCH: aborting" >&2; return 1; }
  shasum -a 256 -c --quiet "$INPUTS" || { echo "INPUT MISMATCH: aborting" >&2; return 1; }
  echo "seal and inputs verified"
}
seal || exit 1
node eval/ontology/pr/sanitize.ts --in $IN/observations.jsonl --out $IN/observations.sanitized.jsonl
mkdir -p $OUT
node eval/ontology/s1/stats-s1.ts --sanitized $IN/observations.sanitized.jsonl --labels $IN/labels.jsonl --labels-pr $IN/labels-pr.jsonl --out $OUT/stats-s1.json
python3 eval/ontology/s1/recheck_s1.py --raw-observations $IN/observations.jsonl --labels $IN/labels.jsonl --labels-pr $IN/labels-pr.jsonl \
  --snapshot $FZ/snapshot.json --manifest $FZ/tool-manifest-v2.json --binding $FZ/binding-v2.json --out $OUT/recheck-s1.json
node eval/ontology/s1/compare-outputs.mjs $OUT/stats-s1.json $OUT/recheck-s1.json
seal || exit 1
shasum -a 256 $OUT/*.json
