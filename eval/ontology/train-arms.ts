// E1b training sets (plan § E1, D6): the train split of eval/splits/items.jsonl in kev-train.jsonl's exact shape
// (rebuilding A0 at 100 % without a block reproduces kev-train.jsonl byte for byte — checked below), with arm blocks
// A0/A1/A3 and a 50 % subset shared by every arm (seed 20261003, stratified by source × label vector, ceil(n/2) each).
//   node eval/ontology/train-arms.ts --out runs/onto-e1b-data
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { EvalItem } from '../../contracts/eval.ts';
import { e1Items, loadFrozen, mulberry, SEED } from './arms.ts';

const kevLine = (i: EvalItem) => JSON.stringify({ state: i.state, questions: Object.fromEntries(i.questions.map(q => [q.question_id, { ...q.question, label: q.label }])) });

export function half(items: EvalItem[]): Set<string> {
  const strata = new Map<string, string[]>();
  for (const i of items) { const k = `${i.source}|${JSON.stringify(i.questions.map(q => [q.question_id, q.label]))}`; (strata.get(k) ?? strata.set(k, []).get(k)!).push(i.item_id); }
  const rnd = mulberry(SEED); const keep = new Set<string>();
  for (const k of [...strata.keys()].sort()) {
    const ids = strata.get(k)!.sort();
    for (let n = ids.length - 1; n >= 1; n--) { const j = Math.floor(rnd() * (n + 1)); [ids[n], ids[j]] = [ids[j], ids[n]]; }
    for (const id of ids.slice(0, Math.ceil(ids.length / 2))) keep.add(id);
  }
  return keep;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--out'); const out = process.argv[i + 1];
  const train = readFileSync('eval/splits/items.jsonl', 'utf8').split('\n').filter(Boolean).map(l => EvalItem.parse(JSON.parse(l))).filter(x => x.split === 'train');
  const original = readFileSync('eval/splits/kev-train.jsonl', 'utf8');
  if (train.map(kevLine).join('\n') + '\n' !== original) throw new Error('train items no longer reproduce kev-train.jsonl');
  const sets = e1Items(loadFrozen(), train);
  const keep = half(train);
  mkdirSync(out, { recursive: true });
  const manifest: Record<string, { records: number; sha256: string }> = {};
  for (const arm of ['A0', 'A1', 'A3'] as const) for (const [tag, filter] of [['100', () => true], ['50', (x: EvalItem) => keep.has(x.item_id)]] as const) {
    const text = sets[arm].filter(filter).map(kevLine).join('\n') + '\n';
    const f = `train-${arm}-${tag}.jsonl`; writeFileSync(join(out, f), text);
    manifest[f] = { records: text.split('\n').filter(Boolean).length, sha256: createHash('sha256').update(text).digest('hex') };
  }
  writeFileSync(join(out, 'MANIFEST.json'), JSON.stringify(manifest, null, 1) + '\n');
  console.log(manifest);
}
