"""Compare independent calculations with saved shared fixture outputs; never reads stats.ts."""
import importlib.util
import json
from pathlib import Path
import sys
sys.dont_write_bytecode = True
root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('independent_recheck', root / 'recheck.py')
r = importlib.util.module_from_spec(spec); spec.loader.exec_module(r)
data = root / 'fixtures/stats/data'
expected = json.loads((data / 'expected-summary.json').read_text())
actual = {}
for name in ('e1-planted', 'e1-null', 'e1-failures', 'e1-gate-fails'):
    actual[name.replace('-', '_')] = r.e1({a: data / name / f'predictions-{a}.jsonl' for a in r.ARMS},
        2000 if name in ('e1-planted', 'e1-null') else 500)
for name in ('e5-planted', 'e5-null', 'e5-crossed'):
    actual[name.replace('-', '_')] = r.e5({a: data / name / f'predictions-{a}.jsonl' for a in r.ARMS},
        r.read_jsonl(data / name / 'input/observations.jsonl'), r.read_jsonl(data / name / 'input/labels.jsonl'),
        json.loads((data / name / 'gates.json').read_text()), 1000, 50 if name == 'e5-crossed' else 200)
actual['verdicts'] = {
    'e1_failures': r.verdict(actual['e1_failures'], None),
    'e1_gate_fails': r.verdict(actual['e1_gate_fails'], None),
    'missing_e1': r.verdict(None, {'p_H7': .03, 'failed_share': 0}),
}
try:
    r.e1({a: data / 'e1-one-class' / f'predictions-{a}.jsonl' for a in r.ARMS}, 500)
except ValueError as error:
    assert 'both classes' in str(error), error
else:
    raise AssertionError('one-class fixture must terminate with an error')

def compare(a, b, path=''):
    if isinstance(b, dict):
        for key, value in b.items(): compare(a[key], value, path + '/' + key)
    elif isinstance(b, list):
        assert len(a) == len(b), path
        for i, (x, y) in enumerate(zip(a, b)): compare(x, y, path + '/' + str(i))
    elif isinstance(b, (int, float)) and not isinstance(b, bool):
        assert abs(a - b) < 1e-9, (path, a, b)
        if '/p/' in path or path.endswith(('/p_H1', '/p_H7', '/p_rand', '/p_ctx', '/p_gate')):
            assert a == b, (path, a, b)
    else:
        assert a == b, (path, a, b)

compare(actual, expected)
print('Shared fixture agreement: PASS (seven summaries, three exact verdicts, one-class error; floats < 1e-9, p-values exactly)')
