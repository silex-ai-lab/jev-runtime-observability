#!/usr/bin/env bash
# P5 acceptance: run-pilot.sh end to end on the synthetic 4-run fixture, then its refusal paths. Synthetic data only.
#   eval/ontology/c-pilot/run-pilot.test.sh
set -uo pipefail
cd "$(dirname "$0")/../../.."
CP=eval/ontology/c-pilot; T=$(mktemp -d); trap 'chmod -R u+w "$T"; rm -rf "$T"' EXIT
fail=0; ok() { echo "ok   $1"; }; bad() { echo "FAIL $1"; fail=1; }
ls $CP/*.ts $CP/*.py $CP/*.mjs $CP/*.sh $CP/*.json $CP/PILOT_SPEC.md | grep -v test | xargs shasum -a 256 > "$T/closure.sha256"
export SILEX=$CP/fixtures/convert/silex EXPECT_RUNS=4 OUT="$T/out" CODE_SEAL="$T/closure.sha256" WORK="$T/work"
python3 - "$T/ml.json" <<'PY'
import json, sys
p = ["runs/ap/user_task_0/important_instructions/injection_task_0.json", "runs/ap/user_task_10/none/none.json",
     "runs/soc/user_task_0/important_instructions/injection_task_0.json", "runs/soc/user_task_10/none/none.json"]
json.dump(dict(zip(p, ["success", "benign-acting", "unmapped", "benign"])), open(sys.argv[1], "w"))
PY
expect_abort() { local name=$1; shift; if "$@" > "$T/log" 2>&1; then bad "$name (did not refuse)"; elif grep -q "C-PILOT ABORT" "$T/log"; then ok "$name"; else bad "$name (no ABORT line)"; cat "$T/log"; fi; }

$CP/run-pilot.sh primary > "$T/log" 2>&1 && [ -f "$OUT/pilot-primary.json" ] && ok "primary phase" || { bad "primary phase"; cat "$T/log"; }
expect_abort "primary refuses to run twice" $CP/run-pilot.sh primary
MANIFEST_LABELS="$T/ml.json" $CP/run-pilot.sh authored > "$T/log" 2>&1 && [ -f "$OUT/pilot.json" ] && ok "authored phase" || { bad "authored phase"; cat "$T/log"; }
python3 -c 'import json,sys;a=json.load(open(sys.argv[1]))["tables"]["authored"];sys.exit(0 if a["unmapped"]==1 else 1)' "$OUT/pilot.json" && ok "authored table excludes the unmapped run" || bad "authored unmapped"
expect_abort "authored refuses to overwrite" env MANIFEST_LABELS="$T/ml.json" $CP/run-pilot.sh authored
rm "$OUT/pilot.json"; chmod u+w "$WORK/observations.sanitized.jsonl"; echo >> "$WORK/observations.sanitized.jsonl"
expect_abort "tampered sanitized input" env MANIFEST_LABELS="$T/ml.json" $CP/run-pilot.sh authored
cp "$T/closure.sha256" "$T/c2"; sed -i.bak '1s/^./0/' "$T/c2"
expect_abort "code closure mismatch" env CODE_SEAL="$T/c2" WORK="$T/w2" OUT="$T/o2" $CP/run-pilot.sh primary
expect_abort "run seal count" env EXPECT_RUNS=40 WORK="$T/w3" OUT="$T/o3" $CP/run-pilot.sh primary
mkdir -p "$PWD/$CP/.tmpwork-test"; expect_abort "WORK inside a repo" env WORK="$PWD/$CP/.tmpwork-test" OUT="$T/o4" $CP/run-pilot.sh primary; rm -rf "$PWD/$CP/.tmpwork-test"
exit $fail
