// P1 (plan silex-mockup/logs/2026-10-04_ONTOLOGY_PRECISION_RECALL_PLAN.md R3, § Inputs sanitized).
// Field-whitelisting + label-independent wrapper removal: reads the sealed converter's raw observations and writes a sanitized copy
// containing only the prediction-visible fields, with `<INFORMATION>` / `</INFORMATION>` (case-insensitive) deleted from `task`,
// every `low_authority[].text`, and every string inside `action.args` recursively (arrays and nested objects), and nothing else.
//   node eval/ontology/pr/sanitize.ts --in runs/onto-pr-input/observations.jsonl --out runs/onto-pr-input/observations.sanitized.jsonl
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WRAP = /<\/?information>/gi;

export function sanitizeString(s: string): string {
  return s.replace(WRAP, '');
}

export function sanitizeValue(v: unknown): unknown {
  if (typeof v === 'string') return sanitizeString(v);
  if (Array.isArray(v)) return v.map(sanitizeValue);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) out[k] = sanitizeValue((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

// Observed shape from the sealed converter (a superset of v2 Obs). We keep only the whitelisted fields.
interface RawObs {
  obs_id: string; run_id: string; model: string; suite: string; user_task: number; injection_task: number | null;
  task: string | null; action: { tool: string; name: string; impact: string; args: Record<string, unknown> };
  recent: string[]; low_authority: Array<{ ref: string; text: string }>; [k: string]: unknown;
}

export function sanitizeObs(o: RawObs) {
  return {
    obs_id: o.obs_id, run_id: o.run_id, model: o.model, suite: o.suite, user_task: o.user_task, injection_task: o.injection_task,
    task: sanitizeString(o.task ?? ''),
    action: { tool: o.action.tool, name: o.action.name, impact: o.action.impact, args: sanitizeValue(o.action.args ?? {}) as Record<string, unknown> },
    recent: o.recent ?? [],
    low_authority: (o.low_authority ?? []).map(e => ({ ref: e.ref, text: sanitizeString(e.text) })),
  };
}

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
if (import.meta.url === `file://${process.argv[1]}`) {
  const fin = arg('--in'), fout = arg('--out');
  if (!fin || !fout) throw new Error('--in and --out are required');
  const obs = readFileSync(fin, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as RawObs);
  const out = obs.map(sanitizeObs);
  writeFileSync(fout, out.map(x => JSON.stringify(x)).join('\n') + '\n');
  console.log(`sanitize: ${out.length} observations -> ${fout}`);
}
