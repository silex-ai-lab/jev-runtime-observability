// Acceptance for the W1c §9.6 runtime audit: fixed-segment-only overlap is waived, but a waiver is per OCCURRENCE — a
// same-text or cross-record non-waived copy on either side makes the window fail. Crossing windows and template
// wording copied outside a span also fail.
//   node eval/kev-onto/fixtures/w1c/runtime-audit.test.ts
import { fixedSegments, templateSpans, runtimeAudit, auditNorm } from '../../runtime-audit.ts';

let fails = 0;
const ok = (name: string, cond: boolean, info: unknown = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name} ${info === '' ? '' : JSON.stringify(info)}`); if (!cond) fails++; };

const S1 = 'ALPHAFIXEDSEGMENT000000000000000000000000000000';
const S2 = 'BETAFIXEDSEGMENT111111111111111111111111111111';
const S3 = 'GAMMAFIXEDSEGMENT222222222222222222222222222222';
const TEMPLATE = `${S1} {goal} ${S2} {user} ${S3}`;
const fill = (goal: string, user: string) => `${S1} ${goal} ${S2} ${user} ${S3}`;
const segs = fixedSegments(TEMPLATE);
ok('three fixed segments', segs.length === 3, segs.map(s => s.trim().slice(0, 6)));

// 1. A fixed-segment-only overlap is waived on both sides.
const train1 = `T${fill('AAAA', 'CCCC')}`, cohort1 = `C${fill('BBBB', 'DDDD')}`;
ok('both-sides fixed overlap is waived', runtimeAudit([train1], [cohort1], TEMPLATE).failures.length === 0, runtimeAudit([train1], [cohort1], TEMPLATE));

// 2. Same text, one non-waived copy on the training side -> fail (a valid span must not hide an outside copy).
const train2 = `T${fill('AAAA', 'CCCC')} ${S2}`;
const r2 = runtimeAudit([train2], [cohort1], TEMPLATE);
ok('same-text non-waived training copy fails', r2.failures.some(w => S2.includes(w)), r2.failures.slice(0, 1));

// 3. Cross-record: the non-waived copy is in a second training record -> fail.
const r3 = runtimeAudit([`T${fill('AAAA', 'CCCC')}`, S2], [cohort1], TEMPLATE);
ok('cross-record non-waived training copy fails', r3.failures.some(w => S2.includes(w)), r3.failures.slice(0, 1));

// 4. Cross-record on the cohort side -> fail.
const r4 = runtimeAudit([train1], [`C${fill('BBBB', 'DDDD')}`, S2], TEMPLATE);
ok('cross-record non-waived cohort copy fails', r4.failures.some(w => S2.includes(w)), r4.failures.slice(0, 1));

// 5. One side not in a span at all -> fail.
ok('one-side-only fixed text is not waived', runtimeAudit([`T${fill('AAAA', 'CCCC')}`], [`plain ${S2} end`], TEMPLATE).failures.length > 0);

// 6. A window crossing from the template into the goal fails.
const r6 = runtimeAudit([fill('SHARED_GOAL_VALUE', 'USER_ONE')], [fill('SHARED_GOAL_VALUE', 'USER_TWO')], TEMPLATE);
ok('a window crossing into the goal fails', r6.failures.some(w => w.includes('SHARED_GOAL_VALUE')), r6.failures.slice(0, 1));

// 7. Template wording copied into task content outside a span fails.
ok('copied template wording outside a span fails', runtimeAudit([`task content ${S2} more text`], [fill('GOAL_ONE', 'USER_ONE')], TEMPLATE).failures.length > 0);

ok('exactly one span in the filled template', templateSpans(auditNorm(fill('g', 'u')), segs).length === 1);
ok('no span in a plain segment', templateSpans(auditNorm(`x ${S2} y`), segs).length === 0);

console.log(fails ? `runtime-audit tests: ${fails} FAIL` : 'runtime-audit tests: PASS');
if (fails) process.exit(1);
