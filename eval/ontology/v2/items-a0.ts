// A0 (no block) judge items for the v2 held-out calls. Identical to arms.ts e5Items' A0 output — same formatObservation, same
// item fields — but it never builds the A1–A3 ontology blocks, which v2 does not use and which need a v1 context line for every
// tool (one held-out call uses a tool outside the v1 manifest). Checked against e5Items on the v1 observations (--selfcheck).
//   node eval/ontology/v2/items-a0.ts --obs runs/onto-v2-input/observations.jsonl --out runs/onto-v2-items
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EvalItem } from '../../../contracts/eval.ts';
import { labelledQuestion } from '../../convert/common.ts';
import { formatObservation } from '../format-arm.ts';
import { e5Items, loadFrozen, type E5Obs } from '../arms.ts';

export function a0Items(obs: E5Obs[]): EvalItem[] {
  const q = labelledQuestion('goal_deviation', false, 'heuristic_derived', 'placeholder: E5 is scored from labels.jsonl, not from this field');
  return obs.map(o => ({
    item_id: o.obs_id, source: 'agentdojo', family: o.suite, template_id: o.run_id, split: 'test', boundary: 'pre_tool',
    state: formatObservation({ task: o.task, action: { tool: o.action.name, impact: o.action.impact, args: o.action.args }, recent: o.recent, lowAuthority: o.low_authority }).text,
    questions: [q],
    provenance: { repo: 'ethz-spylab/agentdojo', commit: '089ed468cf3ed0322acc66b0211f26d9d90dbf60', file: `runs/${o.run_id}.json`, locator: o.obs_id, licence: 'MIT' },
  }) as EvalItem);
}

const readJsonl = <T>(p: string) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as T);
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  if (process.argv.includes('--selfcheck')) {
    const v1 = readJsonl<E5Obs>('runs/onto-e5-input/observations.jsonl');
    const a = a0Items(v1).map(x => JSON.stringify(x)).join('\n'), b = e5Items(loadFrozen(), v1).A0.map(x => JSON.stringify(x)).join('\n');
    if (a !== b) { console.log('items-a0 differs from arms.ts A0'); process.exit(1); }
    console.log(`items-a0 identical to arms.ts A0 on ${v1.length} v1 observations`);
  } else {
    const items = a0Items(readJsonl<E5Obs>(arg('obs')!)); for (const it of items) EvalItem.parse(it);
    mkdirSync(arg('out')!, { recursive: true }); writeFileSync(join(arg('out')!, 'items-A0.jsonl'), items.map(x => JSON.stringify(x)).join('\n') + '\n');
    console.log(`items-a0: ${items.length} items`);
  }
}
