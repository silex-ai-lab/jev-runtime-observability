#!/usr/bin/env bash
# C pilot run (plan r4 §6 P5, §7; PILOT_SPEC), fail-closed. Runs only after F-CP.
#   CODE_SEAL=<closure sha256 list> CODE_SEAL_SHA256=<its sha256, from the F-CP record> WORK=<new dir outside every repo> \
#     eval/ontology/c-pilot/run-pilot.sh primary
#   (same env) MANIFEST_LABELS=<transcription, outside every repo> eval/ontology/c-pilot/run-pilot.sh authored
# primary:  (1) seals: the closure list is the frozen one, covers closure.ts's required set plus the run seal and the P0
#           inventory, and every hash matches; the binding is the W1 subset; the run seal has EXPECT_RUNS entries and
#           matches; (2) convert into WORK; (3) raw baseline, written once; (4) frozen sanitization + its baseline;
#           (5) pilot.ts; (6) independent recheck on RAW observations; (7) compare; (8) verify again; publish.
# authored: verify everything again, recompute both tables with the transcribed labels, recheck, compare; require a
#           non-null authored table and a primary table identical to the primary phase; publish.
# Console: the script's own stdout/stderr go to a private log directory (mktemp, outside every repo) from the first line;
# only fixed status lines reach the console, on fd 3. Locations are checked on resolved targets; results are published
# with O_CREAT|O_EXCL (never through or over an existing path or symlink).
set -euo pipefail
exec 3>&2
LOG=$(mktemp -d "${TMPDIR:-/tmp}/c-pilot-logs.XXXXXX" 2>/dev/null) || { echo "C-PILOT ABORT: cannot create a log directory" >&3; exit 1; }
exec >>"$LOG/script.log" 2>&1
say() { echo "$*" >&3; }
die() { say "C-PILOT ABORT: $1 (logs: $LOG)"; exit 1; }
trap 'say "C-PILOT ABORT: unexpected failure (logs: $LOG)"' ERR
cd "$(dirname "$0")/../../.."
CP=eval/ontology/c-pilot; FZ=eval/ontology/v2/frozen; BINDING=$CP/binding-silex.json
PHASE="${1:-}"
PRIVATE_OUT=../ontology-typed-alerting/logs/c-pilot
SILEX="${SILEX:-../ontology-typed-alerting/data/kev-onto/silex-runs}"
P0="${P0:-$PRIVATE_OUT/P0-inventory.json}"
OUT="${OUT:-$PRIVATE_OUT}"
[ -n "${CODE_SEAL:-}" ] && [ -n "${CODE_SEAL_SHA256:-}" ] && [ -n "${WORK:-}" ] || die "CODE_SEAL, CODE_SEAL_SHA256 and WORK are required"
EXPECT_RUNS="${EXPECT_RUNS:-40}"
real() { python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$1"; }
in_repo() { local d; d=$(real "$1"); while [ ! -d "$d" ]; do d=$(dirname "$d"); done; (cd "$d" && git rev-parse --is-inside-work-tree >/dev/null 2>&1); }
hook() { [ -n "${C_PILOT_TEST_HOOK:-}" ] && [ "${C_PILOT_TEST_HOOK%%:*}" = "$1" ] && eval "${C_PILOT_TEST_HOOK#*:}" || true; }   # tests only
step() { local name=$1; shift; "$@" > "$LOG/$name.log" 2>&1 || die "step $name failed"; }
publish() {   # src dest: exclusive create, never follows or replaces an existing path or symlink
  python3 - "$1" "$2" <<'PY' || die "could not publish $(basename "$2")"
import os, sys
src, dest = sys.argv[1], sys.argv[2]
data = open(src, 'rb').read()
fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o444)
with os.fdopen(fd, 'wb') as f: f.write(data)
PY
}
absent() { [ ! -e "$1" ] && [ ! -L "$1" ]; }

seal() {
  [ -f "$CODE_SEAL" ] || die "closure list missing"
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
  [ -f "$SILEX/SEAL.sha256" ] && [ "$(grep -c . "$SILEX/SEAL.sha256")" = "$EXPECT_RUNS" ] || die "run seal does not list $EXPECT_RUNS files"
  (cd "$SILEX" && shasum -a 256 -c --quiet SEAL.sha256) > "$LOG/seal-runs.log" 2>&1 || die "run seal mismatch"
}
check_list() {   # list self names...: the list hashes to its self file and covers exactly the named files, all matching
  python3 - "$WORK" "$@" > "$LOG/baseline.log" 2>&1 <<'PY'
import hashlib, os, re, sys
work, lst, selff, names = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
h = lambda p: hashlib.sha256(open(os.path.join(work, p), 'rb').read()).hexdigest()
if h(lst) != open(os.path.join(work, selff)).read().strip(): sys.exit('list changed')
seen = {}
for line in open(os.path.join(work, lst)):
    if not line.strip(): continue
    m = re.match(r'^([0-9a-f]{64})\s+\*?(.+)$', line.rstrip('\n'))
    if not m or m.group(2) in seen: sys.exit('malformed list')
    seen[m.group(2)] = m.group(1)
if sorted(seen) != sorted(names): sys.exit('coverage')
for n, d in seen.items():
    if h(n) != d: sys.exit('mismatch')
PY
}
RAW=(observations.jsonl labels.jsonl counts.json); SAN=(observations.sanitized.jsonl)
verify_raw() { check_list baseline.sha256 baseline.self.sha256 "${RAW[@]}" || die "converted input or its baseline changed"; }
verify_all() { verify_raw; check_list baseline-sanitized.sha256 baseline-sanitized.self.sha256 "${SAN[@]}" || die "sanitized input or its baseline changed"; }
write_list() {   # list self names...
  local lst=$1 self=$2; shift 2
  (cd "$WORK" && shasum -a 256 "$@" > "$lst") && shasum -a 256 "$WORK/$lst" | cut -d' ' -f1 > "$WORK/$self" && chmod a-w "$WORK/$lst" "$WORK/$self" || die "could not write a baseline"
}
compute() {   # $1 = suffix, $2.. = extra args for both implementations
  local sfx=$1; shift
  verify_all
  step "pilot$sfx" node $CP/pilot.ts --mode silex --sanitized "$WORK/observations.sanitized.jsonl" --labels "$WORK/labels.jsonl" --counts "$WORK/counts.json" \
    --binding "$BINDING" --frozen $FZ --hash-seal "$SILEX/SEAL.sha256" --hash-spec $CP/PILOT_SPEC.md --hash-code-closure "$CODE_SEAL" \
    "$@" --out "$WORK/pilot$sfx.json"
  verify_all
  step "recheck$sfx" python3 $CP/recheck_pilot.py --raw-observations "$WORK/observations.jsonl" --labels "$WORK/labels.jsonl" --counts "$WORK/counts.json" \
    --binding "$BINDING" --snapshot $FZ/snapshot.json --seal "$SILEX/SEAL.sha256" --spec $CP/PILOT_SPEC.md --code-closure "$CODE_SEAL" \
    "$@" --out "$WORK/recheck$sfx.json"
  hook "after-recheck$sfx"
  step "compare$sfx" node $CP/compare-pilot.mjs "$WORK/pilot$sfx.json" "$WORK/recheck$sfx.json"
  step "validate$sfx" node $CP/validate-pilot.ts --in "$WORK/pilot$sfx.json"
}

# Locations, on resolved targets, before anything runs.
[ -n "${C_PILOT_TEST_HOOK:-}" ] && [ "$(real "$SILEX")" = "$(real ../ontology-typed-alerting/data/kev-onto/silex-runs)" ] && die "test hook set for the real run"
in_repo "$WORK" && die "WORK is inside a git repository"
[ -L "$OUT" ] && die "OUT is a symlink"
[ "$(real "$OUT")" = "$(real "$PRIVATE_OUT")" ] || ! in_repo "$OUT" || die "OUT must be the private destination or outside every repository"
mkdir -p "$WORK" "$OUT" || die "could not create WORK or OUT"
case "$PHASE" in
  primary)
    [ -z "$(ls -A "$WORK")" ] || die "WORK is not empty; the primary phase runs once"
    absent "$OUT/pilot-primary.json" && absent "$OUT/pilot.json" || die "OUT already holds results"
    seal; say "seals verified"
    step convert node $CP/convert-silex.ts --silex "$SILEX" --binding "$BINDING" --out "$WORK"
    write_list baseline.sha256 baseline.self.sha256 "${RAW[@]}"
    verify_raw
    step sanitize node eval/ontology/s2/sanitize-s2.ts --in "$WORK/observations.jsonl" --out "$WORK/observations.sanitized.jsonl"
    write_list baseline-sanitized.sha256 baseline-sanitized.self.sha256 "${SAN[@]}"
    compute ""
    verify_all; seal
    chmod a-w "$WORK/pilot.json"
    absent "$OUT/pilot-primary.json" && absent "$OUT/pilot.json" || die "OUT already holds results"
    publish "$WORK/pilot.json" "$OUT/pilot-primary.json"
    say "pilot-primary.json sha256 $(shasum -a 256 "$OUT/pilot-primary.json" | cut -d' ' -f1)"
    say "C pilot primary phase complete" ;;
  authored)
    [ -n "${MANIFEST_LABELS:-}" ] || die "MANIFEST_LABELS is required"
    [ -f "$(real "$MANIFEST_LABELS")" ] || die "MANIFEST_LABELS is not a regular file"
    in_repo "$(real "$MANIFEST_LABELS")" && die "MANIFEST_LABELS is inside a git repository"
    [ -f "$WORK/pilot.json" ] || die "primary phase has not run"
    absent "$OUT/pilot.json" || die "OUT already holds the authored results"
    seal; say "seals verified"
    compute "-authored" --manifest-labels "$(real "$MANIFEST_LABELS")"
    python3 -c 'import json,sys;sys.exit(0 if json.load(open(sys.argv[1]))["tables"]["authored"] is not None else 1)' "$WORK/pilot-authored.json" \
      || die "authored table not computed (transcription error)"
    python3 -c 'import json,sys;a=json.load(open(sys.argv[1]));b=json.load(open(sys.argv[2]));sys.exit(0 if a["tables"]["primary"]==b["tables"]["primary"] and a["counts"]==b["counts"] else 1)' \
      "$WORK/pilot.json" "$WORK/pilot-authored.json" || die "primary table changed between phases"
    verify_all; seal
    absent "$OUT/pilot.json" || die "OUT already holds the authored results"
    publish "$WORK/pilot-authored.json" "$OUT/pilot.json"
    say "pilot.json sha256 $(shasum -a 256 "$OUT/pilot.json" | cut -d' ' -f1)"
    say "C pilot authored phase complete" ;;
  *) die "phase must be primary or authored" ;;
esac
