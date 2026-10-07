// validate-static.ts — closed-schema validator for runs/onto-s2-diag/static-tools.json (CG-B defect 3). Uses Object.hasOwn
// on every object, traverses every own field, and checks tool rows against the binding + frozen snapshot.
//   node eval/ontology/diag-s2/validate-static.ts --in <json> [--binding …] [--snapshot …] [--schema …]
import { readFileSync } from 'node:fs';

export interface BindingShape { tools: Record<string, { params?: Record<string, string> }> }
export interface SnapshotShape { nodes: Array<{ id: string; kind?: string }> }
type Node = { k?: string; [x: string]: unknown };

const ROW_KEYS = ['tool_id', 'suite', 'regex_write', 'bound_write', 'typed_eligible', 'effects', 'params', 'relevant_params'];

export function validateStatic(data: unknown, binding: BindingShape, snapshot: SnapshotShape, schema: { enums: Record<string, string[]>; legend: string; root: Node }): void {
  const enums = schema.enums;
  const toolIds = new Set(Object.keys(binding.tools));
  const toolParams = new Map(Object.entries(binding.tools).map(([id, t]) => [id, new Set(Object.keys(t.params ?? {}))]));
  const effectIds = new Set((snapshot.nodes ?? []).filter(n => n.kind === 'effect').map(n => n.id));
  const keyOk = (kind: string, key: string, path: string): void => {
    if (kind.startsWith('enum:')) { const e = kind.slice(5); if (!enums[e]?.includes(key)) throw new Error(`${path}: key not in enum ${e}: ${key}`); return; }
    throw new Error(`${path}: unknown key rule ${kind}`);
  };
  const toolRow = (v: unknown, path: string): void => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${path}: expected object`);
    const row = v as Record<string, unknown>;
    for (const k of Object.keys(row)) if (!ROW_KEYS.includes(k)) throw new Error(`${path}.${k}: unexpected field`);
    for (const k of ROW_KEYS) if (!Object.hasOwn(row, k)) throw new Error(`${path}.${k}: missing field`);
    if (typeof row.tool_id !== 'string' || !toolIds.has(row.tool_id)) throw new Error(`${path}.tool_id: not a binding tool id: ${String(row.tool_id)}`);
    const suite = row.tool_id.split(':')[1]?.split('/')[0];
    if (!enums.suite.includes(row.suite as string) || row.suite !== suite) throw new Error(`${path}.suite: not the tool's suite: ${String(row.suite)}`);
    for (const k of ['regex_write', 'bound_write', 'typed_eligible']) if (typeof row[k] !== 'boolean') throw new Error(`${path}.${k}: expected boolean`);
    for (const k of ['effects', 'params', 'relevant_params']) if (!Array.isArray(row[k]) || (row[k] as unknown[]).some(x => typeof x !== 'string')) throw new Error(`${path}.${k}: expected string array`);
    for (const e of row.effects as string[]) if (!effectIds.has(e)) throw new Error(`${path}.effects: unknown effect id: ${e}`);
    const params = toolParams.get(row.tool_id)!;
    for (const p of [...(row.params as string[]), ...(row.relevant_params as string[])]) if (!params.has(p)) throw new Error(`${path}: parameter not registered for ${row.tool_id}: ${p}`);
  };
  const walk = (node: Node, v: unknown, path: string): void => {
    switch (node.k) {
      case 'obj': {
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${path}: expected object`);
        const obj = v as Record<string, unknown>, keys = node.keys as Record<string, Node>;
        for (const [k, value] of Object.entries(obj)) { if (!Object.hasOwn(keys, k)) throw new Error(`${path}.${k}: unexpected field`); walk(keys[k], value, `${path}.${k}`); }
        for (const k of Object.keys(keys)) if (!Object.hasOwn(obj, k)) throw new Error(`${path}.${k}: missing field`);
        return;
      }
      case 'map': {
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${path}: expected map`);
        for (const [k, value] of Object.entries(v as Record<string, unknown>)) { keyOk(node.key as string, k, `${path}["${k}"]`); walk(node.val as Node, value, `${path}.${k}`); }
        return;
      }
      case 'arr': { if (!Array.isArray(v)) throw new Error(`${path}: expected array`); v.forEach((x, i) => walk(node.items as Node, x, `${path}[${i}]`)); return; }
      case 'int': { if (!Number.isInteger(v) || (v as number) < 0) throw new Error(`${path}: expected a non-negative integer, got ${JSON.stringify(v)}`); return; }
      case 'bool': { if (typeof v !== 'boolean') throw new Error(`${path}: expected boolean`); return; }
      case 'str': { if (typeof v !== 'string') throw new Error(`${path}: expected string`); if (node.const) { if (v !== (schema as unknown as Record<string, unknown>)[node.const as string]) throw new Error(`${path}: not the fixed constant`); return; } throw new Error(`${path}: unknown string rule`); }
      case 'toolRow': { toolRow(v, path); return; }
      default: throw new Error(`${path}: unknown schema node ${String(node.k)}`);
    }
  };
  walk(schema.root, data, 'static');
}

const arg = (k: string): string | null => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
if (process.argv[1] != null && import.meta.url === `file://${process.argv[1]}`) {
  const inPath = arg('--in');
  if (!inPath) throw new Error('need --in <json>');
  const binding = JSON.parse(readFileSync(arg('--binding') ?? 'eval/ontology/s2/binding-agentdyn.json', 'utf8')) as BindingShape;
  const snapshot = JSON.parse(readFileSync(arg('--snapshot') ?? 'eval/ontology/v2/frozen/snapshot.json', 'utf8')) as SnapshotShape;
  const schema = JSON.parse(readFileSync(arg('--schema') ?? 'eval/ontology/diag-s2/static-schema.json', 'utf8'));
  validateStatic(JSON.parse(readFileSync(inPath, 'utf8')), binding, snapshot, schema);
  console.log(`validate-static: ${inPath} OK`);
}
