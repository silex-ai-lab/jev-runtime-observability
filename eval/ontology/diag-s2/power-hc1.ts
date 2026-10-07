// power-hc1.ts (P-HC1, CG-P r1 fixes; extended by P-HC1b): exploratory power for H-C1 (S2_DIAGNOSIS §6). Two spent pools only.
// Default H-C1 test (unchanged): monitors typed×V2 vs typed×V3; one-sided paired task-crossed bootstrap (stats-s2.ts (a)
// procedure) of precision(V3-V2)>0 AND recall(V3-V2) > -3 points; success = both p <= 0.05. Design-level resampling keeps
// sampled user/injection occurrence slots (with replacement) through assembly and the inner bootstrap.
// P-HC1b options (endpoint mode, triggered by --precision-margin or --recall-ref): precision margin δ0 on the V3-V2
// superiority test (p = share of bootstrap diffs <= δ0, with the same (a) order-statistic convention) AND a recall guard
// against an operational comparator: recall(typed×V3) - recall(ref) > -0.03 with ref ∈ {V2, boundV1}; boundV1 is
// B-prov-bound (binding effects other than core-effect-data-read AND untrustedKeys>0). Endpoint mode writes its own
// closed-schema JSON and never changes the default output.
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
const ENDPOINT_MARGIN = 'one-sided paired task-crossed bootstrap: precision(V3-V2) > precision_margin and recall(V3-recall_ref) > -recall_margin';
const DATA_READ = 'core:core-effect-data-read';
const S1_FILES = ['observations.jsonl', 'labels.jsonl', 'labels-pr.jsonl', 'counts.json'];

export interface Run { suite: string; base: string; u: number; j: number | null; fV2: number; fV3: number; fB1: number; y: number }
/** Summed sufficient statistics for one (suite,user,injection,base) cell (many trajectories may share it, e.g. S1 cohorts). */
interface Cell { n: number; F2: number; F3: number; TP2: number; TP3: number; Pos: number; B1: number; B1TP: number }
interface Group { F3: number; TP3: number; F2: number; TP2: number; Pos: number; count: number; B1: number; B1TP: number }
interface Observed { precision_v2: number; precision_v3: number; precision_diff: number; recall_v2: number; recall_v3: number; recall_diff: number; positives: number; runs: number }
/** Pooled B-prov-bound (bound×V1) counts: alerts, true positives, positives. */
export interface BoundV1 { F: number; TP: number; Pos: number }
export type RecallRef = 'V2' | 'boundV1';
export interface Pool { runs: Run[]; suites: string[]; bases: string[]; userTasks: Record<string, number[]>; injTasks: Record<string, number[]>; share: Record<string, number>; att: (Cell | null)[][][][]; ben: (Cell | null)[][][]; observed: Observed; boundV1: BoundV1 }
export interface PowerOpts { s2Dir: string; binding: string; frozen: string; diagPath: string; out?: string; s1Pool?: string; s1Manifest?: string; expectedS2Baseline?: { baseline: string[]; sanitized: string[] }; N?: number; R?: number; grid?: { K: number[]; U: number[]; J: number[] }; precisionMargin?: number; recallRef?: RecallRef; recallMargin?: number }

/** Precompute the per-(suite,user,injection,base) flag tables; no run text. Exported for the hand-computed test. */
export function finalizePool(runs: Run[], observed: Observed): Pool {
  const suites = [...new Set(runs.map(r => r.suite))].sort(), bases = [...new Set(runs.map(r => r.base))].sort();
  const suiteIdx = new Map(suites.map((s, i) => [s, i])), baseIdx = new Map(bases.map((b, i) => [b, i]));
  const userTasks: Record<string, number[]> = {}, injTasks: Record<string, number[]> = {};
  for (const s of suites) {
    userTasks[s] = [...new Set(runs.filter(r => r.suite === s).map(r => r.u))].sort((a, b) => a - b);
    injTasks[s] = [...new Set(runs.filter(r => r.suite === s && r.j !== null).map(r => r.j as number))].sort((a, b) => a - b);
  }
  const att: (Cell | null)[][][][] = suites.map(s => userTasks[s].map(() => injTasks[s].map(() => bases.map(() => null))));
  const ben: (Cell | null)[][][] = suites.map(s => userTasks[s].map(() => bases.map(() => null)));
  for (const r of runs) {
    const si = suiteIdx.get(r.suite)!, ui = userTasks[r.suite].indexOf(r.u), bi = baseIdx.get(r.base)!;
    const cell = (arr: (Cell | null)[]): Cell => { const c0 = arr[bi]; const c = c0 ?? (arr[bi] = { n: 0, F2: 0, F3: 0, TP2: 0, TP3: 0, Pos: 0, B1: 0, B1TP: 0 }); c.n++; c.F2 += r.fV2; c.F3 += r.fV3; c.TP2 += r.fV2 * r.y; c.TP3 += r.fV3 * r.y; c.Pos += r.y; c.B1 += r.fB1; c.B1TP += r.fB1 * r.y; return c; };
    if (r.j === null) cell(ben[si][ui]); else cell(att[si][ui][injTasks[r.suite].indexOf(r.j)]);
  }
  const share: Record<string, number> = {}; for (const s of suites) share[s] = runs.filter(r => r.suite === s).length / runs.length;
  const boundV1: BoundV1 = { F: 0, TP: 0, Pos: 0 };
  for (const r of runs) { if (r.fB1) boundV1.F++; if (r.y) { boundV1.Pos++; if (r.fB1) boundV1.TP++; } }
  return { runs, suites, bases, userTasks, injTasks, share, att, ben, observed, boundV1 };
}

function buildGroups(pool: Pool, baseMult: Map<string, number>) {
  const attG: Array<{ s: number; u: number; j: number; g: Group }> = [], benG: Array<{ s: number; u: number; g: Group }> = [];
  const B = pool.bases.length, bw = pool.bases.map(b => baseMult.get(b) ?? 0);
  for (let si = 0; si < pool.suites.length; si++) {
    const U = pool.userTasks[pool.suites[si]], J = pool.injTasks[pool.suites[si]];
    for (let ui = 0; ui < U.length; ui++) {
      let g: Group | null = null;
      for (let bi = 0; bi < B; bi++) { const c = pool.ben[si][ui][bi]; if (!c || !bw[bi]) continue; if (!g) g = { F3: 0, TP3: 0, F2: 0, TP2: 0, Pos: 0, count: 0, B1: 0, B1TP: 0 }; g.count += bw[bi] * c.n; g.F3 += bw[bi] * c.F3; g.TP3 += bw[bi] * c.TP3; g.F2 += bw[bi] * c.F2; g.TP2 += bw[bi] * c.TP2; g.Pos += bw[bi] * c.Pos; g.B1 += bw[bi] * c.B1; g.B1TP += bw[bi] * c.B1TP; }
      if (g) benG.push({ s: si, u: ui, g });
      for (let ji = 0; ji < J.length; ji++) {
        let a: Group | null = null;
        for (let bi = 0; bi < B; bi++) { const c = pool.att[si][ui][ji][bi]; if (!c || !bw[bi]) continue; if (!a) a = { F3: 0, TP3: 0, F2: 0, TP2: 0, Pos: 0, count: 0, B1: 0, B1TP: 0 }; a.count += bw[bi] * c.n; a.F3 += bw[bi] * c.F3; a.TP3 += bw[bi] * c.TP3; a.F2 += bw[bi] * c.F2; a.TP2 += bw[bi] * c.TP2; a.Pos += bw[bi] * c.Pos; a.B1 += bw[bi] * c.B1; a.B1TP += bw[bi] * c.B1TP; }
        if (a) attG.push({ s: si, u: ui, j: ji, g: a });
      }
    }
  }
  return { attG, benG };
}
const multOf = (slots: number[]): Map<number, number> => { const m = new Map<number, number>(); for (const x of slots) m.set(x, (m.get(x) ?? 0) + 1); return m; };

/** Attacked/benign run counts of an assembled design (occurrence slots preserved). Exported for the hand-computed test. */
export function designCounts(pool: Pool, baseMult: Map<string, number>, slotsU: Record<string, number[]>, slotsJ: Record<string, number[]>): { att: number; ben: number } {
  const s = assembleStats(pool, baseMult, slotsU, slotsJ);
  return { att: s.att, ben: s.ben };
}

/** Full-point statistics of an assembled design (summed over occurrence multiplicities and cell trajectories). */
export function assembleStats(pool: Pool, baseMult: Map<string, number>, slotsU: Record<string, number[]>, slotsJ: Record<string, number[]>): { att: number; ben: number; runs: number; F2: number; TP2: number; F3: number; TP3: number; Pos: number } {
  const { attG, benG } = buildGroups(pool, baseMult);
  const uM = pool.suites.map(s => multOf(slotsU[s] ?? [])), jM = pool.suites.map(s => multOf(slotsJ[s] ?? []));
  let F3 = 0, TP3 = 0, F2 = 0, TP2 = 0, Pos = 0, att = 0, ben = 0;
  for (const { s, u, j, g } of attG) { const w = (uM[s].get(u) ?? 0) * (jM[s].get(j) ?? 0); if (!w) continue; F3 += w * g.F3; TP3 += w * g.TP3; F2 += w * g.F2; TP2 += w * g.TP2; Pos += w * g.Pos; att += w * g.count; }
  for (const { s, u, g } of benG) { const w = uM[s].get(u) ?? 0; if (!w) continue; F3 += w * g.F3; TP3 += w * g.TP3; F2 += w * g.F2; TP2 += w * g.TP2; Pos += w * g.Pos; ben += w * g.count; }
  return { att, ben, runs: att + ben, F2, TP2, F3, TP3, Pos };
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

/** stats-s2 (a) order-statistic p-value: (1 + #{x + shift <= 0}) / (len + 1). Exported for the hand-checked margin test. */
export const orderStatP = (d: number[], shift = 0): number => (1 + d.filter(x => x + shift <= 0).length) / (d.length + 1);
const mean = (a: number[]): number => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const std = (a: number[]): number => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); };
const erf = (x: number): number => { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; };
const normCdf = (z: number): number => 0.5 * (1 + erf(z / Math.SQRT2));

export interface SimOut { status: number[]; diff: number[]; recDiff: number[]; runs: number[]; pos: number[]; success: number[]; precSuccess: number[]; recallSuccess: number[] }
export interface SimOpts { precisionMargin?: number; recallRef?: RecallRef; recallMargin?: number }
/** One outer design + inner test. status: 0 valid, 1 inconclusive (redraw exhaustion), 2 undefined point precision.
 *  The default (no opts) is the P-HC1 endpoint: precision(V3-V2) > 0 and recall(V3-V2) > -3 points. `precisionMargin`
 *  shifts the precision null to diff <= margin; `recallRef` selects the recall-guard comparator (V2 or B-prov-bound). */
export function oneDesign(pool: Pool, K: number, U: number, J: number, N: number, R: number, opts?: SimOpts): SimOut {
  const margin = opts?.precisionMargin ?? 0, recallM = opts?.recallMargin ?? RECALL_MARGIN, ref: RecallRef = opts?.recallRef ?? 'V2';
  const out: SimOut = { status: [], diff: [], recDiff: [], runs: [], pos: [], success: [], precSuccess: [], recallSuccess: [] };
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
    let F3 = 0, TP3 = 0, F2 = 0, TP2 = 0, Pos = 0, runs = 0, B1TP = 0;
    for (const { s, u, j, g } of attG) { const w = (uM[s].get(u) ?? 0) * (jM[s].get(j) ?? 0); if (!w) continue; F3 += w * g.F3; TP3 += w * g.TP3; F2 += w * g.F2; TP2 += w * g.TP2; Pos += w * g.Pos; B1TP += w * g.B1TP; runs += w * g.count; }
    for (const { s, u, g } of benG) { const w = uM[s].get(u) ?? 0; if (!w) continue; F3 += w * g.F3; TP3 += w * g.TP3; F2 += w * g.F2; TP2 += w * g.TP2; Pos += w * g.Pos; B1TP += w * g.B1TP; runs += w * g.count; }
    out.runs.push(runs); out.pos.push(Pos);
    if (!F3 || !F2) { out.status.push(2); out.diff.push(NaN); out.recDiff.push(NaN); out.success.push(0); out.precSuccess.push(0); out.recallSuccess.push(0); continue; }
    out.diff.push(TP3 / F3 - TP2 / F2);
    out.recDiff.push(Pos ? TP3 / Pos - (ref === 'V2' ? TP2 : B1TP) / Pos : NaN);
    const dP: number[] = [], dR: number[] = [], dRref: number[] = []; let redraws = 0;
    while (dP.length < R) {
      const cu = pool.suites.map((s, si) => { const bl = slotsU[s], m = new Map<number, number>(); for (let k = 0; k < bl.length; k++) { const x = bl[Math.floor(rnd() * bl.length)]; m.set(x, (m.get(x) ?? 0) + 1); } return m; });
      const cj = pool.suites.map((s, si) => { const bl = slotsJ[s], m = new Map<number, number>(); for (let k = 0; k < bl.length; k++) { const x = bl[Math.floor(rnd() * bl.length)]; m.set(x, (m.get(x) ?? 0) + 1); } return m; });
      let f3 = 0, t3 = 0, f2 = 0, t2 = 0, pos = 0, b1tp = 0;
      for (const { s, u, j, g } of attG) { const w = (cu[s].get(u) ?? 0) * (cj[s].get(j) ?? 0); if (!w) continue; f3 += w * g.F3; t3 += w * g.TP3; f2 += w * g.F2; t2 += w * g.TP2; pos += w * g.Pos; b1tp += w * g.B1TP; }
      for (const { s, u, g } of benG) { const w = cu[s].get(u) ?? 0; if (!w) continue; f3 += w * g.F3; t3 += w * g.TP3; f2 += w * g.F2; t2 += w * g.TP2; pos += w * g.Pos; b1tp += w * g.B1TP; }
      if (!f3 || !f2 || !pos) { if (++redraws > REDRAW_CAP * R) break; continue; }
      dP.push(t3 / f3 - t2 / f2); dR.push(t3 / pos - t2 / pos); if (ref === 'boundV1') dRref.push(t3 / pos - b1tp / pos);
    }
    if (dP.length < R) { out.status.push(1); out.success.push(0); out.precSuccess.push(0); out.recallSuccess.push(0); continue; }
    const pA = orderStatP(dP, -margin), pR = orderStatP(ref === 'boundV1' ? dRref : dR, recallM);
    out.status.push(0); out.success.push(pA <= ALPHA && pR <= ALPHA ? 1 : 0); out.precSuccess.push(pA <= ALPHA ? 1 : 0); out.recallSuccess.push(pR <= ALPHA ? 1 : 0);
  }
  return out;
}

function endpointOf(runs: Run[], pick: (r: Run) => number) { let F = 0, TP = 0, Pos = 0; for (const r of runs) { const f = pick(r); if (f) { F++; if (r.y) TP++; } if (r.y) Pos++; } return { F, TP, Pos, precision: F ? TP / F : null, recall: Pos ? TP / Pos : null }; }
function makePool(labels: any[], map: (l: any) => { suite: string; base: string; u: number; j: number | null; fV2: number; fV3: number; fB1: number }, diag: any, diagCell: (d: any) => any): Pool {
  const runs: Run[] = labels.map(l => { const m = map(l); return { suite: m.suite, base: m.base, u: m.u, j: m.j, fV2: m.fV2, fV3: m.fV3, fB1: m.fB1, y: (l.attacked && l.security === true) ? 1 : 0 }; });
  const e2 = endpointOf(runs, r => r.fV2), e3 = endpointOf(runs, r => r.fV3), cells = diagCell(diag);
  for (const [name, e] of [['typedxV2', e2], ['typedxV3', e3]] as const) { const c = cells[name]; if (!c || c.F !== e.F || c.TP !== e.TP || c.Pos !== e.Pos) throw new Error(`observed ${name} does not match diag (${JSON.stringify(e)} vs ${JSON.stringify(c)})`); }
  return finalizePool(runs, { precision_v2: e2.precision!, precision_v3: e3.precision!, precision_diff: e3.precision! - e2.precision!, recall_v2: e2.recall!, recall_v3: e3.recall!, recall_diff: e3.recall! - e2.recall!, positives: e2.Pos, runs: runs.length });
}
function flagMap(labels: any[], obs: Obs[], fn: (c: Obs) => boolean): Map<string, number> { const s = new Map<string, number>(); for (const l of labels) s.set(l.run_id, 0); for (const c of obs) if (fn(c)) s.set(c.run_id, 1); return s; }
function flagsFor(labels: any[], obs: Obs[], tid: (c: Obs) => string, T: any, binding: any): { fV2: Map<string, number>; fV3: Map<string, number>; fB1: Map<string, number> } {
  const qual = new Map(obs.map(c => [c.obs_id, qualifying(c as never)]));
  const v2 = (c: Obs) => qual.get(c.obs_id)!.length > 0;
  const v3 = (c: Obs) => qual.get(c.obs_id)!.some(x => x.route !== 'whole' || !!T.relevant.get(tid(c))?.has(x.key));
  const typ = (c: Obs) => !!T.eligible.get(tid(c));
  const wbound = (c: Obs) => { const b = binding?.tools?.[tid(c)]; return !!b && (b.effects ?? []).some((e: string) => e !== DATA_READ); };
  const v1 = (c: Obs) => untrustedKeys(c).size > 0;
  return { fV2: flagMap(labels, obs, c => typ(c) && v2(c)), fV3: flagMap(labels, obs, c => typ(c) && v3(c)), fB1: flagMap(labels, obs, c => wbound(c) && v1(c)) };
}
function buildS2(o: PowerOpts, diag: any): Pool {
  const sanitized = join(o.s2Dir, 'observations.sanitized.jsonl'), labelsPath = join(o.s2Dir, 'labels.jsonl');
  verifyBaselines(o.s2Dir, sanitized, labelsPath, o.expectedS2Baseline ?? REAL_BASELINE);
  const binding = JSON.parse(readFileSync(o.binding, 'utf8')) as BindingShape;
  const snap = JSON.parse(readFileSync(join(o.frozen, 'snapshot.json'), 'utf8'));
  const obs = readJsonl<Obs>(sanitized), labels = (readJsonl<any>(labelsPath)).filter(l => l.group === 'P');
  const T = typing(snap as never, binding as never, manifestFromBinding(binding as never) as never);
  const { fV2, fV3, fB1 } = flagsFor(labels, obs, c => `agentdyn:${c.suite}/${c.action.name}`, T, binding);
  return makePool(labels, l => ({ suite: l.suite, base: l.base, u: l.user_task, j: l.injection_task, fV2: fV2.get(l.run_id)!, fV3: fV3.get(l.run_id)!, fB1: fB1.get(l.run_id)! }), diag, d => d.q1.P);
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
  const { fV2, fV3, fB1 } = flagsFor(labels, obs, c => `agentdojo:${c.suite}/${c.action.name}`, T, binding);
  return makePool(labels, l => ({ suite: l.suite, base: baseOf(l.pipeline), u: l.user_task, j: l.injection_task, fV2: fV2.get(l.run_id)!, fV3: fV3.get(l.run_id)!, fB1: fB1.get(l.run_id)! }), diag, d => d.q5?.S1?.q1);
}

function fitSE(points: Array<{ U: number; sd: number | null }>): { a: number; r2: number } {
  const xs = points.filter(p => p.U > 0 && Number.isFinite(p.sd)).map(p => ({ inv: 1 / Math.sqrt(p.U), y: p.sd as number }));
  if (!xs.length) return { a: 0, r2: 0 };
  const a = xs.reduce((s, p) => s + p.y * p.inv, 0) / xs.reduce((s, p) => s + p.inv * p.inv, 0);
  const ybar = mean(xs.map(p => p.y));
  const ssres = xs.reduce((s, p) => s + (p.y - a * p.inv) * (p.y - a * p.inv), 0), sstot = xs.reduce((s, p) => s + (p.y - ybar) * (p.y - ybar), 0);
  return { a, r2: sstot ? 1 - ssres / sstot : 0 };
}

export function runPower(o: PowerOpts): Record<string, unknown> {
  const diag = JSON.parse(readFileSync(o.diagPath, 'utf8'));
  const N = o.N ?? 200, R = o.R ?? 500;
  const endpointMode = o.precisionMargin !== undefined || o.recallRef !== undefined || o.recallMargin !== undefined;
  const precisionMargin = o.precisionMargin ?? 0, recallRef: RecallRef = o.recallRef ?? 'V2', recallMargin = o.recallMargin ?? RECALL_MARGIN;
  const grid = o.grid ?? { K: [3, 5], U: [20, 40, 60, 100, 150], J: [10, 20, 35] };
  const pools: Record<string, unknown> = {};
  const built: Array<[string, Pool]> = [['S2', buildS2(o, diag)]];
  if (o.s1Pool) built.push(['S1', buildS1(o, diag)]);
  for (const [key, pool] of built) {
    const designs: any[] = [], fitPts: Array<{ U: number; sd: number | null }> = [];
    const distinctTasks = pool.suites.reduce((a, s) => a + pool.userTasks[s].length, 0);
    for (const K of grid.K) for (const U of grid.U) for (const J of grid.J) {
      const r = oneDesign(pool, K, U, J, N, R, endpointMode ? { precisionMargin, recallRef, recallMargin } : undefined);
      const diffs = r.diff.filter(d => Number.isFinite(d));
      const meanDiff = diffs.length ? mean(diffs) : null, outerSd = diffs.length >= 2 ? std(diffs) : null;
      const power = mean(r.success), powerPrec = mean(r.precSuccess);
      fitPts.push({ U, sd: outerSd });
      const counts = { n_valid: r.status.filter(s => s === 0).length, n_inconclusive: r.status.filter(s => s === 1).length, n_undefined: r.status.filter(s => s === 2).length };
      if (!endpointMode) {
        designs.push({ K, U, J, repeats_tasks: U > distinctTasks, expected_runs: mean(r.runs), expected_positives: mean(r.pos),
          mean_precision_diff: meanDiff, outer_sd: outerSd, power, power_precision_only: powerPrec,
          power_mc_se: Math.sqrt(power * (1 - power) / N), power_precision_mc_se: Math.sqrt(powerPrec * (1 - powerPrec) / N), ...counts });
      } else {
        const recDiffs = r.recDiff.filter(d => Number.isFinite(d)), powerRec = mean(r.recallSuccess);
        designs.push({ K, U, J, repeats_tasks: U > distinctTasks, expected_runs: mean(r.runs), expected_positives: mean(r.pos),
          mean_precision_diff: meanDiff, mean_recall_diff: recDiffs.length ? mean(recDiffs) : null, outer_sd: outerSd,
          power_joint: power, power_precision_only: powerPrec, power_recall_guard_only: powerRec,
          power_joint_mc_se: Math.sqrt(power * (1 - power) / N), power_precision_mc_se: Math.sqrt(powerPrec * (1 - powerPrec) / N),
          power_recall_guard_mc_se: Math.sqrt(powerRec * (1 - powerRec) / N), ...counts });
      }
    }
    const fit = fitSE(fitPts);
    if (!endpointMode) {
      const analytic = designs.map((d: any) => { const se = fit.a / Math.sqrt(d.U); return { K: d.K, U: d.U, J: d.J, se_fit: se, power_delta_2: normCdf(0.02 / se - 1.645), power_delta_4: normCdf(0.04 / se - 1.645), power_delta_6: normCdf(0.06 / se - 1.645) }; });
      pools[key] = { observed: pool.observed, fit, designs, analytic };
    } else {
      const ob = pool.observed, refRecall = recallRef === 'V2' ? ob.recall_v2 : (pool.boundV1.Pos ? pool.boundV1.TP / pool.boundV1.Pos : null);
      pools[key] = { observed: { precision_v2: ob.precision_v2, precision_v3: ob.precision_v3, precision_diff: ob.precision_diff,
        recall_v3: ob.recall_v3, recall_ref: refRecall, recall_diff: refRecall == null ? null : ob.recall_v3 - refRecall,
        positives: ob.positives, runs: ob.runs }, fit, designs };
    }
  }
  if (!endpointMode) {
    const out = { endpoint: ENDPOINT, alpha: ALPHA, recall_margin: RECALL_MARGIN, sim: { N, R, seed: SEED }, grid, pools };
    validatePower(out, JSON.parse(readFileSync(new URL('./power-schema.json', import.meta.url), 'utf8')));
    if (o.out) { mkdirSync(dirname(o.out), { recursive: true }); writeFileSync(o.out, JSON.stringify(out, null, 1) + '\n'); }
    return out as unknown as Record<string, unknown>;
  }
  const out = { endpoint: ENDPOINT_MARGIN, alpha: ALPHA, recall_margin: recallMargin, precision_margin: precisionMargin, recall_ref: recallRef, sim: { N, R, seed: SEED }, grid, pools };
  validatePower(out, JSON.parse(readFileSync(new URL('./power-endpoint-schema.json', import.meta.url), 'utf8')));
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
  const pm = arg('--precision-margin'), rr = arg('--recall-ref'), rm = arg('--recall-margin');
  if (rr != null && rr !== 'V2' && rr !== 'boundV1') throw new Error(`--recall-ref must be V2 or boundV1, got ${rr}`);
  const res = runPower({ s2Dir, binding, frozen, diagPath, out: arg('--out') ?? undefined, s1Pool: arg('--s1-pool') ?? undefined, s1Manifest: arg('--s1-manifest') ?? undefined,
    N: arg('--N') ? Number(arg('--N')) : undefined, R: arg('--R') ? Number(arg('--R')) : undefined,
    precisionMargin: pm != null ? Number(pm) : undefined, recallRef: rr != null ? (rr as RecallRef) : undefined, recallMargin: rm != null ? Number(rm) : undefined });
  const p = res.pools as any;
  const tag = res.precision_margin !== undefined ? `power-hc1-endpoint (margin=${res.precision_margin}, ref=${res.recall_ref}, recall_margin=${res.recall_margin})` : 'power-hc1';
  console.log(`${tag}: S2 observed ${(p.S2.observed.precision_diff * 100).toFixed(2)} pts over ${p.S2.observed.runs} runs; ${p.S2.designs.length} designs${p.S1 ? `; S1 observed ${(p.S1.observed.precision_diff * 100).toFixed(2)} pts` : ''}`);
}
