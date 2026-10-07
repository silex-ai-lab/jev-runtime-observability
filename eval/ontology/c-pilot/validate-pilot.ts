// validate-pilot.ts — closed-schema validator for c-pilot/pilot.json (PILOT_SPEC §5). Every level rejects an
// unexpected or missing key, a non-integer count, a non-null non-finite number, a statement that differs from the
// frozen STATEMENT, and any run-id-like string appearing anywhere in a key or value.
//   node eval/ontology/c-pilot/validate-pilot.ts --in <pilot.json> [--binding <f>] [--schema <f>]
import { readFileSync } from 'node:fs';

export interface PilotSchema {
  schema: string; statement: string; suites: string[]; cells: string[]; differences: string[];
  hashes_keys: string[]; counts_keys: string[]; score_keys: string[]; binding_row_keys: string[];
  cross_check_keys: string[]; categories: string[]; top_keys: string[]; table_keys: string[]; authored_extra_keys: string[];
}
/** The binding the output was produced against; `relevant` entries are checked against each tool's parameter names. */
export interface PilotBinding { tools: Record<string, { params?: Record<string, unknown> }> }

// No run id, run path or any per-run identifier may appear anywhere in the committed output (PILOT_SPEC §5).
const RUNID_LIKE = /(?:^|\/)(?:runs|silex-authored|agentdyn|agentdojo)\/|\/user_task_\d+\/|\/injection_task_\d+/;
const HEX64 = /^[0-9a-f]{64}$/;

export function validatePilot(data: unknown, schema: PilotSchema, binding: PilotBinding): void {
  const fail = (msg: string): never => { throw new Error(msg); };
  const scanString = (v: string, path: string): void => { if (RUNID_LIKE.test(v)) fail(`${path}: run-id-like string is not allowed`); };
  const toolIds = Object.keys(binding.tools);

  const exactKeys = (obj: Record<string, unknown>, keys: string[], path: string): void => {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) fail(`${path}: expected object`);
    for (const k of Object.keys(obj)) if (!keys.includes(k)) fail(`${path}.${k}: unexpected field`);
    for (const k of keys) if (!Object.hasOwn(obj, k)) fail(`${path}.${k}: missing field`);
  };
  const int = (v: unknown, path: string): void => { if (!Number.isInteger(v)) fail(`${path}: expected integer, got ${JSON.stringify(v)}`); };
  const nonNegInt = (v: unknown, path: string): void => { int(v, path); if ((v as number) < 0) fail(`${path}: expected non-negative integer`); };
  const numOrNull = (v: unknown, path: string): void => { if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) fail(`${path}: expected number or null`); };
  const cellInts = (v: unknown, path: string): void => { const o = v as Record<string, unknown>; exactKeys(o, schema.cells, path); for (const c of schema.cells) int(o[c], `${path}.${c}`); };

  const scoreMap = (v: unknown, path: string): void => {
    const o = v as Record<string, unknown>; exactKeys(o, schema.cells, path);
    for (const c of schema.cells) {
      const s = o[c] as Record<string, unknown>; exactKeys(s, schema.score_keys, `${path}.${c}`);
      int(s.F, `${path}.${c}.F`); int(s.TP, `${path}.${c}.TP`); int(s.Pos, `${path}.${c}.Pos`);
      for (const k of ['precision', 'recall', 'recall_step', 'precision_step_one_more_false_alert']) numOrNull(s[k], `${path}.${c}.${k}`);
    }
  };

  const table = (v: unknown, authored: boolean, path: string): void => {
    const keys = authored ? [...schema.table_keys, ...schema.authored_extra_keys] : schema.table_keys;
    const o = v as Record<string, unknown>; exactKeys(o, keys, path);
    scoreMap(o.pooled, `${path}.pooled`);
    const ps = o.per_suite as Record<string, unknown>; exactKeys(ps, schema.suites, `${path}.per_suite`);
    for (const s of schema.suites) scoreMap(ps[s], `${path}.per_suite.${s}`);
    const cfa = o.clean_false_alerts as Record<string, unknown>; exactKeys(cfa, ['pooled', 'per_suite'], `${path}.clean_false_alerts`);
    cellInts(cfa.pooled, `${path}.clean_false_alerts.pooled`);
    const cps = cfa.per_suite as Record<string, unknown>; exactKeys(cps, schema.suites, `${path}.clean_false_alerts.per_suite`);
    for (const s of schema.suites) cellInts(cps[s], `${path}.clean_false_alerts.per_suite.${s}`);
    const diff = o.differences as Record<string, unknown>; exactKeys(diff, schema.differences, `${path}.differences`);
    for (const k of schema.differences) numOrNull(diff[k], `${path}.differences.${k}`);
    if (!authored) return;
    int(o.unmapped, `${path}.unmapped`);
    const cc = o.cross_check as Record<string, unknown>; exactKeys(cc, schema.cross_check_keys, `${path}.cross_check`);
    for (const k of schema.cross_check_keys) int(cc[k], `${path}.cross_check.${k}`);
    const cat = o.clean_false_alerts_by_category as Record<string, unknown>; exactKeys(cat, schema.categories, `${path}.clean_false_alerts_by_category`);
    for (const k of schema.categories) cellInts(cat[k], `${path}.clean_false_alerts_by_category.${k}`);
  };

  const root = data as Record<string, unknown>; exactKeys(root, schema.top_keys, 'pilot');
  scanString(String(root.schema), 'pilot.schema');
  if (root.schema !== schema.schema) fail(`pilot.schema: expected ${schema.schema}`);
  scanString(String(root.statement), 'pilot.statement');
  if (root.statement !== schema.statement) fail('pilot.statement: differs from STATEMENT');

  const hashes = root.hashes as Record<string, unknown>; exactKeys(hashes, schema.hashes_keys, 'pilot.hashes');
  for (const k of schema.hashes_keys) { const v = hashes[k]; if (typeof v !== 'string' || !HEX64.test(v)) fail(`pilot.hashes.${k}: expected 64-char lowercase hex`); scanString(v as string, `pilot.hashes.${k}`); }

  const counts = root.counts as Record<string, unknown>; exactKeys(counts, schema.counts_keys, 'pilot.counts');
  for (const k of ['runs', 'attacked', 'clean', 'calls', 'call_free_runs', 'label_error']) int(counts[k], `pilot.counts.${k}`);
  const unreg = counts.unregistered_tool_calls as Record<string, unknown>;
  exactKeys(unreg, schema.suites, 'pilot.counts.unregistered_tool_calls');   // exactly ap and soc
  for (const s of schema.suites) {
    const row = unreg[s] as Record<string, unknown>;
    if (row === null || typeof row !== 'object' || Array.isArray(row)) fail(`pilot.counts.unregistered_tool_calls.${s}: expected object`);
    for (const [name, n] of Object.entries(row)) { scanString(name, `pilot.counts.unregistered_tool_calls.${s}.${name}`); nonNegInt(n, `pilot.counts.unregistered_tool_calls.${s}.${name}`); }
  }

  const bt = root.binding_table as Record<string, unknown>; exactKeys(bt, toolIds, 'pilot.binding_table');
  for (const id of toolIds) {
    const row = bt[id] as Record<string, unknown>; exactKeys(row, schema.binding_row_keys, `pilot.binding_table.${id}`);
    if (typeof row.bound !== 'boolean' || typeof row.typed !== 'boolean') fail(`pilot.binding_table.${id}: bound/typed must be boolean`);
    if (!Array.isArray(row.relevant) || row.relevant.some(x => typeof x !== 'string')) fail(`pilot.binding_table.${id}.relevant: expected string array`);
    const allowed = new Set(Object.keys(binding.tools[id]?.params ?? {}));
    for (const p of row.relevant as string[]) {
      if (!allowed.has(p)) fail(`pilot.binding_table.${id}.relevant.${p}: not a parameter of the tool`);
      scanString(p, `pilot.binding_table.${id}.relevant.${p}`);
    }
  }

  const tables = root.tables as Record<string, unknown>; exactKeys(tables, ['primary', 'authored'], 'pilot.tables');
  table(tables.primary, false, 'pilot.tables.primary');
  if (tables.authored === null) return;
  table(tables.authored, true, 'pilot.tables.authored');
}

const arg = (k: string): string | null => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
if (process.argv[1] != null && import.meta.url === `file://${process.argv[1]}`) {
  const inPath = arg('--in');
  if (!inPath) throw new Error('need --in <pilot.json>');
  const schema = JSON.parse(readFileSync(arg('--schema') ?? 'eval/ontology/c-pilot/pilot-schema.json', 'utf8')) as PilotSchema;
  const binding = JSON.parse(readFileSync(arg('--binding') ?? 'eval/ontology/c-pilot/binding-silex.json', 'utf8')) as PilotBinding;
  validatePilot(JSON.parse(readFileSync(inPath, 'utf8')), schema, binding);
  console.log(`validate-pilot: ${inPath} OK`);
}
