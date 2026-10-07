#!/usr/bin/env bash
# P5 acceptance: run-pilot.sh end to end on the synthetic 4-run fixture, then every refusal path, each with the expected
# reason and a quiet console. Synthetic data only.   eval/ontology/c-pilot/run-pilot.test.sh
set -uo pipefail
cd "$(dirname "$0")/../../.."
CP=eval/ontology/c-pilot; R="$PWD/$CP"; T=$(mktemp -d); export TMPDIR="$T"
cleanup() { chmod -R u+w "$T" 2>/dev/null; rm -rf "$T" "$R/.test-out" "$R/.test-ml" "$R/.tmpwork-test" "$R/.test-target" "$R/.test-outlink"; }
trap cleanup EXIT
fail=0; ok() { echo "ok   $1"; }; bad() { echo "FAIL $1"; fail=1; }
export SILEX=$CP/fixtures/convert/silex EXPECT_RUNS=4 P0=$CP/fixtures/inventory/expected.json OUT="$T/out" WORK="$T/work"
{ node $CP/closure.ts; echo "$SILEX/SEAL.sha256"; echo "$P0"; } | xargs shasum -a 256 > "$T/closure.sha256"
export CODE_SEAL="$T/closure.sha256" CODE_SEAL_SHA256=$(shasum -a 256 "$T/closure.sha256" | cut -d' ' -f1)
python3 - "$T/ml.json" "$T/ml-bad.json" <<'PY'
import json, sys
p = ["runs/ap/user_task_0/important_instructions/injection_task_0.json", "runs/ap/user_task_10/none/none.json",
     "runs/soc/user_task_0/important_instructions/injection_task_0.json", "runs/soc/user_task_10/none/none.json"]
json.dump(dict(zip(p, ["success", "benign-acting", "unmapped", "benign"])), open(sys.argv[1], "w"))
json.dump(dict(zip(p[:3], ["success", "benign-acting", "unmapped"])), open(sys.argv[2], "w"))
PY
FIXED='^(seals verified|C-PILOT ABORT: [A-Za-z0-9 /().,;_-]+( \(logs: /[A-Za-z0-9/._-]+\))?|pilot(-primary)?\.json sha256 [0-9a-f]{64}|C pilot (primary|authored) phase complete|logs left in the checked TMPDIR \(logs: /[A-Za-z0-9/._-]+\))$'
quiet() { if grep -vE "$FIXED" "$T/log" | grep -q .; then bad "$1: console not quiet"; cat "$T/log"; else ok "$1: console quiet"; fi; }
expect_abort() { # name, expected reason substring, command...
  local name=$1 why=$2; shift 2
  if "$@" > "$T/log" 2>&1; then bad "$name (did not refuse)"; cat "$T/log"
  elif grep -q "C-PILOT ABORT: .*$why" "$T/log"; then ok "$name"; else bad "$name (wrong reason)"; cat "$T/log"; fi
  quiet "$name"; }
fresh() { local d; d=$(mktemp -d "$T/fresh.XXXXXX"); echo "WORK=$d/work OUT=$d/out"; }   # unique per call, even inside $(...)

# Happy path.
$CP/run-pilot.sh primary > "$T/log" 2>&1 && [ -f "$OUT/pilot-primary.json" ] && ok "primary phase" || { bad "primary phase"; cat "$T/log"; }
quiet "primary"; grep -q progent_note "$T/log" && bad "unlisted envelope key name reached the console" || ok "unlisted key name stays in the logs"
expect_abort "primary refuses to run twice" "WORK is not empty" $CP/run-pilot.sh primary
mkdir -p "$R/.test-ml"; cp "$T/ml.json" "$R/.test-ml/"
expect_abort "transcription inside a repo" "MANIFEST_LABELS is inside" env MANIFEST_LABELS="$R/.test-ml/ml.json" $CP/run-pilot.sh authored
ln -s "$R/.test-ml/ml.json" "$T/ml-link.json"
expect_abort "transcription symlink into a repo" "MANIFEST_LABELS is inside" env MANIFEST_LABELS="$T/ml-link.json" $CP/run-pilot.sh authored
expect_abort "invalid transcription (inline check)" "transcription error" env MANIFEST_LABELS="$T/ml-bad.json" $CP/run-pilot.sh authored
[ -e "$OUT/pilot.json" ] && bad "authored output written after invalid transcription" || ok "no authored output after invalid transcription"
MANIFEST_LABELS="$T/ml.json" $CP/run-pilot.sh authored > "$T/log" 2>&1 && [ -f "$OUT/pilot.json" ] && ok "authored phase" || { bad "authored phase"; cat "$T/log"; }
quiet "authored"
python3 -c 'import json,sys;a=json.load(open(sys.argv[1]))["tables"]["authored"];sys.exit(0 if a["unmapped"]==1 else 1)' "$OUT/pilot.json" && ok "authored table excludes the unmapped run" || bad "authored unmapped"
expect_abort "authored refuses to overwrite" "already holds the authored" env MANIFEST_LABELS="$T/ml.json" $CP/run-pilot.sh authored

# Baselines: tamper, deletion of each guard file, unreadable list.
chmod -R u+w "$OUT"; rm "$OUT/pilot.json"
cp -R "$WORK" "$T/work-orig"; chmod -R u+w "$T/work-orig"
reset_work() { chmod -R u+w "$WORK"; rm -rf "$WORK"; cp -R "$T/work-orig" "$WORK"; chmod a-w "$WORK"/baseline*.sha256; }
reset_work; echo >> "$WORK/observations.sanitized.jsonl"
expect_abort "tampered sanitized input" "sanitized input or its baseline changed" env MANIFEST_LABELS="$T/ml.json" $CP/run-pilot.sh authored
reset_work; rm -f "$WORK/baseline-sanitized.sha256"; echo >> "$WORK/observations.sanitized.jsonl"
expect_abort "sanitized list deleted" "sanitized input or its baseline changed" env MANIFEST_LABELS="$T/ml.json" $CP/run-pilot.sh authored
reset_work; rm -f "$WORK/baseline-sanitized.self.sha256"
expect_abort "sanitized self-hash deleted" "sanitized input or its baseline changed" env MANIFEST_LABELS="$T/ml.json" $CP/run-pilot.sh authored
reset_work; rm -f "$WORK/baseline.sha256"
expect_abort "raw list deleted" "converted input or its baseline changed" env MANIFEST_LABELS="$T/ml.json" $CP/run-pilot.sh authored
reset_work; chmod 000 "$WORK/baseline.sha256"
expect_abort "raw list unreadable" "converted input or its baseline changed" env MANIFEST_LABELS="$T/ml.json" $CP/run-pilot.sh authored
reset_work

# Seals and closure.
cp "$T/closure.sha256" "$T/c2"; sed -i.bak '1s/^./0/' "$T/c2"
expect_abort "code hash mismatch (closure list re-pinned)" "code closure seal mismatch" env CODE_SEAL="$T/c2" CODE_SEAL_SHA256=$(shasum -a 256 "$T/c2" | cut -d' ' -f1) $(fresh) $CP/run-pilot.sh primary
expect_abort "closure list is not the frozen one" "not the frozen one" env CODE_SEAL_SHA256=$(printf '0%.0s' {1..64}) $(fresh) $CP/run-pilot.sh primary
grep -v 'pilot.ts$' "$T/closure.sha256" > "$T/c4"
expect_abort "incomplete but internally valid closure" "does not cover" env CODE_SEAL="$T/c4" CODE_SEAL_SHA256=$(shasum -a 256 "$T/c4" | cut -d' ' -f1) $(fresh) $CP/run-pilot.sh primary
expect_abort "missing closure list (sentinel path)" "closure list missing" env CODE_SEAL="$T/SENTINEL_closure_missing.sha256" $(fresh) $CP/run-pilot.sh primary
grep -q SENTINEL "$T/log" && bad "sentinel path reached the console" || ok "sentinel path stays in the logs"
expect_abort "run seal count" "does not list 40" env EXPECT_RUNS=40 $(fresh) $CP/run-pilot.sh primary
expect_abort "missing required env" "are required" env -u CODE_SEAL $CP/run-pilot.sh primary

# Locations and publication.
mkdir -p "$R/.tmpwork-test"; expect_abort "WORK inside a repo" "WORK is inside" env WORK="$R/.tmpwork-test" OUT="$T/o-w" $CP/run-pilot.sh primary
expect_abort "OUT inside the public repo" "OUT must be" env WORK="$T/w-out" OUT="$R/.test-out" $CP/run-pilot.sh primary
[ -e "$R/.test-out" ] && bad "something was written to the public repo OUT" || ok "nothing written to the public repo OUT"
mkdir -p "$R/.test-target"; ln -s "$R/.test-target" "$R/.test-outlink"; ln -s "$R/.test-target" "$T/outlink"
expect_abort "OUT is a symlink into the repo" "OUT is a symlink" env WORK="$T/w-ol" OUT="$T/outlink" $CP/run-pilot.sh primary
mkdir -p "$T/o-dang"; ln -s "$R/.test-target/pilot-primary.json" "$T/o-dang/pilot-primary.json"
expect_abort "dangling result symlink in OUT" "OUT already holds results" env WORK="$T/w-dang" OUT="$T/o-dang" $CP/run-pilot.sh primary
[ -e "$R/.test-target/pilot-primary.json" ] && bad "result written through a dangling link" || ok "nothing written through the dangling link"
mkdir -p "$T/o-stale"; echo '{}' > "$T/o-stale/pilot.json"
expect_abort "primary with a stale authored result in OUT" "OUT already holds results" env WORK="$T/w-stale" OUT="$T/o-stale" $CP/run-pilot.sh primary
echo x > "$T/o-file"
expect_abort "OUT is a regular file" "could not create WORK or OUT" env WORK="$T/w-of" OUT="$T/o-file" $CP/run-pilot.sh primary
expect_abort "pilot/recheck disagreement" "step compare failed" env C_PILOT_TEST_HOOK='after-recheck:python3 -c "import json,sys;p=sys.argv[1];d=json.load(open(p));d[\"tables\"][\"primary\"][\"pooled\"][\"typedxV3\"][\"F\"]+=7;json.dump(d,open(p,\"w\"))" "$WORK/recheck.json"' $(fresh) $CP/run-pilot.sh primary
mkdir -p "$T/gitrepo/tmp" && git -C "$T/gitrepo" init -q
expect_abort "TMPDIR inside a git repository" "TMPDIR is inside a git repository" env TMPDIR="$T/gitrepo/tmp" $(fresh) $CP/run-pilot.sh primary
ln -s "$T/gitrepo/tmp" "$T/tmplink"
expect_abort "TMPDIR symlink into a git repository" "TMPDIR is inside a git repository" env TMPDIR="$T/tmplink" $(fresh) $CP/run-pilot.sh primary
[ -z "$(ls -A "$T/gitrepo/tmp")" ] && ok "nothing written into the repository's TMPDIR" || bad "logs written into a repository"
[ -d "$WORK/logs-primary" ] && grep -q progent_note "$WORK/logs-primary/convert.log" && ok "logs moved into WORK on success" || bad "logs not moved into WORK"
mkdir -p "$T/nogit-bin"; ln -s "$(command -v python3)" "$T/nogit-bin/python3"
expect_abort "repository check fails closed without git" "TMPDIR is inside a git repository" env PATH="$T/nogit-bin:/bin" $(fresh) $CP/run-pilot.sh primary
expect_abort "test hook refused for the real data" "test hook set" env -u SILEX C_PILOT_TEST_HOOK='x:true' $(fresh) $CP/run-pilot.sh primary
exit $fail
