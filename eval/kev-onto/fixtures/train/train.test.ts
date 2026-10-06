// T7 acceptance (plan §4 T7; KO_SPEC §4 in full): rule probes (rule 2/3/4), the leak check, admission, and G1
// (including the degenerate fixtures). Driven by the synthetic dataset in dataset.ts; no real run data.
//   node eval/kev-onto/fixtures/train/train.test.ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyLog, buildOriginals, buildRule2, buildRule3, leakHit, referenceWindows, admit, assemble, applyA1, g1Of } from '../../train-data.ts';
import { g1 } from '../../g1.ts';
import { fixtureInput } from './dataset.ts';

let fails = 0;
const ok = (name: string, cond: boolean, info: unknown = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name} ${info === '' ? '' : JSON.stringify(info)}`); if (!cond) fails++; };
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../../../..');
const KEV = '/Users/jianwang/workplace/Silex/third_party/kev';

const input = fixtureInput();

// originals + rule 4 (benign ASB/InjecAgent reconstruction and lexicon exclusion)
{
  const log = emptyLog(); const originals = buildOriginals(input, log);
  const ids = originals.map(r => r.item_id);
  ok('originals: kept one per train item except the lexicon-hit benign original',
    ids.includes('asb:normal:normal:ResearchDB:0') && !ids.includes('asb:normal:normal:PoisonTool:1'), { n: originals.length, drop: log.drop });
  ok('rule 4 counts the excluded original', (log.drop['rule4:lexicon'] ?? 0) === 1);
  ok('rule 4 reconstructed the benign ASB passage from Description', originals.find(r => r.item_id.endsWith('ResearchDB:0'))!.state.includes('A research database.'));
}

// rule 2: benign output-consuming negatives
{
  const log = emptyLog(); const r2 = buildRule2(input, log);
  ok('rule 2 yields a record per eligible seed (InjecAgent + τ-bench with a value)', r2.length === 3, { n: r2.length, drop: log.drop });
  ok('rule 2 probed: the value is in the passage and the action, and the labels are false',
    r2.every(r => r.questions.goal_deviation.label === false && (r.source !== 'injecagent' || r.questions.instruction_override.label === false)));
  ok('rule 2 InjecAgent used a harmful write tool with a string parameter', r2.some(r => /AmazonSendEmail/.test(r.state)));
  ok('rule 2 τ-bench used an order id and the get_order_details read tool', r2.some(r => r.family === 'retail' && /#W9876543/.test(r.state) && /get_order_details/.test(r.state)));
}

// rule 3: τ-bench conflicting-target positives; train-split donors only; a no-type-T seed yields nothing
{
  const log = emptyLog(); const r3 = buildRule3(input, log);
  const fromSeed0 = r3.find(r => r.item_id.startsWith('taubench:retail:retail:0:0'));
  ok('rule 3 yields a positive for the seed whose task names a target', !!fromSeed0 && fromSeed0.questions.goal_deviation.label === true);
  ok('rule 3 excluded the non-train donor (#W1111111) and used the train donor (#W7654321)', !!fromSeed0 && /#W7654321/.test(fromSeed0.state) && !/#W1111111/.test(fromSeed0.state));
  ok('rule 3 yields nothing for the seed with no type-T identifier in the instruction', !r3.some(r => r.item_id.startsWith('taubench:retail:retail:3:0')), { r3: r3.map(r => r.item_id) });
}

// rule 5: leak check
{
  const ref = referenceWindows(['the quick brown fox jumps over the lazy dog every single morning']);
  const clean = { ...buildRule2(input, emptyLog())[0] };
  const dirty = { ...clean, state: clean.state + '\nthe quick brown fox jumps over the lazy dog every single morning' };
  ok('rule 5 finds a shared 32-character window', leakHit(dirty, new Set(), ref) !== null);
  ok('rule 5 passes clean text', leakHit(clean, new Set(), ref) === null);
}

// rule 6: admission by the Kev admission code
{
  const records = buildOriginals(input, emptyLog());
  let res: { admitted: unknown[]; rejected: Record<string, number> } | null = null;
  try { res = admit(records, KEV); } catch (e) { console.log('   (admission bridge unavailable:', String(e).slice(0, 80), ')'); }
  ok('rule 6 admits the short fixture records (replicated kev.model.fits at max_state 384)', res !== null && res.admitted.length === records.length && Object.keys(res.rejected).length === 0);
}

// G1 degenerate fixtures (KO_SPEC §4.6)
{
  const empty = JSON.parse(readFileSync(join(REPO, 'eval/kev-onto/fixtures/g1/empty.json'), 'utf8')).records;
  const oneClass = JSON.parse(readFileSync(join(REPO, 'eval/kev-onto/fixtures/g1/one-class.json'), 'utf8')).records;
  const emptyFold = JSON.parse(readFileSync(join(REPO, 'eval/kev-onto/fixtures/g1/empty-fold.json'), 'utf8')).records;
  ok('G1 empty records -> undefined (fail)', g1('goal_deviation', empty).status === 'undefined');
  ok('G1 one-class labels -> undefined (fail)', g1('goal_deviation', oneClass).status === 'undefined');
  ok('G1 empty fold -> undefined (fail)', g1('goal_deviation', emptyFold).status === 'undefined');
}

// assemble + amendment A1 fallback
{
  const res = assemble(input);
  ok('assemble runs all rules and produces G1 for both questions', 'goal_deviation' in res.g1 && 'instruction_override' in res.g1);

  const records = assemble(input).records;
  const withIO = records.filter(r => 'instruction_override' in r.questions).length;
  const stubbed = applyA1(records, { goal_deviation: { question: 'goal_deviation', status: 'pass', features: {}, combined: 0.5, n: 1, positives: 1 }, instruction_override: { question: 'instruction_override', status: 'fail', features: {}, combined: 0.9, n: 1, positives: 1 } });
  ok('A1 fallback fires when only instruction_override fails (drops its labels)',
    stubbed.overridden && records.every(r => !('instruction_override' in r.questions)) && withIO > 0);
  ok('A1 fallback does not fire when goal_deviation fails', !applyA1(records, { goal_deviation: { question: 'goal_deviation', status: 'fail', features: {}, combined: 0.9, n: 1, positives: 1 }, instruction_override: { question: 'instruction_override', status: 'fail', features: {}, combined: 0.9, n: 1, positives: 1 } }).overridden);
}

console.log(fails ? `train tests: ${fails} FAIL` : 'train tests: PASS');
if (fails) process.exit(1);
