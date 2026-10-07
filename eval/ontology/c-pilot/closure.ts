// closure.ts — the C pilot's required freeze closure (plan r4 §7.4, CG-CP Codex 1): the transitive relative-import closure
// of every program run-pilot.sh executes, plus the fixed data/spec files. Prints repo-relative paths, sorted, one per line.
//   node eval/ontology/c-pilot/closure.ts
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '../../..');
const CP = 'eval/ontology/c-pilot';
export const ENTRIES = [`${CP}/convert-silex.ts`, `${CP}/pilot.ts`, `${CP}/validate-pilot.ts`, `${CP}/binding-check.ts`, `${CP}/compare-pilot.mjs`,
  `${CP}/closure.ts`, 'eval/ontology/s2/sanitize-s2.ts'];
export const FIXED = [`${CP}/recheck_pilot.py`, `${CP}/run-pilot.sh`, `${CP}/PILOT_SPEC.md`, `${CP}/REPORT_TEMPLATE.md`, `${CP}/binding-silex.json`,
  `${CP}/pilot-schema.json`, 'eval/ontology/v2/frozen/snapshot.json', 'eval/kev-onto/binding/resolved.json', 'eval/kev-onto/binding/manifest-silex.json'];

export function closure(): string[] {
  const seen = new Set<string>(), todo = [...ENTRIES];
  while (todo.length) {
    const f = normalize(todo.pop()!);
    if (seen.has(f)) continue;
    if (!existsSync(join(ROOT, f))) throw new Error(`closure: missing ${f}`);
    seen.add(f);
    const text = readFileSync(join(ROOT, f), 'utf8');
    for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"\n;]*?(?:from\s*)?['"](\.{1,2}\/[^'"]+)['"]/g)) todo.push(relative(ROOT, resolve(ROOT, dirname(f), m[1])));
    for (const m of text.matchAll(/new URL\(['"](\.{1,2}\/[^'"]+)['"],\s*import\.meta\.url\)/g)) todo.push(relative(ROOT, resolve(ROOT, dirname(f), m[1])));
  }
  for (const f of FIXED) { if (!existsSync(join(ROOT, f))) throw new Error(`closure: missing ${f}`); seen.add(f); }
  return [...seen].sort();
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(closure().join('\n'));
