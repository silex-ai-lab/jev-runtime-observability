// convert-silex.test.ts — C pilot P2 acceptance (PILOT_SPEC §2).
//   node --test eval/ontology/c-pilot/convert-silex.test.ts
// The base fixture `fixtures/convert/silex/` holds 4 runs (ap/soc × attacked/clean), one call-free run, one
// unregistered tool (`crm.create_lead`), one attacked run with security:null (label_error) and one unlisted top-level
// envelope field (`progent_note`). Negative cases mutate a copy of the sealed dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertSilex } from './convert-silex.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const FIX = resolve(HERE, 'fixtures/convert/silex');
const BINDING = resolve(HERE, 'binding-silex.json');
const EXPECTED = {
  runs: 4, attacked: 2, clean: 2, calls: 6, call_free_runs: 1, label_error: 1,
  unregistered_tool_calls: { ap: { 'crm.create_lead': 1 }, soc: {} }, envelope_extra_fields: { progent_note: 1 },
};
const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
const walk = (dir: string, rel: string): string[] => readdirSync(dir).flatMap(name => {
  const p = join(dir, name), r = `${rel}/${name}`;
  return statSync(p).isDirectory() ? walk(p, r) : [r];
});
const reseal = (dir: string): void => {
  const files = walk(join(dir, 'runs'), 'runs').sort();
  writeFileSync(join(dir, 'SEAL.sha256'), files.map(f => `${sha(join(dir, f))}  ${f}`).join('\n') + '\n');
};
const withCopy = (fn: (dir: string, out: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), 'csx-'));
  try { cpSync(FIX, join(root, 'silex'), { recursive: true }); fn(join(root, 'silex'), join(root, 'out')); }
  finally { rmSync(root, { recursive: true, force: true }); }
};
const thrown = (f: () => unknown): string | null => { try { f(); return null; } catch (e) { return String((e as Error).message); } };

test('P2: the 4-run sealed fixture converts to the expected rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'csx-'));
  try {
    const counts = convertSilex(FIX, BINDING, root);
    assert.deepEqual(counts, EXPECTED);
    const labels = readFileSync(join(root, 'labels.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(labels.length, 4);
    const apAtt = labels.find((l: any) => l.run_id === 'silex-authored/important_instructions/ap/user_task_0/injection_task_0');
    assert.deepEqual({ pipeline: apAtt.pipeline, base: apAtt.base, group: apAtt.group, attack: apAtt.attack, attacked: apAtt.attacked, security: apAtt.security, cohort: apAtt.cohort },
      { pipeline: 'silex-authored', base: 'silex', group: 'P', attack: 'important_instructions', attacked: true, security: true, cohort: 'silex-authored/important_instructions' });
    const socAtt = labels.find((l: any) => l.suite === 'soc' && l.attacked);
    assert.deepEqual({ attacked: socAtt.attacked, security: socAtt.security }, { attacked: true, security: null });   // A-S2-3
    const obs = readFileSync(join(root, 'observations.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(obs.length, 6);
    assert.deepEqual(obs.map((o: any) => `${o.action.name}:${o.action.impact}`), ['erp.get_invoice:read', 'crm.create_lead:write', 'email.send:write', 'ticket.update:write', 'firewall.block_ip:write', 'siem.search:read']);
    assert.ok(obs.some((o: any) => o.action.name === 'crm.create_lead'));   // A-S2-2 kept, counted, not fatal
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('P2: a flipped byte fails the seal before any file is parsed', () => {
  withCopy((dir, out) => {
    const f = join(dir, 'runs/ap/user_task_0/important_instructions/injection_task_0.json');
    const buf = readFileSync(f); buf[0] = buf[0] ^ 0x01; writeFileSync(f, buf);   // '{' -> 'z': invalid JSON if ever parsed
    assert.ok(thrown(() => convertSilex(dir, BINDING, out))?.includes('integrity failure'));
    const rep = JSON.parse(readFileSync(join(out, 'integrity-report.json'), 'utf8'));
    assert.equal(rep.categories.seal_mismatch.count, 1);
    assert.ok(!rep.categories.parse_failure);
    assert.ok(!existsSync(join(out, 'observations.jsonl')) && !existsSync(join(out, 'labels.jsonl')) && !existsSync(join(out, 'counts.json')));
  });
});

test('P2: an extra, unsealed run file fails', () => {
  withCopy((dir, out) => {
    const f = join(dir, 'runs/soc/user_task_11/none/none.json');
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({ messages: [] }));
    assert.ok(thrown(() => convertSilex(dir, BINDING, out))?.includes('integrity failure'));
    const rep = JSON.parse(readFileSync(join(out, 'integrity-report.json'), 'utf8'));
    assert.equal(rep.categories.seal_extra.count, 1);
    assert.ok(!existsSync(join(out, 'observations.jsonl')));
  });
});

test('P2: a malformed envelope yields an integrity report and no observations', () => {
  withCopy((dir, out) => {
    writeFileSync(join(dir, 'runs/ap/user_task_10/none/none.json'), JSON.stringify({ messages: 'not-an-array' }));
    reseal(dir);
    assert.ok(thrown(() => convertSilex(dir, BINDING, out))?.includes('integrity failure'));
    const rep = JSON.parse(readFileSync(join(out, 'integrity-report.json'), 'utf8'));
    assert.equal(rep.categories.malformed_envelope.count, 1);
    assert.ok(rep.categories.malformed_envelope.ids.every((x: string) => x.endsWith('.json')));
    assert.ok(!/not-an-array|messages/.test(JSON.stringify(rep)));
    assert.ok(!existsSync(join(out, 'observations.jsonl')) && !existsSync(join(out, 'counts.json')));
  });
});

test('P2: a P0-shape run with content-block arrays and unlisted keys converts without leaking them', () => {
  const root = mkdtempSync(join(tmpdir(), 'csx-'));
  try {
    const counts = convertSilex(resolve(HERE, 'fixtures/convert/p0shape'), BINDING, root);
    assert.deepEqual(counts, {
      runs: 1, attacked: 1, clean: 0, calls: 2, call_free_runs: 0, label_error: 0,
      unregistered_tool_calls: { ap: {}, soc: {} }, envelope_extra_fields: { unlisted_envelope: 1 },
    });
    const text = readFileSync(join(root, 'observations.jsonl'), 'utf8');
    assert.ok(!text.includes('SENTINEL_ENVELOPE_VALUE'), 'unlisted top-level value leaked');
    assert.ok(!text.includes('SENTINEL_MESSAGE_VALUE'), 'unlisted message value leaked');
    assert.ok(!text.includes('annotations'), 'unlisted message key name leaked');
    const rows = text.trim().split('\n').map(l => JSON.parse(l));
    assert.equal(rows[0].action.name, 'email.send');
    assert.equal(rows[1].action.name, 'erp.get_invoice');
    assert.equal(rows[0].task, 'SENTINEL_USER_BLOCK do the task');        // user content-block array through textContent
    assert.equal(rows[1].low_authority[0].text, 'SENTINEL_TOOL_BLOCK');   // tool content-block array through textContent
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('P2: a conversion failure and a later malformed envelope are both collected in one integrity report', () => {
  withCopy((dir, out) => {
    // Early run: an unmatched tool result makes convertRun throw (`unpaired result`) — a conversion_failure.
    const ap = join(dir, 'runs/ap/user_task_0/important_instructions/injection_task_0.json');
    const apRun = JSON.parse(readFileSync(ap, 'utf8'));
    const lastTool = [...apRun.messages].reverse().find((m: { role: string }) => m.role === 'tool') as { tool_call_id: string };
    lastTool.tool_call_id = 'call-9';
    writeFileSync(ap, JSON.stringify(apRun));
    // Later run: a distinct failure category (malformed envelope).
    writeFileSync(join(dir, 'runs/soc/user_task_10/none/none.json'), JSON.stringify({ messages: 'not-an-array' }));
    reseal(dir);
    assert.ok(thrown(() => convertSilex(dir, BINDING, out))?.includes('integrity failure'));
    const rep = JSON.parse(readFileSync(join(out, 'integrity-report.json'), 'utf8'));
    assert.equal(rep.categories.conversion_failure.count, 1);
    assert.equal(rep.categories.malformed_envelope.count, 1);
    assert.ok(rep.categories.conversion_failure.ids.every((x: string) => x.endsWith('.json')));
    assert.ok(!rep.categories.conversion_failure.ids.some((x: string) => x.includes('SENTINEL')));
    assert.ok(!existsSync(join(out, 'observations.jsonl')) && !existsSync(join(out, 'labels.jsonl')) && !existsSync(join(out, 'counts.json')));
  });
});

test('P2 CLI: --silex --binding --out converts the fixture', () => {
  const root = mkdtempSync(join(tmpdir(), 'csx-'));
  try {
    const outp = execFileSync('node', ['eval/ontology/c-pilot/convert-silex.ts', '--silex', FIX, '--binding', BINDING, '--out', root], { cwd: ROOT, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(outp.trim()), EXPECTED);
    assert.ok(existsSync(join(root, 'observations.jsonl')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
