// binding-check.ts — C pilot P1 (PILOT_SPEC §2): binding-silex.json must hold exactly the ids of
// eval/kev-onto/binding/manifest-silex.json, each entry deep-equal to its eval/kev-onto/binding/resolved.json entry.
// Also prints the binding-only per-tool bound/typed table (PILOT_SPEC §3). Reads no runs.
//   node eval/ontology/c-pilot/binding-check.ts [--binding <f>] [--resolved <f>] [--manifest <f>] [--frozen <dir>]
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { typing } from '../v2/typing.ts';
import { manifestFromBinding } from '../s2/stats-s2.ts';

export function checkBinding(binding: any, resolved: any, manifest: any): string[] {
  const errs: string[] = [];
  const want = (manifest.tools as Array<{ id: string }>).map(t => t.id).sort();
  const got = Object.keys(binding.tools ?? {}).sort();
  for (const id of want) if (!got.includes(id)) errs.push(`missing id: ${id}`);
  for (const id of got) if (!want.includes(id)) errs.push(`extra id: ${id}`);
  for (const id of got) if (want.includes(id) && !isDeepStrictEqual(binding.tools[id], resolved.tools[id])) errs.push(`entry differs from resolved.json: ${id}`);
  return errs;
}

export function boundTypedTable(binding: any, snap: any): Record<string, { bound: boolean; typed: boolean; relevant: string[] }> {
  const T = typing(snap, binding, manifestFromBinding(binding) as never);
  const out: Record<string, { bound: boolean; typed: boolean; relevant: string[] }> = {};
  for (const id of Object.keys(binding.tools).sort()) out[id] = {
    bound: binding.tools[id].effects.some((e: string) => e !== 'core:core-effect-data-read'),
    typed: !!T.eligible.get(id), relevant: [...(T.relevant.get(id) ?? [])].sort() };
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const flag = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
  const here = 'eval/ontology/c-pilot', kb = 'eval/kev-onto/binding';
  const binding = JSON.parse(readFileSync(flag('binding', `${here}/binding-silex.json`), 'utf8'));
  const resolved = JSON.parse(readFileSync(flag('resolved', `${kb}/resolved.json`), 'utf8'));
  const manifest = JSON.parse(readFileSync(flag('manifest', `${kb}/manifest-silex.json`), 'utf8'));
  const snap = JSON.parse(readFileSync(join(flag('frozen', 'eval/ontology/v2/frozen'), 'snapshot.json'), 'utf8'));
  const errs = checkBinding(binding, resolved, manifest);
  if (errs.length) { for (const e of errs) console.error(e); process.exit(1); }
  console.log(JSON.stringify({ ok: true, tools: Object.keys(binding.tools).length, table: boundTypedTable(binding, snap) }, null, 1));
}
