#!/usr/bin/env bash
# Wave-1 candidate training (KO_SPEC §5.1; plan §5.5). Same arguments as eval/finetune/finetune.sh, which is not edited;
# only the data file and output directory differ. Reviewed at CG1, hashed into F1, run once at T10a.
#   [MAX_STATE=1024] eval/kev-onto/train.sh <train kev JSONL> <output dir, e.g. runs/kev-onto/ft-cand>
# A crash may be retried once with the identical command (plan §5.5); any other re-run is disclosed in the report.
set -uo pipefail
DATA="${1:?train data JSONL}"; OUT="${2:?output dir}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
KEV_DIR="${KEV_DIR:-$HOME/workplace/Silex/third_party/kev}"
KEV_COMMIT_EXPECTED=3e1cd3bb588a388a06827443380befece23e68c7
BASE=Qwen/Qwen3.5-0.8B-Base; INIT=jaredpalmer/kev-0.8b
MAX_STATE="${MAX_STATE:-384}"   # KO_SPEC §5.5 default; W1c (KO_SPEC §9.8) runs with MAX_STATE=1024
ARGS=(--epochs 2 --lr 2e-5 --batch 1 --accum 8 --device mps --seed 20260928)
[ "$MAX_STATE" = 384 ] || ARGS+=(--max_state "$MAX_STATE")
[ "$(git -C "$KEV_DIR" rev-parse HEAD)" = "$KEV_COMMIT_EXPECTED" ] || { echo "kev checkout is not at $KEV_COMMIT_EXPECTED"; exit 2; }
[ -e "$OUT/model" ] && { echo "$OUT/model exists; refusing to overwrite"; exit 2; }
DATA_ABS="$(cd "$(dirname "$DATA")" && pwd)/$(basename "$DATA")"
mkdir -p "$OUT"; OUT_ABS="$(cd "$OUT" && pwd)"
{
  echo "started_at=$(date -u +%FT%TZ)"; echo "kev_commit=$(git -C "$KEV_DIR" rev-parse HEAD)"
  echo "repo_commit=$(git -C "$REPO" rev-parse HEAD) train_sh_sha256=$(shasum -a 256 "$0" | cut -d' ' -f1)"
  echo "data=$DATA sha256=$(shasum -a 256 "$DATA_ABS" | cut -d' ' -f1) records=$(wc -l < "$DATA_ABS" | tr -d ' ')"
  echo "base=$BASE init_from=$INIT device=mps args=${ARGS[*]} max_state=$MAX_STATE"
  echo "host=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -m) memory_gb=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 ))"
} > "$OUT_ABS/RUN.txt"
cd "$KEV_DIR"
START=$(date +%s)
uv run python -m kev.train --data "$DATA_ABS" --base "$BASE" --init_from "$INIT" "${ARGS[@]}" --out "$OUT_ABS/model" > "$OUT_ABS/train.log" 2>&1
CODE=$?
{
  echo "finished_at=$(date -u +%FT%TZ) wall_s=$(( $(date +%s) - START )) exit=$CODE"
  echo "records_used=$(LC_ALL=C tr '\r' '\n' < "$OUT_ABS/train.log" | grep -ao '[0-9]* training requests' | grep -o '^[0-9]*') records_dropped=$(LC_ALL=C tr '\r' '\n' < "$OUT_ABS/train.log" | grep -ao 'dropped [0-9]*' | grep -o '[0-9]*$')"
  if [ $CODE -eq 0 ]; then echo "result=completed"; else echo "result=failed (see train.log)"; fi
  [ -d "$OUT_ABS/model" ] && (cd "$OUT_ABS/model" && for f in adapter_model.safetensors head.pt tokenizer.json adapter_config.json; do [ -f "$f" ] && echo "sha256 $f $(shasum -a 256 "$f" | cut -d' ' -f1)"; done)
} >> "$OUT_ABS/RUN.txt"
cat "$OUT_ABS/RUN.txt"
exit $CODE
