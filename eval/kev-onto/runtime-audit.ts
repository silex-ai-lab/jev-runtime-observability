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
/** Per side: for each window VALUE, whether EVERY occurrence of it is waived (a non-waived occurrence makes it false). */
export function windowStatus(text: string, segments: string[]): Map<string, boolean> {
  const spans = templateSpans(text, segments), out = new Map<string, boolean>();
  for (let i = 0; i + W1C.window <= text.length; i++) {
    const w = text.slice(i, i + W1C.window), wa = waived(text, spans, i);
    out.set(w, (out.get(w) ?? true) && wa);
  }
  return out;
}
export function windowSet(text: string): Set<string> { return new Set(windowStatus(text, []).keys()); }
export interface AuditResult { failures: string[]; shared: number; waived: number }
/** Fail-only, per OCCURRENCE: a shared window fails unless every occurrence of it on BOTH sides lies inside a fixed
 *  segment of a recognized span. A single non-waived copy (same text, or a copy outside a span) makes it fail. */
export function runtimeAudit(trainTexts: string[], cohortTexts: string[], template: string): AuditResult {
  const segments = fixedSegments(template);
  const merge = (texts: string[]): Map<string, boolean> => {
    const acc = new Map<string, boolean>();
    for (const raw of texts) for (const [w, allWaived] of windowStatus(auditNorm(raw), segments)) acc.set(w, (acc.get(w) ?? true) && allWaived);
    return acc;
  };
  const train = merge(trainTexts), cohort = merge(cohortTexts);
  const failures: string[] = []; let shared = 0, waivedCount = 0;
  for (const [w, trainWaived] of train) {
    if (!cohort.has(w)) continue;
    shared++;
    if (trainWaived && cohort.get(w)) waivedCount++; else failures.push(w);
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
