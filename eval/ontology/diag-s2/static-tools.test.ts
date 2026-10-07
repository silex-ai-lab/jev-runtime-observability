// static-tools.test.ts (B-T1): invariants of the static 2x2x2 table on the real AgentDyn binding, plus the frozen
// regex equality check and the same invariants on the AgentDojo binding when present.
// Run: node --test eval/ontology/diag-s2/static-tools.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMPACT_WRITE, assertFrozenRegex, buildStaticTools, type StaticRow } from './static-tools.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BINDING = resolve(HERE, '../s2/binding-agentdyn.json');
const SNAPSHOT = resolve(HERE, '../v2/frozen/snapshot.json');
const ADOJO_BINDING = resolve(HERE, '../v2/frozen/binding-v2.json');

const invariants = (tools: StaticRow[], bindingPath: string): void => {
  const ids = tools.map(t => t.tool_id);
  const binding = JSON.parse(readFileSync(bindingPath, 'utf8')) as { tools: Record<string, unknown> };
  assert.equal(new Set(ids).size, ids.length, 'tool rows are unique');
  assert.deepEqual(new Set(ids), new Set(Object.keys(binding.tools)), 'every binding tool appears exactly once');
  for (const t of tools) {
    assert.ok(!t.typed_eligible || t.bound_write, `${t.tool_id}: typed_eligible must imply bound_write`);
    assert.equal(t.regex_write, IMPACT_WRITE.test(t.tool_id.split('/')[1]), `${t.tool_id}: regex_write must equal IMPACT_WRITE.test(name)`);
  }
};

const summaryChecks = (res: ReturnType<typeof buildStaticTools>): void => {
  const cells = Object.keys(res.summary.total);
  assert.equal(cells.length, 8, 'total has all 8 cells');
  const sum = (m: Record<string, number>): number => Object.values(m).reduce((a, b) => a + b, 0);
  assert.equal(sum(res.summary.total), res.tools.length, 'total counts sum to the tool count');
  assert.equal(Object.values(res.summary.per_suite).reduce((a, m) => a + sum(m), 0), res.tools.length,
    'per-suite counts sum to the tool count');
  const recompute = (): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const t of res.tools) { const c = `r${+t.regex_write}b${+t.bound_write}t${+t.typed_eligible}`; out[c] = (out[c] ?? 0) + 1; }
    return out;
  };
  const want = recompute();
  for (const c of cells) assert.equal(res.summary.total[c], want[c] ?? 0, `total[${c}] matches the rows`);
};

test('frozen IMPACT_WRITE equals the converter source text', () => {
  assert.doesNotThrow(() => assertFrozenRegex());
  assert.ok(IMPACT_WRITE.test('send_email'));
  assert.ok(!IMPACT_WRITE.test('git_push'));
});

test('AgentDyn binding: one row per tool, typed_eligible implies bound_write, summary sums', () => {
  const res = buildStaticTools(BINDING, SNAPSHOT);
  invariants(res.tools, BINDING);
  summaryChecks(res);
});

test('AgentDojo binding (when frozen): same invariants', { skip: existsSync(ADOJO_BINDING) ? false : 'eval/ontology/v2/frozen/binding-v2.json absent' }, () => {
  const res = buildStaticTools(ADOJO_BINDING, SNAPSHOT);
  invariants(res.tools, ADOJO_BINDING);
  summaryChecks(res);
});
