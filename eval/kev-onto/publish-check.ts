// Publication guard for wave 1 (KO_SPEC §7). Run in the repo before a wave-1 commit. It fails if:
//   - any staged change (any type: add/modify/delete/rename/type change; any directory) touches a path outside PUBLISH_ALLOW;
//   - a staged path's working-tree bytes differ from its staged blob (the check reads staged blobs);
//   - the real-fixture exception folder does not regenerate byte-identically, or holds a file build.ts does not produce;
//   - with --cohort-text <jsonl of {text}> (only after F1), any staged text file shares a LEAK_WINDOW-character window
//     with cohort text. There is no word-based exemption.
//   node eval/kev-onto/publish-check.ts [--cohort-text <file>] [--repo <dir>]
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { LEAK_WINDOW, PUBLISH_ALLOW, PUBLISH_REAL_FIXTURE_EXCEPTION } from './contract.ts';

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { const slash = glob[i + 2] === '/'; re += slash ? '(?:.*/)?' : '.*'; i += slash ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '{') { const end = glob.indexOf('}', i); re += '(?:' + glob.slice(i + 1, end).split(',').map(alt).join('|') + ')'; i = end; }
    else re += c.replace(/[.+?^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
const alt = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');

const ALLOW = PUBLISH_ALLOW.map(globToRegExp);
const EXCEPTION = globToRegExp(PUBLISH_REAL_FIXTURE_EXCEPTION);
export const EXCEPTION_DIR = PUBLISH_REAL_FIXTURE_EXCEPTION.replace(/\/\*\*$/, '');
export const isAllowed = (path: string) => ALLOW.some(r => r.test(path));
export const isRealFixtureException = (path: string) => EXCEPTION.test(path);
export const disallowed = (paths: string[]) => paths.filter(p => !isAllowed(p));

const norm = (s: string) => s.replace(/\s+/g, ' ');
export function windowsOf(text: string, n = LEAK_WINDOW): Set<string> {
  const t = norm(text), out = new Set<string>();
  for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n));
  return out;
}
/** First window of `text` that is in `ref`, or null. */
export function sharedWindow(text: string, ref: Set<string>, n = LEAK_WINDOW): string | null {
  const t = norm(text);
  for (let i = 0; i + n <= t.length; i++) { const w = t.slice(i, i + n); if (ref.has(w)) return w; }
  return null;
}

export interface CheckResult { staged: string[]; failures: string[] }
export function check(repo: string, cohortText?: string): CheckResult {
  const git = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'buffer', maxBuffer: 1 << 30 });
  const lines = (args: string[]) => git(args).toString('utf8').split('\n').filter(Boolean);
  // every change type (A C D M R T U X B): all touched paths, both sides of a rename/copy
  const changes = lines(['diff', '--cached', '--name-status', '--no-renames']);
  const touched = [...new Set(changes.flatMap(l => l.split('\t').slice(1)))].sort();
  const inIndex = new Set(lines(['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=ACMRT']));
  const staged = touched;
  const failures: string[] = [];
  for (const p of disallowed(touched)) failures.push(`not allowlisted: ${p} (${changes.find(l => l.split('\t').slice(1).includes(p))?.split('\t')[0]})`);
  const blob = new Map<string, Buffer>();
  for (const p of touched.filter(x => inIndex.has(x))) {
    const b = git(['show', `:${p}`]); blob.set(p, b);
    const wt = join(repo, p);
    if (!existsSync(wt) || !readFileSync(wt).equals(b)) failures.push(`working tree differs from staged blob: ${p}`);
  }
  if (staged.some(isRealFixtureException)) {
    const build = join(repo, EXCEPTION_DIR, 'build.ts');
    let produced: string[] = [];
    try {
      execFileSync('node', [build, '--check'], { cwd: repo, encoding: 'utf8' });
      produced = execFileSync('node', [build, '--list'], { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean).map(f => `${EXCEPTION_DIR}/${f}`);
    } catch { failures.push(`real-fixture exception does not regenerate byte-identically: ${EXCEPTION_DIR}`); }
    const tracked = new Set([...lines(['ls-files', '--', EXCEPTION_DIR]), ...staged.filter(isRealFixtureException)]);
    const allowedSet = new Set([...produced, `${EXCEPTION_DIR}/build.ts`, `${EXCEPTION_DIR}/README.md`]);
    for (const p of tracked) if (produced.length && !allowedSet.has(p)) failures.push(`file not produced by build.ts in exception folder: ${p}`);
  }
  if (cohortText) {
    const ref = new Set<string>();
    for (const line of readFileSync(cohortText, 'utf8').split('\n')) if (line.trim()) for (const w of windowsOf(JSON.parse(line).text)) ref.add(w);
    for (const [p, b] of blob) {
      if (b.includes(0)) continue;                            // binary: not text
      const hit = sharedWindow(b.toString('utf8'), ref);
      if (hit) failures.push(`cohort text in ${p}: ${JSON.stringify(hit)}`);
    }
  }
  return { staged, failures };
}

function main() {
  const flag = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const r = check(flag('repo') ?? '.', flag('cohort-text'));
  for (const f of r.failures) console.log(`FAIL ${f}`);
  console.log(`publish-check: ${r.staged.length} staged file(s), ${r.failures.length} failure(s)`);
  if (r.failures.length) process.exit(1);
}
if (import.meta.url === `file://${process.argv[1]}`) main();
