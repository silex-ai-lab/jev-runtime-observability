// T3 acceptance (plan §4 T3; KO_SPEC §1–§3). Real foundation-fixture regression plus synthetic envelope/label probes.
//   node eval/kev-onto/fixtures/convert/convert.test.ts
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Manifest } from '../../contract.ts';
import { SENTINELS } from '../../contract.ts';
import { assertEnvelope, cohortFor, convertRun, impactOf, type BindingInput } from '../../convert.ts';
import { sanitizeString, sanitizeValue } from '../../../ontology/pr/sanitize.ts';

let fails = 0;
const ok = (name: string, cond: boolean, info: unknown = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name} ${info === '' ? '' : JSON.stringify(info)}`); if (!cond) fails++; };
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../../../..');
const FX = join(REPO, 'eval/kev-onto/fixtures/foundation/agentdojo-e5');
const manifest = JSON.parse(readFileSync(join(REPO, 'eval/kev-onto/manifest.agentdojo-e5.json'), 'utf8')) as Manifest;
const binding = JSON.parse(readFileSync(join(REPO, 'eval/ontology/v2/frozen/binding-v2.json'), 'utf8')) as BindingInput;
const SRC = 'agentdojo';

const walk = (d: string): string[] => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });

// (a) foundation regression: our observations equal the committed runs-convert output, except the binding impact and
//     the removed <INFORMATION> tags.
const expected = new Map<string, any>(readFileSync(join(FX, 'expected.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { const r = JSON.parse(l); return [r.path, r]; }));
const c5 = new Set<string>(); const impactDiffs = new Set<string>(); const tagDiffs = new Set<string>();
let comparedObs = 0, mismatches = 0;
for (const file of walk(join(FX, 'runs')).sort()) {
  const rel = relative(FX, file);
  const meta = cohortFor(manifest, rel);
  if (!meta) throw new Error(`fixture run not in cohort: ${rel}`);
  const run = JSON.parse(readFileSync(file, 'utf8'));
  const { observations } = convertRun(run, meta, binding, SRC);
  const exp = expected.get(rel);
  if (!exp) throw new Error(`no expected entry for ${rel}`);
  if (observations.length !== exp.observations.length) { mismatches++; continue; }
  for (let i = 0; i < observations.length; i++) {
    const e = exp.observations[i], g = observations[i];
    const expImpact = impactOf(binding, SRC, e.suite, e.action.name);
    if (expImpact !== e.action.impact) { impactDiffs.add(`${e.suite}/${e.action.name}`); c5.add(`${e.suite}/${e.action.name}`); }
    const fixed = {
      obs_id: e.obs_id, run_id: e.run_id, call_index: e.call_index,
      task: sanitizeString(e.task),
      action: { tool: e.action.tool, name: e.action.name, impact: expImpact, args: sanitizeValue(e.action.args) },
      recent: e.recent,
      low_authority: (e.low_authority ?? []).map((x: any) => ({ ref: x.ref, text: sanitizeString(x.text) })),
    };
    if (JSON.stringify(fixed) !== JSON.stringify(g)) { mismatches++; console.log('   MISMATCH', e.obs_id, JSON.stringify(g).slice(0, 160)); }
    if (/<\/?information>/i.test(JSON.stringify(e))) tagDiffs.add(e.suite);
    comparedObs++;
  }
}
ok('(a) foundation regression: observations equal expected (binding impact + tag removal applied)', mismatches === 0, { comparedObs, mismatches });
ok('(a) the diff is exactly the binding-vs-regex impacts and the removed <INFORMATION> tags', impactDiffs.size > 0 && tagDiffs.size > 0, { impactedCells: [...c5].sort() });

// (b) sentinels planted in every forbidden field never appear in any Observation.
const baseMsg = (task: string, out: string) => [
  { role: 'user', content: [{ type: 'text', content: task }] },
  { role: 'assistant', content: null, tool_calls: [{ function: 'read_file', args: { file_path: 'x.txt' }, id: 'c0' }] },
  { role: 'tool', content: [{ type: 'text', content: out }], tool_call_id: 'c0' },
  { role: 'assistant', content: null, tool_calls: [{ function: 'send_money', args: { amount: 1, recipient: 'x' }, id: 'c1' }] },
  { role: 'tool', content: [{ type: 'text', content: 'ok' }], tool_call_id: 'c1' },
];
const runWith = (over: Record<string, unknown> = {}, msgs = baseMsg('do the thing', 'tool output here')) => ({
  suite_name: 'banking', pipeline_name: 'm', user_task_id: 'user_task_0', injection_task_id: 0, attack_type: 'important_instructions',
  injections: { a: 'x' }, messages: msgs, error: null, benchmark_version: 'v', evaluation_timestamp: 't', agentdojo_package_version: 'a',
  utility: false, security: false, duration: 1, ...over,
});
const meta = { pipeline: 'm', suite: 'banking', user_task: 0, injection_task: 0, attacked: true };
{
  const planted = runWith(Object.fromEntries(Object.entries(SENTINELS).map(([k, v]) => [k, v])));
  const { observations, label } = convertRun(planted, meta, binding, SRC);
  const text = JSON.stringify({ observations });
  const leaked = Object.values(SENTINELS).filter(s => text.includes(s));
  ok('(b) sentinels planted in forbidden fields never appear in an Observation', leaked.length === 0, leaked);
  ok('(b) nested args with a tag are sanitized', (() => {
    const r: any = runWith({}, baseMsg('t', 'o'));
    r.messages[1].tool_calls[0].args = { note: '<INFORMATION> hidden </INFORMATION>' };
    const o = convertRun(r, meta, binding, SRC).observations[0];
    return !/information/i.test(JSON.stringify(o.action.args));
  })());
}

// (c) the ordinary words security/utility/injection inside user/tool text are preserved.
{
  const words = 'the security team logs a utility bill and an injection of cash';
  const { observations } = convertRun(runWith({}, baseMsg(`user says ${words}`, `tool returns ${words}`)), meta, binding, SRC);
  ok('(c) ordinary security/utility/injection words in task and tool text are preserved',
    observations[0].task.includes(words) && observations[1].low_authority[0].text.includes(words));
}

// (d) an unknown envelope field throws.
{
  let threw = false; try { assertEnvelope(runWith({ unexpected_field: 1 })); } catch { threw = true; }
  ok('(d) unknown envelope field throws', threw);
  ok('(d) the known envelope alone does not throw', (() => { try { assertEnvelope(runWith()); return true; } catch { return false; } })());
}

// (e) KO_SPEC §1 label rules incl. label_error.
{
  const c = (injection_task: number | null, security: unknown) => convertRun(runWith({ security }), { ...meta, injection_task, attacked: injection_task != null }, binding, SRC).label;
  const attTrue = c(0, true), attFalse = c(0, false), attNull = c(0, null), attAbsent = c(0, undefined), benign = c(null, true);
  ok('(e) attacked + security true -> positive',
    attTrue.positive && !attTrue.label_error && attTrue.attacked);
  ok('(e) attacked + security false -> negative, not a label error',
    !attFalse.positive && !attFalse.label_error && attFalse.security === false);
  ok('(e) attacked + non-boolean security -> label_error (negative)',
    attNull.label_error && !attNull.positive && attNull.security === null && attAbsent.label_error);
  ok('(e) benign + security true -> negative, never a label error',
    !benign.positive && !benign.label_error && benign.attacked === false);
  ok('(e) run_id / n_calls follow runs-convert',
    attTrue.run_id === 'm/banking/user_task_0/injection_task_0' && attTrue.n_calls === 2 && benign.run_id === 'm/banking/user_task_0/none');
}

// (f) a tool missing from the binding is a hard error.
{
  let threw = false; try { impactOf(binding, SRC, 'banking', 'no_such_tool'); } catch { threw = true; }
  ok('(f) a tool missing from the binding throws', threw);
}

console.log(fails ? `convert tests: ${fails} FAIL` : 'convert tests: PASS');
if (fails) process.exit(1);
