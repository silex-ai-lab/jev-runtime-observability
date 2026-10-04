#!/usr/bin/env bash
# Judge fingerprint (v2 freeze objection 2): content hashes of every file that defines the two judges, plus what the running
# servers report. `--write <file>` records it; `--check <file>` recomputes and fails on any difference. Never touches :8009/:8010.
set -euo pipefail
cd "$(dirname "$0")/../../.."
KEV_DIR="${KEV_DIR:-$HOME/workplace/Silex/third_party/kev}"; HF="${HF_HOME:-$HOME/.cache/huggingface}/hub"
FT_URL="${FT_URL:-http://127.0.0.1:8021}"; REL_URL="${REL_URL:-http://127.0.0.1:8022}"
snap() {  # repo dir name → resolved revision + sha256 of every file (symlinks followed)
  local d="$HF/$1" rev; rev=$(cat "$d/refs/main"); echo "$1 revision $rev"
  (cd "$d/snapshots/$rev" && find -L . -type f | LC_ALL=C sort | while read -r f; do echo "$1 $(shasum -a 256 "$f" | cut -d' ' -f1) ${f#./}"; done)
}
fingerprint() {
  echo "kev_code $(git -C "$KEV_DIR" rev-parse HEAD) dirty=$(git -C "$KEV_DIR" status --porcelain --untracked-files=no | wc -l | tr -d ' ')"
  (cd runs/ft-kev-0.8b-2026-09-28/model && find . -type f | LC_ALL=C sort | while read -r f; do echo "ft $(shasum -a 256 "$f" | cut -d' ' -f1) ${f#./}"; done)
  snap models--jaredpalmer--kev-0.8b
  snap models--Qwen--Qwen3.5-0.8B-Base
  echo "serve_env KEV_TRUNCATE_STATES=${KEV_TRUNCATE_STATES:-unset}"
  for u in "$FT_URL" "$REL_URL"; do
    curl -s -m 10 "$u/v1/models" | python3 -c 'import sys,json; d=json.load(sys.stdin); m=d["models"][0]; print("served", {k: m.get(k) for k in ("run","base","lora","dtype","backend","temperature","truncate_states","max_state_tokens")})' | sed "s#^#$u #"
  done
}
case "${1:-}" in
  --write) fingerprint > "$2"; echo "wrote $2 ($(wc -l < "$2") lines)";;
  --check) diff <(fingerprint) "$2" && echo "judge fingerprint OK";;
  *) echo "usage: judge-fingerprint.sh --write|--check <file>"; exit 2;;
esac
