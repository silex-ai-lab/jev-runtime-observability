#!/usr/bin/env bash
# Fault injection for run-al.sh (E-AL freeze r2): a code-seal mismatch and an input mismatch must each abort before any statistic
# or example is written. Uses temporary manifests; never touches runs/onto-al-stats.
set -u
cd "$(dirname "$0")/../../../.."
T=$(mktemp -d); OUT=runs/onto-al-stats; fail=0
[ -e "$OUT" ] && { echo "refusing to run: $OUT already exists"; exit 2; }
sed '1s/^\(.\)/0/;1s/^0\(.\)/f\1/' ../silex-mockup/logs/2026-10-04_ONTOLOGY_AL_SEAL_HASHES.txt > "$T/bad-seal.txt"
sed '1s/^\(.\)/0/;1s/^0\(.\)/f\1/' runs/onto-al-INPUT-MANIFEST.sha256 > "$T/bad-inputs.txt"
SEAL="$T/bad-seal.txt" bash eval/ontology/al/run-al.sh >"$T/a.log" 2>&1; ca=$?
INPUTS="$T/bad-inputs.txt" bash eval/ontology/al/run-al.sh >"$T/b.log" 2>&1; cb=$?
[ $ca -ne 0 ] && grep -q "SEAL MISMATCH" "$T/a.log" && [ ! -e "$OUT" ] && echo "ok   code-seal mismatch aborts before analysis" || { echo "FAIL code-seal mismatch"; fail=1; }
[ $cb -ne 0 ] && grep -q "INPUT MISMATCH" "$T/b.log" && [ ! -e "$OUT" ] && echo "ok   input mismatch aborts before analysis" || { echo "FAIL input mismatch"; fail=1; }
rm -rf "$T"; exit $fail
