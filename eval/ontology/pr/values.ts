// P1 (plan § Values; PR_SPEC § Values). Shared value extraction for every arm: whole values (STATS_SPEC_V2 values()) plus
// recognised substrings (e-mail / IBAN / URL-domain), then the qualifying filter (UTF-16 length ≥ 4, not in task, present in ≥1
// low_authority entry). Ordering (PR_SPEC): distinct (key, value, route) triples, keys JS-sorted, whole values before substrings,
// then values()/scan order; substrings are scanned per whole string value in the order party → account → resource.
import { values } from '../v2/typing.ts';

export type Route = 'whole' | 'party' | 'account' | 'resource';
export interface QualifyingValue { key: string; value: string; route: Route; sources: number[] }
export interface Obs { obs_id: string; task: string | null; action: { args: Record<string, unknown> }; low_authority: Array<{ ref: string; text: string }> }

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IBAN = /\b[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}\b/g;
const DOMAIN = /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:com|org|net|io|ai|co|edu|gov|info|biz|app|dev|me|us|uk|de|fr|ch|eu|ru|cn)\b(?:\/[^\s"'<>)\]]*)?/gi;

interface Sub { start: number; end: number; text: string }
function scan(re: RegExp, s: string): Sub[] {
  const out: Sub[] = [];
  re.lastIndex = 0;
  for (let m; (m = re.exec(s));) out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  return out;
}

export function qualifying(obs: Obs): QualifyingValue[] {
  const task = obs.task ?? '';
  const low = obs.low_authority ?? [];
  const sourcesOf = (v: string) => low.map((_, i) => i).filter(i => low[i].text.includes(v));
  const out: QualifyingValue[] = [];
  const seen = new Set<string>();
  const add = (key: string, value: string, route: Route) => {
    if (value.length < 4) return;                       // UTF-16 length ≥ 4
    if (task.includes(value)) return;                   // not a substring of the (sanitized) task
    const k = `${key}\u0000${value}\u0000${route}`;
    if (seen.has(k)) return;
    const src = sourcesOf(value);
    if (!src.length) return;                            // must occur in ≥1 earlier tool output
    seen.add(k);
    out.push({ key, value, route, sources: src });
  };
  for (const key of Object.keys(obs.action.args ?? {}).sort()) {
    const whole = values(obs.action.args[key]);
    for (const v of whole) add(key, v, 'whole');
    // recognised substrings, per whole string value in order party → account → resource
    for (const v of whole) {
      const party = scan(EMAIL, v);
      const account = scan(IBAN, v);
      const resource = scan(DOMAIN, v).filter(d => !party.some(p => d.start < p.end && p.start < d.end))  // drop e-mail overlaps
        .map(d => ({ ...d, text: d.text.replace(/[.,;:!?]+$/, '') }))                                       // strip trailing punctuation
        .filter(d => d.text.length > 0);
      for (const p of party) add(key, p.text, 'party');
      for (const a of account) add(key, a.text, 'account');
      for (const r of resource) add(key, r.text, 'resource');
    }
  }
  return out;
}
