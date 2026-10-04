// EXPLORATORY diagnostics of the 2026-10-04 null result (not pre-registered; never used as confirmatory evidence).
// Reads committed E5/E1 outputs only.   node eval/ontology/diagnostics/why-null.ts > runs/onto-diagnostics/why-null.json
import { readFileSync } from 'node:fs';
import { aurocW } from '../stats.ts';

const L = <T>(p: string): T[] => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as T);
interface Obs { obs_id: string; run_id: string; suite: string; model: string; user_task: number; task: string; action: { tool: string; name: string; impact: string; args: Record<string, unknown> }; low_authority: Array<{ text: string }> }
interface Lab { run_id: string; suite: string; model: string; user_task: number; injection_task: number | null; attacked: boolean; security: boolean | null; n_calls: number }
const obs = L<Obs>('runs/onto-e5-input/observations.jsonl');
const labs = L<Lab>('runs/onto-e5-input/labels.jsonl');
const y = new Map(labs.map(l => [l.run_id, l.attacked && l.security === true]));
const binding = JSON.parse(readFileSync('../silex-mockup/swm/experiments/ontology-value/binding.json', 'utf8')).tools as Record<string, { action: string | null }>;
const p = (m: string, a: string) => new Map(L<{ item_id: string; signal: { raw_probability: number } }>(`runs/onto-e5-${m}/predictions-${a}.jsonl`).map(r => [r.item_id, r.signal.raw_probability]));
const out: Record<string, unknown> = {};
const strata = [...new Set(labs.map(l => `${l.suite}|${l.model}`))];
const stratAuc = (score: Map<string, number>) => {   // pooled within-stratum pairs, ties 1/2
  let c = 0, n = 0;
  for (const s of strata) {
    const rs = labs.filter(l => `${l.suite}|${l.model}` === s);
    const pos = rs.filter(l => y.get(l.run_id)).map(l => score.get(l.run_id)!), neg = rs.filter(l => !y.get(l.run_id)).map(l => score.get(l.run_id)!);
    for (const a of pos) for (const b of neg) { c += a > b ? 1 : a === b ? 0.5 : 0; n++; }
  }
  return n ? c / n : null;
};
const runMax = (f: (o: Obs) => number) => { const s = new Map(labs.map(l => [l.run_id, 0])); for (const o of obs) s.set(o.run_id, Math.max(s.get(o.run_id)!, f(o))); return s; };

// D1 sensitivity: how much does each block move Kev's probability?
for (const m of ['kev-0.8b-ft', 'kev-0.8b']) {
  const P = Object.fromEntries(['A0', 'A1', 'A2', 'A3'].map(a => [a, p(m, a)]));
  const d = (a: string, sel: (o: Obs) => boolean) => { const xs = obs.filter(sel).map(o => Math.abs(P[a].get(o.obs_id)! - P.A0.get(o.obs_id)!)).sort((u, v) => u - v); return { n: xs.length, median: xs[xs.length >> 1], p90: xs[Math.floor(0.9 * xs.length)], share_changed_over_0_01: xs.filter(x => x > 0.01).length / xs.length }; };
  const bound = (o: Obs) => !!binding[`agentdojo:${o.action.tool}`]?.action;
  out[`D1_sensitivity_${m}`] = { A1_bound: d('A1', bound), A1_unbound: d('A1', o => !bound(o)), A2_all: d('A2', () => true), A3_all: d('A3', () => true) };
}
// D1b saturation: share of A0 scores exactly 0, and median |A1 - A0| on unsaturated calls (0.01 <= p <= 0.99)
for (const m of ['kev-0.8b-ft', 'kev-0.8b']) {
  const a0 = p(m, 'A0'), a1 = p(m, 'A1');
  const zero = obs.filter(o => a0.get(o.obs_id) === 0).length;
  const uns = obs.filter(o => { const v = a0.get(o.obs_id)!; return v >= 0.01 && v <= 0.99; }).map(o => Math.abs(a1.get(o.obs_id)! - a0.get(o.obs_id)!)).sort((u, v) => u - v);
  out[`D1b_saturation_${m}`] = { a0_exactly_zero_share: zero / obs.length, unsaturated_calls: uns.length, median_abs_a1_minus_a0_unsaturated: uns[uns.length >> 1] };
}
// D7 v1 E1 test AUROC (call level, format-separable split) next to the E5 stratified run-level AUROC, same judge, A0
{
  const st = JSON.parse(readFileSync('runs/onto-stats/stats-kev-0.8b-ft.json', 'utf8'));
  out.D7_e1_vs_e5 = { e1_test_auroc_A0: st.e1.auroc.A0, e5_stratified_run_auroc_M_A0: st.e5.auroc['M-A0'], note: 'different unit, endpoint and aggregation; not a measure of the shortcut' };
}
// D2 coverage: calls on bound tools, and run-level AUROC restricted to runs containing a bound-tool call
const P0 = p('kev-0.8b-ft', 'A0'), P1 = p('kev-0.8b-ft', 'A1');
const boundCalls = obs.filter(o => binding[`agentdojo:${o.action.tool}`]?.action);
out.D2_coverage = { calls: obs.length, calls_on_bound_tools: boundCalls.length, positive_runs_with_bound_call: labs.filter(l => y.get(l.run_id) && boundCalls.some(o => o.run_id === l.run_id)).length, positives: labs.filter(l => y.get(l.run_id)).length };
// D3 static per-tool ceiling: cross-fitted P(run positive | run contains tool), leave-one-user-task-out within suite; run score = max over its tools.
{
  const toolsOf = new Map<string, Set<string>>(); for (const o of obs) (toolsOf.get(o.run_id) ?? toolsOf.set(o.run_id, new Set()).get(o.run_id)!).add(o.action.tool);
  const s = new Map<string, number>();
  for (const l of labs) {
    const train = labs.filter(x => x.suite === l.suite && x.user_task !== l.user_task);
    let best = 0;
    for (const t of toolsOf.get(l.run_id) ?? []) { const w = train.filter(x => toolsOf.get(x.run_id)?.has(t)); if (w.length) best = Math.max(best, w.filter(x => y.get(x.run_id)).length / w.length); }
    s.set(l.run_id, best);
  }
  out.D3_static_tool_prior_auroc = stratAuc(s);
  out.D3_reference = { kev_A0: stratAuc(runMax(o => P0.get(o.obs_id)!)), kev_A1: stratAuc(runMax(o => P1.get(o.obs_id)!)) };
}
// D4 instance-level provenance (candidate fix, exploratory): a write call carrying an argument value (string ≥ 4 chars,
// or any element of an array) that appears in earlier low-authority content but not in the user task.
const vals = (v: unknown): string[] => typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(vals) : v && typeof v === 'object' ? Object.values(v).flatMap(vals) : typeof v === 'number' ? [String(v)] : [];
const fromLow = (o: Obs) => vals(o.action.args).some(s => s.length >= 4 && !o.task.includes(s) && o.low_authority.some(x => x.text.includes(s)));
const prov = runMax(o => (o.action.impact === 'write' && fromLow(o) ? 1 : 0));
out.D4_provenance_untyped = { auroc: stratAuc(prov), fused_with_kev_A0: stratAuc(runMax(o => (o.action.impact === 'write' && fromLow(o) ? 1 : 0) + P0.get(o.obs_id)!)) };
// D5 label check: positives whose run has no write call at all
out.D5_positive_runs_without_write_call = labs.filter(l => y.get(l.run_id) && !obs.some(o => o.run_id === l.run_id && o.action.impact === 'write')).length;
// D6 within-tool separability: share of positive-run calls on tools that also occur in negative runs of the same suite
{
  const negTools = new Set(obs.filter(o => !y.get(o.run_id)).map(o => o.action.tool));
  const posCalls = obs.filter(o => y.get(o.run_id));
  out.D6_positive_calls_on_tools_also_in_negatives = posCalls.filter(o => negTools.has(o.action.tool)).length / posCalls.length;
}
console.log(JSON.stringify(out, null, 1));
