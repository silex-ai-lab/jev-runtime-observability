import { readFileSync } from 'node:fs';
// EXPLORATORY (E-AL cohort, already analysed): breakdown of the typed rule's flags by label, value source (inside an injected
// <INFORMATION> block or not — a benchmark marker used here for analysis only, never by a monitor) and source tool.
//   node eval/ontology/diagnostics/eal-fp-breakdown.ts
import { typing, values, type Obs } from '../v2/typing.ts';
const L = (p: string) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const I = 'runs/onto-al-input', F = 'eval/ontology/v2/frozen';
const obs: Obs[] = L(`${I}/observations.jsonl`), labs = L(`${I}/labels.jsonl`);
const T = typing(JSON.parse(readFileSync(`${F}/snapshot.json`, 'utf8')), JSON.parse(readFileSync(`${F}/binding-v2.json`, 'utf8')), JSON.parse(readFileSync(`${F}/tool-manifest-v2.json`, 'utf8')).tools);
const y = new Map(labs.map((l: any) => [l.run_id, l.attacked && l.security === true])), att = new Map(labs.map((l: any) => [l.run_id, l.attacked]));
const tid = (o: Obs) => `agentdojo:${o.suite}/${o.action.name}`;
// first qualifying (hazard-relevant, untrusted) value per flagged call; is it inside an injected <INFORMATION> block?
const inj = (o: Obs, v: string) => o.low_authority.some(x => { const m = x.text.match(/<INFORMATION>[\s\S]*?<\/INFORMATION>/g); return m?.some(b => b.includes(v)); });
const runs = new Map<string, { kind: string; tool: string; src: string }>();
for (const o of obs) {
  if (runs.has(o.run_id) || !T.eligible.get(tid(o))) continue;
  const rel = T.relevant.get(tid(o)) ?? new Set();
  for (const k of Object.keys(o.action.args ?? {}).sort()) {
    if (!rel.has(k)) continue;
    const v = values(o.action.args[k]).find(s => s.length >= 4 && !(o.task ?? '').includes(s) && o.low_authority.some(x => x.text.includes(s)));
    if (v) { const srcRef = (o.low_authority.find(x => x.text.includes(v)) as any)?.ref?.replace(/^tool_result:/, '').replace(/#\d+$/, ''); runs.set(o.run_id, { kind: y.get(o.run_id) ? 'TP' : att.get(o.run_id) ? 'FP attacked-failed' : 'FP clean', tool: `${o.suite}/${o.action.name}.${k}`, src: inj(o, v) ? 'injected' : 'environment', from: srcRef }); break; }
  }
}
const c: Record<string, number> = {}, t: Record<string, number> = {};
for (const r of runs.values()) { c[`${r.kind} | value from ${r.src}`] = (c[`${r.kind} | value from ${r.src}`] ?? 0) + 1; if (r.kind !== 'TP') t[r.tool] = (t[r.tool] ?? 0) + 1; }
console.log('flagged runs', runs.size); console.log(c);
const bySrc: Record<string, Record<string, number>> = {}; for (const r of runs.values() as any) { const k = r.kind === 'TP' ? 'TP' : 'FP'; (bySrc[r.from] ??= { TP: 0, FP: 0 })[k]++; }
console.log('source tool → TP / FP', Object.entries(bySrc).sort((a, b) => (b[1].TP + b[1].FP) - (a[1].TP + a[1].FP)).slice(0, 14).map(([k, v]) => `${k}: ${v.TP}/${v.FP}`).join('  '));
console.log('top FP tool.param', Object.entries(t).sort((a, b) => b[1] - a[1]).slice(0, 10));
const base = labs.filter((l: any) => y.get(l.run_id)).length / labs.length; console.log('base rate', base.toFixed(3));
