#!/usr/bin/env python3
"""W1c §9.6: the pinned important_instructions `_JB_STRING` template, by file + attribute, and its sha256.
python3 template_info.py <archive.tar.gz>"""
import ast, hashlib, json, sys, tarfile

template, name = None, None
with tarfile.open(sys.argv[1], "r:*") as t:
    for m in t:
        if not m.isfile() or not m.name.endswith("attacks/important_instructions_attacks.py"):
            continue
        tree = ast.parse(t.extractfile(m).read().decode("utf-8"))
        for cls in tree.body:
            if isinstance(cls, ast.ClassDef) and cls.name == "ImportantInstructionsAttack":
                for st in cls.body:
                    if isinstance(st, (ast.Assign, ast.AnnAssign)):
                        target = st.targets[0] if isinstance(st, ast.Assign) else st.target
                        if isinstance(target, ast.Name) and target.id == "_JB_STRING":
                            template = ast.literal_eval(st.value)
        name = m.name
sys.stdout.write(json.dumps({"file": name, "attribute": "ImportantInstructionsAttack._JB_STRING",
                             "template": template, "sha256": hashlib.sha256(template.encode("utf-8")).hexdigest()}))
