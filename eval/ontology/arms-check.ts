// Freeze-gate acceptance for the arms (plan § Shared component). For every item of an arm set:
//   removing the block gives byte-identical text across A0–A3; every state ≤ MAX_STATE_CHARS; A2/A3 blocks have A1's
//   length; A3 differs from A1 wherever the draw pool allowed it (exceptions counted).
//   node eval/ontology/arms-check.ts --dir runs/onto-e1a-items        (real sets)
//   node eval/ontology/arms-check.ts --fixtures                        (synthetic edge cases)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_STATE_CHARS } from '../convert/format.ts';
import { ARMS, CONTEXT_MAX, HEADER_ONTO, HEADER_TOOL, withoutBlock } from './format-arm.ts';
import { drawA3, e5Items, type E5Obs, type Frozen, type Tool } from './arms.ts';
import type { EvalItem } from '../../contracts/eval.ts';

const blockOf = (state: string) => {
  const line = state.split('\n').find(l => l.startsWith(HEADER_ONTO) || l.startsWith(HEADER_TOOL));
  return line ?? null;
};

export function checkSets(sets: Record<string, EvalItem[]>) {
  const n = sets.A0.length;
  const r = { items: n, over_limit: 0, base_mismatch: 0, length_mismatch: 0, a3_equal_a1: 0, a2_equal_a1: 0, unchanged_no_tool: 0, max_state: 0 };
  for (const a of ARMS) if (sets[a].length !== n) throw new Error(`arm ${a} has ${sets[a].length} items, A0 has ${n}`);
  for (let i = 0; i < n; i++) {
    const ids = new Set(ARMS.map(a => sets[a][i].item_id));
    if (ids.size !== 1) throw new Error(`item order differs at ${i}`);
    const blocks = Object.fromEntries(ARMS.map(a => [a, blockOf(sets[a][i].state)]));
    if (blocks.A0) throw new Error(`A0 carries a block at ${sets.A0[i].item_id}`);
    if (!blocks.A1) { r.unchanged_no_tool++; if (ARMS.some(a => sets[a][i].state !== sets.A0[i].state)) r.base_mismatch++; continue; }
    const base = ARMS.map(a => withoutBlock(sets[a][i].state, blocks[a]));
    if (new Set(base).size !== 1) r.base_mismatch++;
    if (blocks.A2!.length !== blocks.A1.length || blocks.A3!.length !== blocks.A1.length) r.length_mismatch++;
    if (blocks.A3 === blocks.A1) r.a3_equal_a1++;
    if (blocks.A2!.slice(HEADER_TOOL.length) === blocks.A1.slice(HEADER_ONTO.length)) r.a2_equal_a1++;
    for (const a of ARMS) { const L = sets[a][i].state.length; r.max_state = Math.max(r.max_state, L); if (L > MAX_STATE_CHARS) r.over_limit++; }
  }
  return { ...r, ok: r.over_limit === 0 && r.base_mismatch === 0 && r.length_mismatch === 0 };
}

function fixtures() {
  const tools: Tool[] = [
    { id: 'agentdojo:acme/pay', source: 'agentdojo', suite: 'acme', name: 'pay', impact: 'write', description: 'Pay a vendor. Parameters: recipient: IBAN; amount: money' },
    { id: 'agentdojo:acme/read_mail', source: 'agentdojo', suite: 'acme', name: 'read_mail', impact: 'read', description: 'Read the inbox.' },
    { id: 'agentdojo:acme/long', source: 'agentdojo', suite: 'acme', name: 'long', impact: 'write', description: 'x '.repeat(400) },
    { id: 'agentdojo:acme/unmapped', source: 'agentdojo', suite: 'acme', name: 'unmapped', impact: 'read', description: null },
  ];
  const context: Frozen['context'] = {
    'agentdojo:acme/pay': 'Payment Release (Value Transfer Action). May cause: Financial-value transfer. Hazards: Payment From Unverified Instruction.',
    'agentdojo:acme/read_mail': 'Read Action. May cause: Data Read Effect.',
    'agentdojo:acme/long': 'y'.repeat(CONTEXT_MAX),                      // context at the limit (overflow case)
    'agentdojo:acme/unmapped': 'no ontology match',                     // empty match
  };
  const map: Frozen['map'] = { 'agentdojo:acme/pay': { core: 'c:t', action: 'a:p', rule: 'r' }, 'agentdojo:acme/read_mail': { core: 'c:r', action: null, rule: 'r' }, 'agentdojo:acme/long': { core: 'c:w', action: null, rule: 'r' }, 'agentdojo:acme/unmapped': { core: null, action: null, rule: null } };
  const f: Frozen = { tools, byId: new Map(tools.map(t => [t.id, t])), context, map, a3: drawA3(tools, context, map) };
  const big = 'R'.repeat(5000);
  const obs: E5Obs[] = [
    { obs_id: 'r1#0', run_id: 'r1', model: 'm', suite: 'acme', task: 'T'.repeat(4000), action: { tool: 'acme/pay', name: 'pay', impact: 'write', args: { a: 'z'.repeat(3000) } }, recent: [], low_authority: [] },   // long header
    { obs_id: 'r1#1', run_id: 'r1', model: 'm', suite: 'acme', task: 'pay my bill', action: { tool: 'acme/read_mail', name: 'read_mail', impact: 'read', args: {} }, recent: ['pay', 'pay'], low_authority: Array.from({ length: 30 }, (_, k) => ({ ref: `tool_result:pay#${k}`, text: big })) }, // long results, many calls
    { obs_id: 'r1#2', run_id: 'r1', model: 'm', suite: 'acme', task: 'x', action: { tool: 'acme/long', name: 'long', impact: 'write', args: {} }, recent: [], low_authority: [{ ref: 'tool_result:read_mail#0', text: 'hello' }] },
    { obs_id: 'r1#3', run_id: 'r1', model: 'm', suite: 'acme', task: 'x', action: { tool: 'acme/unmapped', name: 'unmapped', impact: 'read', args: {} }, recent: [], low_authority: [] },
  ];
  const sets = e5Items(f, obs);
  let unseen = false;
  try { e5Items(f, [{ ...obs[3], obs_id: 'r2#0', action: { tool: 'acme/nope', name: 'nope', impact: 'read', args: {} } }]); } catch { unseen = true; }
  return { sets, unseen };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--fixtures')) {
    const { sets, unseen } = fixtures();
    const r = checkSets(sets as Record<string, EvalItem[]>);
    console.log(r, { unseen_tool_rejected: unseen });
    if (!r.ok || !unseen) process.exit(1);
    console.log('arms-check fixtures pass');
  } else {
    const i = process.argv.indexOf('--dir'); const dir = process.argv[i + 1];
    const sets = Object.fromEntries(ARMS.map(a => [a, readFileSync(join(dir, `items-${a}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))]));
    const r = checkSets(sets);
    console.log(JSON.stringify(r));
    if (!r.ok) process.exit(1);
  }
}
