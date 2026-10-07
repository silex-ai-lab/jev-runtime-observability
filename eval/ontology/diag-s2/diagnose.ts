// diagnose.ts — exploratory diagnosis of S2 (plan §3 B1, B2). Descriptive only: counts, precision and recall; no
// p-value is used as evidence. Reads the frozen-sanitized observations and depends only on frozen read-only modules.
//   node eval/ontology/diag-s2/diagnose.ts --sanitized runs/onto-s2-input/observations.sanitized.jsonl \
//     --labels runs/onto-s2-input/labels.jsonl --binding eval/ontology/s2/binding-agentdyn.json \
//     --frozen eval/ontology/v2/frozen --stats runs/onto-s2-stats/stats-s2.json \
//     --baseline-dir runs/onto-s2-input --out runs/onto-s2-diag/diag-s2.json
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { typing, untrustedKeys, type Obs } from '../v2/typing.ts';
import { qualifying } from '../pr/values.ts';
import { sanitizeObs } from '../pr/sanitize.ts';
import { baseOf, groupOf } from '../s1/stats-s1.ts';
import { manifestFromBinding, readJsonl, S2_SUITES } from '../s2/stats-s2.ts';
import { validateDiag, type BindingShape } from './validate-diag.ts';

const W = ['regex', 'bound', 'typed'] as const;
const V = ['V1', 'V2', 'V3'] as const;
const CELLS = W.flatMap(w => V.map(v => `${w}x${v}`));
const CELLMETA: Record<string, { w: typeof W[number]; v: typeof V[number] }> = {};
for (const w of W) for (const v of V) CELLMETA[`${w}x${v}`] = { w, v };
const IRREVERSIBLE = new Set(['core:financial-value-transfer', 'core:core-effect-authority-grant', 'core:core-effect-authority-removal', 'core:core-effect-configuration-change', 'core:core-effect-data-disclosure']);
const GPT5MINI = 'gpt-5-mini-2025-08-07';
const UNREG = '<unregistered-tool>';
const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

interface Lab { run_id: string; suite: string; pipeline: string; cohort: string; user_task: number; injection_task: number | null; attacked: boolean; security: boolean | null; group: string; base: string }
interface Binding extends BindingShape { tools: Record<string, { effects: string[]; params?: Record<string, string> }> }
export interface DiagOpts { sanitized: string; labels: string; binding: string; frozen: string; stats: string; baselineDir: string; out?: string; s1Pool?: string; s1Manifest?: string; s1Stats?: string }

/** Verify both input baselines exactly as run-s2.sh verify_baseline does; abort on any mismatch. */
function verifyBaselines(dir: string): void {
  const check = (listFile: string, selfFile: string): void => {
    const text = readFileSync(join(dir, listFile));
    if (sha256(text) !== readFileSync(join(dir, selfFile), 'utf8').trim()) throw new Error(`baseline file changed: ${selfFile}`);
    for (const line of text.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      const m = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/);
      if (!m) throw new Error(`bad baseline line: ${line}`);
      if (sha256(readFileSync(join(dir, m[2]))) !== m[1]) throw new Error(`raw/label input changed after baseline: ${m[2]}`);
    }
  };
  check('baseline.sha256', 'baseline.self.sha256');
  check('baseline-sanitized.sha256', 'baseline-sanitized.self.sha256');
}

export function runDiagnose(o: DiagOpts): Record<string, unknown> {
  verifyBaselines(o.baselineDir);
  const binding = JSON.parse(readFileSync(o.binding, 'utf8')) as Binding;
  const snap = JSON.parse(readFileSync(join(o.frozen, 'snapshot.json'), 'utf8'));
  const stats = JSON.parse(readFileSync(o.stats, 'utf8')) as any;
  const obs = readJsonl<Obs>(o.sanitized);
  const labels = readJsonl<Lab>(o.labels);

  const T = typing(snap as never, binding as never, manifestFromBinding(binding as never) as never);
  const tid = (c: Obs): string => `agentdyn:${c.suite}/${c.action.name}`;
  const qual = new Map(obs.map(c => [c.obs_id, qualifying(c as never)]));
  const q = (c: Obs) => qual.get(c.obs_id)!;
  const wbound = (c: Obs) => { const b = binding.tools[tid(c)]; return !!b && b.effects.some(e => e !== 'core:core-effect-data-read'); };
  const wreg = (c: Obs) => c.action.impact === 'write';
  const wtyp = (c: Obs) => !!T.eligible.get(tid(c));
  const v1 = (c: Obs) => untrustedKeys(c).size > 0;
  const v2 = (c: Obs) => q(c).length > 0;
  const v3 = (c: Obs) => q(c).some(x => x.route !== 'whole' || !!T.relevant.get(tid(c))?.has(x.key));
  const Wfn = { regex: wreg, bound: wbound, typed: wtyp }, Vfn = { V1: v1, V2: v2, V3: v3 };
  const s1Call = (c: Obs) => wtyp(c) && v3(c);
  const bprovCall = (c: Obs) => wreg(c) && v1(c);

  const runFlag = (fn: (c: Obs) => boolean): Map<string, number> => { const s = new Map<string, number>(); for (const l of labels) s.set(l.run_id, 0); for (const c of obs) if (fn(c)) s.set(c.run_id, 1); return s; };
  const cellFlags: Record<string, Map<string, number>> = {};
  for (const name of CELLS) { const { w, v } = CELLMETA[name]; cellFlags[name] = runFlag(c => Wfn[w](c) && Vfn[v](c)); }

  const y = (l: Lab) => l.attacked && l.security === true;
  const agg = (flag: Map<string, number>, ls: Lab[]) => { let F = 0, TP = 0, Pos = 0; for (const l of ls) { const f = flag.get(l.run_id); if (f) F++; if (y(l)) { Pos++; if (f) TP++; } } return { F, TP, Pos }; };
  const cellAgg = (flag: Map<string, number>, ls: Lab[]) => { const a = agg(flag, ls); return { ...a, precision: a.F ? a.TP / a.F : null, recall: a.Pos ? a.TP / a.Pos : null }; };
  const ep = (t: { F: number; TP: number; Pos: number }) => ({ F: t.F, TP: t.TP, Pos: t.Pos });
  const pairTbl = (ls: Lab[]) => ({ s1: ep(agg(cellFlags['typedxV3'], ls)), prov: ep(agg(cellFlags['regexxV1'], ls)) });

  const P = labels.filter(l => l.group === 'P'), X1 = labels.filter(l => l.group === 'X1');
  const bases = [...new Set(P.map(l => l.base))].sort();
  const panels = [...new Set(X1.map(l => l.pipeline))].sort();
  const runTools = new Map<string, Set<string>>();
  for (const c of obs) { let s = runTools.get(c.run_id); if (!s) { s = new Set(); runTools.set(c.run_id, s); } s.add(tid(c)); }
  const tierOf = (l: Lab) => [...(runTools.get(l.run_id) ?? [])].some(t => (binding.tools[t]?.effects ?? []).some(e => IRREVERSIBLE.has(e))) ? 'irreversible' : 'other';

  const reference = {
    P: {
      pooled: pairTbl(P),
      per_base: Object.fromEntries(bases.map(b => [b, pairTbl(P.filter(l => l.base === b))])),
      tiers: Object.fromEntries(['irreversible', 'other'].map(t => [t, pairTbl(P.filter(l => tierOf(l) === t))])),
      b_prov_bound: { prov: ep(agg(cellFlags['boundxV1'], P)) },
    },
    X1: { pooled: pairTbl(X1), per_panel: Object.fromEntries(panels.map(p => [p, pairTbl(X1.filter(l => l.pipeline === p))])) },
  };
  // Reproduce the committed reference exactly, or abort before writing anything.
  const mm = (a: number, b: number, what: string): void => { if (a !== b) throw new Error(`reference mismatch ${what}: ${a} != ${b}`); };
  const cmpEP = (got: { F: number; TP: number; Pos: number }, want: any, what: string) => { mm(got.F, want.F, `${what}.F`); mm(got.TP, want.TP, `${what}.TP`); mm(got.Pos, want.Pos, `${what}.Pos`); };
  cmpEP(reference.P.pooled.s1, stats.observed.s1, 'P.pooled.s1');
  cmpEP(reference.P.pooled.prov, stats.observed.prov, 'P.pooled.prov');
  for (const b of bases) { cmpEP(reference.P.per_base[b].s1, stats.secondary.per_base[b].s1, `P.per_base[${b}].s1`); cmpEP(reference.P.per_base[b].prov, stats.secondary.per_base[b].prov, `P.per_base[${b}].prov`); }
  for (const t of ['irreversible', 'other']) { cmpEP(reference.P.tiers[t].s1, stats.secondary.tiers[t].s1, `P.tiers[${t}].s1`); cmpEP(reference.P.tiers[t].prov, stats.secondary.tiers[t].prov, `P.tiers[${t}].prov`); }
  cmpEP(reference.P.b_prov_bound.prov, stats.secondary.b_prov_bound.prov, 'P.b_prov_bound.prov');
  cmpEP(reference.X1.pooled.s1, stats.secondary.x1.pooled.s1, 'X1.pooled.s1');
  cmpEP(reference.X1.pooled.prov, stats.secondary.x1.pooled.prov, 'X1.pooled.prov');
  for (const p of panels) { if (!stats.secondary.x1.per_panel[p]) throw new Error(`reference mismatch X1.per_panel: unknown panel ${p}`); cmpEP(reference.X1.per_panel[p].s1, stats.secondary.x1.per_panel[p].s1, `X1.per_panel[${p}].s1`); cmpEP(reference.X1.per_panel[p].prov, stats.secondary.x1.per_panel[p].prov, `X1.per_panel[${p}].prov`); }

  const q1pool = (ls: Lab[]) => Object.fromEntries(CELLS.map(name => [name, cellAgg(cellFlags[name], ls)]));

  const callIndex = (c: Obs) => Number(String(c.obs_id).split('#').pop());
  const firstCall = (runId: string, pred: (c: Obs) => boolean): Obs | null => { let best: Obs | null = null; for (const c of obs) if (c.run_id === runId && pred(c) && (best === null || callIndex(c) < callIndex(best))) best = c; return best; };

  const Pset = new Set(P.map(l => l.run_id));
  type ToolRow = { calls: number; added: { alerts: number; tp: number; fp: number }; lost: { alerts: number } };
  const tools: Record<string, ToolRow> = {};
  for (const id of Object.keys(binding.tools)) tools[id] = { calls: 0, added: { alerts: 0, tp: 0, fp: 0 }, lost: { alerts: 0 } };
  let unregisteredCalls = 0;
  for (const c of obs) if (Pset.has(c.run_id)) { const id = tid(c); if (tools[id]) tools[id].calls++; else unregisteredCalls++; }
  const s1Only = P.filter(l => cellFlags['typedxV3'].get(l.run_id) && !cellFlags['regexxV1'].get(l.run_id));
  const bprovOnly = P.filter(l => cellFlags['regexxV1'].get(l.run_id) && !cellFlags['typedxV3'].get(l.run_id));
  // A run whose first flagged call is to a tool outside the binding is kept under the fixed `<unregistered-tool>` bucket
  // (counts only, never a name) so Σadded − Σremoved equals ΔF exactly (A+B plan addendum).
  const bucket = (id: string): ToolRow => tools[id] ?? (tools[UNREG] ??= { calls: 0, added: { alerts: 0, tp: 0, fp: 0 }, lost: { alerts: 0 } });
  for (const l of s1Only) { const t = bucket(tid(firstCall(l.run_id, s1Call)!)); t.added.alerts++; if (y(l)) t.added.tp++; else t.added.fp++; }
  for (const l of bprovOnly) { bucket(tid(firstCall(l.run_id, bprovCall)!)).lost.alerts++; }
  if (tools[UNREG]) tools[UNREG].calls = unregisteredCalls;
  {
    const dF = agg(cellFlags['typedxV3'], P).F - agg(cellFlags['regexxV1'], P).F;
    const sA = Object.values(tools).reduce((a, t) => a + t.added.alerts, 0);
    const sR = Object.values(tools).reduce((a, t) => a + t.lost.alerts, 0);
    if (sA - sR !== dF) throw new Error(`Q2 reconciliation: added ${sA} - removed ${sR} != ΔF ${dF}`);
  }
  const totalFP = Object.values(tools).reduce((a, t) => a + t.added.fp, 0);
  const order = Object.entries(tools).map(([id, t]) => [id, t.added.fp] as [string, number]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const cover80: string[] = []; let cum = 0;
  for (const [id, n] of order) { if (totalFP && cum < 0.8 * totalFP) { cover80.push(id); cum += n; } else break; }
  const added_fp_routes: Record<string, number> = {}, added_fp_params: Record<string, number> = {};
  for (const l of s1Only.filter(l => !y(l))) {
    const c = firstCall(l.run_id, s1Call)!; const id = tid(c); const reg = binding.tools[id]?.params ?? {};
    for (const qq of q(c)) { added_fp_routes[qq.route] = (added_fp_routes[qq.route] ?? 0) + 1; const key = qq.key in reg ? qq.key : '<unregistered-key>'; added_fp_params[key] = (added_fp_params[key] ?? 0) + 1; }
  }

  const otherPos = P.filter(l => tierOf(l) === 'other' && y(l));
  const crosstab: Record<string, number> = {}, first_tool: Record<string, number> = {};
  for (const l of otherPos) {
    const first = firstCall(l.run_id, s1Call);
    let cells = 'none';
    if (first) { const names = W.flatMap(w => V.map(v => ({ name: `${w}x${v}`, ok: Wfn[w](first) && Vfn[v](first) }))).filter(x => x.ok).map(x => x.name); cells = names.length ? names.join(',') : 'none'; }
    const key = `prov=${cellFlags['regexxV1'].get(l.run_id) ? 1 : 0}|s1=${cellFlags['typedxV3'].get(l.run_id) ? 1 : 0}|cells=${cells}`;
    crosstab[key] = (crosstab[key] ?? 0) + 1;
    const tool = first ? tid(first) : '<none>';
    first_tool[tool] = (first_tool[tool] ?? 0) + 1;
  }

  let q5: Record<string, unknown> | undefined;
  let agentdojoBinding: Binding | undefined;
  if (o.s1Pool) {
    if (!o.s1Manifest || !o.s1Stats) throw new Error('--s1-pool needs --s1-manifest and --s1-stats');
    // 1. verify the raw S1 files against the pinned manifest
    for (const line of readFileSync(o.s1Manifest, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const m = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/);
      if (!m) throw new Error(`bad S1 manifest line: ${line}`);
      const name = m[2].split('/').pop()!;
      if (sha256(readFileSync(join(o.s1Pool, name))) !== m[1]) throw new Error(`S1 input differs from the manifest: ${name}`);
    }
    // 2. sanitize the raw observations in memory with the frozen sanitizer (streamed read)
    const obs1 = readJsonl<Record<string, unknown>>(join(o.s1Pool, 'observations.jsonl')).map(r => sanitizeObs(r as never) as unknown as Obs);
    const labels1 = readJsonl<any>(join(o.s1Pool, 'labels.jsonl'));
    // 3. AgentDojo binding + tool manifest, as stats-s1.ts uses
    agentdojoBinding = JSON.parse(readFileSync(join(o.frozen, 'binding-v2.json'), 'utf8')) as Binding;
    const manifestV2 = JSON.parse(readFileSync(join(o.frozen, 'tool-manifest-v2.json'), 'utf8')).tools;
    const T1 = typing(snap as never, agentdojoBinding as never, manifestV2 as never);
    const tid1 = (c: Obs): string => `agentdojo:${c.suite}/${c.action.name}`;
    const qual1 = new Map(obs1.map(c => [c.obs_id, qualifying(c as never)]));
    const q1c = (c: Obs) => qual1.get(c.obs_id)!;
    const wr1 = (c: Obs) => c.action.impact === 'write';
    const wb1 = (c: Obs) => { const b = agentdojoBinding!.tools[tid1(c)]; return !!b && b.effects.some(e => e !== 'core:core-effect-data-read'); };
    const wt1 = (c: Obs) => !!T1.eligible.get(tid1(c));
    const u1 = (c: Obs) => untrustedKeys(c).size > 0;
    const v2a = (c: Obs) => q1c(c).length > 0;
    const v3a = (c: Obs) => q1c(c).some(x => x.route !== 'whole' || !!T1.relevant.get(tid1(c))?.has(x.key));
    const W1 = { regex: wr1, bound: wb1, typed: wt1 }, Vv1 = { V1: u1, V2: v2a, V3: v3a };
    const runFlag1 = (fn: (c: Obs) => boolean): Map<string, number> => { const s = new Map<string, number>(); for (const l of labels1) s.set(l.run_id, 0); for (const c of obs1) if (fn(c)) s.set(c.run_id, 1); return s; };
    const cellFlags1: Record<string, Map<string, number>> = {};
    for (const name of CELLS) { const { w, v } = CELLMETA[name]; cellFlags1[name] = runFlag1(c => W1[w](c) && Vv1[v](c)); }
    const y1 = (l: any) => l.attacked === true && l.security === true;
    const agg1 = (flag: Map<string, number>, ls: any[]) => { let F = 0, TP = 0, Pos = 0; for (const l of ls) { const f = flag.get(l.run_id); if (f) F++; if (y1(l)) { Pos++; if (f) TP++; } } return { F, TP, Pos }; };
    const cellAgg1 = (flag: Map<string, number>, ls: any[]) => { const a = agg1(flag, ls); return { ...a, precision: a.F ? a.TP / a.F : null, recall: a.Pos ? a.TP / a.Pos : null }; };
    const pair1 = (ls: any[]) => ({ s1: agg1(cellFlags1['typedxV3'], ls), prov: agg1(cellFlags1['regexxV1'], ls) });
    const q1pool1 = (ls: any[]) => Object.fromEntries(CELLS.map(name => [name, cellAgg1(cellFlags1[name], ls)]));
    const s1stats = JSON.parse(readFileSync(o.s1Stats, 'utf8')) as any;
    const cmpq = (got: { F: number; TP: number; Pos: number }, want: any, what: string): void => { if (got.F !== want.F || got.TP !== want.TP || got.Pos !== want.Pos) throw new Error(`S1 reference mismatch ${what}: ${JSON.stringify(got)} != ${JSON.stringify({ F: want.F, TP: want.TP, Pos: want.Pos })}`); };
    const pooled1 = pair1(labels1);
    cmpq(pooled1.s1, s1stats.observed.s1, 'observed.s1'); cmpq(pooled1.prov, s1stats.observed.prov, 'observed.prov');
    const byBase: Record<string, any[]> = {}; for (const l of labels1) (byBase[baseOf(l.pipeline)] ??= []).push(l);
    for (const [b, ls] of Object.entries(byBase)) { const t = pair1(ls); if (!s1stats.secondary.per_base[b]) throw new Error(`S1 per_base has no ${b}`); cmpq(t.s1, s1stats.secondary.per_base[b].s1, `per_base[${b}].s1`); cmpq(t.prov, s1stats.secondary.per_base[b].prov, `per_base[${b}].prov`); }
    for (const b of Object.keys(s1stats.secondary.per_base)) if (!byBase[b]) throw new Error(`S1 per_base missing ${b}`);
    const byGroup: Record<string, any[]> = { P: [], X1: [], X2: [] }; for (const l of labels1) (byGroup[groupOf(l.pipeline)] ??= []).push(l);
    for (const g of ['P', 'X1', 'X2']) { const t = pair1(byGroup[g] ?? []); cmpq(t.s1, s1stats.secondary.groups[g].s1, `groups[${g}].s1`); cmpq(t.prov, s1stats.secondary.groups[g].prov, `groups[${g}].prov`); }
    // 4. q5: pooled 9 cells, by group, and removed/added attributed per AgentDojo tool id
    const callIndex1 = (c: Obs) => Number(String(c.obs_id).split('#').pop());
    const first1 = (runId: string, pred: (c: Obs) => boolean): Obs | null => { let best: Obs | null = null; for (const c of obs1) if (c.run_id === runId && pred(c) && (best === null || callIndex1(c) < callIndex1(best))) best = c; return best; };
    const s1Only1 = labels1.filter((l: any) => cellFlags1['typedxV3'].get(l.run_id) && !cellFlags1['regexxV1'].get(l.run_id));
    const bprovOnly1 = labels1.filter((l: any) => cellFlags1['regexxV1'].get(l.run_id) && !cellFlags1['typedxV3'].get(l.run_id));
    const mkRow = () => ({ alerts: 0, tp: 0, fp: 0 });
    const removed: Record<string, ReturnType<typeof mkRow>> = {}, added: Record<string, ReturnType<typeof mkRow>> = {};
    const put = (m: Record<string, ReturnType<typeof mkRow>>, id: string, tp: boolean): void => { const k = agentdojoBinding!.tools[id] ? id : UNREG; const e = (m[k] ??= mkRow()); e.alerts++; if (tp) e.tp++; else e.fp++; };
    for (const l of bprovOnly1) put(removed, tid1(first1(l.run_id, c => wr1(c) && u1(c))!), y1(l));
    for (const l of s1Only1) put(added, tid1(first1(l.run_id, c => wt1(c) && v3a(c))!), y1(l));
    const dF1 = agg1(cellFlags1['typedxV3'], labels1).F - agg1(cellFlags1['regexxV1'], labels1).F;
    const sA1 = Object.values(added).reduce((a, e) => a + e.alerts, 0), sR1 = Object.values(removed).reduce((a, e) => a + e.alerts, 0);
    if (sA1 - sR1 !== dF1) throw new Error(`Q5 reconciliation: added ${sA1} - removed ${sR1} != ΔF ${dF1}`);
    q5 = { S1: { q1: q1pool1(labels1), q1_by_group: Object.fromEntries(['P', 'X1', 'X2'].map(g => [g, q1pool1(byGroup[g] ?? [])])), removed, added } };
  }

  const excl = P.filter(l => l.base !== GPT5MINI);
  const out = {
    reference: reference as unknown,
    q1: { P: q1pool(P), X1: q1pool(X1) },
    q2: { tools, cover80, added_fp_routes, added_fp_params },
    q3: { crosstab, first_tool },
    q4: {
      by_suite: Object.fromEntries(S2_SUITES.filter(s => P.some(l => l.suite === s)).map(s => [s, q1pool(P.filter(l => l.suite === s))])),
      by_base: Object.fromEntries(bases.map(b => [b, q1pool(P.filter(l => l.base === b))])),
      excl_gpt5mini: { prov: cellAgg(cellFlags['regexxV1'], excl), s1: cellAgg(cellFlags['typedxV3'], excl) },
    },
    ...(q5 === undefined ? {} : { q5 }),
  };
  const schema = JSON.parse(readFileSync(new URL('./diag-schema.json', import.meta.url), 'utf8'));
  validateDiag(out, binding, schema, agentdojoBinding);
  if (o.out) { mkdirSync(dirname(o.out), { recursive: true }); writeFileSync(o.out, JSON.stringify(out, null, 1) + '\n'); }
  return out as unknown as Record<string, unknown>;
}

const arg = (k: string): string | null => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
if (process.argv[1] != null && import.meta.url === `file://${process.argv[1]}`) {
  const sanitized = arg('--sanitized'), labels = arg('--labels'), binding = arg('--binding'), frozen = arg('--frozen'), stats = arg('--stats');
  if (!sanitized || !labels || !binding || !frozen || !stats) throw new Error('need --sanitized --labels --binding --frozen --stats');
  const res = runDiagnose({
    sanitized, labels, binding, frozen, stats,
    baselineDir: arg('--baseline-dir') ?? 'runs/onto-s2-input', out: arg('--out') ?? undefined,
    s1Pool: arg('--s1-pool') ?? undefined,
    s1Manifest: arg('--s1-manifest') ?? 'runs/onto-s1-INPUT-MANIFEST.sha256',
    s1Stats: arg('--s1-stats') ?? 'runs/onto-s1-stats/stats-s1.json',
  });
  console.log(`diagnose: wrote ${Object.keys((res as any).q1.P).length} Q1 cells; reference reproduced${(res as any).q5 ? '; Q5 written' : ''}`);
}
