#!/usr/bin/env bash
# E-AL run (showcase plan Part A): verify the sealed inputs, then stats-al.ts and the independent recheck_al.py. No judge.
set -euo pipefail
cd "$(dirname "$0")/../../.."
shasum -a 256 -c runs/onto-al-INPUT-MANIFEST.sha256
mkdir -p runs/onto-al-stats
node eval/ontology/al/stats-al.ts --input runs/onto-al-input --out runs/onto-al-stats/stats-al.json
python3 eval/ontology/al/recheck_al.py --observations runs/onto-al-input/observations.jsonl --labels runs/onto-al-input/labels.jsonl \
  --snapshot eval/ontology/v2/frozen/snapshot.json --manifest eval/ontology/v2/frozen/tool-manifest-v2.json --binding eval/ontology/v2/frozen/binding-v2.json \
  --out runs/onto-al-stats/recheck-al.json
