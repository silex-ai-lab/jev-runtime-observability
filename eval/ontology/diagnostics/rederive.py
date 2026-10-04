# coder-deepseek V1: independent re-derivation of the Part A diagnosis.
# Stdlib Python only. Recomputes D1 (incl. saturation D1b), D2, D3, D4, D5, D6 from the committed v1
# outputs, matching why-null.ts semantics, then compares the D1-D6 values present in why-null.json to 1e-9.
#   python3 eval/ontology/diagnostics/rederive.py
import json, math, os, sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
OBS = os.path.join(REPO, 'runs/onto-e5-input/observations.jsonl')
LAB = os.path.join(REPO, 'runs/onto-e5-input/labels.jsonl')
BIND = os.path.join(REPO, '..', 'silex-mockup/swm/experiments/ontology-value/binding.json')
WHY = os.path.join(REPO, 'runs/onto-diagnostics/why-null.json')

def load_jsonl(p):
    out = []
    with open(p) as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out

obs = load_jsonl(OBS)
labs = load_jsonl(LAB)
binding = json.load(open(BIND))['tools']
y = {l['run_id']: bool(l['attacked'] and l['security']) for l in labs}

def pred_map(model, arm):
    p = os.path.join(REPO, f'runs/onto-e5-{model}/predictions-{arm}.jsonl')
    return {r['item_id']: r['signal']['raw_probability'] for r in load_jsonl(p)}

def strat_auc(score):
    # score: run_id -> float, defined for every lab run
    strata = sorted({f"{l['suite']}|{l['model']}" for l in labs})
    c = 0.0
    n = 0
    for s in strata:
        rs = [l for l in labs if f"{l['suite']}|{l['model']}" == s]
        pos = [score[l['run_id']] for l in rs if y[l['run_id']]]
        neg = [score[l['run_id']] for l in rs if not y[l['run_id']]]
        for a in pos:
            for b in neg:
                c += 1.0 if a > b else 0.5 if a == b else 0.0
                n += 1
    return (c / n) if n else None

def run_max(f):
    s = {l['run_id']: 0.0 for l in labs}
    for o in obs:
        v = f(o)
        if v > s[o['run_id']]:
            s[o['run_id']] = v
    return s

def bound(o):
    return bool(binding.get(f"agentdojo:{o['action']['tool']}", {}).get('action'))

def vals(v):
    if isinstance(v, str):
        return [v]
    if isinstance(v, list):
        out = []
        for x in v:
            out.extend(vals(x))
        return out
    if v and isinstance(v, dict):
        out = []
        for x in v.values():
            out.extend(vals(x))
        return out
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return [str(v)]
    return []

def from_low(o):
    task = o.get('task') or ''
    low = [x['text'] for x in (o.get('low_authority') or [])]
    for s in vals(o['action']['args']):
        if len(s) >= 4 and s not in task and any(s in t for t in low):
            return True
    return False

def median_sorted(xs):
    return xs[len(xs) >> 1]

def p90_sorted(xs):
    return xs[int(0.9 * len(xs))]

result = {}
# D1 sensitivity
for model in ['kev-0.8b-ft', 'kev-0.8b']:
    P = {a: pred_map(model, a) for a in ['A0', 'A1', 'A2', 'A3']}
    def d(arm, sel):
        xs = sorted(abs(P[arm][o['obs_id']] - P['A0'][o['obs_id']]) for o in obs if sel(o))
        return {'n': len(xs), 'median': median_sorted(xs), 'p90': p90_sorted(xs), 'share_changed_over_0_01': sum(1 for x in xs if x > 0.01) / len(xs)}
    result[f'D1_sensitivity_{model}'] = {
        'A1_bound': d('A1', bound),
        'A1_unbound': d('A1', lambda o: not bound(o)),
        'A2_all': d('A2', lambda o: True),
        'A3_all': d('A3', lambda o: True),
    }
# D1b saturation (both models)
for model in ['kev-0.8b-ft', 'kev-0.8b']:
    a0m = pred_map(model, 'A0')
    a1m = pred_map(model, 'A1')
    zero = sum(1 for o in obs if a0m[o['obs_id']] == 0)
    uns = sorted(abs(a1m[o['obs_id']] - a0m[o['obs_id']]) for o in obs if 0.01 <= a0m[o['obs_id']] <= 0.99)
    result[f'D1b_saturation_{model}'] = {
        'a0_exactly_zero_share': zero / len(obs),
        'unsaturated_calls': len(uns),
        'median_abs_a1_minus_a0_unsaturated': uns[len(uns) >> 1],
    }
# D7 v1 E1 test AUROC next to E5 stratified run-level AUROC (same judge, A0)
st = json.load(open(os.path.join(REPO, 'runs/onto-stats/stats-kev-0.8b-ft.json')))
result['D7_e1_vs_e5'] = {
    'e1_test_auroc_A0': st['e1']['auroc']['A0'],
    'e5_stratified_run_auroc_M_A0': st['e5']['auroc']['M-A0'],
    'note': 'different unit, endpoint and aggregation; not a measure of the shortcut',
}
P0ft = pred_map('kev-0.8b-ft', 'A0')
P1ft = pred_map('kev-0.8b-ft', 'A1')
# D2 coverage
bound_calls = [o for o in obs if bound(o)]
result['D2_coverage'] = {
    'calls': len(obs),
    'calls_on_bound_tools': len(bound_calls),
    'positive_runs_with_bound_call': sum(1 for l in labs if y[l['run_id']] and any(o['run_id'] == l['run_id'] for o in bound_calls)),
    'positives': sum(1 for l in labs if y[l['run_id']]),
}
# D3 static tool prior (leave-one-user-task-out within suite)
tools_of = {}
for o in obs:
    tools_of.setdefault(o['run_id'], set()).add(o['action']['tool'])
s3 = {}
for l in labs:
    train = [x for x in labs if x['suite'] == l['suite'] and x['user_task'] != l['user_task']]
    best = 0.0
    for t in tools_of.get(l['run_id'], set()):
        w = [x for x in train if t in tools_of.get(x['run_id'], set())]
        if w:
            frac = sum(1 for x in w if y[x['run_id']]) / len(w)
            if frac > best:
                best = frac
    s3[l['run_id']] = best
result['D3_static_tool_prior_auroc'] = strat_auc(s3)
result['D3_reference'] = {
    'kev_A0': strat_auc(run_max(lambda o: P0ft[o['obs_id']])),
    'kev_A1': strat_auc(run_max(lambda o: P1ft[o['obs_id']])),
}
# D4 untyped provenance
prov = run_max(lambda o: 1.0 if (o['action']['impact'] == 'write' and from_low(o)) else 0.0)
fused = run_max(lambda o: (1.0 if (o['action']['impact'] == 'write' and from_low(o)) else 0.0) + P0ft[o['obs_id']])
result['D4_provenance_untyped'] = {'auroc': strat_auc(prov), 'fused_with_kev_A0': strat_auc(fused)}
# D5 positives with no write call
result['D5_positive_runs_without_write_call'] = sum(1 for l in labs if y[l['run_id']] and not any(o['run_id'] == l['run_id'] and o['action']['impact'] == 'write' for o in obs))
# D6 within-tool separability
neg_tools = {o['action']['tool'] for o in obs if not y[o['run_id']]}
pos_calls = [o for o in obs if y[o['run_id']]]
result['D6_positive_calls_on_tools_also_in_negatives'] = sum(1 for o in pos_calls if o['action']['tool'] in neg_tools) / len(pos_calls)

# Compare against committed why-null.json (floats to 1e-9), only for keys present there.
committed = json.load(open(WHY))
report = []
def close(a, b):
    if isinstance(a, bool) or isinstance(b, bool):
        return a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(a - b) <= 1e-9
    return a == b
def compare(path, mine, theirs, report):
    if isinstance(theirs, dict):
        for k, v in theirs.items():
            if k not in mine:
                report.append(f'  MISSING in rederive: {path}.{k}')
            else:
                compare(f'{path}.{k}', mine[k], v, report)
    else:
        report.append(('  OK  ' if close(mine, theirs) else '  MISMATCH  ') + f'{path}: rederive={mine} committed={theirs}')

report = []
compare('root', result, committed, report)

print(json.dumps(result, indent=1))
print('\n--- comparison vs committed why-null.json ---')
for r in report:
    print(r)
mismatches = [r for r in report if 'MISMATCH' in r or 'MISSING' in r]
print(f'\nSUMMARY: {len(report)} compared; {len(mismatches)} mismatch/missing')
