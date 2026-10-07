// validate-diag.ts — closed-schema validator for runs/onto-s2-diag/diag-s2.json (plan B0). Walks every serialized key
// and value; string keys/values must be an enum member, a binding tool id, a registered parameter name (or
// `<unregistered-key>`), or a crosstab key. Fails closed and exits non-zero.
//   node eval/ontology/diag-s2/validate-diag.ts --in <json> [--binding …] [--schema …]
import { readFileSync } from 'node:fs';

export interface BindingShape { tools: Record<string, { params?: Record<string, string> }> }
type Node = { $ref?: string; k?: string; [x: string]: unknown };

export function validateDiag(data: unknown, binding: BindingShape, schema: { enums: Record<string, string[]>; crosstabPattern: string; defs: Record<string, Node>; root: Node }, agentdojoBinding?: BindingShape): void {
  const enums = schema.enums;
  const toolIds = new Set(Object.keys(binding.tools));
  const agentdojoIds = new Set(Object.keys(agentdojoBinding?.tools ?? {}));
  const params = new Set<string>(['<unregistered-key>']);
  for (const t of Object.values(binding.tools)) for (const p of Object.keys(t.params ?? {})) params.add(p);
  const crosstab = new RegExp(schema.crosstabPattern);
  const resolve = (n: Node): Node => { while (n && n.$ref) n = schema.defs[n.$ref]; return n; };
  const keyOk = (kind: string, key: string, path: string): void => {
    if (kind.startsWith('enum:')) { const e = kind.slice(5); if (!enums[e]?.includes(key)) throw new Error(`${path}: key not in enum ${e}: ${key}`); return; }
    if (kind === 'toolId') { if (!toolIds.has(key)) throw new Error(`${path}: tool id not in binding: ${key}`); return; }
    if (kind === 'toolIdOrUnregistered') { if (key !== '<unregistered-tool>' && !toolIds.has(key)) throw new Error(`${path}: tool id not in binding: ${key}`); return; }
    if (kind === 'toolOrNone') { if (key !== '<none>' && !toolIds.has(key)) throw new Error(`${path}: not a binding tool id or <none>: ${key}`); return; }
    if (kind === 'agentdojoToolIdOrUnregistered') { if (key !== '<unregistered-tool>' && !agentdojoIds.has(key)) throw new Error(`${path}: not an AgentDojo tool id or <unregistered-tool>: ${key}`); return; }
    if (kind === 'param') { if (!params.has(key)) throw new Error(`${path}: parameter name not registered: ${key}`); return; }
    if (kind === 'crosstab') { if (!crosstab.test(key)) throw new Error(`${path}: not a crosstab key: ${key}`); return; }
    throw new Error(`${path}: unknown key rule ${kind}`);
  };
  const walk = (raw: Node, v: unknown, path: string): void => {
    const node = resolve(raw);
    switch (node.k) {
      case 'obj': {
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${path}: expected object`);
        const obj = v as Record<string, unknown>, keys = node.keys as Record<string, Node>;
        for (const key of Object.keys(obj)) if (!(key in keys)) throw new Error(`${path}.${key}: unexpected field`);
        for (const key of Object.keys(keys)) { if (!(key in obj)) { if ((keys[key] as Node & { opt?: boolean }).opt) continue; throw new Error(`${path}.${key}: missing field`); } walk(keys[key], obj[key], `${path}.${key}`); }
        return;
      }
      case 'map': {
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${path}: expected map`);
        for (const key of Object.keys(v as Record<string, unknown>)) { keyOk(node.key as string, key, `${path}["${key}"]`); walk(node.val as Node, (v as Record<string, unknown>)[key], `${path}.${key}`); }
        return;
      }
      case 'arr': { if (!Array.isArray(v)) throw new Error(`${path}: expected array`); v.forEach((x, i) => walk(node.items as Node, x, `${path}[${i}]`)); return; }
      case 'str': {
        if (typeof v !== 'string') throw new Error(`${path}: expected string`);
        if (node.kind === 'toolId') { if (!toolIds.has(v)) throw new Error(`${path}: string not a binding tool id: ${v}`); return; }
        throw new Error(`${path}: unknown string rule`);
      }
      case 'int': { if (!Number.isInteger(v)) throw new Error(`${path}: expected integer, got ${JSON.stringify(v)}`); return; }
      case 'num': { if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${path}: expected number`); return; }
      case 'nullnum': { if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) throw new Error(`${path}: expected number or null`); return; }
      default: throw new Error(`${path}: unknown schema node ${String(node.k)}`);
    }
  };
  walk(schema.root, data, 'diag');
}

const arg = (k: string): string | null => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
if (process.argv[1] != null && import.meta.url === `file://${process.argv[1]}`) {
  const inPath = arg('--in');
  if (!inPath) throw new Error('need --in <json>');
  const binding = JSON.parse(readFileSync(arg('--binding') ?? 'eval/ontology/s2/binding-agentdyn.json', 'utf8')) as BindingShape;
  const agentdojo = JSON.parse(readFileSync(arg('--agentdojo-binding') ?? 'eval/ontology/v2/frozen/binding-v2.json', 'utf8')) as BindingShape;
  const schema = JSON.parse(readFileSync(arg('--schema') ?? 'eval/ontology/diag-s2/diag-schema.json', 'utf8'));
  validateDiag(JSON.parse(readFileSync(inPath, 'utf8')), binding, schema, agentdojo);
  console.log(`validate-diag: ${inPath} OK`);
}
