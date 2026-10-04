// EXPLORATORY power planning on already-used cohorts (E-AL, E-PR): stage-1 (ontology-typed candidates, no judge) vs provenance only.
import { readFileSync } from 'node:fs';
import { mulberry } from '../arms.ts';
import { typing, untrustedKeys, type Obs } from '../v2/typing.ts';
import { qualifying } from '../pr/values.ts';
const J = (p: string) => JSON.parse(readFileSync(p, 'utf8')), L = (p: string) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const F = 'eval/ontology/v2/frozen';
const Ty = typing(J(`${F}/snapshot.json`), J(`${F}/binding-v2.json`), J(`${F}/tool-manifest-v2.json`).tools);
function cohort(obsP: string, labP: string, tag: string) {
  const obs: Obs[] = L(obsP), labs = L(labP).map((l: any) => ({ ...l, user_task: `${tag}:${l.user_task}` }));
  const tid = (o: Obs) => `agentdojo:${o.suite}/${o.action.name}`;
  const s1 = new Set<string>(), pv = new Set<string>();
  for (const o of obs) {
    if (Ty.eligible.get(tid(o)) && qualifying(o).some(q => q.route !== 'whole' || Ty.relevant.get(tid(o))?.has(q.key))) s1.add(o.run_id);
    if (o.action.impact === 'write' && untrustedKeys(o).size) pv.add(o.run_id);
  }
  return labs.map((l: any) => ({ ...l, s1: s1.has(l.run_id) ? 1 : 0, pv: pv.has(l.run_id) ? 1 : 0, y: l.attacked && l.security === true }));
}
function boot(rows: any[], R = 2000) {
  // tasks are shared across cohorts: cluster by (suite, original user task) and injection task, as the registered design
  const key = (l: any) => String(l.user_task).split(':').pop();
  const suites = [...new Set(rows.map(r => r.suite))].sort();
  const U: Record<string, string[]> = {}, Jx: Record<string, number[]> = {};
  for (const s of suites) { U[s] = [...new Set(rows.filter(r => r.suite === s).map(key))].sort(); Jx[s] = [...new Set(rows.filter(r => r.suite === s && r.injection_task != null).map(r => r.injection_task))].sort((a, b) => a - b); }
  const rnd = mulberry(1); const dr: number[] = [], dp: number[] = [];
  for (let r = 0; r < R; r++) {
    const cu: any = {}, cj: any = {};
    for (const s of suites) { cu[s] = new Map(); cj[s] = new Map(); for (const _ of U[s]) { const u = U[s][Math.floor(rnd() * U[s].length)]; cu[s].set(u, (cu[s].get(u) ?? 0) + 1); } for (const _ of Jx[s]) { const j = Jx[s][Math.floor(rnd() * Jx[s].length)]; cj[s].set(j, (cj[s].get(j) ?? 0) + 1); } }
    let a = { F: 0, TP: 0 }, b = { F: 0, TP: 0 }, P = 0;
    for (const l of rows) { const w = (cu[l.suite].get(key(l)) ?? 0) * (l.injection_task == null ? 1 : (cj[l.suite].get(l.injection_task) ?? 0)); if (!w) continue; a.F += w * l.s1; b.F += w * l.pv; if (l.y) { P += w; a.TP += w * l.s1; b.TP += w * l.pv; } }
    dr.push(a.TP / P - b.TP / P); dp.push(a.TP / a.F - b.TP / b.F);
  }
  const ci = (d: number[]) => { d.sort((x, y) => x - y); return [d[Math.floor(0.025 * d.length)], d[Math.floor(0.975 * d.length)]].map(x => +(100 * x).toFixed(1)); };
  const n = rows.length, pos = rows.filter(r => r.y).length;
  const rec = (k: string) => rows.filter(r => r.y && r[k]).length / pos, prec = (k: string) => rows.filter(r => r.y && r[k]).length / rows.filter(r => r[k]).length;
  return { runs: n, positives: pos, recall: [rec('pv'), rec('s1')].map(x => +x.toFixed(3)), precision: [prec('pv'), prec('s1')].map(x => +x.toFixed(3)), recall_diff_ci_pts: ci(dr), precision_diff_ci_pts: ci(dp) };
}
// run from the repo root: node eval/ontology/diagnostics/power-stage1.ts
import { execFileSync } from 'node:child_process'; import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const T = mkdtempSync(join(tmpdir(), 'power-stage1-'));
execFileSync(process.execPath, ['eval/ontology/pr/sanitize.ts', '--in', 'runs/onto-al-input/observations.jsonl', '--out', `${T}/al.sanitized.jsonl`]);
const R0 = 'runs';
const al = cohort(`${T}/al.sanitized.jsonl`, `${R0}/onto-al-input/labels.jsonl`, 'al');
const pr = cohort(`${R0}/onto-pr-input/observations.sanitized.jsonl`, `${R0}/onto-pr-input/labels.jsonl`, 'pr');
console.log('E-AL (5 models)', JSON.stringify(boot(al)));
console.log('E-PR (6 models)', JSON.stringify(boot(pr)));
console.log('pooled (11 models)', JSON.stringify(boot([...al, ...pr])));
// per-model recall and precision differences (stage-1 minus provenance), points
for (const [name, rows] of [['E-AL', al], ['E-PR', pr]] as const) {
  const models = [...new Set(rows.map((r: any) => r.model))].sort();
  console.log(name, models.map(m => { const x = rows.filter((r: any) => r.model === m), pos = x.filter((r: any) => r.y).length;
    const rec = (k: string) => x.filter((r: any) => r.y && r[k]).length / pos, prec = (k: string) => x.filter((r: any) => r.y && r[k]).length / Math.max(1, x.filter((r: any) => r[k]).length);
    return `${m}: Δrecall ${(100 * (rec('s1') - rec('pv'))).toFixed(1)} Δprecision ${(100 * (prec('s1') - prec('pv'))).toFixed(1)} (pos ${pos})`; }).join(' | '));
}
