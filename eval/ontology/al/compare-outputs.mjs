// Fail-closed comparison of stats-al.json (stats-al.ts) and recheck-al.json (recheck_al.py): every key of each must exist in the
// other; floats agree to 1e-9; p-values (any key under `p`, and p_H13), verdicts and nulls exactly. Exit 1 on any difference.
//   node eval/ontology/al/compare-outputs.mjs <a.json> <b.json>
import { readFileSync } from 'node:fs';
const [a, b] = process.argv.slice(2).map(f => JSON.parse(readFileSync(f, 'utf8')));
const out = [];
(function cmp(x, y, path) {
  const exact = /^\.p(\.|$)|^\.p_H13$|^\.verdict$/.test(path);
  if (typeof x === 'number' && typeof y === 'number') { if (exact ? x !== y : Math.abs(x - y) > 1e-9) out.push(`${path}: ${x} vs ${y}`); return; }
  if (x === null || y === null || typeof x !== 'object' || typeof y !== 'object') { if (x !== y) out.push(`${path}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`); return; }
  const kx = Object.keys(x), ky = Object.keys(y);
  for (const k of ky) if (!kx.includes(k)) out.push(`${path}.${k}: only in the second file`);
  for (const k of kx) { if (!ky.includes(k)) { out.push(`${path}.${k}: only in the first file`); continue; } cmp(x[k], y[k], `${path}.${k}`); }
})(a, b, '');
if (out.length) { console.error(`stats-al and recheck-al DISAGREE:\n${out.slice(0, 30).join('\n')}`); process.exit(1); }
console.log('stats-al and recheck-al agree on every key');
