// Publication guard for wave 1 (KO_SPEC §7). Fails if a file to be committed under eval/kev-onto/ or runs/kev-onto/ is
// outside PUBLISH_ALLOW, and, when --cohort-text is given (only after F1), if any committed text file shares a
// LEAK_WINDOW-character window with cohort task / tool-output text.
//   node eval/kev-onto/publish-check.ts                       # staged + tracked files under the two roots
//   node eval/kev-onto/publish-check.ts --cohort-text <file>  # also the window check; <file> = JSONL of {text}
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { COMMON_WORDS, LEAK_WINDOW, PUBLISH_ALLOW, PUBLISH_REAL_FIXTURE_EXCEPTION } from './contract.ts';

const ROOTS = ['eval/kev-onto/', 'runs/kev-onto/'];

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += glob[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '{') { const end = glob.indexOf('}', i); re += '(?:' + glob.slice(i + 1, end).split(',').map(esc).join('|') + ')'; i = end; }
    else re += esc(c);
  }
  return new RegExp('^' + re + '$');
}
function esc(s: string): string { return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'); }

const ALLOW = PUBLISH_ALLOW.map(globToRegExp);
export const isAllowed = (path: string) => ALLOW.some(r => r.test(path));
export const isRealFixtureException = (path: string) => globToRegExp(PUBLISH_REAL_FIXTURE_EXCEPTION).test(path);

/** Paths under the two roots that are not allowlisted. */
export function disallowed(paths: string[]): string[] {
  return paths.filter(p => ROOTS.some(r => p.startsWith(r)) && !isAllowed(p));
}

const COMMON = new Set<string>(COMMON_WORDS);
const norm = (s: string) => s.replace(/\s+/g, ' ');
/** True when a window is only common words and spaces (KO_SPEC §4.3 rule 5), so it is not evidence of a leak. */
export function benignWindow(w: string): boolean {
  if (!/^[A-Za-z ]+$/.test(w)) return false;
  const words = w.trim().split(' ').filter(Boolean);
  // the first and last token may be cut mid-word; judge only whole interior words, and require at least one
  const inner = words.slice(w.startsWith(' ') ? 0 : 1, w.endsWith(' ') ? words.length : words.length - 1);
  return inner.length > 0 && inner.every(x => COMMON.has(x.toLowerCase()));
}
export function windowsOf(text: string, n = LEAK_WINDOW): Set<string> {
  const t = norm(text), out = new Set<string>();
  for (let i = 0; i + n <= t.length; i++) { const w = t.slice(i, i + n); if (!benignWindow(w)) out.add(w); }
  return out;
}
/** Returns the first shared non-benign window between `text` and the reference windows, or null. */
export function sharedWindow(text: string, ref: Set<string>, n = LEAK_WINDOW): string | null {
  const t = norm(text);
  for (let i = 0; i + n <= t.length; i++) { const w = t.slice(i, i + n); if (ref.has(w)) return w; }
  return null;
}

function gitFiles(): string[] {
  const run = (args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean);
  return [...new Set([...run(['ls-files', '--', ...ROOTS]), ...run(['diff', '--cached', '--name-only', '--', ...ROOTS])])].sort();
}

function main() {
  const files = gitFiles();
  const bad = disallowed(files);
  for (const p of bad) console.log(`FAIL not allowlisted: ${p}`);
  let leaks = 0;
  const ci = process.argv.indexOf('--cohort-text');
  if (ci > 0) {
    const ref = new Set<string>();
    for (const line of readFileSync(process.argv[ci + 1], 'utf8').split('\n')) if (line.trim()) for (const w of windowsOf(JSON.parse(line).text)) ref.add(w);
    for (const p of files) {
      if (!existsSync(p) || isRealFixtureException(p)) continue;
      const hit = sharedWindow(readFileSync(p, 'utf8'), ref);
      if (hit) { leaks++; console.log(`FAIL cohort text in ${p}: ${JSON.stringify(hit)}`); }
    }
  }
  console.log(`publish-check: ${files.length} file(s), ${bad.length} not allowlisted, ${leaks} leak(s)`);
  if (bad.length || leaks) process.exit(1);
}
if (import.meta.url === `file://${process.argv[1]}`) main();
