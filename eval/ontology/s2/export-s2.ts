// Card data for the Runtime Observation page from the verified S2 output (stats-s2.json ≡ recheck-s2.json).
//   node eval/ontology/s2/export-s2.ts --out ../silex-mockup/data/onto-s2.json
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
const IN = 'runs/onto-s2-stats/stats-s2.json';
const raw = readFileSync(IN), s = JSON.parse(raw.toString('utf8'));
const out = process.argv[process.argv.indexOf('--out') + 1];
// Fail closed: the two independent implementations must agree on every key before any card data is written.
execFileSync('node', ['eval/ontology/s1/compare-outputs.mjs', IN, 'runs/onto-s2-stats/recheck-s2.json'], { stdio: 'inherit' });
const strip = (x: { F: number; TP: number; Pos: number; precision: number | null; recall: number | null }) => ({ F: x.F, TP: x.TP, Pos: x.Pos, precision: x.precision, recall: x.recall });
const bb = s.secondary.b_prov_bound, x1 = s.secondary.x1.pooled, le = s.secondary.label_errors;
const data = {
  version: 1, source: `jev-runtime-observability ${IN} (equal on every key to recheck-s2.json)`,
  benchmark: 'AgentDyn', suites: ['dailylife', 'github', 'shopping'], pool: 'P',
  counts: s.counts, observed: { prov: strip(s.observed.prov), s1: strip(s.observed.s1) },
  constraint: s.constraint, margin: 0.03, rand_precision_mean: s.rand_precision_mean, p: s.p, ci: s.ci, p_H15: s.p_H15, verdict: s.verdict, failed: s.failed,
  per_base: Object.fromEntries(Object.entries(s.secondary.per_base).map(([k, v]: [string, any]) => [k, { prov: strip(v.prov), s1: strip(v.s1) }])),
  b_prov_bound: { prov: strip(bb.prov), p_a: bb.p_a },
  x1_pooled: { prov: strip(x1.prov), s1: strip(x1.s1) },
  label_errors: { total: le.total, per_pool: le.per_pool },
};
const text = JSON.stringify(data, null, 1) + '\n';
writeFileSync(out, text);
writeFileSync(out.replace(/\.json$/, '.SOURCE.json'), JSON.stringify({ generated_from: `jev-runtime-observability ${IN}`,
  jev_commit: execSync('git rev-parse --short HEAD').toString().trim(), stats_sha256: createHash('sha256').update(raw).digest('hex'),
  sha256: createHash('sha256').update(text).digest('hex') }, null, 1) + '\n');
