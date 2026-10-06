// Acceptance for T1 publish-check (plan §4): every allowlisted artifact type passes, out-of-list files fail, the
// .gitignore keeps predictions and model weights out, and the window check fails a planted leak but passes common words.
//   node eval/kev-onto/publish-check.test.ts
import { execFileSync } from 'node:child_process';
import { disallowed, sharedWindow, windowsOf, isRealFixtureException } from './publish-check.ts';

let fails = 0;
const check = (name: string, ok: boolean, info: unknown = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info === '' ? '' : JSON.stringify(info)}`); if (!ok) fails++; };

const allowed = [
  'eval/kev-onto/contract.ts', 'eval/kev-onto/KO_SPEC.md', 'eval/kev-onto/recheck_ko.py', 'eval/kev-onto/binding/extract.ts',
  'eval/kev-onto/train.sh', 'eval/kev-onto/manifest.agentdyn.json', 'eval/kev-onto/binding/resolved.json',
  'eval/kev-onto/fixtures/convert/run-a.json', 'eval/kev-onto/fixtures/foundation/agentdojo-e5/runs.json',
  'runs/kev-onto/.gitignore', 'runs/kev-onto/ft-cand/RUN.txt', 'runs/kev-onto/train-v1/train-stats.json',
  'runs/kev-onto/train-v1/G1-goal_deviation.json', 'runs/kev-onto/incumbent-check/identity.json',
  'runs/kev-onto/incumbent-check/agreement-0928-0929.json', 'runs/kev-onto/scores-ab12/meta-candidate.json',
  'runs/kev-onto/scores-ab12/summary.json',
];
const rejected = [
  'eval/kev-onto/other.sh', 'eval/kev-onto/binding/raw/binder-a.txt', 'eval/kev-onto/items.jsonl',
  'runs/kev-onto/scores-ab12/predictions-candidate.jsonl', 'runs/kev-onto/ft-cand/model/adapter_model.safetensors',
  'runs/kev-onto/train-v1/records.jsonl', 'runs/kev-onto/incumbent-check/predictions.jsonl',
];
check('allowlisted artifact types pass', disallowed(allowed).length === 0, disallowed(allowed));
check('out-of-list files fail', disallowed(rejected).length === rejected.length, rejected.filter(p => !disallowed([p]).length));
check('paths outside the two roots are not judged', disallowed(['eval/ontology/stats.ts', 'README.md']).length === 0);
check('real-fixture exception is exactly the named folder',
  isRealFixtureException('eval/kev-onto/fixtures/foundation/agentdojo-e5/a.json') && !isRealFixtureException('eval/kev-onto/fixtures/convert/a.json'));

// .gitignore: git check-ignore exits 0 for ignored, 1 for not ignored (works for paths that do not exist yet).
const ignored = (p: string) => { try { execFileSync('git', ['check-ignore', '-q', '--no-index', p]); return true; } catch { return false; } };
for (const p of ['runs/kev-onto/ft-cand/model/adapter_model.safetensors', 'runs/kev-onto/ft-cand/model/head.pt',
  'runs/kev-onto/scores-ab12/predictions-candidate.jsonl', 'runs/kev-onto/train-v1/records.jsonl']) check(`ignored: ${p}`, ignored(p));
for (const p of ['runs/kev-onto/.gitignore', 'runs/kev-onto/ft-cand/RUN.txt', 'runs/kev-onto/train-v1/train-stats.json',
  'runs/kev-onto/train-v1/G1-goal_deviation.json', 'runs/kev-onto/incumbent-check/identity.json',
  'runs/kev-onto/scores-ab12/summary.json', 'runs/kev-onto/scores-ab12/meta-candidate.json']) check(`not ignored: ${p}`, !ignored(p));

// Window check (rule 5 / §7): a planted 40-character cohort string must be found; text sharing only common words must pass.
const cohort = 'Your order ZQ-88213 ships to 41 Larkspur Lane, Unit 9, Fernhollow on Tuesday.';
const ref = windowsOf(cohort);
check('planted leak is found', sharedWindow(`const fixture = "${cohort.slice(5, 50)}";`, ref) !== null);
check('common words only pass', sharedWindow('please send the file to the user and get the list of what you have', windowsOf('please send the file to the user and get the list of what you have for me')) === null);
check('no shared text passes', sharedWindow('completely unrelated synthetic fixture text 0123456789', ref) === null);

console.log(fails ? `publish-check tests: ${fails} FAIL` : 'publish-check tests: PASS');
if (fails) process.exit(1);
