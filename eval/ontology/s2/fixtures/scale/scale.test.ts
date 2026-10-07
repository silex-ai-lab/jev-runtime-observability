// A-S2-4 scale acceptance: generated data only. (A) streams a >600 MB JSONL (larger than V8's maximum string length,
// 536,870,888) through convert-s2.ts's streaming writer, sanitize-s2.ts and stats-s2.ts's streaming reader, and checks
// sanitize-s2.ts equals pr/sanitize.ts byte for byte on a small input. (B) drives the ACTUAL converter archive-read path
// (readS2 -> temp spool -> line reader -> writer) on a synthetic tarball whose selected runs exceed the V8 limit.
//   node --max-old-space-size=16384 eval/ontology/s2/fixtures/scale/scale.test.ts
import { execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertS2, writeJsonl } from '../../convert-s2.ts';
import { readJsonl } from '../../stats-s2.ts';

let fails = 0;
const ok = (n: string, c: boolean, info: unknown = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n} ${info === '' ? '' : JSON.stringify(info)}`); if (!c) fails++; };
const run = (args: string[]) => { try { return { status: 0, out: execFileSync('node', ['--max-old-space-size=16384', ...args], { encoding: 'utf8' }), err: '' }; } catch (e) { const x = e as { status?: number; stderr?: string; stdout?: string }; return { status: x.status ?? 1, out: x.stdout ?? '', err: x.stderr ?? String(e) }; } };
const head = (p: string, n: number): string => { const fd = openSync(p, 'r'); try { const b = Buffer.alloc(n); return b.toString('utf8', 0, readSync(fd, b, 0, n, null)); } finally { closeSync(fd); } };

const LIMIT = 536870888;              // V8's maximum string length
const TARGET = 600 * 1024 * 1024;    // > LIMIT
const dir = mkdtempSync(join(tmpdir(), 's2scale-'));
try {
  // (A) streaming writer / sanitizer / stats reader
  {
    const filler = 'x'.repeat(180);
    const row = (i: number) => ({ obs_id: `r${i}#0`, run_id: `run${i}`, model: 'm', suite: 'dailylife', user_task: i, injection_task: 0,
      task: `${filler} task ${i}`, action: { tool: 'dailylife/send_email', name: 'send_email', impact: 'write', args: { recipients: `${filler}@x.example`, body: filler } },
      recent: [], low_authority: Array.from({ length: 20 }, (_, k) => ({ ref: `r${k}`, text: `${filler} <INFORMATION> leak ${i}-${k} </INFORMATION>` })) });
    const rows: unknown[] = [];
    let bytes = 0;
    for (let i = 0; bytes <= TARGET; i++) { const rr = row(i); rows.push(rr); bytes += JSON.stringify(rr).length + 1; }

    const big = join(dir, 'big.jsonl');
    writeJsonl(big, rows);   // streaming: a jl()-style join would throw RangeError: Invalid string length here
    ok('streaming writer emits a >600 MB JSONL without one big string', statSync(big).size > TARGET, { rows: rows.length, size: statSync(big).size });

    const san = join(dir, 'big.san.jsonl');
    const r = run(['eval/ontology/s2/sanitize-s2.ts', '--in', big, '--out', san]);
    const m = r.out.trim().match(/^sanitize: (\d+) observations -> /);
    ok('sanitize-s2.ts streams the >600 MB file', r.status === 0 && m !== null && Number(m[1]) === rows.length, { stderr: r.err.slice(-200), stdout: r.out.trim() });
    ok('sanitize-s2.ts removed the INFORMATION wrappers', !/<\/?INFORMATION>/i.test(head(san, 1 << 20)));

    const parsed = readJsonl<{ obs_id: string }>(san);
    ok('stats-s2 reader parses every row line by line', parsed.length === rows.length && parsed[parsed.length - 1].obs_id === `r${rows.length - 1}#0`, { parsed: parsed.length });

    const small = join(dir, 'small.jsonl');
    writeFileSync(small, [row(0), row(1)].map(x => JSON.stringify(x)).join('\n') + '\n');
    const s2Out = join(dir, 'small.s2.jsonl'), prOut = join(dir, 'small.pr.jsonl');
    run(['eval/ontology/s2/sanitize-s2.ts', '--in', small, '--out', s2Out]);
    execFileSync('node', ['eval/ontology/pr/sanitize.ts', '--in', small, '--out', prOut]);
    ok('sanitize-s2.ts output is byte-identical to pr/sanitize.ts', readFileSync(s2Out).equals(readFileSync(prOut)));
  }

  // (B) the actual converter archive-read path above the V8 limit
  {
    const N = 6, BIG = 'x'.repeat(95_000_000);
    const src = join(dir, 'src'), runs = join(src, 'runs', 'p1', 'dailylife');
    const wr = (p: string, o: unknown) => writeFileSync(p, JSON.stringify(o));
    let rawBytes = 0;
    for (let i = 0; i < N; i++) {
      const d = join(runs, `user_task_${i}`, 'important_instructions'); mkdirSync(d, { recursive: true });
      const calls = (id: string) => ({ role: 'assistant', content: null, tool_calls: [{ id, function: 'send_email', args: {} }] });
      const out = (id: string, content: unknown) => ({ role: 'tool', tool_call_id: id, content });
      const runObj = { suite_name: 'dailylife', pipeline_name: 'p1', user_task_id: `user_task_${i}`, injection_task_id: 'injection_task_0',
        attack_type: 'important_instructions', injections: {},
        messages: [{ role: 'system', content: 's' }, { role: 'user', content: 't' }, calls('c0'), out('c0', BIG), calls('c1'), out('c1', 'ok')],
        error: null, security: true, utility: true };
      const f = join(d, 'injection_task_0.json'); wr(f, runObj); rawBytes += statSync(f).size;
    }
    ok('the synthetic archive corpus exceeds the V8 string limit', rawBytes > LIMIT, { rawBytes, runs: N });

    const cohorts = join(dir, 'cohorts.json'); wr(cohorts, [{ pipeline: 'p1', attack: 'important_instructions', clean: true, group: 'P', base: 'p' }]);
    const manifest = join(dir, 'manifest.json');
    wr(manifest, { source: { root_prefix: '' }, path_regex: '^runs/(?<pipeline>[^/]+)/(?<suite>[^/]+)/user_task_(?<user_task>\\d+)/(?:important_instructions/injection_task_(?<injection_task>\\d+)|none/none)\\.json$',
      pipelines: ['p1'], suites: ['dailylife'], expected: { p1: { dailylife: { attacked: N, benign: 0 } } }, total_runs: N });
    const binding = join(dir, 'binding.json'); wr(binding, { tools: { 'agentdyn:dailylife/send_email': { effects: ['core:core-effect-data-write'] } } });
    const registered = join(dir, 'registered.json'); wr(registered, { tools: [{ id: 'agentdyn:dailylife/send_email' }] });
    const tar = join(dir, 'conv.tar.gz'); execFileSync('tar', ['-czf', tar, '-C', src, 'runs']);
    const out = join(dir, 'conv-out');
    const counts = convertS2(tar, cohorts, manifest, binding, registered, '', out);
    ok('converter archive reader streams the >536,870,888-char corpus', counts.runs === N && statSync(join(out, 'observations.jsonl')).size > LIMIT,
      { runs: counts.runs, calls: counts.calls, obs: statSync(join(out, 'observations.jsonl')).size });
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log(fails ? `scale tests: ${fails} FAIL` : 'scale tests: PASS');
if (fails) process.exit(1);
