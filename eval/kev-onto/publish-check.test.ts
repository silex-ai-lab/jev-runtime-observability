// Acceptance for T1 publish-check (plan §4; KO_SPEC §7). Pure checks on paths and windows, then real git scenarios in a
// throwaway worktree of this repo: out-of-root staged file, staged/working-tree mismatch, an extra file in the exception
// folder, a changed exception file, and the .gitignore keeping predictions and model weights out.
//   node eval/kev-onto/publish-check.test.ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { check, disallowed, sharedWindow, windowsOf, isRealFixtureException, EXCEPTION_DIR } from './publish-check.ts';

let fails = 0;
const ok = (name: string, cond: boolean, info: unknown = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name} ${info === '' ? '' : JSON.stringify(info)}`); if (!cond) fails++; };

// 1. Allowlist by path
const allowed = [
  'eval/kev-onto/contract.ts', 'eval/kev-onto/KO_SPEC.md', 'eval/kev-onto/recheck_ko.py', 'eval/kev-onto/binding/extract.ts',
  'eval/kev-onto/train.sh', 'eval/kev-onto/manifest.agentdyn.json', 'eval/kev-onto/binding/resolved.json',
  'eval/kev-onto/fixtures/convert/run-a.json', `${EXCEPTION_DIR}/runs.json`,
  'runs/kev-onto/.gitignore', 'runs/kev-onto/ft-cand/RUN.txt', 'runs/kev-onto/train-v1/train-stats.json',
  'runs/kev-onto/train-v1/G1-goal_deviation.json', 'runs/kev-onto/incumbent-check/identity.json',
  'runs/kev-onto/incumbent-check/agreement-0928-0929.json', 'runs/kev-onto/scores-ab12/meta-candidate.json',
  'runs/kev-onto/scores-ab12/summary.json',
];
const rejected = [
  'eval/kev-onto/other.sh', 'eval/kev-onto/binding/raw/binder-a.txt', 'eval/kev-onto/items.jsonl',
  'runs/kev-onto/scores-ab12/predictions-candidate.jsonl', 'runs/kev-onto/ft-cand/model/adapter_model.safetensors',
  'runs/kev-onto/train-v1/records.jsonl', 'runs/kev-onto/incumbent-check/predictions.jsonl',
  'eval/ontology/stats.ts', 'README.md', 'logs/notes.md',
];
ok('allowlisted artifact types pass', disallowed(allowed).length === 0, disallowed(allowed));
ok('out-of-list files fail, including outside the two roots', disallowed(rejected).length === rejected.length, rejected.filter(p => !disallowed([p]).length));
ok('real-fixture exception is exactly the named folder', isRealFixtureException(`${EXCEPTION_DIR}/a.json`) && !isRealFixtureException('eval/kev-onto/fixtures/convert/a.json'));

// 2. Window check: any shared 32-character window is a leak; text sharing only short fragments passes.
const cohort = 'Your order ZQ-88213 ships to 41 Larkspur Lane, Unit 9, Fernhollow on Tuesday.';
const ref = windowsOf(cohort);
ok('planted leak is found', sharedWindow(`const fixture = "${cohort.slice(5, 50)}";`, ref) !== null);
ok('an exact shared common-word sequence ≥ 32 chars is a leak', sharedWindow('x confidential to the user privatex y', windowsOf('confidential to the user privatex')) !== null);
ok('short shared fragments pass', sharedWindow('Your order ships on Tuesday, Unit 9 — Lane 41.', ref) === null);

// 3. Git scenarios in a throwaway worktree
const repo = process.cwd();
const wt = mkdtempSync(join(tmpdir(), 'kev-onto-pc-'));
execFileSync('git', ['worktree', 'add', '--detach', '-q', wt, 'HEAD']);
const sh = (args: string[]) => execFileSync('git', ['-C', wt, ...args], { encoding: 'utf8' });
const put = (p: string, s: string) => { mkdirSync(dirname(join(wt, p)), { recursive: true }); writeFileSync(join(wt, p), s); };
const reset = () => { sh(['reset', '-q', '--hard']); sh(['clean', '-qfdx', '--', 'eval/kev-onto', 'runs/kev-onto', 'logs']); };
try {
  put('eval/kev-onto/new-module.ts', 'export const x = 1;\n'); sh(['add', 'eval/kev-onto/new-module.ts']);
  ok('allowlisted staged file passes', check(wt).failures.length === 0, check(wt).failures);
  reset();
  put('logs/notes.md', 'x\n'); sh(['add', '-f', 'logs/notes.md']);
  ok('out-of-root staged file fails', check(wt).failures.some(f => f.startsWith('not allowlisted: logs/notes.md')));
  reset();
  sh(['rm', '-q', 'README.md']);
  ok('staged deletion outside the allowlist fails', check(wt).failures.some(f => f.startsWith('not allowlisted: README.md')));
  reset();
  rmSync(join(wt, 'LICENSE')); execFileSync('ln', ['-s', 'NOTICE', join(wt, 'LICENSE')]); sh(['add', 'LICENSE']);
  ok('staged type change outside the allowlist fails', check(wt).failures.some(f => f.startsWith('not allowlisted: LICENSE')));
  reset();
  sh(['mv', 'eval/kev-onto/lexicon-yield.ts', 'logs/lexicon-yield.ts']);
  ok('rename out of the allowlist fails on the new path', check(wt).failures.some(f => f.startsWith('not allowlisted: logs/lexicon-yield.ts')));
  reset();
  put('eval/kev-onto/new-module.ts', 'export const x = 1;\n'); sh(['add', 'eval/kev-onto/new-module.ts']);
  appendFileSync(join(wt, 'eval/kev-onto/new-module.ts'), 'export const y = 2;\n');
  ok('staged/working-tree mismatch fails', check(wt).failures.some(f => f.startsWith('working tree differs')));
  reset();
  put(`${EXCEPTION_DIR}/extra.json`, '{}\n'); sh(['add', `${EXCEPTION_DIR}/extra.json`]);
  ok('extra file in exception folder fails', check(wt).failures.some(f => f.includes('not produced by build.ts')));
  reset();
  appendFileSync(join(wt, `${EXCEPTION_DIR}/expected.jsonl`), '{"tampered":true}\n'); sh(['add', `${EXCEPTION_DIR}/expected.jsonl`]);
  ok('changed exception file fails', check(wt).failures.some(f => f.includes('does not regenerate')));
  reset();
  const ignored = (p: string) => { try { execFileSync('git', ['-C', wt, 'check-ignore', '-q', '--no-index', p]); return true; } catch { return false; } };
  for (const p of ['runs/kev-onto/ft-cand/model/adapter_model.safetensors', 'runs/kev-onto/ft-cand/model/head.pt',
    'runs/kev-onto/scores-ab12/predictions-candidate.jsonl', 'runs/kev-onto/train-v1/records.jsonl']) ok(`ignored: ${p}`, ignored(p));
  for (const p of ['runs/kev-onto/.gitignore', 'runs/kev-onto/ft-cand/RUN.txt', 'runs/kev-onto/train-v1/train-stats.json',
    'runs/kev-onto/train-v1/G1-goal_deviation.json', 'runs/kev-onto/incumbent-check/identity.json',
    'runs/kev-onto/scores-ab12/summary.json', 'runs/kev-onto/scores-ab12/meta-candidate.json']) ok(`not ignored: ${p}`, !ignored(p));
} finally {
  execFileSync('git', ['worktree', 'remove', '--force', wt]);
  rmSync(wt, { recursive: true, force: true });
}
console.log(fails ? `publish-check tests: ${fails} FAIL` : 'publish-check tests: PASS');
if (fails) process.exit(1);
