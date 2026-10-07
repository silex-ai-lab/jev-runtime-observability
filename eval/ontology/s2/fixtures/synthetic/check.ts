// Synthetic S2 validation suite (plan §3 S1e): feeds every case under cases/ to both
// implementations (stats-s2.ts on pr/sanitize.ts output; recheck_s2.py on raw output), compares
// each to the reference-expected outputs in expected.json under S1's comparison contract
// (floats to 1e-9; exact for p.a/p.c/p_H15/verdict/failed/constraint.holds/p_signflip and nulls),
// re-derives the run-flag aggregates from expected.json, and checks the auxiliary fixtures
// (constraint boundaries, random-typing counts, crossed-weight trace, fail-closed inputs).
//
//   node eval/ontology/s2/fixtures/synthetic/check.ts [--tmp <dir>] [--only <case>]
//
// Run from the repo root. Runtime artifacts go to a fresh temp dir (never into the repo).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constraint } from '../../../s1/stats-s1.ts';
import { validateS2Cohorts } from '../../convert-s2.ts';
import { randTyping, manifestFromBinding, SEED } from '../../stats-s2.ts';
import { typing as typingFn } from '../../../v2/typing.ts';
import { mulberry } from '../../../arms.ts';

const ROOT = process.cwd();
if (!readFileSync(join(ROOT, 'eval/ontology/s2/S2_SPEC.md'), 'utf8')) {
  console.error('run from the jev-runtime-observability repo root');
  process.exit(2);
}
const arg = (k: string): string | undefined => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const TMP = arg('--tmp') ?? mkdtempSync(join(tmpdir(), 's2fix-'));
const ONLY = arg('--only');
mkdirSync(TMP, { recursive: true });

const BASE = 'eval/ontology/s2/fixtures/synthetic';
const SUITE_LIST = ['dailylife', 'github', 'shopping'];
let failures = 0, checks = 0;
const fail = (msg: string) => { failures++; console.error('FAIL  ' + msg); };
const ok = (msg: string) => { checks++; console.log('ok    ' + msg); };

function readJsonl<T>(p: string): T[] {
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as T);
}

// ----------------------------------------------------------------------------------------
// S1 comparison contract (S2_SPEC §3 step 7 / S1_SPEC output note).
// ----------------------------------------------------------------------------------------
const EXACT_NUMBERS = new Set(['p_H15']);
function exactNumber(path: string): boolean {
  if (EXACT_NUMBERS.has(path.split('.').pop()!)) return true;
  if (path.endsWith('secondary.p_signflip') || path.endsWith('.p.a') || path.endsWith('.p.c')) return true;
  return false;
}
function compare(actual: unknown, expected: unknown, path: string, errors: string[]): void {
  if (expected === null || actual === null) {
    if (actual !== expected) errors.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    return;
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) {
      errors.push(`${path}: array shape mismatch`); return;
    }
    (expected as unknown[]).forEach((e, i) => compare((actual as unknown[])[i], e, `${path}[${i}]`, errors));
    return;
  }
  if (typeof expected === 'object') {
    if (typeof actual !== 'object' || actual === null) { errors.push(`${path}: expected object`); return; }
    const ek = Object.keys(expected as object).sort(), ak = Object.keys(actual as object).sort();
    if (JSON.stringify(ek) !== JSON.stringify(ak)) {
      errors.push(`${path}: keys ${JSON.stringify(ak)} != ${JSON.stringify(ek)}`); return;
    }
    for (const k of ek) compare((actual as Record<string, unknown>)[k], (expected as Record<string, unknown>)[k], `${path}.${k}`, errors);
    return;
  }
  if (typeof expected === 'number') {
    if (typeof actual !== 'number') { errors.push(`${path}: expected number, got ${typeof actual}`); return; }
    if (exactNumber(path)) { if (!Object.is(actual, expected)) errors.push(`${path}: ${actual} !== ${expected} (exact)`); return; }
    if (!(Math.abs(actual - expected) <= 1e-9)) errors.push(`${path}: ${actual} vs ${expected} beyond 1e-9`);
    return;
  }
  if (actual !== expected) errors.push(`${path}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

function compareChecked(label: string, actual: unknown, expected: unknown): void {
  const errors: string[] = [];
  compare(actual, expected, label, errors);
  if (errors.length) errors.forEach(e => fail(e));
  else ok(label + ' matches expected');
}

// ----------------------------------------------------------------------------------------
// Process runners
// ----------------------------------------------------------------------------------------
function run(cmd: string, argv: string[], input?: string): { status: number; out: string; err: string } {
  const r = spawnSync(cmd, argv, { cwd: ROOT, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  return { status: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

const RECHECK_PY = 'eval/ontology/s2/recheck_s2.py';
const STATS_TS = 'eval/ontology/s2/stats-s2.ts';
const SANITIZE_TS = 'eval/ontology/pr/sanitize.ts';

function sanitizeCase(caseDir: string, tag: string): string | null {
  const out = join(TMP, `${tag}.sanitized.jsonl`);
  const r = run('node', [SANITIZE_TS, '--in', join(caseDir, 'observations.jsonl'), '--out', out]);
  return r.status === 0 ? out : null;
}

function statsCase(caseDir: string, sanitized: string, reps: number, draws: number, tag: string): { r: ReturnType<typeof run>; json: unknown } {
  const out = join(TMP, `${tag}.stats.json`);
  const r = run('node', [STATS_TS, '--mode', 's2', '--sanitized', sanitized,
    '--labels', join(caseDir, 'labels.jsonl'), '--labels-pr', join(caseDir, 'labels-pr.jsonl'),
    '--labels-d5', join(caseDir, 'labels-d5.jsonl'),
    '--binding', 'eval/ontology/s2/binding-agentdyn.json',
    '--reps', String(reps), '--draws', String(draws), '--out', out]);
  let json: unknown = null;
  if (r.status === 0) { try { json = JSON.parse(readFileSync(out, 'utf8')); } catch (e) { fail(`${tag}: stats output not JSON: ${e}`); } }
  return { r, json };
}

function recheckCase(caseDir: string, reps: number, draws: number, tag: string): { r: ReturnType<typeof run>; json: unknown } {
  const out = join(TMP, `${tag}.recheck.json`);
  const r = run('python3', [RECHECK_PY, '--raw-observations', join(caseDir, 'observations.jsonl'),
    '--labels', join(caseDir, 'labels.jsonl'), '--labels-pr', join(caseDir, 'labels-pr.jsonl'),
    '--labels-d5', join(caseDir, 'labels-d5.jsonl'), '--cohorts', join(caseDir, 'cohorts.json'),
    '--snapshot', 'eval/ontology/v2/frozen/snapshot.json',
    '--manifest', 'eval/kev-onto/binding/manifest-agentdyn.json',
    '--binding', 'eval/ontology/s2/binding-agentdyn.json',
    '--reps', String(reps), '--draws', String(draws), '--out', out]);
  let json: unknown = null;
  if (r.status === 0) { try { json = JSON.parse(readFileSync(out, 'utf8')); } catch (e) { fail(`${tag}: recheck output not JSON: ${e}`); } }
  return { r, json };
}

// ----------------------------------------------------------------------------------------
// Per-case structural checks (input hygiene + flag aggregates from expected.json)
// ----------------------------------------------------------------------------------------
interface Lab { run_id: string; suite: string; pipeline: string; group: string; base: string;
  cohort: string; attacked: boolean; security: boolean | null; user_task: number;
  injection_task: number | null; n_calls: number }
interface Obs { obs_id: string; run_id: string; suite: string; action: { tool: string; name: string; impact: string } }
type Flags = Record<string, { s1: number; prov: number; bound: number }>;

function structural(caseDir: string, expected: { outputs: any; flags: Flags }): void {
  const labels = readJsonl<Lab>(join(caseDir, 'labels.jsonl'));
  const obs = readJsonl<Obs>(join(caseDir, 'observations.jsonl'));
  const overlap = readJsonl<{ run_id: string; injection_overlap: boolean }>(join(caseDir, 'labels-pr.jsonl'));
  const d5 = readJsonl<{ run_id: string; security: boolean | null }>(join(caseDir, 'labels-d5.jsonl'));
  const tag = `${expected.flags ? '' : ''}${caseDir.split('/').slice(-1)[0]}`;

  const suites = new Set(labels.map(l => l.suite));
  if (suites.size !== 3 || SUITE_LIST.some(s => !suites.has(s))) fail(`${tag}: labels must cover all 3 suites`);
  else ok(`${tag}: all 3 suites present`);

  if (obs.some(o => o.action.tool.includes(':'))) fail(`${tag}: raw action.tool must not carry the agentdyn: prefix`);
  else ok(`${tag}: raw action.tool is <suite>/<name> (prefix added inside the implementations)`);

  if (new Set(labels.map(l => l.run_id)).size !== labels.length) fail(`${tag}: duplicate run_id`);
  if (new Set(obs.map(o => o.obs_id)).size !== obs.length) fail(`${tag}: duplicate obs_id`);
  if (overlap.length !== labels.length || new Set(overlap.map(o => o.run_id)).size !== overlap.length) fail(`${tag}: overlap rows must cover every run once`);
  if (d5.length !== labels.length || new Set(d5.map(o => o.run_id)).size !== d5.length) fail(`${tag}: d5 rows must cover every run once`);
  const labelIds = new Set(labels.map(l => l.run_id));
  if (obs.some(o => !labelIds.has(o.run_id))) fail(`${tag}: observation without run label`);
  if (labels.some(l => l.n_calls !== obs.filter(o => o.run_id === l.run_id).length)) fail(`${tag}: n_calls mismatch`);

  const y = (l: Lab) => l.attacked && l.security === true;
  const primary = labels.filter(l => l.group === 'P');
  const x1 = labels.filter(l => l.group === 'X1');
  const f = expected.flags;
  if (Object.keys(f).length !== labels.length) fail(`${tag}: flags map must cover every run`);
  for (const [rid, row] of Object.entries(f)) {
    if (row.s1 < 0 || row.s1 > 1 || row.prov < 0 || row.prov > 1 || row.bound < 0 || row.bound > 1) fail(`${tag}: non-binary flag for ${rid}`);
  }
  const sum = (ids: Lab[], m: 's1' | 'prov' | 'bound') => ids.reduce((a, l) => a + f[l.run_id][m], 0);
  const o = expected.outputs;
  const trials: Array<[string, number, number]> = [
    ['observed.s1.F', sum(primary, 's1'), o.observed.s1.F],
    ['observed.prov.F', sum(primary, 'prov'), o.observed.prov.F],
    ['b_prov_bound.s1.F', sum(primary, 's1'), o.secondary.b_prov_bound.s1.F],
    ['b_prov_bound.prov.F', sum(primary, 'bound'), o.secondary.b_prov_bound.prov.F],
    ['x1.s1.F', sum(x1, 's1'), o.secondary.x1.pooled.s1.F],
    ['x1.prov.F', sum(x1, 'prov'), o.secondary.x1.pooled.prov.F],
    ['positives', primary.filter(y).length, o.counts.positives],
  ];
  for (const [name, got, want] of trials) {
    if (got !== want) fail(`${tag}: flag-sum ${name}: recomputed ${got}, outputs say ${want}`);
    else checks++;
  }
  const tp = (ids: Lab[], m: 's1' | 'prov') => ids.reduce((a, l) => a + (y(l) ? f[l.run_id][m] : 0), 0);
  if (tp(primary, 's1') !== o.observed.s1.TP || tp(primary, 'prov') !== o.observed.prov.TP) fail(`${tag}: TP sums disagree with outputs`);
  else checks++;
  if (o.secondary.b_prov_bound.s1.F !== o.observed.s1.F) fail(`${tag}: b_prov_bound.s1 must equal observed.s1`);
  else checks++;
}

function caseChecks(caseName: string, expected: { checks?: Record<string, unknown>; outputs: any }): void {
  const e = expected as any;
  const want: Array<[string, unknown, unknown]> = [
    ['counts.positives', e.checks?.positives, undefined],
  ];
  void want;
  const c = e.checks ?? {};
  if (typeof c.positives === 'number' && e.outputs.counts.positives !== c.positives) fail(`${caseName}: positives ${e.outputs.counts.positives} != ${c.positives}`);
  if (typeof c.redraws_min === 'number') {
    if (e.outputs.redraws < c.redraws_min) fail(`${caseName}: expected redraws >= ${c.redraws_min}, got ${e.outputs.redraws}`);
    else if (typeof c.redraws_max === 'number' && e.outputs.redraws > c.redraws_max) fail(`${caseName}: redraws ${e.outputs.redraws} > cap ${c.redraws_max}`);
    else ok(`${caseName}: redraws = ${e.outputs.redraws} (redraw path exercised)`);
  }
  if (e.outputs.counts.K !== (c.K ?? e.outputs.counts.K)) fail(`${caseName}: K mismatch`);
  if (!Array.isArray(e.outputs.counts.dropped)) fail(`${caseName}: dropped must be a list`);
  checks++;
}

// ----------------------------------------------------------------------------------------
// Pass cases
// ----------------------------------------------------------------------------------------
const PASS_CASES = ['k5', 'k4', 'pos59', 'drop0', 'redraw', 'extra-key', 'two-attacks'];

function checkPassCase(name: string): void {
  if (ONLY && ONLY !== name) return;
  const dir = join(BASE, 'cases', name);
  const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'));
  console.log(`\n=== case ${name} ===`);

  try { validateS2Cohorts(JSON.parse(readFileSync(join(dir, 'cohorts.json'), 'utf8'))); ok(`${name}: cohorts pass validateS2Cohorts`); }
  catch (e) { fail(`${name}: validateS2Cohorts rejected cohorts: ${e}`); }

  const sanitized = sanitizeCase(dir, name);
  if (!sanitized) { fail(`${name}: sanitize failed`); return; }
  ok(`${name}: sanitize ok`);

  const s = statsCase(dir, sanitized, expected.reps, expected.draws, name);
  if (s.r.status !== 0) fail(`${name}: stats exit ${s.r.status}: ${s.r.err.split('\n')[0]}`);
  else ok(`${name}: stats ran`);

  const rc = recheckCase(dir, expected.reps, expected.draws, name);
  if (rc.r.status !== 0) fail(`${name}: recheck exit ${rc.r.status}: ${rc.r.err.split('\n').slice(-3).join(' | ')}`);
  else ok(`${name}: recheck ran`);

  if (s.json) compareChecked(`${name}/stats`, s.json, expected.outputs);
  if (rc.json) compareChecked(`${name}/recheck`, rc.json, expected.outputs);
  structural(dir, expected);
  caseChecks(name, expected);
  console.log(`      verdict=${expected.outputs.verdict} K=${expected.outputs.counts.K} ` +
    `positives=${expected.outputs.counts.positives} redraws=${expected.outputs.redraws} ` +
    `p=(${expected.outputs.p.a}, ${expected.outputs.p.c})`);
}

// ----------------------------------------------------------------------------------------
// Failure cases
// ----------------------------------------------------------------------------------------
const FAILURE_CASES = ['malformed-envelope', 'out-of-binding-tool', 'clean-twice'];

function checkFailureCase(name: string): void {
  if (ONLY && ONLY !== name && !ONLY.startsWith('failures/')) return;
  const dir = join(BASE, 'cases', 'failures', name);
  const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'));
  const want = expected.must_fail as { recheck?: string; sanitize?: string; stats?: string; ts_cohorts?: string; note?: string };
  console.log(`\n=== failure case failures/${name} ===`);
  if (want.note) console.log('      note: ' + want.note);

  const sanitized = sanitizeCase(dir, `fail-${name}`);
  if (want.sanitize === 'fail' && sanitized !== null) fail(`${name}: sanitize should have failed`);
  else if (want.sanitize === 'ok' && sanitized === null) fail(`${name}: sanitize should have passed`);
  else ok(`${name}: sanitize behaves as expected (${want.sanitize})`);

  const rc = recheckCase(dir, 10, 10, `fail-${name}`);
  if (want.recheck) {
    if (rc.r.status === 0) fail(`${name}: recheck should have failed`);
    else if (!(rc.r.err + rc.r.out).includes(want.recheck)) fail(`${name}: recheck error missing "${want.recheck}": ${rc.r.err.split('\n').slice(-3).join(' | ')}`);
    else ok(`${name}: recheck fails with "${want.recheck}"`);
  }

  if (want.ts_cohorts) {
    try { validateS2Cohorts(JSON.parse(readFileSync(join(dir, 'cohorts.json'), 'utf8'))); fail(`${name}: validateS2Cohorts should have thrown`); }
    catch (e) {
      const msg = String(e);
      if (!msg.includes(want.ts_cohorts)) fail(`${name}: TS cohort error missing "${want.ts_cohorts}": ${msg}`);
      else ok(`${name}: validateS2Cohorts fails with "${want.ts_cohorts}"`);
    }
  }

  if (want.stats === 'ok' && sanitized) {
    const s = statsCase(dir, sanitized, 10, 10, `fail-${name}`);
    if (s.r.status !== 0) fail(`${name}: stats should have tolerated this input (exit ${s.r.status})`);
    else ok(`${name}: stats exits 0 (documented gap: it performs no cohort/tool-id validation)`);
  }
}

// ----------------------------------------------------------------------------------------
// Aux: constraint-boundaries.json (both implementations of s1 constraint + sign-flip)
// ----------------------------------------------------------------------------------------
const RECHECK_CONSTRAINT_PY = `
import json, sys
sys.path.insert(0, 'eval/ontology/s2')
from recheck_s2 import constraint, signflip
rows = json.load(sys.stdin)
out = []
for r in rows:
    con, dropped = constraint(r['per_base'], r['observed'])
    out.append({'theta': con['theta'], 'pooled_d': con['pooled_d'], 'holds': con['holds'],
                'K': len(con['per_base']), 'dropped': dropped,
                'p_signflip': signflip(list(con['per_base'].values()))})
print(json.dumps(out))
`;

function checkConstraintRows(): void {
  if (ONLY && !['constraint', 'constraint-boundaries'].includes(ONLY)) return;
  console.log('\n=== aux constraint-boundaries.json ===');
  const doc = JSON.parse(readFileSync(join(BASE, 'cases/constraint-boundaries.json'), 'utf8'));
  const tsInputs = doc.rows.map((r: any) => ({
    per_base: r.per_base as Record<string, { Pos: number; TP_s1: number; TP_prov: number }>,
    pooled: r.pooled,
  }));
  const pyInputs = doc.rows.map((r: any) => {
    const per_base: Record<string, any> = {};
    for (const [k, v] of Object.entries(r.per_base) as Array<[string, any]>) {
      per_base[k] = { s1: { Pos: v.Pos, recall: v.Pos ? v.TP_s1 / v.Pos : 0 },
                      prov: { recall: v.Pos ? v.TP_prov / v.Pos : 0 } };
    }
    const p = r.pooled;
    return { per_base, observed: { s1: { recall: p.TP_s1 / p.Pos }, prov: { recall: p.TP_prov / p.Pos } } };
  });

  const py = run('python3', ['-c', RECHECK_CONSTRAINT_PY], JSON.stringify(pyInputs));
  if (py.status !== 0) { fail(`constraint: recheck python failed: ${py.err.split('\n').slice(-3).join(' | ')}`); return; }
  const pyOut = JSON.parse(py.out) as any[];

  doc.rows.forEach((row: any, i: number) => {
    const c = constraint(tsInputs[i].per_base as never, tsInputs[i].pooled as never);
    const tsOut = { K: c.K, dropped: c.dropped, theta: c.theta, pooled_d: c.pooledD,
                    holds: c.holds, p_signflip: c.pSign, inconclusive: c.K < 5 };
    compareChecked(`constraint/${row.name}/stats`, tsOut, { ...row.expected, inconclusive: c.K < 5 });
    compareChecked(`constraint/${row.name}/recheck`, { ...pyOut[i], inconclusive: pyOut[i].K < 5 },
      { ...row.expected, inconclusive: row.expected.K < 5 });
  });
}

// ----------------------------------------------------------------------------------------
// Aux: random-typing-counts.json
// ----------------------------------------------------------------------------------------
const RECHECK_RANDOM_PY = `
import json, sys
sys.path.insert(0, 'eval/ontology/s2')
from recheck_s2 import typing, random_typing, adapt_manifest, SUITES
snap = json.load(open('eval/ontology/v2/frozen/snapshot.json'))
man = adapt_manifest(json.load(open('eval/kev-onto/binding/manifest-agentdyn.json')), 'agentdyn', SUITES)
bind = json.load(open('eval/ontology/s2/binding-agentdyn.json'))
eligible, relevant, _ = typing(snap, man, bind)
draws = int(sys.argv[1])
detail = []
for i in range(draws):
    el, rel = random_typing(man, eligible, relevant, i)
    detail.append({'i': i, 'eligible_total': len(el),
                   'eligible_by_suite': {s: sorted(t for t in el if t.split(':')[1].split('/')[0] == s) for s in SUITES},
                   'eligible_ids': sorted(el),
                   'relevant': {t: sorted(rel[t]) for t in sorted(rel) if rel[t]},
                   'relevant_sizes': {t: len(rel[t]) for t in sorted(rel)}})
print(json.dumps({'typing': {'eligible': sorted(eligible),
                             'eligible_by_suite': {s: sorted(t for t in eligible if t.split(':')[1].split('/')[0] == s) for s in SUITES},
                             'relevant_sizes': {t: len(relevant[t]) for t in sorted(relevant)},
                             'relevant_total': sum(len(v) for v in relevant.values())},
                  'draws_detail': detail}))
`;

function checkRandomTyping(): void {
  if (ONLY && !['random', 'random-typing'].includes(ONLY)) return;
  console.log('\n=== aux random-typing-counts.json ===');
  const expected = JSON.parse(readFileSync(join(BASE, 'cases/random-typing-counts.json'), 'utf8'));
  const binding = JSON.parse(readFileSync('eval/ontology/s2/binding-agentdyn.json', 'utf8'));
  const snap = JSON.parse(readFileSync('eval/ontology/v2/frozen/snapshot.json', 'utf8'));

  // stats-s2 side: the production typing + randTyping + manifestFromBinding
  const manifest = manifestFromBinding(binding);
  const T = typingFn(snap, binding, manifest);
  const tsEligible = [...T.eligible.entries()].filter(([, v]) => v).map(([k]) => k).sort();
  const tsRelevantSizes: Record<string, number> = {};
  for (const [k, v] of T.relevant) tsRelevantSizes[k] = v.size;
  const tsParams: Record<string, string[]> = {};
  for (const [k, v] of T.params) tsParams[k] = v;
  compareChecked('random/typing.eligible', tsEligible, expected.typing.eligible);
  compareChecked('random/typing.eligible_by_suite',
    Object.fromEntries(SUITE_LIST.map(s => [s, tsEligible.filter(t => t.split(':')[1].split('/')[0] === s)])),
    expected.typing.eligible_by_suite);
  compareChecked('random/typing.relevant_sizes', tsRelevantSizes, expected.typing.relevant_sizes);
  compareChecked('random/typing.relevant_total',
    Object.values(tsRelevantSizes).reduce((a, b) => a + b, 0), expected.typing.relevant_total);
  compareChecked('random/typing.params_sorted', tsParams, expected.typing.params_sorted);

  for (let i = 0; i < expected.draws; i++) {
    const d = randTyping(T, manifest, SUITE_LIST, i);
    const eligibleIds = [...d.eligible.entries()].filter(([, v]) => v).map(([k]) => k).sort();
    const relevant: Record<string, string[]> = {}, sizes: Record<string, number> = {};
    for (const [k, v] of d.relevant) { sizes[k] = v.size; if (v.size) relevant[k] = [...v].sort(); }
    const row = { i, eligible_total: eligibleIds.length,
      eligible_by_suite: Object.fromEntries(SUITE_LIST.map(s => [s, eligibleIds.filter(t => t.split(':')[1].split('/')[0] === s)])),
      eligible_ids: eligibleIds, relevant, relevant_sizes: sizes };
    const errors: string[] = [];
    compare(row, expected.draws_detail[i], `random/draw[${i}]`, errors);
    if (errors.length) errors.forEach(e => fail(e));
    if (eligibleIds.length !== expected.typing.eligible.length) fail(`random/draw[${i}]: eligible count not preserved`);
    else checks++;
    if (JSON.stringify(sizes) !== JSON.stringify(expected.typing.relevant_sizes)) fail(`random/draw[${i}]: per-tool relevant sizes changed`);
    else checks++;
  }
  ok(`random: ${expected.draws} draws match on both eligibility counts and per-tool relevant sizes`);

  // recheck side
  const py = run('python3', ['-c', RECHECK_RANDOM_PY, String(expected.draws)]);
  if (py.status !== 0) { fail(`random: recheck python failed: ${py.err.split('\n').slice(-3).join(' | ')}`); return; }
  const pyOut = JSON.parse(py.out);
  compareChecked('random/recheck.typing.eligible', pyOut.typing.eligible, expected.typing.eligible);
  compareChecked('random/recheck.typing.eligible_by_suite', pyOut.typing.eligible_by_suite, expected.typing.eligible_by_suite);
  compareChecked('random/recheck.typing.relevant_sizes', pyOut.typing.relevant_sizes, expected.typing.relevant_sizes);
  compareChecked('random/recheck.typing.relevant_total', pyOut.typing.relevant_total, expected.typing.relevant_total);
  compareChecked('random/recheck.draws_detail', pyOut.draws_detail, expected.draws_detail);
}

// ----------------------------------------------------------------------------------------
// Aux: crossed-weights-trace.json (shared cells across models/attacks, one RNG stream)
// ----------------------------------------------------------------------------------------
interface TraceLabel { run_id: string; suite: string; user_task: number; injection_task: number | null;
  pipeline: string; attack: string | null }

function crossedTS(labels: TraceLabel[], rng: () => number) {
  const universes: Record<string, [number[], number[]]> = {};
  for (const s of SUITE_LIST) {
    universes[s] = [
      [...new Set(labels.filter(l => l.suite === s).map(l => l.user_task))].sort((a, b) => a - b),
      [...new Set(labels.filter(l => l.suite === s && l.injection_task != null).map(l => l.injection_task!))].sort((a, b) => a - b),
    ];
  }
  const counts: Record<string, { u: Map<number, number>, j: Map<number, number> }> = {};
  for (const s of SUITE_LIST) {
    const [us, js] = universes[s];
    const uc = new Map<number, number>(), jc = new Map<number, number>();
    for (let k = 0; k < us.length; k++) { const u = us[Math.floor(rng() * us.length)]; uc.set(u, (uc.get(u) ?? 0) + 1); }
    for (let k = 0; k < js.length; k++) { const j = js[Math.floor(rng() * js.length)]; jc.set(j, (jc.get(j) ?? 0) + 1); }
    counts[s] = { u: uc, j: jc };
  }
  const weights = labels.map(l => (counts[l.suite].u.get(l.user_task) ?? 0) *
    (l.injection_task == null ? 1 : (counts[l.suite].j.get(l.injection_task) ?? 0)));
  return { counts, weights };
}

const RECHECK_CROSSED_PY = `
import json, sys
sys.path.insert(0, 'eval/ontology/s2')
from recheck_s2 import Mulberry32, crossed_weights, SUITES
labels = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
universes = {s: (sorted({l['user_task'] for l in labels if l['suite'] == s}),
                 sorted({l['injection_task'] for l in labels if l['suite'] == s and l['injection_task'] is not None}))
             for s in SUITES}
rng = Mulberry32(20261007)
par = Mulberry32(20261007)
out = []
for i in range(3):
    w = crossed_weights(labels, universes, rng)
    counts = {}
    for s in SUITES:
        us, js = universes[s]
        uc, jc = {}, {}
        for _ in us:
            k = us[par.pick(len(us))]; uc[str(k)] = uc.get(str(k), 0) + 1
        for _ in js:
            k = js[par.pick(len(js))]; jc[str(k)] = jc.get(str(k), 0) + 1
        counts[s] = {'user_task': uc, 'injection_task': jc}
    out.append({'i': i, 'counts': counts,
                'weights': {l['run_id']: w[j] for j, l in enumerate(labels)}})
print(json.dumps(out))
`;

function checkCrossedWeights(): void {
  if (ONLY && !['crossed', 'crossed-weights'].includes(ONLY)) return;
  console.log('\n=== aux crossed-weights-trace.json ===');
  const expected = JSON.parse(readFileSync(join(BASE, 'cases/crossed-weights-trace.json'), 'utf8'));
  const labelsPath = join(BASE, expected.labels);
  const labels = readJsonl<TraceLabel>(labelsPath);

  const rng = mulberry(SEED);
  const attempts = [0, 1, 2].map(i => {
    const { counts, weights } = crossedTS(labels, rng);
    return { i,
      counts: Object.fromEntries(SUITE_LIST.map(s => [s, {
        user_task: Object.fromEntries([...counts[s].u.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), v])),
        injection_task: Object.fromEntries([...counts[s].j.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), v])),
      }])),
      weights: Object.fromEntries(labels.map((l, j) => [l.run_id, weights[j]])) };
  });
  compareChecked('crossed/stats.attempts', attempts, expected.attempts);

  for (const cell of expected.shared_cells) {
    for (const a of attempts) {
      const ws = new Set(cell.run_ids.map((r: string) => a.weights[r]));
      if (ws.size !== 1) fail(`crossed: shared cell ${cell.suite}/${cell.user_task}/${cell.injection_task} has split weights in attempt ${a.i}`);
    }
    if (cell.pipelines.length < 2) fail(`crossed: shared cell should span >1 pipeline`);
    checks++;
  }
  ok(`crossed: ${expected.shared_cells.length} shared cells keep one weight per (suite, u, j) across models/attacks`);

  const py = run('python3', ['-c', RECHECK_CROSSED_PY, labelsPath]);
  if (py.status !== 0) { fail(`crossed: recheck python failed: ${py.err.split('\n').slice(-3).join(' | ')}`); return; }
  compareChecked('crossed/recheck.attempts', JSON.parse(py.out), expected.attempts);
}

// ----------------------------------------------------------------------------------------
function main(): void {
  console.log(`runtime dir: ${TMP}`);
  PASS_CASES.forEach(checkPassCase);
  FAILURE_CASES.forEach(checkFailureCase);
  checkConstraintRows();
  checkRandomTyping();
  checkCrossedWeights();
  console.log(`\n${checks} checks passed, ${failures} failed`);
  if (failures) process.exit(1);
  console.log('ALL GREEN');
}

main();
