// Fail-closed comparison of pilot.json (pilot.ts) and recheck.json (recheck_pilot.py), PILOT_SPEC §7: every key of each
// must exist in the other; integers and nulls exactly; other numbers to 1e-12. Exit 1 on any difference.
//   node eval/ontology/c-pilot/compare-pilot.mjs <a.json> <b.json>
import { readFileSync } from 'node:fs';
const [a, b] = process.argv.slice(2).map(f => JSON.parse(readFileSync(f, 'utf8')));
const out = [];
(function cmp(x, y, path) {
  if (typeof x === 'number' && typeof y === 'number') {
    const exact = Number.isInteger(x) && Number.isInteger(y);
    if (exact ? x !== y : Math.abs(x - y) > 1e-12) out.push(`${path}: ${x} vs ${y}`);
    return;
  }
  if (x === null || y === null || typeof x !== 'object' || typeof y !== 'object') { if (x !== y) out.push(`${path}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`); return; }
  if (Array.isArray(x) !== Array.isArray(y)) { out.push(`${path}: array vs object`); return; }
  const kx = Object.keys(x), ky = Object.keys(y);
  for (const k of ky) if (!kx.includes(k)) out.push(`${path}.${k}: only in the second file`);
  for (const k of kx) { if (!ky.includes(k)) { out.push(`${path}.${k}: only in the first file`); continue; } cmp(x[k], y[k], `${path}.${k}`); }
})(a, b, '');
if (out.length) { console.error(`pilot and recheck DISAGREE (${out.length}):\n${out.slice(0, 30).join('\n')}`); process.exit(1); }
console.log('pilot and recheck agree');
