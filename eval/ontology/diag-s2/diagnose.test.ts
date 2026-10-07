// diagnose.test.ts — compares Q1 to Mimo's synthetic fixture when present; skips with a clear message otherwise.
// Expected fixture layout (eval/ontology/diag-s2/fixtures/synthetic/): observations.sanitized.jsonl, labels.jsonl,
// binding.json, frozen/snapshot.json, stats-s2.json, baseline.sha256 + baseline.self.sha256 (+ sanitized), expected.json
// with a "q1" object matching the shared contract.
// Run: node --test eval/ontology/diag-s2/diagnose.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDiagnose } from './diagnose.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(HERE, 'fixtures/synthetic');
const EXPECTED = resolve(FIX, 'expected.json');

test('Q1 reproduces Mimo\'s synthetic fixture', { skip: existsSync(EXPECTED) ? false : 'fixtures/synthetic/expected.json absent (Mimo fixture pending)' }, () => {
  const expected = JSON.parse(readFileSync(EXPECTED, 'utf8'));
  const out = runDiagnose({
    sanitized: resolve(FIX, 'observations.sanitized.jsonl'), labels: resolve(FIX, 'labels.jsonl'),
    binding: resolve(FIX, 'binding.json'), frozen: resolve(FIX, 'frozen'), stats: resolve(FIX, 'stats-s2.json'), baselineDir: FIX,
  });
  assert.deepEqual(out.q1, expected.q1);
});
