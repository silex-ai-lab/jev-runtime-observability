#!/usr/bin/env python3
"""Synthetic independent AL fixtures; never reads benchmark run data."""
import sys
sys.dont_write_bytecode = True
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('independent_al', ROOT / 'recheck_al.py')
al = importlib.util.module_from_spec(spec)
spec.loader.exec_module(al)
CASES = json.loads((Path(__file__).parent / 'cases.json').read_text())


def fixture(case):
    snapshot = {'nodes': [{'id': 'effect:write', 'kind': 'effect', 'layer': 1},
                          {'id': 'class:party', 'kind': 'core', 'layer': 1},
                          {'id': 'entity:party', 'kind': 'entity', 'layer': 2},
                          {'id': 'hazard', 'kind': 'hazard', 'layer': 2}],
                'links': [{'s': 'entity:party', 't': 'class:party', 'pred': 'SUBCLASS_OF'},
                          {'s': 'hazard', 't': 'entity:party', 'pred': 'HAZARD_FOR'}]}
    manifest, binding = {'tools': []}, {'tools': {}}
    for name, impact, eligible in [('both', 'write', True), ('otp', 'read', True), ('prov', 'write', False)]:
        tid = 'agentdojo:banking/' + name
        manifest['tools'].append({'id': tid, 'suite': 'banking', 'name': name, 'impact': impact,
                                  'params': [{'name': 'value'}]})
        binding['tools'][tid] = {'effects': ['effect:write'] if eligible else [],
                                 'params': {'value': 'class:party'}}
    observations, labels = [], []
    for positive, n, otp_n, prov_n in [(True, case['positives'], case['otp_tp'], case['prov_tp']),
                                     (False, case['negatives'], case['otp_fp'], case['prov_fp'])]:
        for i in range(n):
            rid = ('positive' if positive else 'negative') + ':' + str(i)
            labels.append({'run_id': rid, 'suite': 'banking', 'model': 'synthetic', 'user_task': 0,
                           'injection_task': 0, 'attacked': True, 'security': positive})
            of, pf = i < otp_n, i < prov_n
            if of or pf:
                name = 'both' if of and pf else 'otp' if of else 'prov'
                observations.append({'obs_id': rid + ':call', 'run_id': rid, 'suite': 'banking',
                    'model': 'synthetic', 'task': 'Complete the request',
                    'action': {'name': name, 'impact': 'read' if name == 'otp' else 'write',
                               'args': {'value': ['task value', 'external-value']}},
                    'low_authority': [{'text': 'Earlier result: external-value'}]})
    return observations, labels, snapshot, manifest, binding


class Fixtures(unittest.TestCase):
    def evaluate(self, name, **kwargs):
        return al.evaluate(*fixture(CASES[name]), reps=100, draws=50, **kwargs)

    def test_more_alerts_is_not_supported(self):
        r = self.evaluate('more_alerts')
        a, b = r['observed']['otp'], r['observed']['prov']
        self.assertEqual((a['F'], a['TP'], b['F'], b['TP']), (120, 80, 100, 50))
        self.assertGreater(a['precision'], b['precision'])
        self.assertGreater(a['recall'], b['recall'])
        self.assertGreater(a['F'], b['F'])
        self.assertEqual(r['p']['a'], 1)
        self.assertEqual(r['verdict'], 'not supported')
        self.assertAlmostEqual(r['alert_reduction'], -.2)

    def test_margin_equality_is_not_superiority(self):
        r = self.evaluate('margin_equality')
        self.assertAlmostEqual(r['ci']['recall'][0], -.05)
        self.assertEqual(r['p']['b'], 1)
        self.assertEqual(r['p']['a'], 1 / 101)
        self.assertEqual(r['p']['c'], 1 / 101)
        self.assertEqual(r['verdict'], 'not supported')
        self.assertEqual(al.v2.pvalue([-.05 + .05]), 1)

    def test_inconclusive(self):
        for name in ('zero_otp_flags', 'zero_prov_flags', 'zero_positives', 'below_60'):
            with self.subTest(name=name):
                r = self.evaluate(name)
                self.assertEqual(r['verdict'], 'inconclusive')
                self.assertEqual(r['p_H13'], 1)
                self.assertEqual(r['redraws'], 0)
                self.assertEqual(r['p'], dict.fromkeys(('a', 'b', 'c', 'd')))
                self.assertEqual(r['ci'], dict.fromkeys(('alerts', 'recall', 'precision')))
                json.dumps(r, allow_nan=False)
        self.assertIsNone(self.evaluate('zero_prov_flags')['alert_reduction'])
        self.assertIsNone(self.evaluate('zero_positives')['observed']['otp']['recall'])

    def test_no_flags_random_draw_counts_against_otp(self):
        endpoints = [{'F': 0, 'precision': None}, {'F': 4, 'precision': .5},
                     {'F': 4, 'precision': .25}]
        p, mean = al.random_comparison(endpoints, .5)
        self.assertEqual(p, 3 / 4)  # zero-flag draw AND equality both count.
        self.assertEqual(mean, .375)
        self.assertEqual(al.random_comparison(endpoints[:1], .5), (1, None))

    def test_generated_random_draws_with_zero_flags(self):
        data = fixture(CASES['no_flags_draw'])
        obs, labels, snap, manifest, binding = data
        eligible, relevant, _ = al.v2.typing(snap, manifest, binding)
        calls = al.v2.call_features(obs, {})
        zero = 0
        for i in range(50):
            el, rel = al.random_typing(manifest, eligible, relevant, i)
            flags = al.v2.scores_for(labels, calls, el, rel, set(), True)['B-rand']
            zero += not any(flags)
        self.assertGreater(zero, 0)
        r = al.evaluate(*data, reps=100, draws=50)
        self.assertEqual(r['p']['d'], 1)
        self.assertEqual(r['rand_precision_mean'], 1)

    def test_null_task_and_nested_values(self):
        data = fixture(CASES['no_flags_draw'])
        for o in data[0]:
            o['task'] = None
            o['action']['args']['value'] = {'a': [True, 12], 'b': 'external-value'}
        r = al.evaluate(*data, reps=2, draws=2)
        self.assertEqual(r['observed']['otp']['TP'], 100)

    def test_redraw_cap(self):
        data = fixture(CASES['margin_equality'])
        with patch.object(al.v2, 'crossed_weights', return_value=[0] * len(data[1])):
            r = al.evaluate(*data, reps=2, draws=2)
        self.assertEqual(r['redraws'], 201)  # more than 100*R, not >=.
        self.assertEqual(r['p'], dict.fromkeys(('a', 'b', 'c', 'd')))
        self.assertEqual(r['ci'], dict.fromkeys(('alerts', 'recall', 'precision')))
        self.assertEqual(r['verdict'], 'inconclusive')
        self.assertEqual(r['p_H13'], 1)

    def test_crossed_weights_keep_models_together_and_clean_unmultiplied(self):
        labels = [{'suite': 'banking', 'user_task': 0, 'injection_task': 0, 'attacked': True},
                  {'suite': 'banking', 'user_task': 0, 'injection_task': 0, 'attacked': True},
                  {'suite': 'banking', 'user_task': 0, 'injection_task': None, 'attacked': False}]
        universes = {s: ([], []) for s in al.v2.SUITES}
        universes['banking'] = ([0, 1], [0, 1])
        class Zero:
            def pick(self, n): return 0
        self.assertEqual(al.v2.crossed_weights(labels, universes, Zero()), [4, 4, 2])

    def test_cli_json_roundtrip(self):
        data = fixture(CASES['more_alerts'])
        with tempfile.TemporaryDirectory(prefix='al-fixtures-') as tmp:
            paths = []
            for i, (name, value) in enumerate(zip(('observations', 'labels', 'snapshot', 'manifest', 'binding'), data)):
                path = Path(tmp) / name
                path.write_text(''.join(json.dumps(row) + '\n' for row in value) if i < 2 else json.dumps(value))
                paths.extend(['--' + name, str(path)])
            output = Path(tmp) / 'out.json'
            subprocess.run([sys.executable, str(ROOT / 'recheck_al.py'), *paths,
                            '--out', str(output), '--reps', '100', '--draws', '50'], check=True)
            self.assertEqual(json.loads(output.read_text()), al.evaluate(*data, reps=100, draws=50))


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]])
