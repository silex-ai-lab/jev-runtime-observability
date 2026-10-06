// CG0 evidence for KO_SPEC §4.4: imperative-lexicon yield on each rule-2 source pool (counts only; prints no text).
//   node eval/kev-onto/lexicon-yield.ts      (needs eval/sources/raw from `node eval/sources/fetch.ts`)
import { readFileSync } from 'node:fs';
import { IMPERATIVE_LEXICON, INJECAGENT_BENIGN_FILLER } from './contract.ts';

const R = 'eval/sources/raw';
export const LEXICON_RE = new RegExp('\\b(?:' + IMPERATIVE_LEXICON.map(w => w.replace(/ /g, '\\s+')).join('|') + ')\\b', 'i');
export const lexiconHit = (passage: string) => LEXICON_RE.test(passage.split(INJECAGENT_BENIGN_FILLER).join(' '));
const VALUE = [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, /\b[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}\b/,
  /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:com|org|net|io|ai|co|edu|gov|info|biz|app|dev|me|us|uk|de|fr|ch|eu|ru|cn)\b/i];
const hasValue = (s: string) => VALUE.some(r => { const m = s.match(r); return !!m && m[0].length >= 4; });

function row(name: string, passages: string[], hit: (p: string) => boolean) {
  const v = passages.filter(hasValue), m = v.filter(hit);
  console.log(`| ${name} | ${passages.length} | ${v.length} | ${m.length} | ${v.length - m.length} |`);
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const users = readFileSync(`${R}/injecagent/data/user_cases.jsonl`, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const filled = users.map((u: any) => String(u['Tool Response Template']).replace(/<Attacker Instruction>/g, INJECAGENT_BENIGN_FILLER));
  const tb = JSON.parse(readFileSync('eval/convert/fixtures/taubench.json', 'utf8'));
  const normal = readFileSync(`${R}/asb/data/all_normal_tools.jsonl`, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  console.log('| pool | size | with value | lexicon matched | kept |\n|---|---|---|---|---|');
  row('InjecAgent templates, filler removed', filled, lexiconHit);
  row('InjecAgent templates, filler not removed', filled, p => LEXICON_RE.test(p));
  row('τ-bench benign_record (e-mail/IBAN/domain)', [...tb.retail, ...tb.airline].map((t: any) => typeof t.benign_record === 'string' ? t.benign_record : JSON.stringify(t.benign_record ?? '')), lexiconHit);
  row('ASB normal Description', normal.map((n: any) => String(n.Description ?? '')), lexiconHit);
}
