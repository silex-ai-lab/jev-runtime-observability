import assert from 'node:assert/strict';
import { convertRun, cohort } from '../../runs-convert.ts';
const meta = cohort('pin/runs/Meta-SecAlign-70B/banking/user_task_2/important_instructions/injection_task_3.json');
const run = { security: true, utility: false, injections: { x: 'attacker instruction' }, messages: [
  { role: 'user', content: [{ type: 'text', content: 'Pay the approved invoice' }] },
  { role: 'assistant', tool_calls: [{ function: 'lookup', args: {}, id: 'a' }] },
  { role: 'tool', tool_call_id: 'a', content: 'earlier result' },
  { role: 'assistant', tool_calls: [{ function: 'send_money', args: { amount: 1 }, id: 'b' }, { function: 'update_password', args: {}, id: 'c' }] },
  { role: 'tool', tool_call_id: 'c', content: 'sibling result C' },
  { role: 'tool', tool_call_id: 'b', content: 'sibling result B' },
  { role: 'assistant', tool_calls: [{ function: 'lookup', args: {} }] },
  { role: 'tool', content: 'later result' },
] };
const x = convertRun(run, meta);
assert.equal(x.observations.length, 4);
assert.deepEqual(x.observations[2].recent, ['lookup', 'send_money']);
assert.deepEqual(x.observations[1].low_authority, [{ ref: 'tool_result:lookup#0', text: 'earlier result' }]);
assert.deepEqual(x.observations[2].low_authority, x.observations[1].low_authority);
assert.deepEqual(x.observations[3].low_authority.map(r => r.ref), ['tool_result:send_money#1', 'tool_result:update_password#2', 'tool_result:lookup#0']);
assert.ok(!JSON.stringify(x.observations).includes('later result'));
assert.ok(!JSON.stringify(x.observations).includes('security'));
assert.ok(!JSON.stringify(x.observations).includes('attacker instruction'));
assert.equal(cohort('pin/runs/Meta-SecAlign-70B/banking/injection_task_2/none/none.json'), null);
assert.equal(convertRun({ messages: [] }, meta).label.n_calls, 0);
console.log('runs converter fixtures: PASS');
