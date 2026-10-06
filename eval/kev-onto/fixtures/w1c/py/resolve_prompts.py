#!/usr/bin/env python3
"""W1c §9.5: resolve the PROMPT/GOAL of every AgentDyn user and injection task class in shopping,
github and dailylife by AST constant folding (module/class constants, f-strings, `+` concatenation and
`str.format` on constants). Any node the folder cannot resolve in a PROMPT/GOAL is a hard error.
python3 resolve_prompts.py <agentdyn-clone-root>"""
import ast, json, os, sys


class Unresolved(Exception):
    pass


def fold(node, env):
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.JoinedStr):
        out = []
        for value in node.values:
            if isinstance(value, ast.Constant):
                out.append(str(value.value))
            elif isinstance(value, ast.FormattedValue):
                if value.format_spec is not None:
                    raise Unresolved("format_spec")
                out.append(format(fold(value.value, env), ""))
            else:
                raise Unresolved("joined")
        return "".join(out)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        return fold(node.left, env) + fold(node.right, env)
    if isinstance(node, ast.Name):
        if node.id in env:
            return env[node.id]
        raise Unresolved("name " + node.id)
    if isinstance(node, ast.Call):
        func = node.func
        if isinstance(func, ast.Attribute) and func.attr == "format":
            base = fold(func.value, env)
            args = [fold(a, env) for a in node.args]
            kwargs = {k.arg: fold(k.value, env) for k in node.keywords}
            return base.format(*args, **kwargs)
        if isinstance(func, ast.Attribute) and func.attr == "join":
            return fold(func.value, env).join(str(x) for x in fold(node.args[0], env))
        if isinstance(func, ast.Name) and func.id == "str":
            return str(fold(node.args[0], env))
        raise Unresolved("call")
    if isinstance(node, (ast.List, ast.Tuple)):
        return [fold(e, env) for e in node.elts]
    raise Unresolved(type(node).__name__)


def target_of(stmt):
    if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
        return stmt.targets[0].id, stmt.value
    if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
        return stmt.target.id, stmt.value
    return None, None


def main():
    root = sys.argv[1]
    out = []
    for suite in ("shopping", "github", "dailylife"):
        for fn in ("user_tasks.py", "injection_tasks.py"):
            path = os.path.join(root, "src/agentdojo/default_suites/v1", suite, fn)
            tree = ast.parse(open(path, encoding="utf-8").read())
            menv = {}
            for stmt in tree.body:
                name, value = target_of(stmt)
                if name and value is not None:
                    try:
                        menv[name] = fold(value, menv)
                    except Unresolved:
                        pass
            for cls in (c for c in tree.body if isinstance(c, ast.ClassDef)):
                env = dict(menv)
                for stmt in cls.body:
                    name, value = target_of(stmt)
                    if name and value is not None:
                        try:
                            env[name] = fold(value, env)
                        except Unresolved:
                            pass
                for attr in ("PROMPT", "GOAL"):
                    assigns = [target_of(stmt)[1] for stmt in cls.body
                               if target_of(stmt)[0] == attr and target_of(stmt)[1] is not None]
                    if not assigns:
                        continue
                    # §9.5: an unresolvable PROMPT/GOAL is a hard error, with context; nothing partial is emitted.
                    try:
                        out.append(str(fold(assigns[-1], env)))
                    except Unresolved as exc:
                        raise SystemExit(f"unresolved {attr} in {suite}/{fn} class {cls.name}: {exc}")
    sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    main()
