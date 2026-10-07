// diagnose.test.ts — compares Q1 to Mimo's synthetic fixture and rejects unpinned/duplicated inputs.
// Run: node --test eval/ontology/diag-s2/diagnose.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDiagnose } from './diagnose.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(HERE, 'fixtures/synthetic');
const EXPECTED = resolve(FIX, 'expected.json');
// The fixture seals labels/binding/snapshot separately from its sanitize-stable observations (its own layout).
const FIX_BASELINE = { baseline: ['labels.jsonl', 'labels-pr.jsonl', 'labels-d5.jsonl', 'binding.json', 'frozen/snapshot.json'], sanitized: ['observations.sanitized.jsonl'] };
const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
const opts = (dir: string) => ({ sanitized: resolve(dir, 'observations.sanitized.jsonl'), labels: resolve(dir, 'labels.jsonl'), binding: resolve(dir, 'binding.json'), frozen: resolve(dir, 'frozen'), stats: resolve(dir, 'stats-s2.json'), baselineDir: dir, expectedBaseline: FIX_BASELINE });
const inCopy = (fn: (dir: string) => void): void => { const dir = mkdtempSync(join(tmpdir(), 'diag-rej-')); try { cpSync(FIX, dir, { recursive: true }); fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };

test('Q1 reproduces Mimo\'s synthetic fixture', { skip: existsSync(EXPECTED) ? false : 'fixtures/synthetic/expected.json absent (Mimo fixture pending)' }, () => {
  const expected = JSON.parse(readFileSync(EXPECTED, 'utf8'));
  assert.deepEqual(runDiagnose(opts(FIX)).q1, expected.q1);
});

test('rejects a --sanitized path that is not the baseline-pinned file', () => {
  inCopy(dir => {
    cpSync(resolve(FIX, 'observations.sanitized.jsonl'), resolve(dir, 'other.jsonl'));
    assert.throws(() => runDiagnose({ ...opts(dir), sanitized: resolve(dir, 'other.jsonl') }), /--sanitized must be the baseline-pinned/);
  });
});

test('rejects a baseline missing an expected entry', () => {
  inCopy(dir => {
    const kept = readFileSync(resolve(dir, 'baseline.sha256'), 'utf8').split('\n').filter(Boolean).filter(l => !l.endsWith('  labels.jsonl'));
    writeFileSync(resolve(dir, 'baseline.sha256'), kept.join('\n') + '\n');
    writeFileSync(resolve(dir, 'baseline.self.sha256'), sha(resolve(dir, 'baseline.sha256')) + '\n');
    assert.throws(() => runDiagnose(opts(dir)), /is missing labels\.jsonl/);
  });
});

test('rejects a duplicate baseline entry', () => {
  inCopy(dir => {
    const lines = readFileSync(resolve(dir, 'baseline.sha256'), 'utf8').split('\n').filter(Boolean);
    writeFileSync(resolve(dir, 'baseline.sha256'), lines.join('\n') + '\n' + lines[0] + '\n');
    writeFileSync(resolve(dir, 'baseline.self.sha256'), sha(resolve(dir, 'baseline.sha256')) + '\n');
    assert.throws(() => runDiagnose(opts(dir)), /duplicate baseline entry/);
  });
});

test('rejects a duplicate observation id', () => {
  inCopy(dir => {
    const san = resolve(dir, 'observations.sanitized.jsonl');
    const rows = readFileSync(san, 'utf8').split('\n').filter(Boolean);
    writeFileSync(san, rows.join('\n') + '\n' + rows[0] + '\n');
    writeFileSync(resolve(dir, 'baseline-sanitized.sha256'), `${sha(san)}  observations.sanitized.jsonl\n`);
    writeFileSync(resolve(dir, 'baseline-sanitized.self.sha256'), sha(resolve(dir, 'baseline-sanitized.sha256')) + '\n');
    assert.throws(() => runDiagnose(opts(dir)), /duplicate observation id/);
  });
});
