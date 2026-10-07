// power-hc1.ts (P-HC1): exploratory power analysis for H-C1 (S2_DIAGNOSIS §6). Two spent pools only; no new data.
// H-C1 test: monitors typed×V2 vs typed×V3; endpoint = one-sided paired task-crossed bootstrap of precision(V3-V2) > 0
// AND recall(V3-V2) > -3 points, exactly the stats-s2.ts (a) procedure. Design-level resampling gives empirical power.
//   node eval/ontology/diag-s2/power-hc1.ts --s2-dir runs/onto-s2-input --s1-pool <dir> \
//     --binding eval/ontology/s2/binding-agentdyn.json --frozen eval/ontology/v2/frozen --diag runs/onto-s2-diag/diag-s2.json \
//     --out runs/onto-c-power/power-hc1.json
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { typing, untrustedKeys, type Obs } from '../v2/typing.ts';
import { qualifying } from '../pr/values.ts';
import { sanitizeObs } from '../pr/sanitize.ts';
import { manifestFromBinding, readJsonl } from '../s2/stats-s2.ts';
import { baseOf } from '../s1/stats-s1.ts';
import { mulberry } from '../arms.ts';
import { verifyBaselines, REAL_BASELINE } from './diagnose.ts';
import { type BindingShape } from './validate-diag.ts';

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const SEED = 20261007, RECALL_MARGIN = 0.03, ALPHA = 0.05;
const ENDPOINT = 'one-sided paired task-crossed bootstrap: precision(V3-V2) > 0 and recall(V3-V2) > -3 points';

interface Run { suite: string; base: string; u: number; j: number | null; fV2: number; fV3: number; y: number }
interface Pool { runs: Run[]; suites: string[]; bases: string[]; userTasks: Record<string, number[]>; injTasks: Record<string, number[]>; share: Record<string, number>; observed: { precision_v2: number; precision_v3: number; precision_diff: number; recall_v2: number; recall_v3: number; recall_diff: number; positives: number; runs: number } }
export interface PowerOpts { s2Dir: string; binding: string; frozen: string; diagPath: string; out?: string; s1Pool?: string; s1Manifest?: string; s1Stats?: string; expectedS2Baseline?: { baseline: string[]; sanitized: string[] }; N?: number; R?: number; grid?: { K: number[]; U: number[]; J: number[] } }

/** Precision/recall of a run-level flag over a pool (weight 1). */
function endpointOf(runs: Run[], pick: (r: Run) => number) {
  let F = 0, TP = 0, Pos = 0;
  for (const r of runs) { const f = pick(r); if (f) { F++; if (r.y) TP++; } if (r.y) Pos++; }
  return { F, TP, Pos, precision: F ? TP / F : null, recall: Pos ? TP / Pos : null };
}

function makePool(labels: any[], map: (l: any) => { suite: string; base: string; u: number; j: number | null; fV2: number; fV3: number }, diag: any, diagCell: (d: any) => any): Pool {
  const runs: Run[] = labels.map(l => { const m = map(l); return { suite: m.suite, base: m.base, u: m.u, j: m.j, fV2: m.fV2, fV3: m.fV3, y: (l.attacked && l.security === true) ? 1 : 0 }; });
  const suites = [...new Set(runs.map(r => r.suite))].sort();
  const bases = [...new Set(runs.map(r => r.base))].sort();
  const userTasks: Record<string, number[]> = {}, injTasks: Record<string, number[]> = {}, share: Record<string, number> = {};
  for (const s of suites) {
    userTasks[s] = [...new Set(runs.filter(r => r.suite === s).map(r => r.u))].sort((a, b) => a - b);
    injTasks[s] = [...new Set(runs.filter(r => r.suite === s && r.j !== null).map(r => r.j as number))].sort((a, b) => a - b);
    share[s] = runs.filter(r => r.suite === s).length / runs.length;
  }
  const e2 = endpointOf(runs, r => r.fV2), e3 = endpointOf(runs, r => r.fV3);
  const cells = diagCell(diag);
  for (const [name, e] of [['typedxV2', e2], ['typedxV3', e3]] as const) {
    const c = cells[name];
    if (!c || c.F !== e.F || c.TP !== e.TP || c.Pos !== e.Pos) throw new Error(`observed ${name} does not match diag (${JSON.stringify(e)} vs ${JSON.stringify(c)})`);
  }
  return { runs, suites, bases, userTasks, injTasks, share, observed: {
    precision_v2: e2.precision!, precision_v3: e3.precision!, precision_diff: e3.precision! - e2.precision!,
    recall_v2: e2.recall!, recall_v3: e3.recall!, recall_diff: e3.recall! - e2.recall!, positives: e2.Pos, runs: runs.length } };
}

function buildS2(o: PowerOpts, diag: any): Pool {
  const sanitized = join(o.s2Dir, 'observations.sanitized.jsonl'), labelsPath = join(o.s2Dir, 'labels.jsonl');
  verifyBaselines(o.s2Dir, sanitized, labelsPath, o.expectedS2Baseline ?? REAL_BASELINE);
  const binding = JSON.parse(readFileSync(o.binding, 'utf8')) as BindingShape;
  const snap = JSON.parse(readFileSync(join(o.frozen, 'snapshot.json'), 'utf8'));
  const obs = readJsonl<Obs>(sanitized);
  const labels = (readJsonl<any>(labelsPath)).filter(l => l.group === 'P');
  const T = typing(snap as never, binding as never, manifestFromBinding(binding as never) as never);
  const tid = (c: Obs) => `agentdyn:${c.suite}/${c.action.name}`;
  const qual = new Map(obs.map(c => [c.obs_id, qualifying(c as never)]));
  const v2 = (c: Obs) => qual.get(c.obs_id)!.length > 0;
  const v3 = (c: Obs) => qual.get(c.obs_id)!.some(x => x.route !== 'whole' || !!T.relevant.get(tid(c))?.has(x.key));
  const typ = (c: Obs) => !!T.eligible.get(tid(c));
  const flag = (fn: (c: Obs) => boolean) => { const s = new Map<string, number>(); for (const l of labels) s.set(l.run_id, 0); for (const c of obs) if (fn(c)) s.set(c.run_id, 1); return s; };
  const fV2 = flag(c => typ(c) && v2(c)), fV3 = flag(c => typ(c) && v3(c));
  return makePool(labels, l => ({ suite: l.suite, base: l.base, u: l.user_task, j: l.injection_task, fV2: fV2.get(l.run_id)!, fV3: fV3.get(l.run_id)! }), diag, d => d.q1.P);
}

function buildS1(o: PowerOpts, diag: any): Pool {
  const raw = join(o.s1Pool!, 'observations.jsonl'), labelsPath = join(o.s1Pool!, 'labels.jsonl');
  if (!o.s1Manifest) throw new Error('--s1-pool needs --s1-manifest');
  for (const line of readFileSync(o.s1Manifest, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/);
    if (!m) throw new Error(`bad S1 manifest line: ${line}`);
    const name = m[2].split('/').pop()!;
    if (sha256(readFileSync(join(o.s1Pool!, name))) !== m[1]) throw new Error(`S1 input differs from the manifest: ${name}`);
  }
  const obs = readJsonl<Record<string, unknown>>(raw).map(r => sanitizeObs(r as never) as unknown as Obs);
  const labels = readJsonl<any>(labelsPath);
  const binding = JSON.parse(readFileSync(join(o.frozen, 'binding-v2.json'), 'utf8')) as BindingShape;
  const manifestV2 = JSON.parse(readFileSync(join(o.frozen, 'tool-manifest-v2.json'), 'utf8')).tools;
  const snap = JSON.parse(readFileSync(join(o.frozen, 'snapshot.json'), 'utf8'));
  const T = typing(snap as never, binding as never, manifestV2 as never);
  const tid = (c: Obs) => `agentdojo:${c.suite}/${c.action.name}`;
  const qual = new Map(obs.map(c => [c.obs_id, qualifying(c as never)]));
  const v2 = (c: Obs) => qual.get(c.obs_id)!.length > 0;
  const v3 = (c: Obs) => qual.get(c.obs_id)!.some(x => x.route !== 'whole' || !!T.relevant.get(tid(c))?.has(x.key));
  const typ = (c: Obs) => !!T.eligible.get(tid(c));
  const flag = (fn: (c: Obs) => boolean) => { const s = new Map<string, number>(); for (const l of labels) s.set(l.run_id, 0); for (const c of obs) if (fn(c)) s.set(c.run_id, 1); return s; };
  const fV2 = flag(c => typ(c) && v2(c)), fV3 = flag(c => typ(c) && v3(c));
  return makePool(labels, l => ({ suite: l.suite, base: baseOf(l.pipeline), u: l.user_task, j: l.injection_task, fV2: fV2.get(l.run_id)!, fV3: fV3.get(l.run_id)! }), diag, d => d.q5?.S1?.q1);
}

const mean = (a: number[]): number => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const std = (a: number[]): number => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); };
const erf = (x: number): number => { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; };
const normCdf = (z: number): number => 0.5 * (1 + erf(z / Math.SQRT2));
const p1 = (d: number[], shift = 0): number => (1 + d.filter(x => x + shift <= 0).length) / (d.length + 1);

/** One outer design simulation + its inner bootstrap. */
function oneDesign(pool: Pool, K: number, U: number, J: number, N: number, R: number) {
  const suiteIdx = new Map(pool.suites.map((s, i) => [s, i]));
  const out = { runs: [] as number[], pos: [] as number[], diff: [] as number[], pA: [] as number[], pRec: [] as number[], ok: [] as number[], se: [] as number[] };
  for (let n = 0; n < N; n++) {
    const rnd = mulberry(SEED + n);
    const baseMult = new Map<string, number>();
    for (let k = 0; k < K; k++) { const b = pool.bases[Math.floor(rnd() * pool.bases.length)]; baseMult.set(b, (baseMult.get(b) ?? 0) + 1); }
    const chosenU: Record<string, number[]> = {}, chosenJ: Record<string, number[]> = {}, uIdx: Record<string, Map<number, number>> = {}, jIdx: Record<string, Map<number, number>> = {};
    for (const s of pool.suites) {
      const uN = Math.max(1, Math.round(U * pool.share[s])), jN = Math.max(1, Math.round(J * pool.share[s]));
      const su = new Set<number>(); for (let k = 0; k < uN; k++) su.add(pool.userTasks[s][Math.floor(rnd() * pool.userTasks[s].length)]);
      const sj = new Set<number>(); for (let k = 0; k < jN; k++) sj.add(pool.injTasks[s][Math.floor(rnd() * pool.injTasks[s].length)]);
      chosenU[s] = [...su].sort((a, b) => a - b); chosenJ[s] = [...sj].sort((a, b) => a - b);
      uIdx[s] = new Map(chosenU[s].map((u, i) => [u, i])); jIdx[s] = new Map(chosenJ[s].map((j, i) => [j, i]));
    }
    const groups = new Map<string, { F3: number; TP3: number; F2: number; TP2: number; Pos: number }>();
    let runsCount = 0, positives = 0;
    for (const r of pool.runs) {
      const bw = baseMult.get(r.base); if (!bw) continue;
      const ui = uIdx[r.suite].get(r.u); if (ui === undefined) continue;
      let ji = -1; if (r.j !== null) { const x = jIdx[r.suite].get(r.j); if (x === undefined) continue; ji = x; }
      const key = `${suiteIdx.get(r.suite)}|${ui}|${ji}`;
      const g = groups.get(key) ?? { F3: 0, TP3: 0, F2: 0, TP2: 0, Pos: 0 };
      g.F3 += bw * r.fV3; g.TP3 += bw * r.fV3 * r.y; g.F2 += bw * r.fV2; g.TP2 += bw * r.fV2 * r.y; g.Pos += bw * r.y;
      groups.set(key, g); runsCount += bw; positives += bw * r.y;
    }
    let F3 = 0, TP3 = 0, F2 = 0, TP2 = 0, Pos = 0;
    for (const g of groups.values()) { F3 += g.F3; TP3 += g.TP3; F2 += g.F2; TP2 += g.TP2; Pos += g.Pos; }
    out.runs.push(runsCount); out.pos.push(positives);
    out.diff.push(F3 && F2 ? TP3 / F3 - TP2 / F2 : 0);
    const gArr = [...groups.entries()];
    const dP: number[] = [], dR: number[] = []; let redraws = 0;
    while (dP.length < R) {
      const cu: Record<string, number[]> = {}, cj: Record<string, number[]> = {};
      for (const s of pool.suites) {
        const un = chosenU[s].length, jn = chosenJ[s].length;
        const a = new Array(un).fill(0); for (let k = 0; k < un; k++) a[Math.floor(rnd() * un)]++; cu[s] = a;
        const b = new Array(jn).fill(0); for (let k = 0; k < jn; k++) b[Math.floor(rnd() * jn)]++; cj[s] = b;
      }
      let f3 = 0, t3 = 0, f2 = 0, t2 = 0, pos = 0;
      for (const [key, g] of gArr) { const [si, ui, ji] = key.split('|').map(Number); const s = pool.suites[si]; const w = cu[s][ui] * (ji < 0 ? 1 : cj[s][ji]); if (!w) continue; f3 += w * g.F3; t3 += w * g.TP3; f2 += w * g.F2; t2 += w * g.TP2; pos += w * g.Pos; }
      if (!f3 || !f2 || !pos) { if (++redraws > 100 * R) break; continue; }
      dP.push(t3 / f3 - t2 / f2); dR.push(t3 / pos - t2 / pos);
    }
    const ok = dP.length && dR.length;
    out.pA.push(ok ? p1(dP) : 1); out.pRec.push(ok ? p1(dR, RECALL_MARGIN) : 1);
    out.ok.push(ok && p1(dP) <= ALPHA && p1(dR, RECALL_MARGIN) <= ALPHA ? 1 : 0);
    out.se.push(std(dP));
  }
  return out;
}

/** Closed-schema validator for this output (Object.hasOwn on every object, every own field traversed; str const/enum). */
export function validatePower(data: unknown, schema: any): void {
  const enums: Record<string, string[]> = schema.enums ?? {};
  const resolve = (n: any): any => { while (n && n.$ref) n = schema.defs[n.$ref]; return n; };
  const keyOk = (kind: string, key: string, path: string): void => {
    if (kind.startsWith('enum:')) { const e = kind.slice(5); if (!enums[e]?.includes(key)) throw new Error(`${path}: key not in enum ${e}: ${key}`); return; }
    throw new Error(`${path}: unknown key rule ${kind}`);
  };
  const walk = (raw: any, v: unknown, path: string): void => {
    const node = resolve(raw);
    switch (node.k) {
      case 'obj': {
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${path}: expected object`);
        const obj = v as Record<string, unknown>, keys = node.keys as Record<string, any>;
        for (const [k, val] of Object.entries(obj)) { if (!Object.hasOwn(keys, k)) throw new Error(`${path}.${k}: unexpected field`); walk(keys[k], val, `${path}.${k}`); }
        for (const k of Object.keys(keys)) if (!Object.hasOwn(obj, k) && !keys[k].opt) throw new Error(`${path}.${k}: missing field`);
        return;
      }
      case 'map': { if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${path}: expected map`); for (const [k, val] of Object.entries(v as Record<string, unknown>)) { keyOk(node.key, k, `${path}["${k}"]`); walk(node.val, val, `${path}.${k}`); } return; }
      case 'arr': { if (!Array.isArray(v)) throw new Error(`${path}: expected array`); v.forEach((x, i) => walk(node.items, x, `${path}[${i}]`)); return; }
      case 'int': { if (!Number.isInteger(v) || (v as number) < 0) throw new Error(`${path}: expected non-negative integer`); return; }
      case 'num': { if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${path}: expected number`); return; }
      case 'nullnum': { if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) throw new Error(`${path}: expected number or null`); return; }
      case 'bool': { if (typeof v !== 'boolean') throw new Error(`${path}: expected boolean`); return; }
      case 'str': { if (typeof v !== 'string') throw new Error(`${path}: expected string`); if (node.const) { if (v !== schema[node.const]) throw new Error(`${path}: not the fixed constant`); return; } if (node.in) { if (!enums[node.in]?.includes(v)) throw new Error(`${path}: not in enum ${node.in}`); return; } throw new Error(`${path}: unknown string rule`); }
      default: throw new Error(`${path}: unknown schema node ${String(node.k)}`);
    }
  };
  walk(schema.root, data, 'power');
}

export function runPower(o: PowerOpts): Record<string, unknown> {
  const diag = JSON.parse(readFileSync(o.diagPath, 'utf8'));
  const N = o.N ?? 200, R = o.R ?? 500;
  const grid = o.grid ?? { K: [3, 5], U: [20, 40, 60], J: [10, 20, 35] };
  const pools: Record<string, unknown> = {};
  const s2 = buildS2(o, diag);
  const built: Array<[string, Pool]> = [['S2', s2]];
  if (o.s1Pool) built.push(['S1', buildS1(o, diag)]);
  for (const [key, pool] of built) {
    const designs = [], analytic = [];
    for (const K of grid.K) for (const U of grid.U) for (const J of grid.J) {
      const r = oneDesign(pool, K, U, J, N, R);
      designs.push({ K, U, J, expected_runs: mean(r.runs), expected_positives: mean(r.pos), mean_precision_diff: mean(r.diff), power: mean(r.ok), power_precision_only: mean(r.pA.map(x => x <= ALPHA ? 1 : 0)), se_precision_diff: mean(r.se.filter(Number.isFinite)) });
      const se = mean(r.se.filter(Number.isFinite));
      analytic.push({ K, U, J, se, power_delta_2: normCdf(0.02 / se - 1.645), power_delta_4: normCdf(0.04 / se - 1.645), power_delta_6: normCdf(0.06 / se - 1.645) });
    }
    pools[key] = { observed: pool.observed, designs, analytic };
  }
  const out = { endpoint: ENDPOINT, alpha: ALPHA, recall_margin: RECALL_MARGIN, sim: { N, R, seed: SEED }, grid, pools };
  const schema = JSON.parse(readFileSync(new URL('./power-schema.json', import.meta.url), 'utf8'));
  validatePower(out, schema);
  if (o.out) { mkdirSync(dirname(o.out), { recursive: true }); writeFileSync(o.out, JSON.stringify(out, null, 1) + '\n'); }
  return out as unknown as Record<string, unknown>;
}

const arg = (k: string): string | null => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
if (process.argv[1] != null && import.meta.url === `file://${process.argv[1]}`) {
  const s2Dir = arg('--s2-dir') ?? 'runs/onto-s2-input', binding = arg('--binding') ?? 'eval/ontology/s2/binding-agentdyn.json';
  const frozen = arg('--frozen') ?? 'eval/ontology/v2/frozen', diagPath = arg('--diag') ?? 'runs/onto-s2-diag/diag-s2.json';
  const res = runPower({ s2Dir, binding, frozen, diagPath, out: arg('--out') ?? undefined, s1Pool: arg('--s1-pool') ?? undefined, s1Manifest: arg('--s1-manifest') ?? undefined,
    N: arg('--N') ? Number(arg('--N')) : undefined, R: arg('--R') ? Number(arg('--R')) : undefined });
  const p = res.pools as any;
  console.log(`power-hc1: S2 observed precision diff ${(p.S2.observed.precision_diff * 100).toFixed(2)} pts over ${p.S2.observed.runs} runs; ${p.S2.designs.length} designs${p.S1 ? `; S1 observed ${(p.S1.observed.precision_diff * 100).toFixed(2)} pts` : ''}`);
}
