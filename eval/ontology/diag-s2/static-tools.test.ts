// static-tools.test.ts (B-T1 + CG-B defect 3): invariants of the static 2x2x2 table, the frozen regex equality check, the
// closed static schema (real AgentDyn and --agentdojo outputs pass, leaky variants are rejected).
// Run: node --test eval/ontology/diag-s2/static-tools.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMPACT_WRITE, assertFrozenRegex, buildStaticTools, type StaticRow, type StaticTools } from './static-tools.ts';
import { validateStatic, type BindingShape, type SnapshotShape } from './validate-static.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BINDING = resolve(HERE, '../s2/binding-agentdyn.json');
const SNAPSHOT = resolve(HERE, '../v2/frozen/snapshot.json');
const ADOJO_BINDING = resolve(HERE, '../v2/frozen/binding-v2.json');
const schema = JSON.parse(readFileSync(resolve(HERE, 'static-schema.json'), 'utf8'));
const binding = JSON.parse(readFileSync(BINDING, 'utf8')) as BindingShape;
const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as SnapshotShape;

const invariants = (tools: StaticRow[], bindingPath: string): void => {
  const ids = tools.map(t => t.tool_id);
  const b = JSON.parse(readFileSync(bindingPath, 'utf8')) as { tools: Record<string, unknown> };
  assert.equal(new Set(ids).size, ids.length, 'tool rows are unique');
  assert.deepEqual(new Set(ids), new Set(Object.keys(b.tools)), 'every binding tool appears exactly once');
  for (const t of tools) {
    assert.ok(!t.typed_eligible || t.bound_write, `${t.tool_id}: typed_eligible must imply bound_write`);
    assert.equal(t.regex_write, IMPACT_WRITE.test(t.tool_id.split('/')[1]), `${t.tool_id}: regex_write must equal IMPACT_WRITE.test(name)`);
  }
};
const summaryChecks = (res: StaticTools): void => {
  const cells = Object.keys(res.summary.total);
  assert.equal(cells.length, 8, 'total has all 8 cells');
  const sum = (m: Record<string, number>): number => Object.values(m).reduce((a, b) => a + b, 0);
  assert.equal(sum(res.summary.total), res.tools.length, 'total counts sum to the tool count');
  assert.equal(Object.values(res.summary.per_suite).reduce((a, m) => a + sum(m), 0), res.tools.length, 'per-suite counts sum to the tool count');
  const recompute: Record<string, number> = {};
  for (const t of res.tools) { const c = `r${+t.regex_write}b${+t.bound_write}t${+t.typed_eligible}`; recompute[c] = (recompute[c] ?? 0) + 1; }
  for (const c of cells) assert.equal(res.summary.total[c], recompute[c] ?? 0, `total[${c}] matches the rows`);
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
  assert.doesNotThrow(() => validateStatic(res, binding, snapshot, schema));
});
test('AgentDojo binding (when frozen): same invariants and schema', { skip: existsSync(ADOJO_BINDING) ? false : 'eval/ontology/v2/frozen/binding-v2.json absent' }, () => {
  const res = buildStaticTools(ADOJO_BINDING, SNAPSHOT);
  invariants(res.tools, ADOJO_BINDING);
  summaryChecks(res);
  assert.doesNotThrow(() => validateStatic(res, JSON.parse(readFileSync(ADOJO_BINDING, 'utf8')), snapshot, schema));
});

const clone = (): StaticTools => JSON.parse(JSON.stringify(buildStaticTools(BINDING, SNAPSHOT)));
const reject = (mutate: (d: any) => void, re: RegExp): void => { const d = clone(); mutate(d); assert.throws(() => validateStatic(d, binding, snapshot, schema), re); };

test('rejects an unregistered tool id', () => { reject(d => { d.tools[0].tool_id = 'agentdyn:dailylife/not_a_tool'; }, /not a binding tool id/); });
test('rejects a path string as a tool id', () => { reject(d => { d.tools[0].tool_id = '/Users/some/private/path.json'; }, /not a binding tool id/); });
test('rejects a parameter that belongs to another tool', () => {
  reject(d => {
    const foreign = d.tools.flatMap((t: any) => t.params).find((p: string) => !d.tools[0].params.includes(p));
    d.tools[0].params = [foreign];
  }, /parameter not registered for/);
});
test('rejects an unknown effect id', () => { reject(d => { d.tools[0].effects = ['core:core-effect-not-real']; }, /unknown effect id/); });
test('rejects an unexpected field', () => { reject(d => { d.tools[0].extra = 1; }, /unexpected field/); });
test('rejects a top-level path field', () => { reject(d => { d.binding = '/Users/some/private/binding.json'; }, /unexpected field/); });
test('rejects a non-constant legend', () => { reject(d => { d.summary.legend = '/Users/some/private/path'; }, /fixed constant/); });
test('rejects an unexpected summary cell', () => { reject(d => { d.summary.total['rXbYtZ'] = 1; }, /key not in enum cell/); });
test('rejects a prototype-named field carrying private text', () => {
  const raw = JSON.stringify(clone());
  const injected = raw.replace('{"tool_id":"', '{"__proto__":"ZZ_PRIVATE","constructor":"ZZ_PRIVATE","tool_id":"');
  const d = JSON.parse(injected);
  assert.ok(Object.hasOwn(d.tools[0], '__proto__') && Object.hasOwn(d.tools[0], 'constructor'));
  assert.throws(() => validateStatic(d, binding, snapshot, schema), /unexpected field/);
});
