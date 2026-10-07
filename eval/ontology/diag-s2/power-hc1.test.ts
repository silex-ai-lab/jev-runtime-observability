// power-hc1.test.ts — determinism + schema on the synthetic fixture, the hand-computed repeated-cluster count, and the
// inconclusive/undefined handling. Run: node --test eval/ontology/diag-s2/power-hc1.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPower, validatePower, finalizePool, designCounts, oneDesign, type Run } from './power-hc1.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(HERE, 'fixtures/synthetic');
const EXPECTED = resolve(FIX, 'expected.json');
const FIX_BASELINE = { baseline: ['labels.jsonl', 'labels-pr.jsonl', 'labels-d5.jsonl', 'binding.json', 'frozen/snapshot.json'], sanitized: ['observations.sanitized.jsonl'] };
const opts = () => ({ s2Dir: FIX, binding: resolve(FIX, 'binding.json'), frozen: resolve(FIX, 'frozen'), diagPath: EXPECTED, expectedS2Baseline: FIX_BASELINE, N: 6, R: 40, grid: { K: [3], U: [6], J: [3] } });
const OBS = { precision_v2: 1, precision_v3: 1, precision_diff: 0, recall_v2: 1, recall_v3: 1, recall_diff: 0, positives: 0, runs: 0 };
const mkRun = (u: number, j: number | null, fV2: number, fV3: number, y: number): Run => ({ suite: 's', base: 'b0', u, j, fV2, fV3, y });

test('deterministic on the synthetic fixture and passes the closed schema', { skip: existsSync(EXPECTED) ? false : 'fixtures/synthetic/expected.json absent' }, () => {
  const a = runPower(opts()), b = runPower(opts());
  assert.deepEqual(a, b);
  assert.doesNotThrow(() => validatePower(a, JSON.parse(readFileSync(resolve(HERE, 'power-schema.json'), 'utf8'))));
  const p = (a as any).pools;
  assert.equal(p.S2.designs.length, 1);
  assert.equal(p.S1, undefined, 'S1 skipped without a pool');
});

test('repeated occurrence slots are preserved: 1 base, 2 user, 2 injection, U=J=20 gives 400 attacked + 20 benign', () => {
  const runs: Run[] = [];
  for (const u of [0, 1]) for (const j of [0, 1]) runs.push(mkRun(u, j, 1, 1, 1));   // 4 attacked
  for (const u of [0, 1]) runs.push(mkRun(u, null, 0, 0, 0));                       // 2 benign
  const pool = finalizePool(runs, OBS);
  const slots = { s: Array.from({ length: 20 }, (_, k) => k % 2) };                 // 10 of each task
  const c = designCounts(pool, new Map([['b0', 1]]), slots, slots);
  assert.deepEqual(c, { att: 400, ben: 20 });
});

test('a design with no positives is inconclusive (redraw exhaustion)', () => {
  const pool = finalizePool([mkRun(0, 0, 1, 1, 0), mkRun(1, 0, 1, 1, 0)], OBS);
  const r = oneDesign(pool, 1, 2, 1, 3, 5);
  assert.ok(r.status.length === 3 && r.status.every(s => s === 1), JSON.stringify(r.status));
  assert.ok(r.success.every(s => s === 0));
});

test('a design with no typed×V3 alert has an undefined point precision and is not counted valid', () => {
  const pool = finalizePool([mkRun(0, 0, 1, 0, 1), mkRun(1, 0, 1, 0, 1)], OBS);
  const r = oneDesign(pool, 1, 2, 1, 3, 5);
  assert.ok(r.status.every(s => s === 2), JSON.stringify(r.status));
});
