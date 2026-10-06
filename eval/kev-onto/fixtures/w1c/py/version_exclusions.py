#!/usr/bin/env python3
"""W1c §9.1 version exclusion: for each suite, the class names defined in any versioned
default_suites directory. python3 version_exclusions.py <archive.tar.gz> <version_dirs.json> <suites.json>"""
import ast, json, sys, tarfile

archive, dirs_json, suites_json = sys.argv[1:4]
dirs, suites = json.loads(dirs_json), json.loads(suites_json)
out = {s: set() for s in suites}
with tarfile.open(archive, "r:*") as t:
    for m in t:
        if not m.isfile() or not m.name.endswith(".py"):
            continue
        for v in dirs:
            for s in suites:
                if m.name.endswith(f"/default_suites/{v}/{s}/user_tasks.py") or m.name.endswith(f"/default_suites/{v}/{s}/injection_tasks.py"):
                    tree = ast.parse(t.extractfile(m).read().decode("utf-8"))
                    for node in tree.body:
                        if isinstance(node, ast.ClassDef):
                            out[s].add(node.name)
sys.stdout.write(json.dumps({s: sorted(v) for s, v in out.items()}))
