// Synthetic model-selection tests; optional v1 regenerated-output verification.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cohort, convertRun } from '../../runs-convert.ts';
const path = 'pin/runs/synthetic-model/banking/user_task_12/important_instructions/injection_task_3.json';
assert.equal(cohort(path), null);
assert.deepEqual(cohort(path, ['synthetic-model']), { model: 'synthetic-model', suite: 'banking', user_task: 12, injection_task: 3 });
assert.equal(cohort(path, ['other-model']), null);
assert.equal(cohort(path.replace('important_instructions', 'different-attack'), ['synthetic-model']), null);
const clean = cohort('pin/runs/synthetic-model/slack/user_task_7/none/none.json', ['synthetic-model']);
assert.deepEqual(clean, { model: 'synthetic-model', suite: 'slack', user_task: 7, injection_task: null });
assert.equal(convertRun({ messages: [], security: false }, clean).label.run_id, 'synthetic-model/slack/user_task_7/none');
assert.equal(cohort('pin/runs/synthetic-model/workspace/user_task_1/none/none.json/extra', ['synthetic-model']), null);
const arg = process.argv.indexOf('--v1-out');
if (arg >= 0) {
  const dir = resolve(process.argv[arg + 1]);
  const original = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../runs/onto-e5-input');
  for (const file of ['observations.jsonl', 'labels.jsonl']) {
    const hash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
    assert.equal(hash(join(dir, file)), hash(join(original, file)), `${file} v1 byte identity`);
  }
  const counts = JSON.parse(readFileSync(join(dir, 'counts.json'), 'utf8'));
  assert.deepEqual(Object.keys(counts).sort(), ['runs', 'calls', 'parse_failures', 'pooled_positives', 'per_model_runs'].sort());
  const labels = readFileSync(join(dir, 'labels.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const calls = readFileSync(join(dir, 'observations.jsonl'), 'utf8').trim().split('\n').length;
  assert.equal(counts.runs, labels.length); assert.equal(counts.calls, calls);
  assert.equal(counts.pooled_positives, labels.filter(l => l.attacked && l.security === true).length);
  for (const [model, n] of Object.entries(counts.per_model_runs)) assert.equal(n, labels.filter(l => l.model === model).length);
}
console.log('v2 filename selection, v1 byte identity and restricted counts fixtures: PASS');
