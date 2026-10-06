// W1c runtime audit (KO_SPEC v3 §9.6; plan §15.3): after F1, fail-only. Each side is sanitized then whitespace-
// collapsed; the pinned important_instructions template is normalized the same way and split at its placeholders into
// fixed segments. A 32-character window of shared text is waived ONLY if it lies wholly inside one fixed segment of a
// recognized template span on BOTH sides; any other shared window fails and invalidates the evaluation.
//   node eval/kev-onto/runtime-audit.ts --template-file <text> --train <jsonl> --cohort <jsonl>
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { W1C } from './contract.ts';
import { sanitizeString } from '../ontology/pr/sanitize.ts';

export const auditNorm = (s: string): string => sanitizeString(s).replace(/\s+/g, ' ');
const ESC = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The fixed segments of a template: the text between its `{placeholder}` markers, after normalization. */
export function fixedSegments(template: string): string[] {
  return auditNorm(template).split(/\{[a-z_]+\}/g).filter(s => s.length > 0);
}
export interface Span { start: number; end: number }       // a recognized template occurrence [start, end)
/** Ranges of the fixed segments inside each recognized template span of `text`. */
export function templateSpans(text: string, segments: string[]): Span[][] {
  if (!segments.length) return [];
  const re = new RegExp(segments.map(ESC).join('(.*?)'), 'gs');
  const out: Span[][] = [];
  for (const m of text.matchAll(re)) {
    const ranges: Span[] = [];
    let cursor = m.index!;
    for (const seg of segments) { const j = text.indexOf(seg, cursor); if (j < 0) { cursor = -1; break; } ranges.push({ start: j, end: j + seg.length }); cursor = j + seg.length; }
    if (cursor >= 0) out.push(ranges);
  }
  return out;
}
/** True iff the window [i, i+window) lies wholly inside one fixed segment of some recognized span. */
export function waived(text: string, spans: Span[][], i: number, window = W1C.window): boolean {
  return spans.some(ranges => ranges.some(r => r.start <= i && i + window <= r.end));
}
/** Per side, the set of window values that occur at least once as a waived window. */
export function waivedWindows(text: string, segments: string[]): Set<string> {
  const spans = templateSpans(text, segments), out = new Set<string>();
  for (let i = 0; i + W1C.window <= text.length; i++) if (waived(text, spans, i)) out.add(text.slice(i, i + W1C.window));
  return out;
}
export function windowSet(text: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + W1C.window <= text.length; i++) out.add(text.slice(i, i + W1C.window));
  return out;
}
export interface AuditResult { failures: string[]; shared: number; waived: number }
/** Fail-only: a shared window fails unless it is waived on both sides. */
export function runtimeAudit(trainTexts: string[], cohortTexts: string[], template: string): AuditResult {
  const segments = fixedSegments(template);
  const cohort = new Map<string, boolean>();               // window -> waived on at least one cohort occurrence
  for (const raw of cohortTexts) { const t = auditNorm(raw); const wa = waivedWindows(t, segments);
    for (const w of windowSet(t)) cohort.set(w, (cohort.get(w) ?? false) || wa.has(w)); }
  const failures: string[] = []; let shared = 0, waivedCount = 0;
  for (const raw of trainTexts) {
    const t = auditNorm(raw); const wa = waivedWindows(t, segments);
    for (const w of windowSet(t)) {
      if (!cohort.has(w)) continue;
      shared++;
      if (wa.has(w) && cohort.get(w)) waivedCount++; else failures.push(w);
    }
  }
  return { failures: [...new Set(failures)], shared, waived: waivedCount };
}

function flag(k: string): string | undefined { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; }
if (process.argv[1] != null && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const template = readFileSync(flag('template-file')!, 'utf8');
  const read = (p: string): string[] => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).state);
  const res = runtimeAudit(read(flag('train')!), read(flag('cohort')!), template);
  console.log(JSON.stringify({ shared: res.shared, waived: res.waived, failures: res.failures.length, example: res.failures.slice(0, 3) }, null, 1));
  if (res.failures.length) process.exit(1);
}
