// S1b acceptance: AgentDojo compatibility is byte-identical to runs-convert.ts; S2 conversion output schema; the
// extra-key pass-through; the out-of-subset tool-id integrity failure; D7 envelope validation; and manifest+seal
// selection (other-root and partial-cell fail closed).
//   node eval/ontology/s2/fixtures/convert/convert.test.ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertS2, convertSelectedRunS2, validateEnvelope, type Binding } from '../../convert-s2.ts';
import { convertRun } from '../../../runs-convert.ts';

let fails = 0;
const ok = (n: string, c: boolean, info: unknown = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n} ${info === '' ? '' : JSON.stringify(info)}`); if (!c) fails++; };
const thrown = (f: () => unknown): string | null => { try { f(); return null; } catch (e) { return String((e as Error).message); } };

const binding: Binding = { tools: { 'agentdyn:dailylife/send_email': { effects: ['core:core-effect-data-write'] }, 'agentdyn:dailylife/browse_webpage': { effects: ['core:core-effect-data-read'] }, 'agentdyn:github/send_email': { effects: ['core:core-effect-data-write'] } } };
const registered = new Set(Object.keys(binding.tools));
const meta = { pipeline: 'p', suite: 'dailylife', user_task: 0, injection_task: 1, attack: 'important_instructions', cohort: 'p/important_instructions', group: 'P', base: 'p' };
const mkMessages = (calls: Array<[string, Record<string, unknown>]>) => ([{ role: 'system', content: 's' }, { role: 'user', content: 'task' },
  ...calls.flatMap(([fn, args], i) => [{ role: 'assistant', tool_calls: [{ id: `c${i}`, function: fn, args }] }, { role: 'tool', tool_call_id: `c${i}`, content: `result ${JSON.stringify(args)}` }])]);
const mk = (calls: Array<[string, Record<string, unknown>]>, extra: Record<string, unknown> = {}) => ({ messages: mkMessages(calls), injections: { x: 'candidate-1234' }, error: null, security: true, utility: false, ...extra });

const c = convertSelectedRunS2(mk([['browse_webpage', { url: 'www.x.com', 'extra key': 'candidate-1234' }], ['send_email', { recipients: 'a@b.com' }]]), meta, binding, registered);
ok('run id includes the attack and suite', c.label.run_id === 'p/important_instructions/dailylife/user_task_0/injection_task_1', c.label.run_id);
ok('label carries group and base', c.label.group === 'P' && c.label.base === 'p');
ok('raw observations are exactly the S1 schema (no S2-only field)', c.observations.every(o => !('bound_impact' in o.action)) && c.observations[0].action.impact === 'read' && c.observations[1].action.impact === 'write', c.observations.map(o => [o.action.name, o.action.impact, 'bound_impact' in o.action]));
ok('an extra argument key is preserved', (c.observations[0].action.args as Record<string, unknown>)['extra key'] === 'candidate-1234');
ok('d5 carries error/utility/security', c.d5.error_present === false && c.d5.utility === false && c.d5.security === true, c.d5);
ok('low_authority holds the prior tool output', (c.observations[1].low_authority as Array<{ text: string }>)[0].text.includes('candidate-1234'));
ok('an unregistered tool call is kept and reported by name (A-S2-2)', (() => { const k = convertSelectedRunS2(mk([['download_file', {}]]), meta, binding, registered); return k.observations.length === 1 && k.observations[0].action.name === 'download_file' && k.unregistered.includes('download_file'); })());
ok('a registered-but-unbound tool id is an integrity failure (A-S2-2)', thrown(() => convertSelectedRunS2(mk([['ghost_tool', {}]]), meta, binding, new Set([...registered, 'agentdyn:dailylife/ghost_tool'])))?.includes('registered_unbound_tool') === true);

// D7 envelope validation
ok('a no-messages envelope fails', thrown(() => validateEnvelope({ security: true }))?.includes('messages must be an array') === true);
ok('non-array messages fail', thrown(() => validateEnvelope({ messages: 'x' }))?.includes('messages must be an array') === true);
ok('a top-level field outside the schema is accepted and returned by name (A-S2-1)', (() => { const e = validateEnvelope({ messages: [], build_constraints: { x: 1 } }); return Array.isArray(e) && e.includes('build_constraints'); })());
ok('a bogus role fails', thrown(() => validateEnvelope({ messages: [{ role: 'bogus', content: 'x' }] }))?.includes('unsupported message role: bogus') === true);
ok('a message without a role fails', thrown(() => validateEnvelope({ messages: [{ content: 'x' }] }))?.includes('unsupported message role') === true);
ok('a user message carrying tool_calls fails', thrown(() => validateEnvelope({ messages: [{ role: 'user', content: 'x', tool_calls: [{ function: 'f', args: {} }] }] }))?.includes('only assistant messages may carry tool_calls') === true);
ok('a tool call without a function name fails', thrown(() => validateEnvelope({ messages: [{ role: 'assistant', tool_calls: [{ id: 'c' }] }] }))?.includes('without a function name') === true);
ok('tool-call args that are not an object fail', thrown(() => validateEnvelope({ messages: [{ role: 'assistant', tool_calls: [{ function: 'x', args: 5 }] }] }))?.includes('args must be an object') === true);
ok('assistant tool_calls:null is accepted', thrown(() => validateEnvelope({ messages: [{ role: 'assistant', content: null, tool_calls: null }] })) === null);
ok('a call-free run passes envelope validation', thrown(() => validateEnvelope({ messages: mkMessages([]) })) === null);
ok('an error run passes envelope validation', thrown(() => validateEnvelope({ messages: mkMessages([]), error: 'boom' })) === null);
{
  const nullCalls = { messages: [...mkMessages([]), { role: 'assistant', content: null, tool_calls: null }], error: null, security: true, utility: true, injections: {} };
  const viaLegacy = convertRun(nullCalls as never, { model: 'p', suite: 'dailylife', user_task: 0, injection_task: 1 } as never);
  const viaS2 = convertSelectedRunS2(nullCalls, meta, binding, registered);
  ok('assistant tool_calls:null converts like runs-convert.ts (0 calls)', viaS2.observations.length === 0 && viaS2.observations.length === viaLegacy.observations.length);
}
{
  const withExtra = mk([['send_email', { recipients: 'a@b.com' }]], { build_constraints: { secret: 'ZZ_SENTINEL_BUILD' } });
  const conv = convertSelectedRunS2(withExtra, meta, binding, registered);
  const blob = JSON.stringify({ o: conv.observations, l: conv.label, d: conv.d5 });
  ok('an extra top-level field is accepted and its name returned (A-S2-1)', conv.extraFields.includes('build_constraints'), conv.extraFields);
  ok('the extra field value never appears in any output', !blob.includes('ZZ_SENTINEL_BUILD'));
}

// S2 selection: manifest root/regex/cells + optional seal
const root = mkdtempSync(join(tmpdir(), 's2sel-'));
const ROOTP = 'R/';
const suites = ['dailylife', 'github'];
const pipes = ['p1', 'p2'];
const run = (p: string, s: string, attacked: boolean, extra?: Record<string, unknown>, tool = 'send_email') => ({ suite_name: s, pipeline_name: p, user_task_id: 'user_task_0', injection_task_id: attacked ? 'injection_task_0' : null,
  attack_type: attacked ? 'important_instructions' : null, injections: {}, messages: mkMessages([[tool, { recipients: 'a@b.com' }]]), error: null,
  benchmark_version: 'v1.2.2', evaluation_timestamp: 'x', agentdojo_package_version: '0.1.35', utility: true, security: true, duration: 1, ...extra });
const pathRegex = '^runs/(?<pipeline>[^/]+)/(?<suite>[^/]+)/user_task_(?<user_task>\\d+)/(?:important_instructions/injection_task_(?<injection_task>\\d+)|none/none)\\.json$';
const expected = Object.fromEntries(pipes.map(p => [p, Object.fromEntries(suites.map(s => [s, { attacked: 1, benign: 1 }]))]));
const manifest = { source: { root_prefix: ROOTP }, path_regex: pathRegex, pipelines: pipes, suites, expected, total_runs: 8, strata: 4 };
function stage(extraOtherRoot = false, topLevel = false, tool = 'send_email') {
  const dir = join(root, 'stage'); rmSync(dir, { recursive: true, force: true });
  for (const p of pipes) for (const s of suites) {
    const base = join(dir, 'R', 'runs', p, s, 'user_task_0');
    mkdirSync(join(base, 'important_instructions'), { recursive: true }); mkdirSync(join(base, 'none'), { recursive: true });
    const p1extra = p === 'p1' ? { build_constraints: { secret: 'ZZ_SENTINEL_BUILD' } } : undefined;
    writeFileSync(join(base, 'important_instructions', 'injection_task_0.json'), JSON.stringify(run(p, s, true, p1extra, tool)));
    writeFileSync(join(base, 'none', 'none.json'), JSON.stringify(run(p, s, false, p1extra, tool)));
  }
  if (extraOtherRoot) { const b = join(dir, 'S', 'runs', 'p1', 'dailylife', 'user_task_0', 'important_instructions'); mkdirSync(b, { recursive: true });
    writeFileSync(join(b, 'injection_task_0.json'), JSON.stringify(run('p1', 'dailylife', true))); }
  if (topLevel) { const b = join(dir, 'runs', 'p1', 'dailylife', 'user_task_0', 'important_instructions'); mkdirSync(b, { recursive: true });
    writeFileSync(join(b, 'injection_task_0.json'), JSON.stringify(run('p1', 'dailylife', true))); }
  const tar = join(root, 'sel.tgz'); execFileSync('tar', ['-czf', tar, '-C', dir, ...['R', ...(extraOtherRoot ? ['S'] : []), ...(topLevel ? ['runs'] : [])]]); return tar;
}
try {
  writeFileSync(join(root, 'cohorts.json'), JSON.stringify(pipes.map(p => ({ pipeline: p, attack: 'important_instructions', clean: true, group: 'P', base: p }))));
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
  const bind = join(root, 'binding.json'); writeFileSync(bind, JSON.stringify(binding));
  const regPath = join(root, 'registered.json'); writeFileSync(regPath, JSON.stringify({ tools: [...registered].map(id => ({ id })) }));
  const tar = stage();
  const good = convertS2(tar, join(root, 'cohorts.json'), join(root, 'manifest.json'), bind, regPath, '', join(root, 'out-good'));
  ok('convertS2 enforces the manifest cells and total', good.runs === 8 && (good.per_cohort_runs as Record<string, number>)['p1/important_instructions'] === 4, good);
  ok('extra envelope field names are counted per pipeline (A-S2-1)', (good.extra_envelope_fields as Record<string, Record<string, number>>).p1.build_constraints === 4 && !('p2' in (good.extra_envelope_fields as Record<string, unknown>)), good.extra_envelope_fields);
  const goodOut = ['observations.jsonl', 'labels.jsonl', 'labels-d5.jsonl'].map(f => readFileSync(join(root, 'out-good', f), 'utf8')).join('');
  ok('the extra field value never appears in the converted outputs', !goodOut.includes('ZZ_SENTINEL_BUILD'));
  const badManifest = join(root, 'manifest-bad.json'); const m2 = JSON.parse(JSON.stringify(manifest)); m2.expected.p1.dailylife.attacked = 2; writeFileSync(badManifest, JSON.stringify(m2));
  ok('a partial cell fails closed', thrown(() => convertS2(tar, join(root, 'cohorts.json'), badManifest, bind, regPath, '', join(root, 'out-bad')))?.includes('cell p1/dailylife') === true);
  ok('a matching path under another root fails closed', thrown(() => convertS2(stage(true), join(root, 'cohorts.json'), join(root, 'manifest.json'), bind, regPath, '', join(root, 'out-intr')))?.includes('archive reader failed') === true);
  ok('a top-level runs/ path is a root mismatch', thrown(() => convertS2(stage(false, true), join(root, 'cohorts.json'), join(root, 'manifest.json'), bind, regPath, '', join(root, 'out-top')))?.includes('archive reader failed') === true);
  // seal: only sealed paths are parsed; an unsealed manifest-matching run is a membership mismatch
  const tarForSeal = stage();
  execFileSync('node', ['eval/ontology/s2/fetch-s2.ts', '--manifest', join(root, 'manifest.json'), '--tar', tarForSeal, '--out', join(root, 'seal.json')]);
  ok('convertS2 succeeds with the matching seal', convertS2(tarForSeal, join(root, 'cohorts.json'), join(root, 'manifest.json'), bind, regPath, join(root, 'seal.json'), join(root, 'out-seal')).runs === 8);
  // now an extra manifest-matching run under the root, absent from the seal -> membership mismatch
  const extra = join(root, 'stage', 'R', 'runs', 'p1', 'github', 'user_task_1', 'important_instructions'); mkdirSync(extra, { recursive: true });
  writeFileSync(join(extra, 'injection_task_0.json'), JSON.stringify(run('p1', 'github', true)));
  execFileSync('tar', ['-czf', join(root, 'sel2.tgz'), '-C', join(root, 'stage'), 'R']);
  ok('an unsealed manifest-matching run is a membership mismatch', thrown(() => convertS2(join(root, 'sel2.tgz'), join(root, 'cohorts.json'), join(root, 'manifest.json'), bind, regPath, join(root, 'seal.json'), join(root, 'out-mm')))?.includes('membership differs from the seal') === true);

  // A-S2-2: unregistered calls are kept and counted by name per suite; a registered-but-unbound tool fails.
  const tarUnreg = stage(false, false, 'download_file');
  const unreg = convertS2(tarUnreg, join(root, 'cohorts.json'), join(root, 'manifest.json'), bind, regPath, '', join(root, 'out-unreg'));
  const utc = unreg.unregistered_tool_calls as Record<string, Record<string, number>>;
  ok('an unregistered tool call is kept and counted by name per suite (A-S2-2)', utc.dailylife?.download_file === 4 && utc.github?.download_file === 4, utc);
  ok('the unregistered call is present in the raw observations (S1 schema)', readFileSync(join(root, 'out-unreg', 'observations.jsonl'), 'utf8').includes('"name":"download_file"'));
  const regGhost = join(root, 'registered-ghost.json'); writeFileSync(regGhost, JSON.stringify({ tools: [...registered, 'agentdyn:dailylife/ghost_tool'].map(id => ({ id })) }));
  const ghostErr = thrown(() => convertS2(stage(false, false, 'ghost_tool'), join(root, 'cohorts.json'), join(root, 'manifest.json'), bind, regGhost, '', join(root, 'out-ghost')));
  const ghostReport = JSON.parse(readFileSync(join(root, 'out-ghost', 'integrity-report.json'), 'utf8'));
  ok('a registered-but-unbound tool fails and is named in the integrity report (A-S2-2)', ghostErr?.includes('integrity failure') === true && ghostReport.categories.registered_unbound_tool.ids.includes('agentdyn:dailylife/ghost_tool'), ghostReport.categories);
  ok('no observations or labels are written on an integrity failure', !existsSync(join(root, 'out-ghost', 'observations.jsonl')) && !existsSync(join(root, 'out-ghost', 'labels.jsonl')));
  // one pass: two different integrity failures in one archive are both reported
  function stageTwoFailures() {
    const dir = join(root, 'staget'); rmSync(dir, { recursive: true, force: true });
    for (const p of pipes) for (const s of suites) {
      const base = join(dir, 'R', 'runs', p, s, 'user_task_0');
      mkdirSync(join(base, 'important_instructions'), { recursive: true }); mkdirSync(join(base, 'none'), { recursive: true });
      const tool = (p === 'p1' && s === 'dailylife') ? 'ghost_tool' : 'send_email';
      const att = (p === 'p1' && s === 'github') ? run(p, s, true, { messages: 'not-an-array' }) : run(p, s, true, undefined, tool);
      writeFileSync(join(base, 'important_instructions', 'injection_task_0.json'), JSON.stringify(att));
      writeFileSync(join(base, 'none', 'none.json'), JSON.stringify(run(p, s, false, undefined, tool)));
    }
    const tar = join(root, 'twofail.tgz'); execFileSync('tar', ['-czf', tar, '-C', dir, 'R']); return tar;
  }
  const twoErr = thrown(() => convertS2(stageTwoFailures(), join(root, 'cohorts.json'), join(root, 'manifest.json'), bind, regGhost, '', join(root, 'out-two')));
  const twoRep = JSON.parse(readFileSync(join(root, 'out-two', 'integrity-report.json'), 'utf8'));
  ok('two different integrity failures in one archive are both reported in one pass', twoErr?.includes('integrity failure') === true
    && twoRep.categories.registered_unbound_tool?.count >= 1 && twoRep.categories.malformed_envelope?.count >= 1, twoRep.categories);
  ok('the integrity report carries categories, counts and identifier names only', twoRep.categories.malformed_envelope.ids.every((x: string) => x.endsWith('.json'))
    && !/security|utility|ZZ_SENTINEL/.test(JSON.stringify(twoRep)) && !existsSync(join(root, 'out-two', 'observations.jsonl')));
} finally { rmSync(root, { recursive: true, force: true }); }

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
