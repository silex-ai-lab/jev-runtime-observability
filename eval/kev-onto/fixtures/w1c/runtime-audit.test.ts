// Acceptance for the W1c §9.6 runtime audit: fixed-segment-only overlap is waived; one-side-only and crossing windows
// fail; template wording copied outside a span fails.
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

// 1. A fixed-segment-only overlap is waived (both sides recognize a span; placeholder values and the surrounding
// characters differ, so only fixed-segment windows are shared).
const train1 = `T${fill('AAAA', 'CCCC')}`;
const cohort1 = `C${fill('BBBB', 'DDDD')}`;
ok('both-sides fixed overlap is waived', runtimeAudit([train1], [cohort1], TEMPLATE).failures.length === 0, runtimeAudit([train1], [cohort1], TEMPLATE));

// 2. One side not in a span -> not waived.
const train2 = `intro ${fill('GOAL_ONE', 'USER_ONE')} outro`;
const cohort2 = `plain ${S2} end`;   // no full template: no span recognized
const r2 = runtimeAudit([train2], [cohort2], TEMPLATE);
ok('one-side-only fixed text is not waived', r2.failures.length > 0, r2.failures.slice(0, 1));

// 3. A window crossing from the template into the goal fails.
const train3 = fill('SHARED_GOAL_VALUE', 'USER_ONE');
const cohort3 = fill('SHARED_GOAL_VALUE', 'USER_TWO');
const r3 = runtimeAudit([train3], [cohort3], TEMPLATE);
ok('a window crossing into the goal fails', r3.failures.some(w => w.includes('SHARED_GOAL_VALUE')), r3.failures.slice(0, 1));

// 4. Template wording copied into task content outside a span fails (even if the cohort has it in a span).
const train4 = `task content ${S2} more text`;
const cohort4 = fill('GOAL_ONE', 'USER_ONE');
ok('copied template wording outside a span fails', runtimeAudit([train4], [cohort4], TEMPLATE).failures.length > 0);

// span recognition sanity: the filled template contains exactly one span, the plain segment none.
ok('exactly one span in the filled template', templateSpans(auditNorm(fill('g', 'u')), segs).length === 1);
ok('no span in a plain segment', templateSpans(auditNorm(`x ${S2} y`), segs).length === 0);

console.log(fails ? `runtime-audit tests: ${fails} FAIL` : 'runtime-audit tests: PASS');
if (fails) process.exit(1);
