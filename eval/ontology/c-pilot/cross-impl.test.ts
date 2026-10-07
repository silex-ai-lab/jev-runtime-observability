// cross-impl.test.ts — CG-CP round 1 fix 5: the TypeScript pilot and the independent Python recheck must agree on
// the authored-transcription contract (a valid total map, or uniformly `authored: null` with the primary table
// unchanged) and produce identical primary tables and full outputs. Synthetic fixture only (fixtures/recheck/).
//   node --test eval/ontology/c-pilot/cross-impl.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const FIX = resolve(HERE, 'fixtures/recheck');
const RAW = join(FIX, 'observations.jsonl');

const run = (cmd: string, args: string[]): string =>
  execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Preprocess the raw observations exactly as the runner does, run both implementations, and compare them. */
function compute(manifestPath: string, tmp: string): { pilot: any; recheck: any } {
  const san = join(tmp, 'observations.sanitized.jsonl');
  run('node', ['eval/ontology/s2/sanitize-s2.ts', '--in', RAW, '--out', san]);
  const pilotOut = join(tmp, 'pilot.json');
  run('node', ['eval/ontology/c-pilot/pilot.ts', '--mode', 'silex',
    '--sanitized', san, '--labels', join(FIX, 'labels.jsonl'), '--counts', join(FIX, 'counts.json'),
    '--binding', join(FIX, 'binding.json'), '--frozen', FIX, '--manifest-labels', manifestPath,
    '--hash-seal', join(FIX, 'seal.sha256'), '--hash-spec', join(FIX, 'README.md'),
    '--hash-code-closure', join(FIX, 'code-closure.sha256'), '--out', pilotOut]);
  const recheckOut = join(tmp, 'recheck.json');
  run('python3', ['eval/ontology/c-pilot/recheck_pilot.py',
    '--raw-observations', RAW, '--labels', join(FIX, 'labels.jsonl'), '--counts', join(FIX, 'counts.json'),
    '--binding', join(FIX, 'binding.json'), '--snapshot', join(FIX, 'snapshot.json'),
    '--seal', join(FIX, 'seal.sha256'), '--spec', join(FIX, 'README.md'),
    '--code-closure', join(FIX, 'code-closure.sha256'), '--manifest-labels', manifestPath, '--out', recheckOut]);
  run('node', ['eval/ontology/c-pilot/compare-pilot.mjs', pilotOut, recheckOut]);   // throws on any disagreement
  return { pilot: JSON.parse(readFileSync(pilotOut, 'utf8')), recheck: JSON.parse(readFileSync(recheckOut, 'utf8')) };
}

test('cross-impl: the authored transcription contract agrees for the valid map and every invalid case', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cross-impl-'));
  try {
    const validText = readFileSync(join(FIX, 'manifest-labels.json'), 'utf8');
    const valid = JSON.parse(validText) as Record<string, string>;
    const entries = Object.entries(valid);
    const [firstKey, firstVal] = entries[0];
    const q = (s: string): string => JSON.stringify(s);
    const rest = entries.slice(1).map(([k, v]) => `${q(k)}: ${q(v)}`).join(', ');
    const cases: Array<{ name: string; text: string; authored: 'computed' | 'null' }> = [
      { name: 'valid', text: validText, authored: 'computed' },
      { name: 'malformed-json', text: `{ ${q(firstKey)}: ${q(firstVal)},`, authored: 'null' },
      { name: 'null-root', text: 'null', authored: 'null' },
      { name: 'duplicate-key', text: `{ ${q(firstKey)}: ${q(firstVal)}, ${q(firstKey)}: ${q(firstVal)}, ${rest} }`, authored: 'null' },
      { name: 'missing-path', text: JSON.stringify(Object.fromEntries(entries.slice(1))), authored: 'null' },
      { name: 'extra-path', text: JSON.stringify({ ...valid, 'runs/ap/user_task_99/none/none.json': 'benign' }), authored: 'null' },
      { name: 'bad-category', text: JSON.stringify({ ...valid, [firstKey]: 'mystery' }), authored: 'null' },
    ];
    for (const c of cases) {
      const tmp = join(dir, c.name);
      mkdirSync(tmp, { recursive: true });
      const manifest = join(tmp, 'manifest-labels.json');
      writeFileSync(manifest, c.text);
      const { pilot, recheck } = compute(manifest, tmp);
      if (c.authored === 'null') {
        assert.equal(pilot.tables.authored, null, `${c.name}: pilot authored is not null`);
        assert.equal(recheck.tables.authored, null, `${c.name}: recheck authored is not null`);
      } else {
        assert.notEqual(pilot.tables.authored, null, `${c.name}: pilot authored is null`);
        assert.notEqual(recheck.tables.authored, null, `${c.name}: recheck authored is null`);
      }
      assert.deepEqual(pilot.tables.primary, recheck.tables.primary, `${c.name}: primary tables differ`);
      assert.deepEqual(pilot, recheck, `${c.name}: full outputs differ`);   // compare-pilot.mjs already required this
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
