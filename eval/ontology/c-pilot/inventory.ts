// inventory.ts — C pilot P0 (plan r4 §1): a label-blind structural inventory of the sealed Silex runs. It answers only
// a closed list of questions, as a union over all files: JSON types at allowlisted AgentDojo envelope paths, the set of
// canonical roles, and two fixed booleans. `security`/`utility` are never read or traversed; content, args, injections
// and tool output are typed, never traversed. No values, raw key names, per-file rows, counts or parser diagnostics.
//   node eval/ontology/c-pilot/inventory.ts --silex <data/kev-onto/silex-runs> --binding eval/ontology/c-pilot/binding-silex.json --out <file>
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const TOP = ['suite_name', 'pipeline_name', 'user_task_id', 'injection_task_id', 'attack_type', 'injections', 'messages', 'error', 'duration', 'agentdojo_package_version', 'evaluation_timestamp'] as const;
export const MSG = ['role', 'content', 'tool_calls', 'tool_call_id', 'tool_call', 'error'] as const;
export const CALL = ['function', 'args', 'id'] as const;
const EXEMPT = new Set(['security', 'utility']);
const ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const PATH_RE = /^runs\/(ap|soc)\/user_task_\d+\/(?:none\/none|[^/]+\/injection_task_\d+)\.json$/;

export class InventoryAbort extends Error {}

const jtype = (v: unknown): string => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object'
  : typeof v === 'string' ? 'string' : typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'other';
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Verify SEAL.sha256 against the files: same set of runs/**.json, every sha256 equal. Paths only; nothing is parsed. */
export function verifySeal(dir: string): string[] {
  const seal = new Map<string, string>();
  for (const line of readFileSync(join(dir, 'SEAL.sha256'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/);
    if (!m || seal.has(m[2]) || !PATH_RE.test(m[2])) throw new InventoryAbort('seal mismatch');   // no duplicates, no unexpected path
    seal.set(m[2], m[1]);
  }
  const found: string[] = [];
  const walk = (d: string): void => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (n.endsWith('.json')) found.push(relative(dir, p)); } };
  if (existsSync(join(dir, 'runs'))) walk(join(dir, 'runs'));
  if (found.length !== seal.size || found.some(f => !seal.has(f))) throw new InventoryAbort('seal mismatch');
  for (const [f, h] of seal) if (createHash('sha256').update(readFileSync(join(dir, f))).digest('hex') !== h) throw new InventoryAbort('seal mismatch');
  return [...seal.keys()].sort();
}

/** The closed-question inventory over parsed runs (path → parsed JSON). Pure; used by the CLI and the tests. */
export function inventory(runs: Array<{ path: string; run: unknown }>, registered: Set<string>) {
  const env = new Map<string, Set<string>>(TOP.map(k => [k, new Set()]));
  const msg = new Map<string, Set<string>>(MSG.map(k => [k, new Set()]));
  const call = new Map<string, Set<string>>(CALL.map(k => [k, new Set()]));
  const roles = new Set<string>();
  let unlisted = false, allRegistered = true;
  const see = (m: Map<string, Set<string>>, o: Record<string, unknown>, keys: readonly string[]): void => {
    for (const k of keys) if (Object.hasOwn(o, k)) m.get(k)!.add(jtype(o[k]));
  };
  for (const { path, run } of runs) {
    const pm = path.match(PATH_RE);
    if (!pm || !isObj(run)) throw new InventoryAbort('parse failure');
    const suite = pm[1];
    for (const k of Object.keys(run)) if (!(TOP as readonly string[]).includes(k) && !EXEMPT.has(k)) unlisted = true;
    see(env, run, TOP);
    const messages = run.messages;
    if (!Array.isArray(messages)) continue;
    for (const m of messages) {
      if (!isObj(m)) continue;
      for (const k of Object.keys(m)) if (!(MSG as readonly string[]).includes(k) && !EXEMPT.has(k)) unlisted = true;
      see(msg, m, MSG);
      if (Object.hasOwn(m, 'role')) roles.add(typeof m.role === 'string' && ROLES.has(m.role) ? m.role : 'other');
      if (!Array.isArray(m.tool_calls)) continue;
      for (const c of m.tool_calls) {
        if (!isObj(c)) { allRegistered = false; continue; }
        see(call, c, CALL);
        const fn = c.function;
        const name = typeof fn === 'string' ? fn : isObj(fn) && typeof fn.name === 'string' ? fn.name : null;
        if (name === null || !registered.has(`silex:${suite}/${name}`)) allRegistered = false;
      }
    }
  }
  const types = (m: Map<string, Set<string>>) => Object.fromEntries([...m.keys()].sort().map(k => [k, m.get(k)!.size ? [...m.get(k)!].sort() : ['absent']]));
  return { schema: 'c-pilot-inventory/1', envelope: types(env), message: types(msg), tool_call: types(call),
    roles: [...roles].sort(), unlisted_key_exists: unlisted, all_tool_names_registered: allRegistered };
}

/** Publish `text` at `out` only through a complete temporary write and a rename; on any failure remove the temporary
 *  file and return false. `ops` is injectable for fault tests. */
export function publish(out: string, text: string, ops = { write: writeFileSync, rename: renameSync }): boolean {
  const tmp = `${out}.partial-${process.pid}`;
  try { ops.write(tmp, text, { flag: 'wx' }); ops.rename(tmp, out); return true; }
  catch { try { rmSync(tmp, { force: true }); } catch { /* nothing to clean */ } return false; }
}

/** Seal, parse all files (any failure aborts with no output), inventory. `expect` = required number of seal entries. */
export function runInventory(dir: string, bindingPath: string, expect?: number): string {
  const paths = verifySeal(dir);
  if (expect !== undefined && paths.length !== expect) throw new InventoryAbort('seal mismatch');
  const registered = new Set(Object.keys(JSON.parse(readFileSync(bindingPath, 'utf8')).tools));
  const runs: Array<{ path: string; run: unknown }> = [];
  for (const p of paths) {
    try { runs.push({ path: p, run: JSON.parse(readFileSync(join(dir, p), 'utf8')) }); }
    catch { throw new InventoryAbort('parse failure'); }
  }
  return JSON.stringify(inventory(runs, registered), null, 1) + '\n';
}

// CLI: every failure prints one fixed line (no stack, path or exception text) and leaves no output file; the output is
// published by rename only after a complete write.
if (import.meta.url === `file://${process.argv[1]}`) {
  const fail = (msg: string): never => { console.error(msg); process.exit(1); };
  const flag = (n: string): string => { const i = process.argv.indexOf(`--${n}`); const v = i > 0 ? process.argv[i + 1] : undefined; return v && !v.startsWith('--') ? v : fail('usage error'); };
  const out = flag('out'), silex = flag('silex'), binding = flag('binding');
  const expectArg = process.argv.includes('--expect') ? Number(flag('expect')) : undefined;
  if (expectArg !== undefined && !Number.isInteger(expectArg)) fail('usage error');
  if (existsSync(out)) fail('output exists');
  let text = '';
  try { text = runInventory(silex, binding, expectArg); }
  catch (e) { fail(e instanceof InventoryAbort ? e.message : 'parse failure'); }
  if (!publish(out, text)) fail('write failure');
  console.log('inventory written');
}
