#!/usr/bin/env bash
# S2 run (plan r3 §3 S1f; S2_SPEC §3), fail-closed. Runs only after F-S2. No judge.
#   eval/ontology/s2/run-s2.sh                         # real run: TAR, CODE_SEAL, TAR_SEAL from the F-S2 freeze record
#   TAR=… CODE_SEAL=… TAR_SEAL=… COHORTS=… MANIFEST=… IN=… OUT=… eval/ontology/s2/run-s2.sh   # tests override paths
# Steps: (1) seal check of the dependency closure and the tarball; (2) raw conversion; (3) baseline hashes of raw
# observations and every label-side file, written once, plus the baseline's own hash; (4) frozen sanitization and its
# hash, also written once; (5) verify, then TS statistics; (6) verify, then the independent Python recheck on RAW
# observations; (7) compare every key; (8) verify the baselines and the full seal again.
set -euo pipefail
cd "$(dirname "$0")/../../.."
S2=eval/ontology/s2; FZ=eval/ontology/v2/frozen
TAR="${TAR:?sealed AgentDyn tarball}"; CODE_SEAL="${CODE_SEAL:?dependency-closure sha256 list}"; TAR_SEAL="${TAR_SEAL:?fetch-s2 seal json}"
COHORTS="${COHORTS:-$S2/cohorts.json}"; MANIFEST="${MANIFEST:-$S2/manifest-s2.json}"; BINDING="${BINDING:-$S2/binding-agentdyn.json}"
IN="${IN:-runs/onto-s2-input}"; OUT="${OUT:-runs/onto-s2-stats}"
die() { echo "S2 ABORT: $*" >&2; exit 1; }

seal() {
  shasum -a 256 -c --quiet "$CODE_SEAL" || die "dependency seal mismatch"
  local want; want=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["tarball_sha256"])' "$TAR_SEAL")
  [ "$(shasum -a 256 "$TAR" | cut -d' ' -f1)" = "$want" ] || die "tarball does not match its seal"
}
verify_baseline() {
  [ "$(shasum -a 256 "$IN/baseline.sha256" | cut -d' ' -f1)" = "$(cat "$IN/baseline.self.sha256")" ] || die "baseline file changed"
  (cd "$IN" && shasum -a 256 -c --quiet baseline.sha256) || die "raw/label input changed after baseline"
  if [ -f "$IN/baseline-sanitized.sha256" ]; then
    [ "$(shasum -a 256 "$IN/baseline-sanitized.sha256" | cut -d' ' -f1)" = "$(cat "$IN/baseline-sanitized.self.sha256")" ] || die "sanitized baseline file changed"
    (cd "$IN" && shasum -a 256 -c --quiet baseline-sanitized.sha256) || die "sanitized input changed after baseline"
  fi
}
hook() { [ -n "${S2_TEST_HOOK:-}" ] && [ "${S2_TEST_HOOK%%:*}" = "$1" ] && eval "${S2_TEST_HOOK#*:}" || true; }   # test-only mutation point

# (1)
seal; echo "seal verified"
python3 -c 'import json,sys;c=json.load(open(sys.argv[1]));m=json.load(open(sys.argv[2]));bad=[e["pipeline"] for e in c if e["pipeline"] not in m["pipelines"]];sys.exit("cohort pipelines missing from manifest: %s"%bad if bad else 0)' "$COHORTS" "$MANIFEST" || die "cohorts and manifest disagree"
[ -e "$IN/baseline.sha256" ] && die "$IN already holds a baseline; S2 inputs are written once"
# (2)
node $S2/convert-s2.ts --mode s2 --cohorts "$COHORTS" --manifest "$MANIFEST" --binding "$BINDING" --archive "$TAR" --seal "$TAR_SEAL" --out "$IN"
# (3)
(cd "$IN" && shasum -a 256 observations.jsonl labels.jsonl labels-pr.jsonl labels-d5.jsonl counts.json > baseline.sha256)
shasum -a 256 "$IN/baseline.sha256" | cut -d' ' -f1 > "$IN/baseline.self.sha256"
chmod a-w "$IN/baseline.sha256" "$IN/baseline.self.sha256"
hook after-baseline
# (4)
verify_baseline
node eval/ontology/pr/sanitize.ts --in "$IN/observations.jsonl" --out "$IN/observations.sanitized.jsonl"
(cd "$IN" && shasum -a 256 observations.sanitized.jsonl > baseline-sanitized.sha256)
shasum -a 256 "$IN/baseline-sanitized.sha256" | cut -d' ' -f1 > "$IN/baseline-sanitized.self.sha256"
chmod a-w "$IN/baseline-sanitized.sha256" "$IN/baseline-sanitized.self.sha256"
hook after-sanitize
# (5)
verify_baseline
mkdir -p "$OUT"
node $S2/stats-s2.ts --mode s2 --sanitized "$IN/observations.sanitized.jsonl" --labels "$IN/labels.jsonl" --labels-pr "$IN/labels-pr.jsonl" \
  --labels-d5 "$IN/labels-d5.jsonl" --binding "$BINDING" --frozen $FZ ${S2_REPS:+--reps $S2_REPS} ${S2_DRAWS:+--draws $S2_DRAWS} --out "$OUT/stats-s2.json"
hook after-stats
# (6)
verify_baseline
python3 $S2/recheck_s2.py --mode agentdyn --raw-observations "$IN/observations.jsonl" --labels "$IN/labels.jsonl" --labels-pr "$IN/labels-pr.jsonl" \
  --labels-d5 "$IN/labels-d5.jsonl" --snapshot $FZ/snapshot.json --manifest "${TOOL_MANIFEST:-eval/kev-onto/binding/manifest-agentdyn.json}" --binding "$BINDING" --cohorts "$COHORTS" \
  ${S2_REPS:+--reps $S2_REPS} ${S2_DRAWS:+--draws $S2_DRAWS} --out "$OUT/recheck-s2.json"
# (7)
node eval/ontology/s1/compare-outputs.mjs "$OUT/stats-s2.json" "$OUT/recheck-s2.json"
# (8)
verify_baseline; seal
shasum -a 256 "$OUT"/*.json
echo "S2 run complete"
