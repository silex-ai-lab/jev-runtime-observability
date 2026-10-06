// T4 item builder (KO_SPEC §2, §3). Observations → judge items for goal_deviation and instruction_override.
// The state is eval/convert/format.ts formatState over the prediction fields only, with action details under the single
// canonical key `arguments` (as the P1 training records, KO_SPEC §4.2), then a hard final bound of MAX_ITEM_STATE with a
// persisted `truncated` flag. format.ts is not edited. bookkeeping ids (obs_id, run_id) never enter the state.
// Two outputs per observation:
//   - contract Items, one per question (item_id `<obs_id>:<question>`), for accounting and leak probes;
//   - one scorer EvalItem (item_id = obs_id, both questions) for eval/run/run.ts. Its labels are placeholders the
//     scorer ignores; H-K1 is scored from RunLabel records, which never cross the model boundary.
//   node eval/kev-onto/items.ts --obs <observations.jsonl> --out <dir>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { formatState } from '../convert/format.ts';
import { labelledQuestion } from '../convert/common.ts';
import { MAX_ITEM_STATE, QUESTIONS, type Item, type Observation, type QuestionId } from './contract.ts';

/** The state for one observation (identical for both questions). */
export function renderState(o: Observation): { state: string; truncated: boolean } {
  const f = formatState({
    task: o.task,
    action: { tool: o.action.name, impact: o.action.impact, details: [['arguments', JSON.stringify(o.action.args ?? {})]] },
    recent: o.recent,
    lowAuthority: o.low_authority.map(x => ({ ref: x.ref, text: x.text })),
  });
  if (f.state.length <= MAX_ITEM_STATE) return f;
  return { state: f.state.slice(0, MAX_ITEM_STATE), truncated: true };   // KO_SPEC §2 hard final bound
}

export function buildItems(obs: Observation[]) {
  const items: Item[] = [];
  const evalItems: unknown[] = [];
  const seen = new Set<string>();
  let truncated = 0;
  for (const o of obs) {
    if (seen.has(o.obs_id)) throw new Error(`duplicate observation ${o.obs_id}`);
    seen.add(o.obs_id);
    const { state, truncated: t } = renderState(o);
    if (t) truncated++;
    for (const q of QUESTIONS) items.push({ item_id: `${o.obs_id}:${q}`, obs_id: o.obs_id, run_id: o.run_id, question_id: q as QuestionId, state, truncated: t });
    evalItems.push({
      // contracts/eval.ts EvalSource has no 'agentdyn'; AgentDyn runs are AgentDojo-format and `source`/`family` are never
      // sent to the judge (run.ts sends state + questions only), so the item is filed as agentdojo with family agentdyn:<suite>.
      item_id: o.obs_id, source: 'agentdojo', family: `agentdyn:${o.run_id.split('/')[1] ?? 'unknown'}`, template_id: o.run_id, split: 'test', boundary: 'pre_tool', state,
      questions: QUESTIONS.map(q => labelledQuestion(q, false, 'heuristic_derived', 'placeholder: H-K1 is scored from RunLabel records, not this field')),
      provenance: { repo: 'SaFo-Lab/AgentDyn', commit: '5353cf7615b135cace8d07c8f12dac53a16b6db3', file: `runs/${o.run_id}.json`, locator: o.obs_id, licence: 'MIT' },
    });
  }
  return { items, evalItems, counts: { observations: obs.length, items: items.length, truncated } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const inp = arg('obs'), out = arg('out');
  if (!inp || !out) throw new Error('--obs and --out are required');
  const obs = readFileSync(inp, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Observation);
  const r = buildItems(obs);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'items.jsonl'), r.items.map(x => JSON.stringify(x)).join('\n') + '\n');
  writeFileSync(join(out, 'eval-items.jsonl'), r.evalItems.map(x => JSON.stringify(x)).join('\n') + '\n');
  writeFileSync(join(out, 'items-stats.json'), JSON.stringify(r.counts, null, 1) + '\n');
  console.log(JSON.stringify(r.counts));
}
