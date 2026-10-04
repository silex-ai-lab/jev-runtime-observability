#!/usr/bin/env bash
# E1b (plan § E1, D6): six training runs (A0/A1/A3 × 100 %/50 %) with the published kev.train recipe, each with its own
# dataset (runs/onto-e1b-data, built by eval/ontology/train-arms.ts) and output directory; 3 h box per run. Each model is
# then served on $PORT and evaluated on its own arm's E1 items (calibration+dev+test). A timeout or failure is recorded,
# never re-run for a better number.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$REPO"
KEV_DIR="${KEV_DIR:-$HOME/workplace/Silex/third_party/kev}"; PORT="${PORT:-8023}"; FT_TIMEOUT_S=10800
for cell in A0-100 A1-100 A3-100 A0-50 A1-50 A3-50; do
  arm="${cell%-*}"; OUT="$REPO/runs/onto-e1b-$cell"; DATA="$REPO/runs/onto-e1b-data/train-$cell.jsonl"
  mkdir -p "$OUT"
  if ! grep -q '^result=' "$OUT/RUN.txt" 2>/dev/null; then
    { echo "started_at=$(date -u +%FT%TZ)"; echo "kev_commit=$(git -C "$KEV_DIR" rev-parse HEAD)"
      echo "data=runs/onto-e1b-data/train-$cell.jsonl sha256=$(shasum -a 256 "$DATA" | cut -d' ' -f1) records=$(wc -l < "$DATA" | tr -d ' ')"
      echo "base=Qwen/Qwen3.5-0.8B-Base init_from=jaredpalmer/kev-0.8b timeout=3h device=mps args=--epochs 2 --lr 2e-5 --batch 1 --accum 8 --seed 20260928"
      echo "host=$(sysctl -n machdep.cpu.brand_string) memory_gb=$(( $(sysctl -n hw.memsize) / 1073741824 ))"; } > "$OUT/RUN.txt"
    START=$(date +%s)
    (cd "$KEV_DIR" && perl "$REPO/eval/finetune/timebox.pl" $FT_TIMEOUT_S uv run python -m kev.train --data "$DATA" --base Qwen/Qwen3.5-0.8B-Base \
      --init_from jaredpalmer/kev-0.8b --epochs 2 --lr 2e-5 --batch 1 --accum 8 --device mps --seed 20260928 --out "$OUT/model") > "$OUT/train.log" 2>&1
    CODE=$?
    { echo "finished_at=$(date -u +%FT%TZ) wall_s=$(( $(date +%s) - START )) exit=$CODE"
      echo "training_method=$(LC_ALL=C tr '\r' '\n' < "$OUT/train.log" | grep -aio -m1 -E 'lora[^,;]*|full[- ]weight[^,;]*|adapter[^,;]*' || echo unknown)"
      if [ $CODE -eq 124 ]; then echo "result=not_completed_locally (time box 3h reached)"; elif [ $CODE -eq 0 ]; then echo "result=completed"; else echo "result=failed (see train.log)"; fi
    } >> "$OUT/RUN.txt"
  fi
  grep -q '^result=completed' "$OUT/RUN.txt" || continue
  (cd "$KEV_DIR" && exec uv run --extra serve python -m kev.serve --run "$OUT/model" --port "$PORT") > "$OUT/serve.log" 2>&1 &
  SP=$!
  for i in $(seq 1 120); do lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 && break; sleep 3; done
  for pass in 0 1 2 3; do
    node eval/run/run.ts --judge "http://127.0.0.1:$PORT" --expect "$OUT/model" --label "$arm" --splits calibration,dev,test --items runs/onto-e1a-items/items-$arm.jsonl --out "runs/onto-e1b-eval-$cell"
    [ "$pass" = 3 ] && break; node eval/ontology/retry-failed.ts "runs/onto-e1b-eval-$cell/predictions-$arm.jsonl"
  done
  pkill -f "kev.serve --run $OUT/model" ; kill $SP 2>/dev/null; wait $SP 2>/dev/null
done
