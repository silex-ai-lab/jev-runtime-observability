// S1b acceptance: AgentDojo compatibility is byte-identical to runs-convert.ts; S2 conversion output schema; the
// extra-key pass-through; and the out-of-subset tool-id integrity failure.
//   node eval/ontology/s2/fixtures/convert/convert.test.ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertSelectedRunS2, type Binding } from '../../convert-s2.ts';

let fails = 0;
const ok = (n: string, c: boolean, info: unknown = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n} ${info === '' ? '' : JSON.stringify(info)}`); if (!c) fails++; };

const binding: Binding = { tools: { 'agentdyn:dailylife/send_email': { effects: ['core:core-effect-data-write'] }, 'agentdyn:dailylife/browse_webpage': { effects: ['core:core-effect-data-read'] } } };
const meta = { pipeline: 'p', suite: 'dailylife', user_task: 0, injection_task: 1, attack: 'important_instructions', cohort: 'p/important_instructions', group: 'P', base: 'p' };
const mk = (calls: Array<[string, Record<string, unknown>]>, tail: Record<string, unknown> = {}) => ({ messages: calls.flatMap(([fn, args], i) => [
  { role: 'assistant', tool_calls: [{ id: `c${i}`, function: fn, args }] },
  { role: 'tool', tool_call_id: `c${i}`, content: `result ${JSON.stringify(args)}` },
]), injections: { x: 'candidate-1234' }, security: true, utility: false, error: null, ...tail });

const c = convertSelectedRunS2(mk([['browse_webpage', { url: 'www.x.com', 'extra key': 'candidate-1234' }], ['send_email', { recipients: 'a@b.com' }]]), meta, binding);
ok('run id includes the attack and suite', c.label.run_id === 'p/important_instructions/dailylife/user_task_0/injection_task_1', c.label.run_id);
ok('label carries group and base', c.label.group === 'P' && c.label.base === 'p');
ok('raw observations are exactly the S1 schema (no S2-only field)', c.observations.every(o => !('bound_impact' in o.action)) && c.observations[0].action.impact === 'read' && c.observations[1].action.impact === 'write', c.observations.map(o => [o.action.name, o.action.impact, 'bound_impact' in o.action]));
ok('an extra argument key is preserved', (c.observations[0].action.args as Record<string, unknown>)['extra key'] === 'candidate-1234');
ok('d5 carries error/utility/security', c.d5.error_present === false && c.d5.utility === false && c.d5.security === true, c.d5);
ok('low_authority holds the prior tool output', (c.observations[1].low_authority as Array<{ text: string }>)[0].text.includes('candidate-1234'));
ok('an out-of-subset tool id is an integrity failure', (() => { try { convertSelectedRunS2(mk([['mystery_tool', {}]]), meta, binding); return false; } catch (e) { return String((e as Error).message).includes('outside the sealed binding subset'); } })());

// AgentDojo compatibility: byte-identical to runs-convert.ts on the full S1 cohort (regenerated from the pinned archive).
const archive = '../silex-mockup/swm/.cache/agentdojo-repo-089ed468cf3e.tar.gz';
if (!existsSync(archive)) { console.log('ok  AgentDojo byte-identity skipped (archive absent)'); }
else {
  const dir = mkdtempSync(join(tmpdir(), 's2conv-'));
  try {
    execFileSync('node', ['eval/ontology/runs-convert.ts', '--cohorts', 'eval/ontology/s1/cohorts.json', '--out', join(dir, 's1'), '--labels-pr'], { stdio: 'ignore' });
    execFileSync('node', ['eval/ontology/s2/convert-s2.ts', '--mode', 'agentdojo', '--cohorts', 'eval/ontology/s1/cohorts.json', '--archive', archive, '--out', join(dir, 's2')], { stdio: 'ignore' });
    const same = ['observations.jsonl', 'labels.jsonl', 'labels-pr.jsonl', 'counts.json'].every(f => {
      try { execFileSync('diff', ['-q', join(dir, 's1', f), join(dir, 's2', f)], { stdio: 'ignore' }); return true; } catch { return false; }
    });
    ok('AgentDojo mode is byte-identical to runs-convert.ts on the S1 cohort', same);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
console.log(fails ? `convert-s2 tests: ${fails} FAIL` : 'convert-s2 tests: PASS');
if (fails) process.exit(1);
