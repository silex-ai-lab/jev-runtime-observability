// validate-diag.test.ts — the closed-schema validator must reject every forbidden leak and accept a minimal valid
// object. Run: node --test eval/ontology/diag-s2/validate-diag.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDiag, type BindingShape } from './validate-diag.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const schema = JSON.parse(readFileSync(resolve(HERE, 'diag-schema.json'), 'utf8'));
const binding = JSON.parse(readFileSync(resolve(ROOT, 'eval/ontology/s2/binding-agentdyn.json'), 'utf8')) as BindingShape;
const agentdojo = JSON.parse(readFileSync(resolve(ROOT, 'eval/ontology/v2/frozen/binding-v2.json'), 'utf8')) as BindingShape;
const ep = () => ({ F: 0, TP: 0, Pos: 0 });
const cell = () => ({ F: 0, TP: 0, Pos: 0, precision: null, recall: null });
const row = () => ({ alerts: 0, tp: 0, fp: 0 });
const valid = () => ({
  reference: { P: { pooled: { s1: ep(), prov: ep() }, per_base: {}, tiers: {}, b_prov_bound: { prov: ep() } }, X1: { pooled: { s1: ep(), prov: ep() }, per_panel: {} } },
  q1: { P: {}, X1: {} },
  q2: { tools: {}, cover80: [], added_fp_routes: {}, added_fp_params: {} },
  q3: { crosstab: {}, first_tool: {} },
  q4: { by_suite: {}, by_base: {}, excl_gpt5mini: { prov: cell(), s1: cell() } },
});
const bad = (mutate: (d: any) => void, re: RegExp): void => { const d = valid(); mutate(d); assert.throws(() => validateDiag(d, binding, schema), re); };

test('a minimal valid object passes', () => { validateDiag(valid(), binding, schema); });
test('rejects a run id used as a key', () => { bad(d => { d.q2.tools['gpt-4o-2024-08-06/important_instructions/dailylife/user_task_0/injection_task_0'] = { calls: 1, added: { alerts: 0, tp: 0, fp: 0 }, lost: { alerts: 0 } }; }, /tool id not in binding/); });
test('rejects a tool-output substring as a value', () => { bad(d => { d.q2.cover80 = ['Inbox: meeting at 10 with bob@team.example']; }, /not a binding tool id/); });
test('rejects an argument value used as a parameter name', () => { bad(d => { d.q2.added_fp_params['bob@team.example'] = 1; }, /parameter name not registered/); });
test('rejects an unregistered tool name', () => { bad(d => { d.q2.tools['agentdyn:dailylife/download_file'] = { calls: 0, added: { alerts: 0, tp: 0, fp: 0 }, lost: { alerts: 0 } }; }, /tool id not in binding/); });
test('rejects an unregistered key', () => { bad(d => { d.q2.extra = 1; }, /unexpected field/); });
test('rejects an unexpected nested field', () => { bad(d => { d.reference.P.pooled.s1.extra = 1; }, /unexpected field/); });
test('rejects a bad crosstab key', () => { bad(d => { d.q3.crosstab['prov=1|s1=0|cells=V3'] = 1; }, /not a crosstab key/); });
test('rejects a non-integer count', () => { bad(d => { d.q1.P['typedxV3'] = { F: 1.5, TP: 0, Pos: 0, precision: null, recall: null }; }, /expected integer/); });

const withQ5 = () => ({ ...valid(), q5: { S1: { q1: {}, q1_by_group: {}, removed: {}, added: {} } } });
test('q5 accepts AgentDojo tool ids and the <unregistered-tool> bucket', () => {
  const d: any = withQ5();
  d.q5.S1.removed['agentdojo:banking/get_balance'] = row();
  d.q5.S1.added['<unregistered-tool>'] = row();
  validateDiag(d, binding, schema, agentdojo);
});
test('q5 rejects an AgentDyn tool id', () => {
  const d: any = withQ5();
  d.q5.S1.added['agentdyn:dailylife/send_email'] = row();
  assert.throws(() => validateDiag(d, binding, schema, agentdojo), /not an AgentDojo tool id/);
});
test('q2 rejects an AgentDojo tool id and accepts <unregistered-tool>', () => {
  const bad: any = valid(); bad.q2.tools['agentdojo:banking/get_balance'] = { calls: 0, added: row(), lost: { alerts: 0 } };
  assert.throws(() => validateDiag(bad, binding, schema, agentdojo), /tool id not in binding/);
  const ok: any = valid(); ok.q2.tools['<unregistered-tool>'] = { calls: 0, added: row(), lost: { alerts: 1 } };
  validateDiag(ok, binding, schema, agentdojo);
});
