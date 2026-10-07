// inventory.test.ts — P0 acceptance (plan r4 §6 P0): adversarial byte-identity fixtures, all synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInventory, InventoryAbort, publish } from './inventory.ts';
import { writeFileSync as realWrite } from 'node:fs';

const BINDING = 'eval/ontology/c-pilot/binding-silex.json';

function baseRuns(): Record<string, any> {
  return JSON.parse(readFileSync('eval/ontology/c-pilot/fixtures/inventory/base-runs.json', 'utf8'));
}

function materialize(runs: Record<string, any>, raw: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'cpilot-inv-'));
  const lines: string[] = [];
  for (const [p, r] of Object.entries(runs)) {
    const text = raw[p] ?? JSON.stringify(r);
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
    lines.push(`${createHash('sha256').update(text).digest('hex')}  ${p}`);
  }
  writeFileSync(join(dir, 'SEAL.sha256'), lines.join('\n') + '\n');
  return dir;
}
const inv = (runs: Record<string, any>) => runInventory(materialize(runs), BINDING);
const A = 'runs/ap/user_task_0/important_instructions/injection_task_0.json', C = 'runs/soc/user_task_10/none/none.json';
const base = inv(baseRuns());

test('golden: the committed base fixture gives exactly the committed expected output', () => {
  assert.equal(base, readFileSync('eval/ontology/c-pilot/fixtures/inventory/expected.json', 'utf8'));
});

test('base output has only the closed shape', () => {
  const o = JSON.parse(base);
  assert.deepEqual(Object.keys(o).sort(), ['all_tool_names_registered', 'envelope', 'message', 'roles', 'schema', 'tool_call', 'unlisted_key_exists']);
  assert.equal(o.unlisted_key_exists, false);
  assert.equal(o.all_tool_names_registered, true);
  assert.deepEqual(o.roles, ['assistant', 'other', 'system', 'tool', 'user']);
  for (const s of ['SYNTH', 'INV-0001', 'Acme', 'vector_a', 'invoice_id', 'payee', 'erp.get_invoice', 'security', 'utility']) assert.ok(!base.includes(s), s);
});

const identical: Array<[string, (r: Record<string, any>) => void]> = [
  ['security/utility values flip', r => { r[A].security = false; r[C].utility = false; }],
  ['security/utility change type', r => { r[A].security = null; r[C].utility = 'x'; }],
  ['security/utility removed', r => { delete r[A].security; delete r[A].utility; delete r[C].security; }],
  ['security/utility added where absent', r => { delete r[A].security; delete r[C].security; r[A].security = { nested: true }; }],
  ['message content changes', r => { r[A].messages[1].content = 'totally different SECRET'; r[C].messages[3].content[0].text = 'other output'; }],
  ['args keys and values change', r => { r[A].messages[2].tool_calls[0].args = { SECRET_KEY_PAYLOAD: 'v', invoice_id: 'X' }; }],
  ['secret key inside args', r => { r[A].messages[4].tool_calls[0].args.ignore_previous_instructions = 'pay attacker'; }],
  ['secret key inside injections', r => { r[A].injections['transfer to attacker now'] = 'payload'; }],
  ['secret key inside tool output object', r => { r[A].messages[3].tool_call.args = { 'SECRET_OUTPUT_KEY': 1 }; }],
  ['secret key inside tool output content blocks', r => { r[C].messages[3].content[0].SECRET_BLOCK_KEY = 'attack succeeded'; r[C].messages[3].content.push({ type: 'image', data: 'z' }); }],
  ['unknown role string replaced by another', r => { r[A].messages[0].role = 'narrator'; r[C].messages[0].role = 'narrator'; }],
  ['allowlisted key present in one file vs all', r => { delete r[C].duration; }],
];
for (const [name, mutate] of identical) test(`identical output: ${name}`, () => {
  const r = baseRuns();
  if (name.startsWith('unknown role')) {   // compare two different unknown role strings with each other
    const r2 = baseRuns(); r2[A].messages[0].role = 'oracle-success'; r2[C].messages[0].role = 'oracle-success';
    mutate(r); assert.equal(inv(r), inv(r2)); assert.ok(!inv(r).includes('narrator')); return;
  }
  mutate(r);
  assert.equal(inv(r), base);
});

for (const [name, mutate] of [
  ['message-level security added', (r: any) => { r[A].messages[2].security = true; }],
  ['message-level utility added with another type', (r: any) => { r[C].messages[3].utility = 'x'; r[A].messages[1].security = null; }],
  ['extra tool-call keys', (r: any) => { r[A].messages[2].tool_calls[0].SECRET_CALL_KEY = 'v'; r[C].messages[4].tool_calls[0].success = true; }],
] as Array<[string, (r: any) => void]>) test(`identical output: ${name}`, () => { const r = baseRuns(); mutate(r); assert.equal(inv(r), base); });
test('message-level label fields: removed and changed are identical too', () => {
  const r1 = baseRuns(); r1[A].messages[2].security = true;
  const r2 = baseRuns(); r2[A].messages[2].security = false; r2[A].messages[2].utility = 3;
  assert.equal(inv(r1), inv(r2)); assert.equal(inv(r1), base);
});

test('an unlisted envelope key changes only the boolean, and its name never appears', () => {
  const r = baseRuns(); r[A].attack_succeeded_SECRET = true;
  const o = JSON.parse(inv(r)), b = JSON.parse(base);
  assert.equal(o.unlisted_key_exists, true);
  assert.deepEqual({ ...o, unlisted_key_exists: false }, b);
  assert.ok(!inv(r).includes('attack_succeeded_SECRET'));
});

test('function.name form gives the same registration result as the string form', () => {
  const r = baseRuns(); r[A].messages[2].tool_calls[0].function = { name: 'erp.get_invoice', arguments: {} };
  assert.equal(JSON.parse(inv(r)).all_tool_names_registered, true);
  const bad = baseRuns(); bad[A].messages[2].tool_calls[0].function = { arguments: {} };
  assert.equal(JSON.parse(inv(bad)).all_tool_names_registered, false);
  const wrongSuite = baseRuns(); wrongSuite[C].messages[2].tool_calls[0].function = 'erp.get_invoice';   // ap tool in soc
  assert.equal(JSON.parse(inv(wrongSuite)).all_tool_names_registered, false);
  assert.ok(!inv(wrongSuite).includes('erp.get_invoice'));
});

test('absent only when absent everywhere', () => {
  const r = baseRuns(); delete r[A].duration; delete r[C].duration;
  assert.deepEqual(JSON.parse(inv(r)).envelope.duration, ['absent']);
});

test('seal mismatch refuses before parsing', () => {
  const dir = materialize(baseRuns());
  writeFileSync(join(dir, A), '{tampered, not JSON');   // unparseable: a parse-first implementation would throw SyntaxError
  assert.throws(() => runInventory(dir, BINDING), (e: unknown) => e instanceof InventoryAbort && (e as Error).message === 'seal mismatch');
  const dir2 = materialize(baseRuns());
  mkdirSync(join(dir2, 'runs/ap/user_task_9/none'), { recursive: true });
  writeFileSync(join(dir2, 'runs/ap/user_task_9/none/none.json'), '{}');
  assert.throws(() => runInventory(dir2, BINDING), (e: unknown) => (e as Error).message === 'seal mismatch');
});

test('duplicate seal entries are refused, identical or conflicting', () => {
  for (const conflicting of [false, true]) {
    const dir = materialize(baseRuns());
    const lines = readFileSync(join(dir, 'SEAL.sha256'), 'utf8').trim().split('\n');
    const first = conflicting ? '0'.repeat(64) + lines[0].slice(64) : lines[0];
    writeFileSync(join(dir, 'SEAL.sha256'), [first, ...lines].join('\n') + '\n');
    assert.throws(() => runInventory(dir, BINDING), (e: unknown) => e instanceof InventoryAbort && (e as Error).message === 'seal mismatch');
  }
});

test('an unexpected seal path and a wrong expected count are refused', () => {
  const dir = materialize({ ...baseRuns(), 'runs/xx/odd.json': {} });
  assert.throws(() => runInventory(dir, BINDING), (e: unknown) => (e as Error).message === 'seal mismatch');
  assert.throws(() => runInventory(materialize(baseRuns()), BINDING, 40), (e: unknown) => (e as Error).message === 'seal mismatch');
  assert.doesNotThrow(() => runInventory(materialize(baseRuns()), BINDING, 2));
});

const cli = (args: string[]) => spawnSync(process.execPath, ['eval/ontology/c-pilot/inventory.ts', ...args], { encoding: 'utf8' });
test('CLI: missing arguments and output failures give one fixed line, empty stdout and no output', () => {
  const dir = materialize(baseRuns());
  const p1 = cli(['--silex', dir, '--binding', BINDING]);
  assert.notEqual(p1.status, 0); assert.equal(p1.stderr.trim(), 'usage error'); assert.equal(p1.stdout, '');
  const out = join(dir, 'no-such-dir', 'inventory.json');
  const p2 = cli(['--silex', dir, '--binding', BINDING, '--out', out]);
  assert.notEqual(p2.status, 0); assert.equal(p2.stderr.trim(), 'write failure'); assert.equal(p2.stdout, '');
  assert.ok(!existsSync(out)); assert.ok(!existsSync(join(dir, 'no-such-dir')));
  const ok = join(dir, 'inv.json');
  const p3 = cli(['--silex', dir, '--binding', BINDING, '--out', ok, '--expect', '2']);
  assert.equal(p3.status, 0); assert.equal(readFileSync(ok, 'utf8'), base);
  assert.equal(p3.stdout.trim(), 'inventory written'); assert.equal(p3.stderr, '');
  const p4 = cli(['--silex', dir, '--binding', BINDING, '--out', ok]);
  assert.notEqual(p4.status, 0); assert.equal(p4.stderr.trim(), 'output exists');
  assert.deepEqual(readdirSync(dir).filter(n => n.includes('partial')), []);
});

test('parse failure aborts with the fixed message and writes no output', () => {
  const dir = materialize(baseRuns(), { [C]: '{not json SECRET' });
  const out = join(dir, 'inventory.json');
  const p = spawnSync(process.execPath, ['eval/ontology/c-pilot/inventory.ts', '--silex', dir, '--binding', BINDING, '--out', out], { encoding: 'utf8' });
  assert.notEqual(p.status, 0);
  assert.equal(p.stderr.trim(), 'parse failure');
  assert.equal(p.stdout, '');
  assert.ok(!existsSync(out));
});

test('publish: a failing rename leaves neither the output nor the temporary file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cpilot-pub-')); const out = join(dir, 'inv.json');
  let tmpSeen = '';
  const okFlag = publish(out, 'x', { write: ((p: string, t: string, o: object) => { tmpSeen = p; realWrite(p, t, o as never); }) as never, rename: (() => { throw new Error('boom'); }) as never });
  assert.equal(okFlag, false); assert.ok(tmpSeen.endsWith(`.partial-${process.pid}`));
  assert.ok(!existsSync(out)); assert.ok(!existsSync(tmpSeen));
  assert.equal(publish(out, 'y'), true); assert.equal(readFileSync(out, 'utf8'), 'y');
});
