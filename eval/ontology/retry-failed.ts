// Failed-call procedure (plan § Statistics): eval/run/run.ts marks every recorded item as done, failures included.
// This removes rows whose status is not exactly ok (or that carry no probability) from one predictions file so the next run.ts pass retries them.
// Arm-blind: the caller applies it to every arm file alike. At most 3 passes per file (counter in <file>.retries).
//   node eval/ontology/retry-failed.ts runs/onto-e5-kev-0.8b-ft/predictions-A1.jsonl
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
if (!file || !existsSync(file)) throw new Error('usage: retry-failed.ts <predictions.jsonl>');
const counter = `${file}.retries`;
const passes = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
const failedItems = new Set(lines.map(l => JSON.parse(l)).filter(r => r.status !== 'ok' || typeof r.signal?.raw_probability !== 'number').map(r => r.item_id));
if (!failedItems.size) { console.log(`${file}: no failed items`); process.exit(0); }
if (passes >= 3) { console.log(`${file}: ${failedItems.size} items still failing after 3 retries; they are dropped from all arms by stats.ts`); process.exit(0); }
// Drop every row of a failed item (all its questions), so run.ts re-asks the item as a whole.
writeFileSync(file, lines.filter(l => !failedItems.has(JSON.parse(l).item_id)).join('\n') + (lines.length ? '\n' : ''));
writeFileSync(counter, String(passes + 1));
console.log(`${file}: removed ${failedItems.size} failed items for retry pass ${passes + 1}`);
