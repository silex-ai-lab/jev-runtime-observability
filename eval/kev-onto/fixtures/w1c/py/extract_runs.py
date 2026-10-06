#!/usr/bin/env python3
"""W1c §9.1: select archive runs by path and stream them as {path, run} JSONL.
    python3 extract_runs.py <archive.tar.gz> <out.jsonl> <suites.json> <attack> <suffixes.json>
Writes the count to stdout. No run under a non-selected path is decoded."""
import json, sys, tarfile

archive, out_file, suites_json, attack, suffixes_json = sys.argv[1:6]
suites, suffixes = set(json.loads(suites_json)), json.loads(suffixes_json)
n = 0
with tarfile.open(archive, "r:*") as t, open(out_file, "w") as out:
    for m in t:
        if not m.isfile() or not m.name.endswith(".json"):
            continue
        parts = m.name.split("/runs/")
        if len(parts) != 2:
            continue
        rest = parts[1].split("/")
        if len(rest) != 5:
            continue
        pipeline, suite, user_d, attack_d, file = rest
        if suite not in suites or any(pipeline.endswith(s) for s in suffixes):
            continue
        if not user_d.startswith("user_task_"):
            continue
        attacked = attack_d == attack and file.startswith("injection_task_") and file.endswith(".json")
        clean = attack_d == "none" and file == "none.json"
        if not (attacked or clean):
            continue
        out.write(json.dumps({"path": parts[1], "run": json.load(t.extractfile(m))}) + "\n")
        n += 1
print(n)
