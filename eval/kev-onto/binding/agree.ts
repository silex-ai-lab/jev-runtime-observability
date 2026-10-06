// T6c (plan §4): agreement between the two blind binders, then the planner's written per-tool resolution.
//   node eval/kev-onto/binding/agree.ts --a <binder-a dir> --b <binder-b dir> --out eval/kev-onto/binding
//        [--resolutions eval/kev-onto/binding/resolutions.json]
// Inputs are binding-<manifest>.json files ({tools:{id:{effects,params,reason}}}) for the four manifests. Without
// --resolutions it writes binder-a.json, binder-b.json (copied, merged), disagreements.json and AGREEMENT.md. With it, it
// also writes resolved.json: an agreed tool takes the shared binding; a disputed tool takes the resolution, which must
// carry a reason and use only effect/class ids present in either binder's output or the prompt lists.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_READ_EFFECT } from '../contract.ts';

export const MANIFESTS = ['agentdyn', 'agentdojo', 'train', 'silex'] as const;
export interface ToolBinding { effects: string[]; params: Record<string, string>; reason?: string }
type Binding = Record<string, ToolBinding>;

const sorted = (xs: string[]) => [...xs].sort();
const sameSet = (a: string[], b: string[]) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
export const harmful = (b: ToolBinding) => b.effects.some(e => e !== DATA_READ_EFFECT);

export function loadBinder(dir: string): Record<string, Binding> {
  const out: Record<string, Binding> = {};
  for (const m of MANIFESTS) {
    const p = join(dir, `binding-${m}.json`);
    if (!existsSync(p)) throw new Error(`missing ${p}`);
    out[m] = JSON.parse(readFileSync(p, 'utf8')).tools;
  }
  return out;
}

export function compare(a: Record<string, Binding>, b: Record<string, Binding>, manifestIds: Record<string, string[]>) {
  const rows: Array<{ manifest: string; id: string; effectsEqual: boolean; impactEqual: boolean; paramsEqual: boolean; a: ToolBinding; b: ToolBinding }> = [];
  const missing: string[] = [];
  for (const m of MANIFESTS) for (const id of manifestIds[m]) {
    const x = a[m][id], y = b[m][id];
    if (!x || !y) { missing.push(`${m}:${id}:${!x ? 'A' : ''}${!y ? 'B' : ''}`); continue; }
    const pk = sorted([...new Set([...Object.keys(x.params ?? {}), ...Object.keys(y.params ?? {})])]);
    rows.push({ manifest: m, id, effectsEqual: sameSet(x.effects, y.effects), impactEqual: harmful(x) === harmful(y),
      paramsEqual: pk.every(k => (x.params ?? {})[k] === (y.params ?? {})[k]), a: x, b: y });
  }
  const rate = (f: (r: typeof rows[number]) => boolean, m?: string) => { const rs = rows.filter(r => !m || r.manifest === m); return { agree: rs.filter(f).length, n: rs.length }; };
  const summary = Object.fromEntries([...MANIFESTS, 'all'].map(m => [m, {
    effects: rate(r => r.effectsEqual, m === 'all' ? undefined : m), impact: rate(r => r.impactEqual, m === 'all' ? undefined : m),
    params: rate(r => r.paramsEqual, m === 'all' ? undefined : m) }]));
  return { rows, missing, summary };
}

function main() {
  const flag = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const A = flag('a')!, B = flag('b')!, out = flag('out')!;
  const ids: Record<string, string[]> = {};
  for (const m of MANIFESTS) ids[m] = JSON.parse(readFileSync(join(out, `manifest-${m}.json`), 'utf8')).tools.map((t: { id: string }) => t.id);
  const a = loadBinder(A), b = loadBinder(B);
  const merged = (x: Record<string, Binding>) => ({ version: 2, tools: Object.fromEntries(MANIFESTS.flatMap(m => Object.entries(x[m])).sort(([p], [q]) => p < q ? -1 : 1)) });
  writeFileSync(join(out, 'binder-a.json'), JSON.stringify(merged(a), null, 1) + '\n');
  writeFileSync(join(out, 'binder-b.json'), JSON.stringify(merged(b), null, 1) + '\n');
  const c = compare(a, b, ids);
  if (c.missing.length) throw new Error(`binders do not cover every tool: ${c.missing.slice(0, 10).join(', ')}`);
  const disputed = c.rows.filter(r => !r.effectsEqual || !r.paramsEqual);
  writeFileSync(join(out, 'disagreements.json'), JSON.stringify(disputed.map(r => ({ manifest: r.manifest, id: r.id,
    effects_equal: r.effectsEqual, impact_equal: r.impactEqual, params_equal: r.paramsEqual, a: r.a, b: r.b })), null, 1) + '\n');
  const pct = (x: { agree: number; n: number }) => `${x.agree}/${x.n} (${(100 * x.agree / x.n).toFixed(1)}%)`;
  const md = ['# T6c binder agreement', '',
    'Binder A: coder-mimo (fresh OpenCode sessions). Binder B: one-shot `opencode run -m deepseek/deepseek-v4-pro` processes.',
    'The 25 τ-bench tools were re-bound by both binders at CG1 with source descriptions and family-scoped ids.',
    'Both bound from the tool manifests and the binding prompt only (no runs, labels or outcomes).', '',
    '| manifest | effect set equal | read/write impact equal | every parameter class equal |', '|---|---|---|---|',
    ...[...MANIFESTS, 'all'].map(m => `| ${m} | ${pct(c.summary[m].effects)} | ${pct(c.summary[m].impact)} | ${pct(c.summary[m].params)} |`), '',
    `Disputed tools (effect set or any parameter class differs): ${disputed.length}; of these, impact differs for ${disputed.filter(r => !r.impactEqual).length}.`];
  const resPath = flag('resolutions');
  if (resPath) {
    const res: Record<string, ToolBinding & { reason: string }> = JSON.parse(readFileSync(resPath, 'utf8')).tools;
    const tools: Record<string, ToolBinding> = {};
    for (const r of c.rows) {
      if (r.effectsEqual && r.paramsEqual) { tools[r.id] = { effects: sorted(r.a.effects), params: r.a.params }; continue; }
      const x = res[r.id];
      if (!x || !x.reason) throw new Error(`disputed tool without a written resolution: ${r.id}`);
      tools[r.id] = { effects: sorted(x.effects), params: x.params, reason: x.reason };
    }
    const extra = Object.keys(res).filter(k => !disputed.some(r => r.id === k));
    if (extra.length) throw new Error(`resolutions for undisputed tools: ${extra.join(', ')}`);
    writeFileSync(join(out, 'resolved.json'), JSON.stringify({ version: 2, tools: Object.fromEntries(Object.entries(tools).sort(([p], [q]) => p < q ? -1 : 1)) }, null, 1) + '\n');
    md.push('', `Resolved binding: ${Object.keys(tools).length} tools; ${disputed.length} by written planner resolution (resolutions.json).`);
  }
  writeFileSync(join(out, 'AGREEMENT.md'), md.join('\n') + '\n');
  console.log(md.join('\n'));
}
if (import.meta.url === `file://${process.argv[1]}`) main();
