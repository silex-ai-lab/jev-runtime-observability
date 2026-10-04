// P1 (plan § Stage 2; PR_SPEC § Files). Builds the complete judge-item universe: every (call, source entry) pair where the entry
// is a source of any qualifying value of the call under any arm — i.e. every qualifying value of every call regardless of tool or
// impact. One LOW-AUTHORITY CONTENT entry per item, formatted by eval/convert/format.ts; entries over 2 400 chars are windowed.
//   node eval/ontology/pr/judge-items.ts --obs runs/onto-pr-input/observations.sanitized.jsonl --out runs/onto-pr-items
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { formatState } from '../../convert/format.ts';
import { labelledQuestion } from '../../convert/common.ts';
import { qualifying, type Obs } from './values.ts';

const MAX_ENTRY = 2400;
const WRAP = /<\/?information>/gi;

export function centredWindow(text: string, value: string): string {
  const idx = text.indexOf(value);
  if (idx < 0 || text.length <= MAX_ENTRY) return text;
  const centre = idx + value.length / 2;
  let start = Math.floor(centre - MAX_ENTRY / 2);
  start = Math.max(0, Math.min(start, text.length - MAX_ENTRY));
  return text.slice(start, start + MAX_ENTRY);
}

export function buildItem(obs: Obs & { obs_id: string; run_id: string; suite: string; action: { tool: string; name: string; impact: string; args: Record<string, unknown> } }, qv: ReturnType<typeof qualifying>, i: number) {
  const entry = obs.low_authority[i];
  // earliest qualifying value whose sources include this entry (qualifying() is already key-ordered, whole-before-substring, then natural order)
  const earliest = qv.find(q => q.sources.includes(i));
  const text = centredWindow(entry.text, earliest ? earliest.value : '');
  const state = formatState({
    task: obs.task,
    action: { tool: obs.action.name, impact: obs.action.impact, details: [['args', JSON.stringify(obs.action.args ?? {})]] },
    lowAuthority: [{ ref: entry.ref, text }],
  }).state;
  return {
    item_id: `${obs.obs_id}@${i}`,
    source: 'agentdojo' as const, family: obs.suite, template_id: obs.run_id, split: 'test' as const, boundary: 'pre_tool' as const,
    state,
    questions: [labelledQuestion('instruction_override', false, 'heuristic_derived', 'placeholder: E-PR is scored from labels-pr.jsonl, not from this field')],
    provenance: { repo: 'ethz-spylab/agentdojo', commit: '089ed468cf3ed0322acc66b0211f26d9d90dbf60', file: `runs/${obs.run_id}.json`, locator: obs.obs_id, licence: 'MIT' },
  };
}

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
if (import.meta.url === `file://${process.argv[1]}`) {
  const fin = arg('--obs'), dir = arg('--out');
  if (!fin || !dir) throw new Error('--obs and --out are required');
  const obs = readFileSync(fin, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Obs & { obs_id: string; run_id: string; suite: string; action: { tool: string; name: string; impact: string; args: Record<string, unknown> } });
  const items: unknown[] = [];
  for (const o of obs) {
    const qv = qualifying(o);
    const union = new Set<number>(qv.flatMap(q => q.sources));
    for (const i of [...union].sort((a, b) => a - b)) items.push(buildItem(o, qv, i));
  }
  mkdirSync(dir, { recursive: true });
  const text = items.map(x => JSON.stringify(x)).join('\n') + '\n';
  if (WRAP.test(text)) throw new Error('wrapper string leaked into a built item');
  writeFileSync(join(dir, 'items-pr.jsonl'), text);
  console.log(`judge-items: ${items.length} items -> ${join(dir, 'items-pr.jsonl')}`);
}
