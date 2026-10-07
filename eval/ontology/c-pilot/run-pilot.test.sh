#!/usr/bin/env bash
# P5 acceptance: run-pilot.sh end to end on the synthetic 4-run fixture, then its refusal paths and its quiet console.
# Synthetic data only.   eval/ontology/c-pilot/run-pilot.test.sh
set -uo pipefail
cd "$(dirname "$0")/../../.."
CP=eval/ontology/c-pilot; T=$(mktemp -d); trap 'chmod -R u+w "$T"; rm -rf "$T"; rm -rf "$PWD/$CP/.test-out" "$PWD/$CP/.test-ml"' EXIT
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
expect_abort() { # name, expected reason substring, command...
  local name=$1 why=$2; shift 2
  if "$@" > "$T/log" 2>&1; then bad "$name (did not refuse)"; elif grep -q "C-PILOT ABORT: .*$why" "$T/log"; then ok "$name"; else bad "$name (wrong reason)"; cat "$T/log"; fi; }
quiet() { # console may hold only fixed status lines
  if grep -vE '^(seals verified|C-PILOT ABORT: [A-Za-z /().,;-]+(WORK/logs/[a-z-]+\.log\))?|pilot(-primary)?\.json sha256 [0-9a-f]{64}|C pilot (primary|authored) phase complete)$' "$T/log" | grep -q .; then bad "$1: console not quiet"; cat "$T/log"; else ok "$1: console quiet"; fi; }

$CP/run-pilot.sh primary > "$T/log" 2>&1 && [ -f "$OUT/pilot-primary.json" ] && ok "primary phase" || { bad "primary phase"; cat "$T/log"; }
quiet "primary"; grep -q progent_note "$T/log" && bad "unlisted envelope key name reached the console" || ok "unlisted key name stays in WORK/logs"
expect_abort "primary refuses to run twice" "WORK is not empty" $CP/run-pilot.sh primary
expect_abort "transcription inside a repo" "MANIFEST_LABELS is inside" env MANIFEST_LABELS="$PWD/$CP/.test-ml/ml.json" bash -c "mkdir -p $PWD/$CP/.test-ml && cp $T/ml.json $PWD/$CP/.test-ml/ && $CP/run-pilot.sh authored"
expect_abort "invalid transcription gives no authored output" "transcription" env MANIFEST_LABELS="$T/ml-bad.json" $CP/run-pilot.sh authored
[ -e "$OUT/pilot.json" ] && bad "authored output written after invalid transcription" || ok "no authored output after invalid transcription"
MANIFEST_LABELS="$T/ml.json" $CP/run-pilot.sh authored > "$T/log" 2>&1 && [ -f "$OUT/pilot.json" ] && ok "authored phase" || { bad "authored phase"; cat "$T/log"; }
quiet "authored"
python3 -c 'import json,sys;a=json.load(open(sys.argv[1]))["tables"]["authored"];sys.exit(0 if a["unmapped"]==1 else 1)' "$OUT/pilot.json" && ok "authored table excludes the unmapped run" || bad "authored unmapped"
expect_abort "authored refuses to overwrite" "already holds the authored" env MANIFEST_LABELS="$T/ml.json" $CP/run-pilot.sh authored
rm "$OUT/pilot.json"; chmod u+w "$WORK/observations.sanitized.jsonl"; echo >> "$WORK/observations.sanitized.jsonl"
expect_abort "tampered sanitized input" "sanitized input changed" env MANIFEST_LABELS="$T/ml.json" $CP/run-pilot.sh authored

fresh() { echo "WORK=$T/w$1 OUT=$T/o$1"; }
cp "$T/closure.sha256" "$T/c2"; sed -i.bak '1s/^./0/' "$T/c2"
expect_abort "code hash mismatch (closure list re-pinned)" "code closure seal mismatch" env CODE_SEAL="$T/c2" CODE_SEAL_SHA256=$(shasum -a 256 "$T/c2" | cut -d' ' -f1) $(fresh 2) $CP/run-pilot.sh primary
expect_abort "closure list is not the frozen one" "not the frozen one" env CODE_SEAL_SHA256=$(printf '0%.0s' {1..64}) $(fresh 3) $CP/run-pilot.sh primary
grep -v 'pilot.ts$' "$T/closure.sha256" > "$T/c4"
expect_abort "incomplete but internally valid closure" "does not cover" env CODE_SEAL="$T/c4" CODE_SEAL_SHA256=$(shasum -a 256 "$T/c4" | cut -d' ' -f1) $(fresh 4) $CP/run-pilot.sh primary
expect_abort "run seal count" "does not list 40" env EXPECT_RUNS=40 $(fresh 5) $CP/run-pilot.sh primary
mkdir -p "$PWD/$CP/.tmpwork-test"; expect_abort "WORK inside a repo" "WORK is inside" env WORK="$PWD/$CP/.tmpwork-test" OUT="$T/o6" $CP/run-pilot.sh primary; rm -rf "$PWD/$CP/.tmpwork-test"
expect_abort "OUT inside the public repo" "OUT must be" env WORK="$T/w7" OUT="$PWD/$CP/.test-out" $CP/run-pilot.sh primary
[ -e "$PWD/$CP/.test-out" ] && bad "something was written to the public repo OUT" || ok "nothing written to the public repo OUT"
expect_abort "pilot/recheck disagreement" "step compare failed" env C_PILOT_TEST_HOOK='after-recheck:python3 -c "import json,sys;p=sys.argv[1];d=json.load(open(p));d[\"tables\"][\"primary\"][\"pooled\"][\"typedxV3\"][\"F\"]+=7;json.dump(d,open(p,\"w\"))" "$WORK/recheck.json"' $(fresh 8) $CP/run-pilot.sh primary
quiet "disagreement"
exit $fail
