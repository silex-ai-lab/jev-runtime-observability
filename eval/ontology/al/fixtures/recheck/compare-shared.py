#!/usr/bin/env python3
"""Compare every AL shared-fixture result against the independent Python CLI."""
import sys
sys.dont_write_bytecode = True
import json
import math
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / 'fixtures/stats/data'
NAMES = ('good', 'more', 'lossy', 'zero', 'small')


def compare(actual, expected, path='result', exact=False):
    exact = exact or path.endswith('.p') or path.endswith('.p_H13') or path.endswith('.verdict')
    if isinstance(expected, dict):
        assert isinstance(actual, dict), f'{path}: expected dictionary'
        assert actual.keys() == expected.keys(), f'{path}: different keys'
        for key in expected:
            compare(actual[key], expected[key], path + '.' + key, exact)
    elif isinstance(expected, list):
        assert isinstance(actual, list) and len(actual) == len(expected), f'{path}: different array'
        for i, (a, e) in enumerate(zip(actual, expected)):
            compare(a, e, f'{path}[{i}]', exact)
    elif expected is None:
        assert actual is None, f'{path}: {actual!r} != null'
    elif isinstance(expected, (float, int)) and not isinstance(expected, bool):
        assert isinstance(actual, (float, int)) and not isinstance(actual, bool), f'{path}: not a number'
        assert math.isfinite(actual), f'{path}: nonfinite number'
        assert actual == expected if exact else abs(actual - expected) <= 1e-9, f'{path}: {actual!r} != {expected!r}'
    else:
        assert type(actual) is type(expected) and actual == expected, f'{path}: {actual!r} != {expected!r}'


def main():
    expected = json.loads((DATA / 'expected-summary.json').read_text())
    assert expected['reps'] == 400 and expected['draws'] == 100
    assert set(expected['results']) == set(NAMES)
    with tempfile.TemporaryDirectory(prefix='al-shared-') as tmp:
        for name in NAMES:
            directory = DATA / name
            out = Path(tmp) / (name + '.json')
            cmd = [sys.executable, str(ROOT / 'recheck_al.py'),
                   '--observations', str(directory / 'input/observations.jsonl'),
                   '--labels', str(directory / 'input/labels.jsonl'),
                   '--snapshot', str(directory / 'frozen/snapshot.json'),
                   '--manifest', str(directory / 'frozen/tool-manifest-v2.json'),
                   '--binding', str(directory / 'frozen/binding-v2.json'),
                   '--out', str(out), '--reps', '400', '--draws', '100']
            subprocess.run(cmd, check=True)
            compare(json.loads(out.read_text()), expected['results'][name], name)
            print(f'PASS {name}: every key; floats 1e-9, p/verdict exact, nulls exact')


if __name__ == '__main__':
    main()
