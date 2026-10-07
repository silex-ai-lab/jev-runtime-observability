// power-hc1.test.ts — determinism + closed schema on Mimo's synthetic fixture. Run:
//   node --test eval/ontology/diag-s2/power-hc1.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPower, validatePower } from './power-hc1.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(HERE, 'fixtures/synthetic');
const EXPECTED = resolve(FIX, 'expected.json');
const FIX_BASELINE = { baseline: ['labels.jsonl', 'labels-pr.jsonl', 'labels-d5.jsonl', 'binding.json', 'frozen/snapshot.json'], sanitized: ['observations.sanitized.jsonl'] };
const opts = () => ({ s2Dir: FIX, binding: resolve(FIX, 'binding.json'), frozen: resolve(FIX, 'frozen'), diagPath: EXPECTED, expectedS2Baseline: FIX_BASELINE, N: 6, R: 40, grid: { K: [3], U: [6], J: [3] } });

test('deterministic on the synthetic fixture and passes the closed schema', { skip: existsSync(EXPECTED) ? false : 'fixtures/synthetic/expected.json absent' }, () => {
  const a = runPower(opts());
  const b = runPower(opts());
  assert.deepEqual(a, b);
  const schema = JSON.parse(readFileSync(resolve(HERE, 'power-schema.json'), 'utf8'));
  assert.doesNotThrow(() => validatePower(a, schema));
  const pools = (a as any).pools;
  assert.equal(pools.S2.designs.length, 1);
  assert.ok(pools.S2.observed.precision_diff >= 0, 'observed diff present');
  assert.equal(pools.S1, undefined, 'S1 skipped without a pool');
});
