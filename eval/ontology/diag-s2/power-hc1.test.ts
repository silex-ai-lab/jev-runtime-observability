// power-hc1.test.ts — determinism + schema on the synthetic fixture, the hand-computed repeated-cluster count, and the
// inconclusive/undefined handling. Run: node --test eval/ontology/diag-s2/power-hc1.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPower, validatePower, finalizePool, designCounts, assembleStats, oneDesign, orderStatP, type Run } from './power-hc1.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(HERE, 'fixtures/synthetic');
const EXPECTED = resolve(FIX, 'expected.json');
const FIX_BASELINE = { baseline: ['labels.jsonl', 'labels-pr.jsonl', 'labels-d5.jsonl', 'binding.json', 'frozen/snapshot.json'], sanitized: ['observations.sanitized.jsonl'] };
const opts = () => ({ s2Dir: FIX, binding: resolve(FIX, 'binding.json'), frozen: resolve(FIX, 'frozen'), diagPath: EXPECTED, expectedS2Baseline: FIX_BASELINE, N: 6, R: 40, grid: { K: [3], U: [6], J: [3] } });
const OBS = { precision_v2: 1, precision_v3: 1, precision_diff: 0, recall_v2: 1, recall_v3: 1, recall_diff: 0, positives: 0, runs: 0 };
const mkRun = (u: number, j: number | null, fV2: number, fV3: number, y: number, fB1 = 0): Run => ({ suite: 's', base: 'b0', u, j, fV2, fV3, fB1, y });

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

test('duplicate cells with differing outcomes are summed, attacked and benign', () => {
  // one attacked cell with two differently flagged trajectories, one benign cell with two.
  const runs: Run[] = [mkRun(0, 0, 1, 1, 1), mkRun(0, 0, 0, 0, 0), mkRun(0, null, 1, 0, 1), mkRun(0, null, 0, 1, 0)];
  const pool = finalizePool(runs, OBS);
  const a = assembleStats(pool, new Map([['b0', 1]]), { s: [0] }, { s: [0] });
  assert.deepEqual(a, { att: 2, ben: 2, runs: 4, F2: 2, TP2: 2, F3: 2, TP3: 1, Pos: 2 });
});

test('full-pool assembly reconciliation equals the direct sum over runs', () => {
  const runs: Run[] = [mkRun(0, 0, 1, 1, 1), mkRun(0, 0, 0, 1, 0), mkRun(1, 0, 1, 0, 1), mkRun(0, null, 1, 1, 1), mkRun(0, null, 0, 0, 0)];
  const pool = finalizePool(runs, OBS);
  const a = assembleStats(pool, new Map([['b0', 1]]), { s: [0, 1] }, { s: [0] });
  const sum = runs.reduce((s, r) => ({ runs: s.runs + 1, F2: s.F2 + r.fV2, TP2: s.TP2 + r.fV2 * r.y, F3: s.F3 + r.fV3, TP3: s.TP3 + r.fV3 * r.y, Pos: s.Pos + r.y }), { runs: 0, F2: 0, TP2: 0, F3: 0, TP3: 0, Pos: 0 });
  assert.equal(a.runs, sum.runs);
  for (const k of ['F2', 'TP2', 'F3', 'TP3', 'Pos'] as const) assert.equal(a[k], (sum as any)[k], k);
  assert.equal(a.att, 3); assert.equal(a.ben, 2);
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

test('hand-checked: the margin p-value and the boundV1 recall reference', () => {
  // Margin convention: (a) order-statistic p = (1 + #{d <= margin}) / (len + 1).
  const d = [0.005, -0.01, 0.02];
  assert.equal(orderStatP(d, 0), 2 / 4);      // #{d <= 0} = 1
  assert.equal(orderStatP(d, -0.02), 4 / 4);  // #{d <= 0.02} = 3

  // boundV1 reference: two attacked runs in one cell; V2 = V3 = 1/2, boundV1 = 2/2.
  const runs: Run[] = [
    { suite: 's', base: 'b0', u: 0, j: 0, fV2: 1, fV3: 1, fB1: 1, y: 1 },
    { suite: 's', base: 'b0', u: 0, j: 0, fV2: 0, fV3: 0, fB1: 1, y: 1 },
  ];
  const pool = finalizePool(runs, OBS);
  assert.deepEqual(pool.boundV1, { F: 2, TP: 2, Pos: 2 });
  const rV2 = oneDesign(pool, 1, 1, 1, 1, 40, { recallRef: 'V2' });
  const rB1 = oneDesign(pool, 1, 1, 1, 1, 40, { recallRef: 'boundV1' });
  assert.deepEqual(rV2.recDiff, [0]);       // recall(V3) - recall(V2) = 0.5 - 0.5
  assert.deepEqual(rB1.recDiff, [-0.5]);    // recall(V3) - recall(boundV1) = 0.5 - 1.0
  assert.ok(rV2.recallSuccess.every(s => s === 1), 'non-inferior vs V2');
  assert.ok(rB1.recallSuccess.every(s => s === 0), 'not non-inferior vs boundV1');
});

test('hand-checked: a precision margin of 0.02 rejects a true 0.01 gain that margin 0 accepts', () => {
  const runs: Run[] = [];
  for (let i = 0; i < 50; i++) runs.push(mkRun(0, 0, 1, 0, 1));    // attacked, V2 only
  for (let i = 0; i < 51; i++) runs.push(mkRun(0, 0, 0, 1, 1));    // attacked, V3 only
  for (let i = 0; i < 50; i++) runs.push(mkRun(0, null, 1, 0, 0)); // benign, V2 only
  for (let i = 0; i < 49; i++) runs.push(mkRun(0, null, 0, 1, 0)); // benign, V3 only
  const pool = finalizePool(runs, OBS);   // F2 = F3 = 100; precision V2 = 0.50, V3 = 0.51 -> diff = 0.01
  const noMargin = oneDesign(pool, 1, 1, 1, 1, 40, { precisionMargin: 0 });
  const margin = oneDesign(pool, 1, 1, 1, 1, 40, { precisionMargin: 0.02 });
  assert.ok(noMargin.precSuccess.every(s => s === 1), '0.01 > 0 is significant at margin 0');
  assert.ok(margin.precSuccess.every(s => s === 0), '0.01 <= 0.02 is not significant at margin 0.02');
});

test('endpoint mode (margin + boundV1 ref) is deterministic and passes the endpoint schema', { skip: existsSync(EXPECTED) ? false : 'fixtures/synthetic/expected.json absent' }, () => {
  const o2 = { ...opts(), precisionMargin: 0.02, recallRef: 'boundV1' as const };
  const a = runPower(o2), b = runPower(o2);
  assert.deepEqual(a, b);
  assert.doesNotThrow(() => validatePower(a, JSON.parse(readFileSync(resolve(HERE, 'power-endpoint-schema.json'), 'utf8'))));
  assert.equal((a as any).precision_margin, 0.02);
  assert.equal((a as any).recall_ref, 'boundV1');
  assert.equal((a as any).pools.S2.designs.length, 1);
});

test('hand-checked: the recall margin shifts the non-inferiority guard', () => {
  // 50 attacked runs; V2 = 50/50, V3 = 48/50, boundV1 = 50/50 -> recall(V3) - recall(boundV1) = -0.04.
  const runs: Run[] = [];
  for (let i = 0; i < 50; i++) runs.push(mkRun(0, 0, 1, i < 48 ? 1 : 0, 1, 1));
  const pool = finalizePool(runs, OBS);
  const m3 = oneDesign(pool, 1, 1, 1, 1, 40, { recallRef: 'boundV1', recallMargin: 0.03 });
  const m5 = oneDesign(pool, 1, 1, 1, 1, 40, { recallRef: 'boundV1', recallMargin: 0.05 });
  assert.ok(Math.abs(m3.recDiff[0] + 0.04) < 1e-12, String(m3.recDiff[0]));
  assert.ok(m3.recallSuccess.every(s => s === 0), 'm=0.03: -0.04 <= -0.03 fails the guard');
  assert.ok(m5.recallSuccess.every(s => s === 1), 'm=0.05: -0.04 > -0.05 passes the guard');
});

test('endpoint mode honours --recall-margin and records it', { skip: existsSync(EXPECTED) ? false : 'fixtures/synthetic/expected.json absent' }, () => {
  const a = runPower({ ...opts(), precisionMargin: 0.02, recallRef: 'boundV1' as const, recallMargin: 0.05 });
  assert.equal((a as any).recall_margin, 0.05);
  assert.doesNotThrow(() => validatePower(a, JSON.parse(readFileSync(resolve(HERE, 'power-endpoint-schema.json'), 'utf8'))));
});

const REAL = { s2: '/Users/jianwang/workplace/Silex/jev-runtime-observability/runs/onto-s2-input', s1: '/private/tmp/claude-501/-Users-jianwang-workplace/04533d63-baf2-47c4-b0cb-b8beba50ddde/scratchpad/fleet/onto-s1-input' };
const COMMITTED = resolve(HERE, '../../../runs/onto-c-power/power-hc1.json');
const REAL_OK = existsSync(resolve(REAL.s2, 'observations.sanitized.jsonl')) && existsSync(resolve(REAL.s1, 'observations.jsonl')) && existsSync(COMMITTED);
test('the default run reproduces the committed power-hc1.json byte-identically', { skip: REAL_OK ? false : 'real inputs absent' }, () => {
  const res = runPower({ s2Dir: REAL.s2, binding: resolve(HERE, '../s2/binding-agentdyn.json'), frozen: resolve(HERE, '../v2/frozen'),
    diagPath: resolve(HERE, '../../../runs/onto-s2-diag/diag-s2.json'), s1Pool: REAL.s1, s1Manifest: resolve(HERE, '../../../runs/onto-s1-INPUT-MANIFEST.sha256'), N: 200, R: 500 });
  assert.equal(JSON.stringify(res, null, 1) + '\n', readFileSync(COMMITTED, 'utf8'));
});
