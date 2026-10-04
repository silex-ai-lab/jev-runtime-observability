// Builds the A0–A3 item files for E1 (Kev's stored eval items) and E5 (AgentDojo run observations), from the
// vendored, frozen ontology files in eval/ontology/frozen/. Items are then run by the unchanged eval/run/run.ts.
//   node eval/ontology/arms.ts --exp e1 --out runs/onto-e1a-items
//   node eval/ontology/arms.ts --exp e5 --out runs/onto-e5-items [--obs runs/onto-e5-input/observations.jsonl]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EvalItem } from '../../contracts/eval.ts';
import { labelledQuestion } from '../convert/common.ts';
import { ARMS, CONTEXT_MAX, HEADER_ONTO, HEADER_TOOL, fitTo, formatObservation, observationFromState, withBlock, words, type Arm } from './format-arm.ts';

export const FROZEN = 'eval/ontology/frozen';
export const SEED = 20261003;
export const mulberry = (seed: number) => () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

export interface Tool { id: string; source: string; suite: string; name: string; impact: string; description: string | null }
export interface Frozen {
  tools: Tool[];
  byId: Map<string, Tool>;
  context: Record<string, string>;
  map: Record<string, { core: string | null; action: string | null; rule: string | null }>;
  a3: Map<string, string>;            // tool id → the tool whose context A3 shows
}

export function loadFrozen(dir = FROZEN): Frozen {
  const tools = (JSON.parse(readFileSync(join(dir, 'tool-manifest.json'), 'utf8')).tools as Tool[]);
  const context = JSON.parse(readFileSync(join(dir, 'ontology-context.v1.json'), 'utf8')).contexts as Record<string, string>;
  const map = JSON.parse(readFileSync(join(dir, 'tool-map.json'), 'utf8')).tools as Frozen['map'];
  const byId = new Map(tools.map(t => [t.id, t]));
  return { tools, byId, context, map, a3: drawA3(tools, context, map) };
}

/** A3 partner per tool: one seeded draw, in sorted tool-id order, from the same source's tools whose mapping and
 *  context line both differ (else from all tools). A tool with no such partner keeps none (counted by arms-check). */
export function drawA3(tools: Tool[], context: Frozen['context'], map: Frozen['map']): Map<string, string> {
  const ids = tools.map(t => t.id).sort();
  const key = (id: string) => `${map[id]?.core ?? ''}|${map[id]?.action ?? ''}`;
  const rnd = mulberry(SEED);
  const out = new Map<string, string>();
  for (const id of ids) {
    const src = id.slice(0, id.indexOf(':'));
    const ok = (o: string) => o !== id && key(o) !== key(id) && context[o] !== context[id];
    let pool = ids.filter(o => o.startsWith(src + ':') && ok(o));
    if (!pool.length) pool = ids.filter(ok);
    if (pool.length) out.set(id, pool[Math.floor(rnd() * pool.length)]);
  }
  return out;
}

/** The block each arm adds for a tool (null for A0). A2 and A3 are fitted to A1's content length. */
export function block(f: Frozen, toolId: string, arm: Arm): string | null {
  if (arm === 'A0') return null;
  const own = f.context[toolId];
  if (own == null) throw new Error(`no context line for ${toolId}`);
  if (own.length > CONTEXT_MAX) throw new Error(`context over ${CONTEXT_MAX} chars for ${toolId}`);
  if (arm === 'A1') return HEADER_ONTO + own;
  if (arm === 'A2') {
    const t = f.byId.get(toolId)!;
    return HEADER_TOOL + fitTo(t.description ?? words(t.name), own.length);
  }
  const partner = f.a3.get(toolId);
  return HEADER_ONTO + fitTo(partner ? f.context[partner] : own, own.length);
}

/** E1 items carry (source, family, tool); the manifest keys AgentDojo tools by suite, other sources by first family seen. */
export function e1ToolId(f: Frozen, it: EvalItem): string {
  const m = it.state.match(/^CANDIDATE ACTION: (.+?) \(registry impact: (\w+)\)$/m);
  if (!m) throw new Error(`no candidate action in ${it.item_id}`);
  if (it.source === 'agentdojo') return `agentdojo:${it.family}/${m[1]}`;
  const t = f.tools.find(x => x.source === it.source && x.name === m[1]);
  if (!t) throw new Error(`tool ${it.source}:${m[1]} missing from the manifest`);
  return t.id;
}

export interface E5Obs { obs_id: string; run_id: string; model: string; suite: string; task: string | null;
  action: { tool: string; name: string; impact: string; args: unknown }; recent: string[]; low_authority: Array<{ ref: string; text: string }> }

export function e1Items(f: Frozen, items: EvalItem[]): Record<Arm, EvalItem[]> {
  const out = { A0: [], A1: [], A2: [], A3: [] } as Record<Arm, EvalItem[]>;
  for (const it of items) {
    if (!/^CANDIDATE ACTION: /m.test(it.state)) { for (const a of ARMS) out[a].push(it); continue; }   // no tool: unchanged
    const tool = e1ToolId(f, it);
    const obs = observationFromState(it.state).text;
    for (const a of ARMS) out[a].push({ ...it, state: withBlock(obs, block(f, tool, a)) });
  }
  return out;
}

export function e5Items(f: Frozen, obs: E5Obs[]): Record<Arm, EvalItem[]> {
  const out = { A0: [], A1: [], A2: [], A3: [] } as Record<Arm, EvalItem[]>;
  // The judge never sees an E5 label; the placeholder below is required by the item schema and ignored by the scorer,
  // which reads runs/onto-e5-input/labels.jsonl.
  const q = labelledQuestion('goal_deviation', false, 'heuristic_derived', 'placeholder: E5 is scored from labels.jsonl, not from this field');
  for (const o of obs) {
    const toolId = `agentdojo:${o.action.tool}`;
    const text = formatObservation({ task: o.task, action: { tool: o.action.name, impact: o.action.impact, args: o.action.args }, recent: o.recent, lowAuthority: o.low_authority }).text;
    for (const a of ARMS) out[a].push({
      item_id: o.obs_id, source: 'agentdojo', family: o.suite, template_id: o.run_id, split: 'test', boundary: 'pre_tool',
      state: withBlock(text, block(f, toolId, a)), questions: [q],
      provenance: { repo: 'ethz-spylab/agentdojo', commit: '089ed468cf3ed0322acc66b0211f26d9d90dbf60', file: `runs/${o.run_id}.json`, locator: o.obs_id, licence: 'MIT' },
    });
  }
  return out;
}

const readJsonl = <T>(p: string) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as T);

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  const exp = arg('exp'), out = arg('out');
  if (!exp || !out) throw new Error('--exp e1|e5 and --out are required');
  const f = loadFrozen();
  const sets = exp === 'e1'
    ? e1Items(f, readJsonl<unknown>(arg('items', 'eval/splits/items.jsonl')!).map(x => EvalItem.parse(x)).filter(i => i.split !== 'train'))
    : e5Items(f, readJsonl<E5Obs>(arg('obs', 'runs/onto-e5-input/observations.jsonl')!));
  mkdirSync(out, { recursive: true });
  for (const a of ARMS) {
    for (const it of sets[a]) EvalItem.parse(it);
    writeFileSync(join(out, `items-${a}.jsonl`), sets[a].map(x => JSON.stringify(x)).join('\n') + '\n');
  }
  console.log(`${exp}: ${sets.A0.length} items per arm → ${out}`);
}
