// A-S2-4 scale acceptance: generated data only. Streams a >600 MB JSONL (larger than V8's maximum string length,
// 536,870,888) through convert-s2.ts's streaming writer, sanitize-s2.ts and stats-s2.ts's streaming reader, and checks
// sanitize-s2.ts output equals pr/sanitize.ts output byte for byte on a small input.
//   node --max-old-space-size=16384 eval/ontology/s2/fixtures/scale/scale.test.ts
import { execFileSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonl } from '../../convert-s2.ts';
import { readJsonl } from '../../stats-s2.ts';

let fails = 0;
const ok = (n: string, c: boolean, info: unknown = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n} ${info === '' ? '' : JSON.stringify(info)}`); if (!c) fails++; };
const run = (args: string[]) => { try { return { status: 0, out: execFileSync('node', ['--max-old-space-size=16384', ...args], { encoding: 'utf8' }), err: '' }; } catch (e) { const x = e as { status?: number; stderr?: string; stdout?: string }; return { status: x.status ?? 1, out: x.stdout ?? '', err: x.stderr ?? String(e) }; } };
const head = (p: string, n: number): string => { const fd = openSync(p, 'r'); try { const b = Buffer.alloc(n); return b.toString('utf8', 0, readSync(fd, b, 0, n, null)); } finally { closeSync(fd); } };

const TARGET = 600 * 1024 * 1024;   // > 536,870,888, V8's max string length
const dir = mkdtempSync(join(tmpdir(), 's2scale-'));
try {
  const filler = 'x'.repeat(180);
  const row = (i: number) => ({ obs_id: `r${i}#0`, run_id: `run${i}`, model: 'm', suite: 'dailylife', user_task: i, injection_task: 0,
    task: `${filler} task ${i}`, action: { tool: 'dailylife/send_email', name: 'send_email', impact: 'write', args: { recipients: `${filler}@x.example`, body: filler } },
    recent: [], low_authority: Array.from({ length: 20 }, (_, k) => ({ ref: `r${k}`, text: `${filler} <INFORMATION> leak ${i}-${k} </INFORMATION>` })) });
  const rows: unknown[] = [];
  let bytes = 0;
  for (let i = 0; bytes <= TARGET; i++) { const rr = row(i); rows.push(rr); bytes += JSON.stringify(rr).length + 1; }

  const big = join(dir, 'big.jsonl');
  writeJsonl(big, rows);   // streaming: a jl()-style join would throw RangeError: Invalid string length here
  const size = statSync(big).size;
  ok('streaming writer emits a >600 MB JSONL without one big string', size > TARGET, { rows: rows.length, size });

  const san = join(dir, 'big.san.jsonl');
  const r = run(['eval/ontology/s2/sanitize-s2.ts', '--in', big, '--out', san]);
  const m = r.out.trim().match(/^sanitize: (\d+) observations -> /);
  ok('sanitize-s2.ts streams the >600 MB file', r.status === 0 && m !== null && Number(m[1]) === rows.length, { stderr: r.err.slice(-200), stdout: r.out.trim() });
  ok('sanitize-s2.ts removed the INFORMATION wrappers', !/<\/?INFORMATION>/i.test(head(san, 1 << 20)));

  const parsed = readJsonl<{ obs_id: string }>(san);
  ok('stats-s2 reader parses every row line by line', parsed.length === rows.length && parsed[parsed.length - 1].obs_id === `r${rows.length - 1}#0`, { parsed: parsed.length });

  // byte-identity with the frozen sanitizer on a small input
  const small = join(dir, 'small.jsonl');
  writeFileSync(small, [row(0), row(1)].map(x => JSON.stringify(x)).join('\n') + '\n');
  const s2Out = join(dir, 'small.s2.jsonl'), prOut = join(dir, 'small.pr.jsonl');
  run(['eval/ontology/s2/sanitize-s2.ts', '--in', small, '--out', s2Out]);
  execFileSync('node', ['eval/ontology/pr/sanitize.ts', '--in', small, '--out', prOut]);
  ok('sanitize-s2.ts output is byte-identical to pr/sanitize.ts', readFileSync(s2Out).equals(readFileSync(prOut)));
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log(fails ? `scale tests: ${fails} FAIL` : 'scale tests: PASS');
if (fails) process.exit(1);
