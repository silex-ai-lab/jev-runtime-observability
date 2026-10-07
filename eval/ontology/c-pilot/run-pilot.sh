#!/usr/bin/env bash
# C pilot run (plan r4 §6 P5, §7; PILOT_SPEC), fail-closed. Runs only after F-CP.
#   CODE_SEAL=<closure sha256 list> CODE_SEAL_SHA256=<its sha256, from the F-CP record> WORK=<new dir outside every repo> \
#     eval/ontology/c-pilot/run-pilot.sh primary
#   (same env) MANIFEST_LABELS=<transcription, outside every repo> eval/ontology/c-pilot/run-pilot.sh authored
# primary:  (1) seals: the closure list is the frozen one, covers closure.ts's required set plus the run seal and the P0
#           inventory, and every hash matches; the binding is the W1 subset; the run seal has EXPECT_RUNS entries and
#           matches; (2) convert into WORK; (3) baseline hashes, written once; (4) frozen sanitization + its hash;
#           (5) pilot.ts; (6) independent recheck on RAW observations; (7) compare; (8) verify again; copy the aggregate.
# authored: verify everything again, recompute both tables with the transcribed labels, recheck, compare; require a
#           non-null authored table and a primary table identical to the primary phase; copy the aggregate.
# Every child's output goes to WORK/logs (local); the console shows fixed status lines only. WORK and the transcription
# must be outside every repository; OUT must be the private destination or outside every repository.
set -euo pipefail
cd "$(dirname "$0")/../../.."
CP=eval/ontology/c-pilot; FZ=eval/ontology/v2/frozen; BINDING=$CP/binding-silex.json
PHASE="${1:?primary|authored}"
PRIVATE_OUT=../ontology-typed-alerting/logs/c-pilot
SILEX="${SILEX:-../ontology-typed-alerting/data/kev-onto/silex-runs}"
P0="${P0:-$PRIVATE_OUT/P0-inventory.json}"
OUT="${OUT:-$PRIVATE_OUT}"
CODE_SEAL="${CODE_SEAL:?code-closure sha256 list from the F-CP freeze record}"
CODE_SEAL_SHA256="${CODE_SEAL_SHA256:?sha256 of the closure list, from the F-CP freeze record}"
WORK="${WORK:?scratch dir outside every repo}"
EXPECT_RUNS="${EXPECT_RUNS:-40}"
die() { echo "C-PILOT ABORT: $*" >&2; exit 1; }
hook() { [ -n "${C_PILOT_TEST_HOOK:-}" ] && [ "${C_PILOT_TEST_HOOK%%:*}" = "$1" ] && eval "${C_PILOT_TEST_HOOK#*:}" || true; }   # test-only
in_repo() { local d=$1; while [ ! -d "$d" ]; do d=$(dirname "$d"); done; (cd "$d" && git rev-parse --is-inside-work-tree >/dev/null 2>&1); }
real() { python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$1"; }
LOG=""
step() { local name=$1; shift; "$@" > "$LOG/$name.log" 2>&1 || die "step $name failed (details in WORK/logs/$name.log)"; }

seal() {
  [ "$(shasum -a 256 "$CODE_SEAL" | cut -d' ' -f1)" = "$CODE_SEAL_SHA256" ] || die "closure list is not the frozen one"
  shasum -a 256 -c --quiet "$CODE_SEAL" > "$LOG/seal-code.log" 2>&1 || die "code closure seal mismatch"
  node $CP/closure.ts > "$LOG/closure-required.txt" 2> "$LOG/closure.log" || die "closure could not be computed"
  python3 - "$CODE_SEAL" "$LOG/closure-required.txt" "$SILEX/SEAL.sha256" "$P0" > "$LOG/closure-coverage.log" 2>&1 <<'PY' || die "closure list does not cover the required files"
import os, re, sys
entries = set()
for line in open(sys.argv[1]):
    m = re.match(r'^[0-9a-f]{64}\s+\*?(.+)$', line.rstrip('\n'))
    if m: entries.add(os.path.realpath(m.group(1)))
required = [l.strip() for l in open(sys.argv[2]) if l.strip()] + sys.argv[3:5]
missing = [r for r in required if os.path.realpath(r) not in entries]
if missing: print('\n'.join(missing)); sys.exit(1)
PY
  step binding-check node $CP/binding-check.ts
  [ "$(grep -c . "$SILEX/SEAL.sha256")" = "$EXPECT_RUNS" ] || die "run seal does not list $EXPECT_RUNS files"
  (cd "$SILEX" && shasum -a 256 -c --quiet SEAL.sha256) > "$LOG/seal-runs.log" 2>&1 || die "run seal mismatch"
}
verify_baseline() {
  [ "$(shasum -a 256 "$WORK/baseline.sha256" | cut -d' ' -f1)" = "$(cat "$WORK/baseline.self.sha256")" ] || die "baseline file changed"
  (cd "$WORK" && shasum -a 256 -c --quiet baseline.sha256) > "$LOG/verify.log" 2>&1 || die "converted input changed after baseline"
  if [ -f "$WORK/baseline-sanitized.sha256" ]; then
    [ "$(shasum -a 256 "$WORK/baseline-sanitized.sha256" | cut -d' ' -f1)" = "$(cat "$WORK/baseline-sanitized.self.sha256")" ] || die "sanitized baseline file changed"
    (cd "$WORK" && shasum -a 256 -c --quiet baseline-sanitized.sha256) > "$LOG/verify.log" 2>&1 || die "sanitized input changed after baseline"
  fi
}
compute() {   # $1 = suffix, $2.. = extra args for both implementations
  local sfx=$1; shift
  verify_baseline
  step "pilot$sfx" node $CP/pilot.ts --mode silex --sanitized "$WORK/observations.sanitized.jsonl" --labels "$WORK/labels.jsonl" --counts "$WORK/counts.json" \
    --binding "$BINDING" --frozen $FZ --hash-seal "$SILEX/SEAL.sha256" --hash-spec $CP/PILOT_SPEC.md --hash-code-closure "$CODE_SEAL" \
    "$@" --out "$WORK/pilot$sfx.json"
  verify_baseline
  step "recheck$sfx" python3 $CP/recheck_pilot.py --raw-observations "$WORK/observations.jsonl" --labels "$WORK/labels.jsonl" --counts "$WORK/counts.json" \
    --binding "$BINDING" --snapshot $FZ/snapshot.json --seal "$SILEX/SEAL.sha256" --spec $CP/PILOT_SPEC.md --code-closure "$CODE_SEAL" \
    "$@" --out "$WORK/recheck$sfx.json"
  hook "after-recheck$sfx"
  step "compare$sfx" node $CP/compare-pilot.mjs "$WORK/pilot$sfx.json" "$WORK/recheck$sfx.json"
  step "validate$sfx" node $CP/validate-pilot.ts --in "$WORK/pilot$sfx.json"
}

# Locations first: nothing run-derived may land in a repository.
in_repo "$WORK" && die "WORK is inside a git repository"
[ "$(real "$OUT")" = "$(real "$PRIVATE_OUT")" ] || ! in_repo "$OUT" || die "OUT must be the private destination or outside every repository"
mkdir -p "$WORK"
case "$PHASE" in
  primary)
    [ -z "$(ls -A "$WORK")" ] || die "WORK is not empty; the primary phase runs once"
    [ -e "$OUT/pilot-primary.json" ] && die "OUT already holds results"
    mkdir "$WORK/logs"; LOG="$WORK/logs"
    seal; echo "seals verified"
    step convert node $CP/convert-silex.ts --silex "$SILEX" --binding "$BINDING" --out "$WORK"
    (cd "$WORK" && shasum -a 256 observations.jsonl labels.jsonl counts.json > baseline.sha256)
    shasum -a 256 "$WORK/baseline.sha256" | cut -d' ' -f1 > "$WORK/baseline.self.sha256"
    chmod a-w "$WORK/baseline.sha256" "$WORK/baseline.self.sha256"
    verify_baseline
    step sanitize node eval/ontology/s2/sanitize-s2.ts --in "$WORK/observations.jsonl" --out "$WORK/observations.sanitized.jsonl"
    (cd "$WORK" && shasum -a 256 observations.sanitized.jsonl > baseline-sanitized.sha256)
    shasum -a 256 "$WORK/baseline-sanitized.sha256" | cut -d' ' -f1 > "$WORK/baseline-sanitized.self.sha256"
    chmod a-w "$WORK/baseline-sanitized.sha256" "$WORK/baseline-sanitized.self.sha256"
    compute ""
    verify_baseline; seal
    mkdir -p "$OUT"; cp "$WORK/pilot.json" "$OUT/pilot-primary.json"; chmod a-w "$WORK/pilot.json"
    echo "pilot-primary.json sha256 $(shasum -a 256 "$OUT/pilot-primary.json" | cut -d' ' -f1)"
    echo "C pilot primary phase complete" ;;
  authored)
    MANIFEST_LABELS="${MANIFEST_LABELS:?transcribed manifest-labels.json}"
    in_repo "$(dirname "$MANIFEST_LABELS")" && die "MANIFEST_LABELS is inside a git repository"
    [ -e "$WORK/pilot.json" ] || die "primary phase has not run"
    [ -e "$OUT/pilot.json" ] && die "OUT already holds the authored results"
    LOG="$WORK/logs"
    seal; echo "seals verified"
    compute "-authored" --manifest-labels "$MANIFEST_LABELS"
    python3 -c 'import json,sys;sys.exit(0 if json.load(open(sys.argv[1]))["tables"]["authored"] is not None else 1)' "$WORK/pilot-authored.json" \
      || die "authored table not computed (transcription error; details in WORK/logs)"
    python3 -c 'import json,sys;a=json.load(open(sys.argv[1]));b=json.load(open(sys.argv[2]));sys.exit(0 if a["tables"]["primary"]==b["tables"]["primary"] and a["counts"]==b["counts"] else 1)' \
      "$WORK/pilot.json" "$WORK/pilot-authored.json" || die "primary table changed between phases"
    verify_baseline; seal
    cp "$WORK/pilot-authored.json" "$OUT/pilot.json"
    echo "pilot.json sha256 $(shasum -a 256 "$OUT/pilot.json" | cut -d' ' -f1)"
    echo "C pilot authored phase complete" ;;
  *) die "unknown phase" ;;
esac
