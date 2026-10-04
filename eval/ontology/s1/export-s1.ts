// Card data for the Runtime Observation page from the verified stage-1 output (stats-s1.json ≡ recheck-s1.json).
//   node eval/ontology/s1/export-s1.ts --out ../silex-mockup/data/onto-s1.json
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
const IN = 'runs/onto-s1-stats/stats-s1.json';
const raw = readFileSync(IN), s = JSON.parse(raw.toString('utf8'));
const out = process.argv[process.argv.indexOf('--out') + 1];
const strip = (x: { F: number; TP: number; Pos: number; precision: number | null; recall: number | null }) => ({ F: x.F, TP: x.TP, Pos: x.Pos, precision: x.precision, recall: x.recall });
const data = {
  version: 1, source: `jev-runtime-observability ${IN} (equal on every key to recheck-s1.json)`,
  counts: s.counts, observed: { prov: strip(s.observed.prov), s1: strip(s.observed.s1) },
  constraint: s.constraint, margin: 0.03, rand_precision_mean: s.rand_precision_mean, p: s.p, ci: s.ci, p_H15: s.p_H15, verdict: s.verdict, failed: s.failed,
  per_base: Object.fromEntries(Object.entries(s.secondary.per_base).map(([k, v]: [string, any]) => [k, { prov: strip(v.prov), s1: strip(v.s1) }])),
  groups: Object.fromEntries(Object.entries(s.secondary.groups).map(([k, v]: [string, any]) => [k, { prov: strip(v.prov), s1: strip(v.s1) }])),
};
const text = JSON.stringify(data, null, 1) + '\n';
writeFileSync(out, text);
writeFileSync(out.replace(/\.json$/, '.SOURCE.json'), JSON.stringify({ generated_from: `jev-runtime-observability ${IN}`,
  jev_commit: execSync('git rev-parse --short HEAD').toString().trim(), stats_sha256: createHash('sha256').update(raw).digest('hex'),
  sha256: createHash('sha256').update(text).digest('hex') }, null, 1) + '\n');
