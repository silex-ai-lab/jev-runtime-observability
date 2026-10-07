// binding-check.test.ts — P1 acceptance: the subset check fails on a planted one-byte entry change and on a planted
// extra or missing id; the real binding passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkBinding } from './binding-check.ts';

const read = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
const binding = read('eval/ontology/c-pilot/binding-silex.json');
const resolved = read('eval/kev-onto/binding/resolved.json');
const manifest = read('eval/kev-onto/binding/manifest-silex.json');
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

test('the committed binding is the W1 Silex subset', () => assert.deepEqual(checkBinding(binding, resolved, manifest), []));
test('a one-byte change in an entry fails', () => {
  const b = clone(binding); b.tools['silex:soc/firewall.block_ip'].params.ip = 'nonf';
  assert.deepEqual(checkBinding(b, resolved, manifest), ['entry differs from resolved.json: silex:soc/firewall.block_ip']);
});
test('a dropped reason fails', () => {
  const b = clone(binding); delete b.tools['silex:ap/erp.get_po'].reason;
  assert.equal(checkBinding(b, resolved, manifest).length, 1);
});
test('an extra id fails', () => {
  const b = clone(binding); b.tools['silex:ap/extra.tool'] = { effects: [], params: {} };
  assert.deepEqual(checkBinding(b, resolved, manifest), ['extra id: silex:ap/extra.tool']);
});
test('a missing id fails', () => {
  const b = clone(binding); delete b.tools['silex:ap/email.send'];
  assert.deepEqual(checkBinding(b, resolved, manifest), ['missing id: silex:ap/email.send']);
});
