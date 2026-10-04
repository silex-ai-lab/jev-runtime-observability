// Shared synthetic fixtures for stats-s1.ts (data/ is also the input for recheck_s1.py). Built from the E-PR synthetic world; no held-out data.
//   node eval/ontology/s1/fixtures/stats/test.ts
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run, type Lab } from '../../stats-s1.ts';
import type { Obs } from '../../../v2/typing.ts';

const SRC = 'eval/ontology/pr/fixtures/stats/data/good', D = 'eval/ontology/s1/fixtures/stats/data';
let fails = 0;
const check = (n: string, ok: boolean, info: unknown = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${n} ${typeof info === 'string' ? info : JSON.stringify(info)}`); if (!ok) fails++; };
const readJsonl = <T>(p: string): T[] => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as T);
rmSync(D, { recursive: true, force: true });
const obs = readJsonl<Obs>(join(SRC, 'input/observations.sanitized.jsonl'));
const base = readJsonl<Lab & { model: string }>(join(SRC, 'input/labels.jsonl'));
const lpr = readJsonl<{ run_id: string; injection_overlap: boolean }>(join(SRC, 'input/labels-pr.jsonl'));
const frozen = (f: string) => JSON.parse(readFileSync(join(SRC, 'frozen', f), 'utf8'));
const ctx = { obs, overlap: new Map(lpr.map(x => [x.run_id, x.injection_overlap])), snap: frozen('snapshot.json') as never,
  manifest: frozen('tool-manifest-v2.json').tools as never, binding: frozen('binding-v2.json'), reps: 400, nDraws: 100 };
const PIPES = ['claude-a', 'claude-b', 'gpt-4o-2024-05-13', 'gpt-4o-2024-05-13-tool_filter', 'gemini-x', 'gpt-3.5', 'llm-z'];
function world(name: string, pipe: (l: Lab) => string) {
  const labels = base.map(l => { const p = pipe(l); return { ...l, model: p, pipeline: p, attack: l.attacked ? 'important_instructions' : null, cohort: `${p}/important_instructions` }; });
  const dir = join(D, name); mkdirSync(dir, { recursive: true }); cpSync(join(SRC, 'frozen'), join(dir, 'frozen'), { recursive: true });
  const jl = (a: unknown[]) => a.map(x => JSON.stringify(x)).join('\n') + '\n';
  writeFileSync(join(dir, 'observations.jsonl'), jl(obs)); writeFileSync(join(dir, 'labels.jsonl'), jl(labels)); writeFileSync(join(dir, 'labels-pr.jsonl'), jl(lpr));
  return run({ ...ctx, labels });
}
const out: Record<string, unknown> = {};
const prGood = (JSON.parse(readFileSync('eval/ontology/pr/fixtures/stats/data/expected-summary.json', 'utf8')).results.good.secondary.ablations.stage1_only);
// six: 7 pipelines → 6 base models (two gpt-4o pipelines merge)
const six = world('six', l => PIPES[l.user_task % 7]);
check('six: s1 = E-PR stage1_only on the same world', six.observed.s1.F === prGood.F && six.observed.s1.TP === prGood.TP, { s1: six.observed.s1, prGood });
check('six: K = 6, gpt-4o variants form one base', six.counts.K === 6 && 'gpt-4o-2024-05-13' in six.constraint.per_base && !('gpt-4o-2024-05-13-tool_filter' in six.constraint.per_base), six.counts);
check('six: groups P, X1, X2', JSON.stringify(Object.keys(six.secondary.groups)) === '["P","X1","X2"]');
const theta = Object.values(six.constraint.per_base).reduce((a, b) => a + b, 0) / 6;
check('six: theta = mean of d_k; holds as defined', six.constraint.theta === theta && six.constraint.holds === (theta >= -0.03 && six.constraint.pooled_d! >= -0.03), six.constraint);
check('six: verdict follows p_H15 and constraint', six.verdict === (six.p_H15 <= 0.05 && six.constraint.holds ? 'supported' : 'not supported'), { p: six.p, v: six.verdict, f: six.failed });
out.six = six;
// four: 4 base models → inconclusive
const four = world('four', l => ['claude-a', 'claude-b', 'gemini-x', 'gpt-3.5'][l.user_task % 4]);
check('four: K = 4 → inconclusive, p null', four.counts.K === 4 && four.verdict === 'inconclusive' && four.p.a === null && four.ci.precision_vs_prov === null, four.counts);
out.four = four;
// zero: a pipeline holding only clean runs has no positive → dropped
const zero = world('zero', l => (l.injection_task == null && l.user_task % 2 === 0 ? 'cleanonly' : PIPES[l.user_task % 7]));
check('zero: clean-only base dropped, K = 6', zero.counts.dropped.includes('cleanonly') && zero.counts.K === 6 && !('cleanonly' in zero.constraint.per_base), zero.counts);
out.zero = zero;
writeFileSync(join(D, 'expected-summary.json'), JSON.stringify({ reps: 400, draws: 100, results: out }, null, 1));
if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log('all S1 stats fixtures pass');
