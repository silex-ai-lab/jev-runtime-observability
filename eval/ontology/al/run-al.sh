#!/usr/bin/env bash
# E-AL run (showcase plan Part A), fail-closed: verify the seal and the inputs; compute both statistics; require exact agreement;
# generate the card data from the verified outputs with the sealed generator; verify the seal again. No judge.
set -euo pipefail
cd "$(dirname "$0")/../../.."
SEAL="${SEAL:-../silex-mockup/logs/2026-10-04_ONTOLOGY_AL_SEAL_HASHES.txt}"
seal() { (cd .. && shasum -a 256 -c --quiet "silex-mockup/logs/$(basename "$SEAL")") && shasum -a 256 -c --quiet runs/onto-al-INPUT-MANIFEST.sha256; echo "seal and inputs verified"; }
seal
mkdir -p runs/onto-al-stats
node eval/ontology/al/stats-al.ts --input runs/onto-al-input --out runs/onto-al-stats/stats-al.json
python3 eval/ontology/al/recheck_al.py --observations runs/onto-al-input/observations.jsonl --labels runs/onto-al-input/labels.jsonl \
  --snapshot eval/ontology/v2/frozen/snapshot.json --manifest eval/ontology/v2/frozen/tool-manifest-v2.json --binding eval/ontology/v2/frozen/binding-v2.json \
  --out runs/onto-al-stats/recheck-al.json
node eval/ontology/al/compare-outputs.mjs runs/onto-al-stats/stats-al.json runs/onto-al-stats/recheck-al.json
seal
node eval/ontology/showcase/onto-observability.ts --al-input runs/onto-al-input --al-stats runs/onto-al-stats/stats-al.json \
  --v2-stats runs/onto-v2-stats/stats-kev-0.8b-ft.json --v1-stats runs/onto-stats/stats-kev-0.8b-ft.json --frozen eval/ontology/v2/frozen \
  --out runs/onto-al-stats/onto-observability.json
seal
shasum -a 256 runs/onto-al-stats/*.json
