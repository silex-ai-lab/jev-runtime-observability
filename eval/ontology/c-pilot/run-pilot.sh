#!/usr/bin/env bash
# C pilot run (plan r4 §6 P5, §7; PILOT_SPEC), fail-closed. Runs only after F-CP.
#   CODE_SEAL=<closure sha256 list> WORK=<new scratch dir outside every repo> eval/ontology/c-pilot/run-pilot.sh primary
#   CODE_SEAL=… WORK=<same dir> MANIFEST_LABELS=<WORK/manifest-labels.json> eval/ontology/c-pilot/run-pilot.sh authored
# primary:  (1) seal checks: code closure, binding subset, the 40-entry run seal; (2) convert into WORK; (3) baseline
#           hashes, written once; (4) frozen sanitization + its hash; (5) pilot.ts; (6) independent recheck on RAW
#           observations; (7) compare; (8) verify again; copy the aggregate to OUT/pilot-primary.json.
# authored: verify everything again, recompute both tables with the transcribed MANIFEST labels, recheck, compare;
#           require the primary table to be byte-identical to the primary phase; copy to OUT/pilot.json.
# WORK holds run-derived files and must never be inside a repository. OUT (private repo) receives aggregates only.
set -euo pipefail
cd "$(dirname "$0")/../../.."
CP=eval/ontology/c-pilot; FZ=eval/ontology/v2/frozen; BINDING=$CP/binding-silex.json
PHASE="${1:?primary|authored}"
SILEX="${SILEX:-../ontology-typed-alerting/data/kev-onto/silex-runs}"
OUT="${OUT:-../ontology-typed-alerting/logs/c-pilot}"
CODE_SEAL="${CODE_SEAL:?code-closure sha256 list from the F-CP freeze record}"; WORK="${WORK:?scratch dir outside every repo}"
EXPECT_RUNS="${EXPECT_RUNS:-40}"
die() { echo "C-PILOT ABORT: $*" >&2; exit 1; }

seal() {
  shasum -a 256 -c --quiet "$CODE_SEAL" || die "code closure seal mismatch"
  node $CP/binding-check.ts > /dev/null || die "binding-silex.json is not the frozen W1 subset"
  [ "$(grep -c . "$SILEX/SEAL.sha256")" = "$EXPECT_RUNS" ] || die "run seal does not list $EXPECT_RUNS files"
  (cd "$SILEX" && shasum -a 256 -c --quiet SEAL.sha256) || die "run seal mismatch"
}
verify_baseline() {
  [ "$(shasum -a 256 "$WORK/baseline.sha256" | cut -d' ' -f1)" = "$(cat "$WORK/baseline.self.sha256")" ] || die "baseline file changed"
  (cd "$WORK" && shasum -a 256 -c --quiet baseline.sha256) || die "converted input changed after baseline"
  if [ -f "$WORK/baseline-sanitized.sha256" ]; then
    [ "$(shasum -a 256 "$WORK/baseline-sanitized.sha256" | cut -d' ' -f1)" = "$(cat "$WORK/baseline-sanitized.self.sha256")" ] || die "sanitized baseline file changed"
    (cd "$WORK" && shasum -a 256 -c --quiet baseline-sanitized.sha256) || die "sanitized input changed after baseline"
  fi
}
outside_repos() { local d; d=$(cd "$1" && pwd -P); (cd "$d" && git rev-parse --is-inside-work-tree >/dev/null 2>&1) && die "$1 is inside a git repository" || true; }
compute() {   # $1 = suffix, $2.. = extra args for both implementations
  local sfx=$1; shift
  verify_baseline
  node $CP/pilot.ts --mode silex --sanitized "$WORK/observations.sanitized.jsonl" --labels "$WORK/labels.jsonl" --counts "$WORK/counts.json" \
    --binding "$BINDING" --frozen $FZ --hash-seal "$SILEX/SEAL.sha256" --hash-spec $CP/PILOT_SPEC.md --hash-code-closure "$CODE_SEAL" \
    "$@" --out "$WORK/pilot$sfx.json"
  verify_baseline
  python3 $CP/recheck_pilot.py --raw-observations "$WORK/observations.jsonl" --labels "$WORK/labels.jsonl" --counts "$WORK/counts.json" \
    --binding "$BINDING" --snapshot $FZ/snapshot.json --seal "$SILEX/SEAL.sha256" --spec $CP/PILOT_SPEC.md --code-closure "$CODE_SEAL" \
    "$@" --out "$WORK/recheck$sfx.json"
  node $CP/compare-pilot.mjs "$WORK/pilot$sfx.json" "$WORK/recheck$sfx.json" || die "pilot and recheck disagree"
  node $CP/validate-pilot.ts --in "$WORK/pilot$sfx.json" > /dev/null || die "pilot output fails its schema"
}

seal; echo "seals verified"
mkdir -p "$WORK"; outside_repos "$WORK"
case "$PHASE" in
  primary)
    [ -z "$(ls -A "$WORK")" ] || die "$WORK is not empty; the primary phase runs once"
    [ -e "$OUT/pilot-primary.json" ] && die "$OUT already holds results"
    node $CP/convert-silex.ts --silex "$SILEX" --binding "$BINDING" --out "$WORK"
    (cd "$WORK" && shasum -a 256 observations.jsonl labels.jsonl counts.json > baseline.sha256)
    shasum -a 256 "$WORK/baseline.sha256" | cut -d' ' -f1 > "$WORK/baseline.self.sha256"
    chmod a-w "$WORK/baseline.sha256" "$WORK/baseline.self.sha256"
    verify_baseline
    node eval/ontology/s2/sanitize-s2.ts --in "$WORK/observations.jsonl" --out "$WORK/observations.sanitized.jsonl"
    (cd "$WORK" && shasum -a 256 observations.sanitized.jsonl > baseline-sanitized.sha256)
    shasum -a 256 "$WORK/baseline-sanitized.sha256" | cut -d' ' -f1 > "$WORK/baseline-sanitized.self.sha256"
    chmod a-w "$WORK/baseline-sanitized.sha256" "$WORK/baseline-sanitized.self.sha256"
    compute ""
    verify_baseline; seal
    mkdir -p "$OUT"; cp "$WORK/pilot.json" "$OUT/pilot-primary.json"; chmod a-w "$WORK/pilot.json"
    shasum -a 256 "$OUT/pilot-primary.json"; echo "C pilot primary phase complete" ;;
  authored)
    MANIFEST_LABELS="${MANIFEST_LABELS:?transcribed manifest-labels.json}"
    [ -e "$WORK/pilot.json" ] || die "primary phase has not run"
    [ -e "$OUT/pilot.json" ] && die "$OUT already holds the authored results"
    compute "-authored" --manifest-labels "$MANIFEST_LABELS"
    python3 -c 'import json,sys;a=json.load(open(sys.argv[1]));b=json.load(open(sys.argv[2]));sys.exit(0 if a["tables"]["primary"]==b["tables"]["primary"] and a["counts"]==b["counts"] else "primary table changed between phases")' \
      "$WORK/pilot.json" "$WORK/pilot-authored.json" || die "primary table changed between phases"
    verify_baseline; seal
    cp "$WORK/pilot-authored.json" "$OUT/pilot.json"
    shasum -a 256 "$OUT/pilot.json"; echo "C pilot authored phase complete" ;;
  *) die "unknown phase $PHASE" ;;
esac
