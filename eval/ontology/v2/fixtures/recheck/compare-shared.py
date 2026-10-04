#!/usr/bin/env python3
"""Run independent V4 CLI against shared synthetic fixtures; never imports stats-v2.ts.
Compare every result key except root typing. Absolute float tolerance 1e-9;
p, p_H, verdict and Holm values are exact. Outputs live only in /private/tmp.
"""
import sys
sys.dont_write_bytecode = True
import argparse
import json
import math
from pathlib import Path
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
FIXTURES = {'small': (200, 50), 'planted': (300, 100), 'kevfail': (200, 50), 'nokev': (200, 50)}

def compare(actual, expected, path=()):
    location = '.'.join(map(str, path)) or 'result'
    if isinstance(expected, dict):
        assert isinstance(actual, dict), f'{location}: expected object'
        assert set(actual) == set(expected), f'{location}: missing {set(expected) - set(actual)}, extra {set(actual) - set(expected)}'
        for key in expected: compare(actual[key], expected[key], path + (key,))
    elif isinstance(expected, list):
        assert isinstance(actual, list) and len(actual) == len(expected), f'{location}: array length/type mismatch'
        for i, (a, e) in enumerate(zip(actual, expected)): compare(a, e, path + (i,))
    elif isinstance(expected, (int, float)) and not isinstance(expected, bool):
        assert isinstance(actual, (int, float)) and not isinstance(actual, bool), f'{location}: expected number'
        assert math.isfinite(actual) and math.isfinite(expected), f'{location}: nonfinite number'
        exact = path and path[0] in ('p', 'p_H')
        matches = actual == expected if exact or (isinstance(actual, int) and isinstance(expected, int)) else abs(actual - expected) <= 1e-9
        assert matches, f'{location}: {actual!r} != {expected!r}'
    else:
        assert type(actual) is type(expected) and actual == expected, f'{location}: {actual!r} != {expected!r}'

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', type=Path, default=HERE.parent / 'stats/data')
    args = parser.parse_args()
    expected = json.loads((args.data / 'expected-summary.json').read_text())
    with tempfile.TemporaryDirectory(prefix='codex-v4-shared-', dir='/private/tmp') as tmp:
        for name, registered in FIXTURES.items():
            case = expected[name]
            assert (case['reps'], case['draws']) == registered, f'{name}: fixture replicate counts changed'
            fixture = args.data / name
            output = Path(tmp) / (name + '.json')
            command = [sys.executable, str(HERE.parents[1] / 'recheck_v2.py'),
                       '--observations', str(fixture / 'input/observations.jsonl'),
                       '--labels', str(fixture / 'input/labels.jsonl'),
                       '--snapshot', str(fixture / 'frozen/snapshot.json'),
                       '--manifest', str(fixture / 'frozen/tool-manifest-v2.json'),
                       '--binding', str(fixture / 'frozen/binding-v2.json'),
                       '--out', str(output), '--reps', str(case['reps']), '--draws', str(case['draws'])]
            kev = fixture / 'predictions-A0.jsonl'
            if kev.is_file(): command += ['--kev', str(kev)]
            subprocess.run(command, check=True)
            result = json.loads(output.read_text())
            target = {k: v for k, v in case['result'].items() if k != 'typing'}
            compare(result, target)
            print(f'{name}: PASS (all keys except typing; floats <=1e-9; p-values/verdicts exact; reps={case["reps"]}, draws={case["draws"]})')

if __name__ == '__main__': main()
