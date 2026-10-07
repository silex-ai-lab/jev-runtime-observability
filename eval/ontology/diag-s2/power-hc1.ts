// power-hc1.ts (P-HC1, CG-P r1 fixes): exploratory power for H-C1 (S2_DIAGNOSIS §6). Two spent pools only.
// H-C1 test: monitors typed×V2 vs typed×V3; one-sided paired task-crossed bootstrap (stats-s2.ts (a) procedure) of
// precision(V3-V2)>0 AND recall(V3-V2) > -3 points; success = both p <= 0.05. Design-level resampling keeps sampled
// user/injection occurrence slots (with replacement) through assembly and the inner bootstrap.
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
const SEED = 20261007, RECALL_MARGIN = 0.03, ALPHA = 0.05, REDRAW_CAP = 100;
const ENDPOINT = 'one-sided paired task-crossed bootstrap: precision(V3-V2) > 0 and recall(V3-V2) > -3 points';
const S1_FILES = ['observations.jsonl', 'labels.jsonl', 'labels-pr.jsonl', 'counts.json'];

export interface Run { suite: string; base: string; u: number; j: number | null; fV2: number; fV3: number; y: number }
interface Flags { fV2: number; fV3: number; y: number }
interface Group { F3: number; TP3: number; F2: number; TP2: number; Pos: number; count: number }
interface Observed { precision_v2: number; precision_v3: number; precision_diff: number; recall_v2: number; recall_v3: number; recall_diff: number; positives: number; runs: number }
export interface Pool { runs: Run[]; suites: string[]; bases: string[]; userTasks: Record<string, number[]>; injTasks: Record<string, number[]>; share: Record<string, number>; att: (Flags | null)[][][][]; ben: (Flags | null)[][][]; observed: Observed }
export interface PowerOpts { s2Dir: string; binding: string; frozen: string; diagPath: string; out?: string; s1Pool?: string; s1Manifest?: string; expectedS2Baseline?: { baseline: string[]; sanitized: string[] }; N?: number; R?: number; grid?: { K: number[]; U: number[]; J: number[] } }

/** Precompute the per-(suite,user,injection,base) flag tables; no run text. Exported for the hand-computed test. */
export function finalizePool(runs: Run[], observed: Observed): Pool {
  const suites = [...new Set(runs.map(r => r.suite))].sort(), bases = [...new Set(runs.map(r => r.base))].sort();
  const suiteIdx = new Map(suites.map((s, i) => [s, i])), baseIdx = new Map(bases.map((b, i) => [b, i]));
  const userTasks: Record<string, number[]> = {}, injTasks: Record<string, number[]> = {};
  for (const s of suites) {
    userTasks[s] = [...new Set(runs.filter(r => r.suite === s).map(r => r.u))].sort((a, b) => a - b);
    injTasks[s] = [...new Set(runs.filter(r => r.suite === s && r.j !== null).map(r => r.j as number))].sort((a, b) => a - b);
  }
  const att: (Flags | null)[][][][] = suites.map(s => userTasks[s].map(() => injTasks[s].map(() => bases.map(() => null))));
  const ben: (Flags | null)[][][] = suites.map(s => userTasks[s].map(() => bases.map(() => null)));
  for (const r of runs) {
    const si = suiteIdx.get(r.suite)!, ui = userTasks[r.suite].indexOf(r.u), bi = baseIdx.get(r.base)!, fl = { fV2: r.fV2, fV3: r.fV3, y: r.y };
    if (r.j === null) ben[si][ui][bi] = fl; else att[si][ui][injTasks[r.suite].indexOf(r.j)][bi] = fl;
  }
  const share: Record<string, number> = {}; for (const s of suites) share[s] = runs.filter(r => r.suite === s).length / runs.length;
  return { runs, suites, bases, userTasks, injTasks, share, att, ben, observed };
}

function buildGroups(pool: Pool, baseMult: Map<string, number>) {
  const attG: Array<{ s: number; u: number; j: number; g: Group }> = [], benG: Array<{ s: number; u: number; g: Group }> = [];
  const B = pool.bases.length, bw = pool.bases.map(b => baseMult.get(b) ?? 0);
  for (let si = 0; si < pool.suites.length; si++) {
    const U = pool.userTasks[pool.suites[si]], J = pool.injTasks[pool.suites[si]];
    for (let ui = 0; ui < U.length; ui++) {
      let g: Group | null = null;
      for (let bi = 0; bi < B; bi++) { const fl = pool.ben[si][ui][bi]; if (!fl || !bw[bi]) continue; if (!g) g = { F3: 0, TP3: 0, F2: 0, TP2: 0, Pos: 0, count: 0 }; g.count += bw[bi]; g.F3 += bw[bi] * fl.fV3; g.TP3 += bw[bi] * fl.fV3 * fl.y; g.F2 += bw[bi] * fl.fV2; g.TP2 += bw[bi] * fl.fV2 * fl.y; g.Pos += bw[bi] * fl.y; }
      if (g) benG.push({ s: si, u: ui, g });
      for (let ji = 0; ji < J.length; ji++) {
        let a: Group | null = null;
        for (let bi = 0; bi < B; bi++) { const fl = pool.att[si][ui][ji][bi]; if (!fl || !bw[bi]) continue; if (!a) a = { F3: 0, TP3: 0, F2: 0, TP2: 0, Pos: 0, count: 0 }; a.count += bw[bi]; a.F3 += bw[bi] * fl.fV3; a.TP3 += bw[bi] * fl.fV3 * fl.y; a.F2 += bw[bi] * fl.fV2; a.TP2 += bw[bi] * fl.fV2 * fl.y; a.Pos += bw[bi] * fl.y; }
        if (a) attG.push({ s: si, u: ui, j: ji, g: a });
      }
    }
  }
  return { attG, benG };
}
const multOf = (slots: number[]): Map<number, number> => { const m = new Map<number, number>(); for (const x of slots) m.set(x, (m.get(x) ?? 0) + 1); return m; };

/** Attacked/benign run counts of an assembled design (occurrence slots preserved). Exported for the hand-computed test. */
export function designCounts(pool: Pool, baseMult: Map<string, number>, slotsU: Record<string, number[]>, slotsJ: Record<string, number[]>): { att: number; ben: number } {
  const { attG, benG } = buildGroups(pool, baseMult);
  const uM = pool.suites.map(s => multOf(slotsU[s] ?? [])), jM = pool.suites.map(s => multOf(slotsJ[s] ?? []));
  let att = 0, ben = 0;
  for (const { s, u, j, g } of attG) att += (uM[s].get(u) ?? 0) * (jM[s].get(j) ?? 0) * g.count;
  for (const { s, u, g } of benG) ben += (uM[s].get(u) ?? 0) * g.count;
  return { att, ben };
}

/** Exact allocation of `total` across suites proportional to `weights` (largest remainder). */
function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const raw = weights.map(w => total * w / sum), fl = raw.map(Math.floor);
  let rem = total - fl.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => ({ i, f: x - Math.floor(x) })).sort((a, b) => b.f - a.f);
  for (let k = 0; k < rem; k++) fl[order[k % fl.length].i]++;
  return fl;
}

const p1 = (d: number[], shift = 0): number => (1 + d.filter(x => x + shift <= 0).length) / (d.length + 1);   // stats-s2 (a) order statistic
const mean = (a: number[]): number => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const std = (a: number[]): number => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); };
const erf = (x: number): number => { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; };
const normCdf = (z: number): number => 0.5 * (1 + erf(z / Math.SQRT2));

export interface SimOut { status: number[]; diff: number[]; runs: number[]; pos: number[]; success: number[]; precSuccess: number[] }
/** One outer design + inner test. status: 0 valid, 1 inconclusive (redraw exhaustion), 2 undefined point precision. */
export function oneDesign(pool: Pool, K: number, U: number, J: number, N: number, R: number): SimOut {
  const out: SimOut = { status: [], diff: [], runs: [], pos: [], success: [], precSuccess: [] };
  const nU = allocate(U, pool.suites.map(s => pool.share[s])), nJ = allocate(J, pool.suites.map(s => pool.share[s]));
  for (let n = 0; n < N; n++) {
    const rnd = mulberry(SEED + n);
    const baseMult = new Map<string, number>();
    for (let k = 0; k < K; k++) { const b = pool.bases[Math.floor(rnd() * pool.bases.length)]; baseMult.set(b, (baseMult.get(b) ?? 0) + 1); }
    const slotsU: Record<string, number[]> = {}, slotsJ: Record<string, number[]> = {};
    pool.suites.forEach((s, si) => {
      const us = pool.userTasks[s], js = pool.injTasks[s];
      const su: number[] = []; for (let k = 0; k < nU[si]; k++) su.push(Math.floor(rnd() * us.length));
      const sj: number[] = []; for (let k = 0; k < nJ[si]; k++) sj.push(js.length ? Math.floor(rnd() * js.length) : 0);
      slotsU[s] = su; slotsJ[s] = sj;
    });
    const { attG, benG } = buildGroups(pool, baseMult);
    const uM = pool.suites.map(s => multOf(slotsU[s])), jM = pool.suites.map(s => multOf(slotsJ[s]));
    let F3 = 0, TP3 = 0, F2 = 0, TP2 = 0, Pos = 0, runs = 0;
    for (const { s, u, j, g } of attG) { const w = (uM[s].get(u) ?? 0) * (jM[s].get(j) ?? 0); if (!w) continue; F3 += w * g.F3; TP3 += w * g.TP3; F2 += w * g.F2; TP2 += w * g.TP2; Pos += w * g.Pos; runs += w * g.count; }
    for (const { s, u, g } of benG) { const w = uM[s].get(u) ?? 0; if (!w) continue; F3 += w * g.F3; TP3 += w * g.TP3; F2 += w * g.F2; TP2 += w * g.TP2; Pos += w * g.Pos; runs += w * g.count; }
    out.runs.push(runs); out.pos.push(Pos);
    if (!F3 || !F2) { out.status.push(2); out.diff.push(NaN); out.success.push(0); out.precSuccess.push(0); continue; }
    out.diff.push(TP3 / F3 - TP2 / F2);
    const dP: number[] = [], dR: number[] = []; let redraws = 0;
    while (dP.length < R) {
      const cu = pool.suites.map((s, si) => { const bl = slotsU[s], m = new Map<number, number>(); for (let k = 0; k < bl.length; k++) { const x = bl[Math.floor(rnd() * bl.length)]; m.set(x, (m.get(x) ?? 0) + 1); } return m; });
      const cj = pool.suites.map((s, si) => { const bl = slotsJ[s], m = new Map<number, number>(); for (let k = 0; k < bl.length; k++) { const x = bl[Math.floor(rnd() * bl.length)]; m.set(x, (m.get(x) ?? 0) + 1); } return m; });
      let f3 = 0, t3 = 0, f2 = 0, t2 = 0, pos = 0;
      for (const { s, u, j, g } of attG) { const w = (cu[s].get(u) ?? 0) * (cj[s].get(j) ?? 0); if (!w) continue; f3 += w * g.F3; t3 += w * g.TP3; f2 += w * g.F2; t2 += w * g.TP2; pos += w * g.Pos; }
      for (const { s, u, g } of benG) { const w = cu[s].get(u) ?? 0; if (!w) continue; f3 += w * g.F3; t3 += w * g.TP3; f2 += w * g.F2; t2 += w * g.TP2; pos += w * g.Pos; }
      if (!f3 || !f2 || !pos) { if (++redraws > REDRAW_CAP * R) break; continue; }
      dP.push(t3 / f3 - t2 / f2); dR.push(t3 / pos - t2 / pos);
    }
    if (dP.length < R) { out.status.push(1); out.success.push(0); out.precSuccess.push(0); continue; }
    const pA = p1(dP), pR = p1(dR, RECALL_MARGIN);
    out.status.push(0); out.success.push(pA <= ALPHA && pR <= ALPHA ? 1 : 0); out.precSuccess.push(pA <= ALPHA ? 1 : 0);
  }
  return out;
}

function endpointOf(runs: Run[], pick: (r: Run) => number) { let F = 0, TP = 0, Pos = 0; for (const r of runs) { const f = pick(r); if (f) { F++; if (r.y) TP++; } if (r.y) Pos++; } return { F, TP, Pos, precision: F ? TP / F : null, recall: Pos ? TP / Pos : null }; }
function makePool(labels: any[], map: (l: any) => { suite: string; base: string; u: number; j: number | null; fV2: number; fV3: number }, diag: any, diagCell: (d: any) => any): Pool {
  const runs: Run[] = labels.map(l => { const m = map(l); return { suite: m.suite, base: m.base, u: m.u, j: m.j, fV2: m.fV2, fV3: m.fV3, y: (l.attacked && l.security === true) ? 1 : 0 }; });
  const e2 = endpointOf(runs, r => r.fV2), e3 = endpointOf(runs, r => r.fV3), cells = diagCell(diag);
  for (const [name, e] of [['typedxV2', e2], ['typedxV3', e3]] as const) { const c = cells[name]; if (!c || c.F !== e.F || c.TP !== e.TP || c.Pos !== e.Pos) throw new Error(`observed ${name} does not match diag (${JSON.stringify(e)} vs ${JSON.stringify(c)})`); }
  return finalizePool(runs, { precision_v2: e2.precision!, precision_v3: e3.precision!, precision_diff: e3.precision! - e2.precision!, recall_v2: e2.recall!, recall_v3: e3.recall!, recall_diff: e3.recall! - e2.recall!, positives: e2.Pos, runs: runs.length });
}
function flagMap(labels: any[], obs: Obs[], fn: (c: Obs) => boolean): Map<string, number> { const s = new Map<string, number>(); for (const l of labels) s.set(l.run_id, 0); for (const c of obs) if (fn(c)) s.set(c.run_id, 1); return s; }
function flagsFor(labels: any[], obs: Obs[], tid: (c: Obs) => string, T: any): { fV2: Map<string, number>; fV3: Map<string, number> } {
  const qual = new Map(obs.map(c => [c.obs_id, qualifying(c as never)]));
  const v2 = (c: Obs) => qual.get(c.obs_id)!.length > 0;
  const v3 = (c: Obs) => qual.get(c.obs_id)!.some(x => x.route !== 'whole' || !!T.relevant.get(tid(c))?.has(x.key));
  const typ = (c: Obs) => !!T.eligible.get(tid(c));
  return { fV2: flagMap(labels, obs, c => typ(c) && v2(c)), fV3: flagMap(labels, obs, c => typ(c) && v3(c)) };
}
function buildS2(o: PowerOpts, diag: any): Pool {
  const sanitized = join(o.s2Dir, 'observations.sanitized.jsonl'), labelsPath = join(o.s2Dir, 'labels.jsonl');
  verifyBaselines(o.s2Dir, sanitized, labelsPath, o.expectedS2Baseline ?? REAL_BASELINE);
  const binding = JSON.parse(readFileSync(o.binding, 'utf8')) as BindingShape;
  const snap = JSON.parse(readFileSync(join(o.frozen, 'snapshot.json'), 'utf8'));
  const obs = readJsonl<Obs>(sanitized), labels = (readJsonl<any>(labelsPath)).filter(l => l.group === 'P');
  const T = typing(snap as never, binding as never, manifestFromBinding(binding as never) as never);
  const { fV2, fV3 } = flagsFor(labels, obs, c => `agentdyn:${c.suite}/${c.action.name}`, T);
  return makePool(labels, l => ({ suite: l.suite, base: l.base, u: l.user_task, j: l.injection_task, fV2: fV2.get(l.run_id)!, fV3: fV3.get(l.run_id)! }), diag, d => d.q1.P);
}
function buildS1(o: PowerOpts, diag: any): Pool {
  const raw = join(o.s1Pool!, 'observations.jsonl'), labelsPath = join(o.s1Pool!, 'labels.jsonl');
  if (!o.s1Manifest) throw new Error('--s1-pool needs --s1-manifest');
  const names: string[] = [];
  for (const line of readFileSync(o.s1Manifest, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/); if (!m) throw new Error(`bad S1 manifest line: ${line}`);
    const name = m[2].split('/').pop()!;
    if (sha256(readFileSync(join(o.s1Pool!, name))) !== m[1]) throw new Error(`S1 input differs from the manifest: ${name}`);
    names.push(name);
  }
  const set = new Set(names);
  if (set.size !== names.length) throw new Error('duplicate S1 manifest entry');
  for (const n of S1_FILES) if (!set.has(n)) throw new Error(`S1 manifest is missing ${n}`);
  for (const n of set) if (!S1_FILES.includes(n)) throw new Error(`S1 manifest has an unexpected entry: ${n}`);
  const obs = readJsonl<Record<string, unknown>>(raw).map(r => sanitizeObs(r as never) as unknown as Obs), labels = readJsonl<any>(labelsPath);
  const binding = JSON.parse(readFileSync(join(o.frozen, 'binding-v2.json'), 'utf8')) as BindingShape;
  const manifestV2 = JSON.parse(readFileSync(join(o.frozen, 'tool-manifest-v2.json'), 'utf8')).tools;
  const snap = JSON.parse(readFileSync(join(o.frozen, 'snapshot.json'), 'utf8'));
  const T = typing(snap as never, binding as never, manifestV2 as never);
  const { fV2, fV3 } = flagsFor(labels, obs, c => `agentdojo:${c.suite}/${c.action.name}`, T);
  return makePool(labels, l => ({ suite: l.suite, base: baseOf(l.pipeline), u: l.user_task, j: l.injection_task, fV2: fV2.get(l.run_id)!, fV3: fV3.get(l.run_id)! }), diag, d => d.q5?.S1?.q1);
}

function fitSE(points: Array<{ U: number; sd: number }>): { a: number; r2: number } {
  const xs = points.filter(p => p.U > 0 && Number.isFinite(p.sd)).map(p => ({ inv: 1 / Math.sqrt(p.U), y: p.sd }));
  if (!xs.length) return { a: 0, r2: 0 };
  const a = xs.reduce((s, p) => s + p.y * p.inv, 0) / xs.reduce((s, p) => s + p.inv * p.inv, 0);
  const ybar = mean(xs.map(p => p.y));
  const ssres = xs.reduce((s, p) => s + (p.y - a * p.inv) * (p.y - a * p.inv), 0), sstot = xs.reduce((s, p) => s + (p.y - ybar) * (p.y - ybar), 0);
  return { a, r2: sstot ? 1 - ssres / sstot : 0 };
}

export function runPower(o: PowerOpts): Record<string, unknown> {
  const diag = JSON.parse(readFileSync(o.diagPath, 'utf8'));
  const N = o.N ?? 200, R = o.R ?? 500;
  const grid = o.grid ?? { K: [3, 5], U: [20, 40, 60, 100, 150], J: [10, 20, 35] };
  const pools: Record<string, unknown> = {};
  const built: Array<[string, Pool]> = [['S2', buildS2(o, diag)]];
  if (o.s1Pool) built.push(['S1', buildS1(o, diag)]);
  for (const [key, pool] of built) {
    const designs: any[] = [], fitPts: Array<{ U: number; sd: number }> = [];
    const distinctTasks = pool.suites.reduce((a, s) => a + pool.userTasks[s].length, 0);
    for (const K of grid.K) for (const U of grid.U) for (const J of grid.J) {
      const r = oneDesign(pool, K, U, J, N, R);
      const defIdx = r.diff.map((d, i) => Number.isFinite(d) ? i : -1).filter(i => i >= 0);
      const diffs = defIdx.map(i => r.diff[i]), outerSd = std(diffs);
      const power = mean(r.success), powerPrec = mean(r.precSuccess);
      designs.push({ K, U, J, repeats_tasks: U > distinctTasks, expected_runs: mean(r.runs), expected_positives: mean(r.pos),
        mean_precision_diff: mean(diffs), outer_sd: outerSd, power, power_precision_only: powerPrec,
        power_mc_se: Math.sqrt(power * (1 - power) / N), power_precision_mc_se: Math.sqrt(powerPrec * (1 - powerPrec) / N),
        n_valid: r.status.filter(s => s === 0).length, n_inconclusive: r.status.filter(s => s === 1).length, n_undefined: r.status.filter(s => s === 2).length });
      fitPts.push({ U, sd: outerSd });
    }
    const fit = fitSE(fitPts);
    const analytic = designs.map((d: any) => { const se = fit.a / Math.sqrt(d.U); return { K: d.K, U: d.U, J: d.J, se_fit: se, power_delta_2: normCdf(0.02 / se - 1.645), power_delta_4: normCdf(0.04 / se - 1.645), power_delta_6: normCdf(0.06 / se - 1.645) }; });
    pools[key] = { observed: pool.observed, fit, designs, analytic };
  }
  const out = { endpoint: ENDPOINT, alpha: ALPHA, recall_margin: RECALL_MARGIN, sim: { N, R, seed: SEED }, grid, pools };
  validatePower(out, JSON.parse(readFileSync(new URL('./power-schema.json', import.meta.url), 'utf8')));
  if (o.out) { mkdirSync(dirname(o.out), { recursive: true }); writeFileSync(o.out, JSON.stringify(out, null, 1) + '\n'); }
  return out as unknown as Record<string, unknown>;
}

export function validatePower(data: unknown, schema: any): void {
  const enums: Record<string, string[]> = schema.enums ?? {};
  const resolve = (n: any): any => { while (n && n.$ref) n = schema.defs[n.$ref]; return n; };
  const keyOk = (kind: string, key: string, path: string): void => { if (kind.startsWith('enum:')) { const e = kind.slice(5); if (!enums[e]?.includes(key)) throw new Error(`${path}: key not in enum ${e}: ${key}`); return; } throw new Error(`${path}: unknown key rule ${kind}`); };
  const walk = (raw: any, v: unknown, path: string): void => {
    const node = resolve(raw);
    switch (node.k) {
      case 'obj': { if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${path}: expected object`); const obj = v as Record<string, unknown>, keys = node.keys;
        for (const [k, val] of Object.entries(obj)) { if (!Object.hasOwn(keys, k)) throw new Error(`${path}.${k}: unexpected field`); walk(keys[k], val, `${path}.${k}`); }
        for (const k of Object.keys(keys)) if (!Object.hasOwn(obj, k) && !keys[k].opt) throw new Error(`${path}.${k}: missing field`); return; }
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

const arg = (k: string): string | null => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
if (process.argv[1] != null && import.meta.url === `file://${process.argv[1]}`) {
  const s2Dir = arg('--s2-dir') ?? 'runs/onto-s2-input', binding = arg('--binding') ?? 'eval/ontology/s2/binding-agentdyn.json';
  const frozen = arg('--frozen') ?? 'eval/ontology/v2/frozen', diagPath = arg('--diag') ?? 'runs/onto-s2-diag/diag-s2.json';
  const res = runPower({ s2Dir, binding, frozen, diagPath, out: arg('--out') ?? undefined, s1Pool: arg('--s1-pool') ?? undefined, s1Manifest: arg('--s1-manifest') ?? undefined,
    N: arg('--N') ? Number(arg('--N')) : undefined, R: arg('--R') ? Number(arg('--R')) : undefined });
  const p = res.pools as any;
  console.log(`power-hc1: S2 observed %s pts over ${p.S2.observed.runs} runs; ${p.S2.designs.length} designs%s`, (p.S2.observed.precision_diff * 100).toFixed(2), p.S1 ? `; S1 observed ${(p.S1.observed.precision_diff * 100).toFixed(2)} pts` : '');
}
