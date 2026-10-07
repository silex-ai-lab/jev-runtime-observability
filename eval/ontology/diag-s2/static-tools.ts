// static-tools.ts (B-T1): the static 2×2×2 monitoring table over a tool binding — for every tool one row with
// regex_write (the converter's IMPACT_WRITE name rule), bound_write (binding harmful effect) and typed_eligible
// (v2 typing). Printed and written key-sorted so two runs diff empty.
//   node eval/ontology/diag-s2/static-tools.ts [--out <json>] [--binding <json>] [--snapshot <json>] [--agentdojo]
// --agentdojo swaps in the AgentDojo binding v2 frozen pair used by S1 (eval/ontology/s1/stats-s1.ts imports).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { typing } from '../v2/typing.ts';
import { manifestFromBinding } from '../s2/stats-s2.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Verbatim copy of runs-convert.ts:10 (the converter's write-impact rule); assertFrozenRegex fails closed if that line ever changes. */
export const IMPACT_WRITE = /(send|update|schedule|add|delete|create|remove|post|transfer|reset|rename|modify|revoke|block|grant|set|remove|rename|delete|unsubscribe|subscribe|share|write|insert|append)/i;

export interface StaticRow {
  tool_id: string;
  suite: string;
  regex_write: boolean;
  bound_write: boolean;
  typed_eligible: boolean;
  effects: string[];
  params: string[];
  relevant_params: string[];
}
export interface StaticTools {
  binding: string;
  snapshot: string;
  impact_write_regex: string;
  tools: StaticRow[];
  summary: { legend: string; total: Record<string, number>; per_suite: Record<string, Record<string, number>> };
}

const CELLS = ['r0b0t0', 'r0b0t1', 'r0b1t0', 'r0b1t1', 'r1b0t0', 'r1b0t1', 'r1b1t0', 'r1b1t1'] as const;
const cellOf = (r: StaticRow): string => `r${+r.regex_write}b${+r.bound_write}t${+r.typed_eligible}`;
const emptyCells = (): Record<string, number> => Object.fromEntries(CELLS.map(c => [c, 0]));

/** Fail closed unless the frozen copy is byte-identical to the IMPACT_WRITE line in the converter source. */
export function assertFrozenRegex(srcPath = resolve(HERE, '../runs-convert.ts')): void {
  const line = readFileSync(srcPath, 'utf8').split('\n').find(l => l.startsWith('const IMPACT_WRITE = '));
  if (!line) throw new Error(`${srcPath}: const IMPACT_WRITE not found`);
  const lit = line.slice(line.indexOf('= ') + 2).replace(/;.*$/, '').trim();
  if (lit !== IMPACT_WRITE.toString()) throw new Error(`IMPACT_WRITE drifted: frozen ${IMPACT_WRITE.toString()} != ${srcPath}: ${lit}`);
}

export function buildStaticTools(bindingPath: string, snapshotPath: string): StaticTools {
  assertFrozenRegex();
  const binding = JSON.parse(readFileSync(bindingPath, 'utf8')) as {
    tools: Record<string, { effects: string[]; params: Record<string, string> }>;
  };
  const snap = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  const T = typing(snap as never, binding as never, manifestFromBinding(binding as never));
  const tools: StaticRow[] = Object.keys(binding.tools).sort().map(id => {
    const b = binding.tools[id];
    return {
      tool_id: id,
      suite: id.split(':')[1].split('/')[0],
      regex_write: IMPACT_WRITE.test(id.split('/')[1]),
      bound_write: b.effects.some(e => e !== 'core:core-effect-data-read'),
      typed_eligible: T.eligible.get(id) ?? false,
      effects: [...b.effects].sort(),
      params: T.params.get(id) ?? Object.keys(b.params).sort(),
      relevant_params: [...(T.relevant.get(id) ?? [])].sort(),
    };
  });
  const total = emptyCells();
  const per_suite: Record<string, Record<string, number>> = {};
  for (const r of tools) {
    const c = cellOf(r);
    total[c] += 1;
    (per_suite[r.suite] ??= emptyCells())[c] += 1;
  }
  return {
    binding: bindingPath,
    snapshot: snapshotPath,
    impact_write_regex: IMPACT_WRITE.toString(),
    tools,
    summary: {
      legend: 'r{regex_write}b{bound_write}t{typed_eligible}: tool count in that 2x2x2 cell; all 8 keys are present (0 when empty)',
      total,
      per_suite,
    },
  };
}

/** Recursively key-sort, then serialize exactly as the run pipeline does: JSON.stringify(x, null, 1) + "\n". */
export function stringifySorted(x: unknown): string {
  const sortDeep = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>, out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) out[k] = sortDeep(o[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sortDeep(x), null, 1) + '\n';
}

const flag = (k: string): string | undefined => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
if (process.argv[1] != null && import.meta.url === `file://${process.argv[1]}`) {
  try {
    const agentdojo = process.argv.includes('--agentdojo');
    const bindingPath = flag('binding') ?? (agentdojo ? 'eval/ontology/v2/frozen/binding-v2.json' : 'eval/ontology/s2/binding-agentdyn.json');
    const snapshotPath = flag('snapshot') ?? 'eval/ontology/v2/frozen/snapshot.json';
    const outPath = flag('out') ?? 'runs/onto-s2-diag/static-tools.json';
    const res = buildStaticTools(bindingPath, snapshotPath);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, stringifySorted(res));
    const pad = Math.max(6, ...Object.keys(res.summary.per_suite).map(s => s.length));
    const line = (name: string, cnt: Record<string, number>): string => name.padEnd(pad) + '  ' + CELLS.map(c => `${c}=${cnt[c]}`).join('  ');
    console.log(`static-tools: ${res.tools.length} tools -> ${outPath}`);
    console.log(line('total', res.summary.total));
    for (const [s, cnt] of Object.entries(res.summary.per_suite)) console.log(line(s, cnt));
  } catch (e) {
    console.error(`static-tools: ${(e as Error).message}`);
    process.exit(1);
  }
}
