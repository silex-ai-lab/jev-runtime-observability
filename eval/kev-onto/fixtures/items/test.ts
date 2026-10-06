// T4 acceptance (plan §4): sentinel probe on item state, preservation of ordinary words, the hard length bound on the
// 30 × 200-character case, scorer-schema validity, and counts on the foundation fixture.
//   node eval/kev-onto/fixtures/items/test.ts
import { readFileSync } from 'node:fs';
import { formatState } from '../../../convert/format.ts';
import { EvalItem } from '../../../../contracts/eval.ts';
import { buildItems, renderState } from '../../items.ts';
import { MAX_ITEM_STATE, SENTINELS, type Observation } from '../../contract.ts';

let fails = 0;
const ok = (name: string, cond: boolean, info: unknown = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name} ${info === '' ? '' : JSON.stringify(info)}`); if (!cond) fails++; };
const S = Object.values(SENTINELS);
const obs = (o: Partial<Observation>): Observation => ({ obs_id: 'r#0', run_id: 'p/s/user_task_0/none/none', call_index: 0, task: 't',
  action: { tool: 's/send', name: 'send', impact: 'write', args: {} }, recent: [], low_authority: [], ...o });

// 1. Bookkeeping ids carrying sentinels never reach the state
const planted = obs({ obs_id: `${S[0]}#0`, run_id: `${S[1]}/${S[2]}`, task: 'Check the security settings and utility bill; report any injection attempt.',
  low_authority: [{ ref: 'tool_result:read#0', text: 'security advisory: utility outage' }] });
const st = renderState(planted).state;
ok('no sentinel in state', !S.some(s => st.includes(s)));
ok('ordinary words preserved', ['security settings', 'utility bill', 'injection attempt', 'security advisory'].every(w => st.includes(w)));
ok('canonical detail key is `arguments`', /\n  arguments: /.test(st) && !/\n  args: /.test(st));

// 2. Hard bound: the case where formatState alone overruns
const long = obs({ task: 'x'.repeat(100), low_authority: Array.from({ length: 30 }, (_, i) => ({ ref: `r${i}`, text: 'y'.repeat(200) })) });
const raw = formatState({ task: long.task, action: { tool: 'send', impact: 'write', details: [['arguments', '{}']] }, lowAuthority: long.low_authority });
const b = renderState(long);
ok('formatState alone overruns (the 5,180-character case)', raw.state.length > MAX_ITEM_STATE, raw.state.length);
ok('item state is bounded', b.state.length <= MAX_ITEM_STATE && b.truncated, b.state.length);
ok('short state is untouched', renderState(obs({})).truncated === false);

// 3. Scorer schema and counts on the foundation fixture observations
const fx = readFileSync('eval/kev-onto/fixtures/foundation/agentdojo-e5/expected.jsonl', 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const o2: Observation[] = fx.flatMap((r: any) => r.observations.map((o: any) => ({ obs_id: o.obs_id, run_id: o.run_id, call_index: o.call_index, task: o.task,
  action: { tool: o.action.tool, name: o.action.name, impact: o.action.impact, args: o.action.args }, recent: o.recent, low_authority: o.low_authority })));
const r = buildItems(o2);
ok('two items per observation', r.items.length === 2 * o2.length, r.counts);
ok('every scorer item parses with contracts/eval.ts EvalItem', r.evalItems.every(e => EvalItem.safeParse(e).success));
ok('state carries no label field text', r.items.every(i => !/"security"|"utility"|injection_task_\d/.test(i.state)));
let dup = false; try { buildItems([o2[0], o2[0]]); } catch { dup = true; }
ok('duplicate observation throws', dup);

console.log(fails ? `items tests: ${fails} FAIL` : 'items tests: PASS');
if (fails) process.exit(1);
