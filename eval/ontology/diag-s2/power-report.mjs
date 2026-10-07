// power-report.mjs — prints the P-HC1 (default) or P-HC1b (endpoint) report tables straight from the JSON.
//   node eval/ontology/diag-s2/power-report.mjs [path]   (default runs/onto-c-power/power-hc1.json)
import { readFileSync } from 'node:fs';
const p = process.argv[2] ?? 'runs/onto-c-power/power-hc1.json';
const d = JSON.parse(readFileSync(p, 'utf8'));
const pts = x => (x == null ? '—' : (100 * x).toFixed(2));
const f3 = x => (x == null ? '—' : Number(x).toFixed(3));
const sim = () => console.log(`sim: N=${d.sim.N} R=${d.sim.R} seed=${d.sim.seed}; grid K=${JSON.stringify(d.grid.K)} U=${JSON.stringify(d.grid.U)} J=${JSON.stringify(d.grid.J)}`);
if (d.precision_margin === undefined) {
  console.log(`endpoint: ${d.endpoint}; alpha=${d.alpha}; recall_margin=${d.recall_margin}`);
  sim();
  for (const key of ['S2', 'S1']) {
    const pool = d.pools[key];
    if (!pool) continue;
    const o = pool.observed;
    console.log(`\n## ${key}\n`);
    console.log(`observed: runs=${o.runs} positives=${o.positives} precision ${f3(o.precision_v2)}→${f3(o.precision_v3)} (${pts(o.precision_diff)} pts) recall ${f3(o.recall_v2)}→${f3(o.recall_v3)} (${pts(o.recall_diff)} pts)`);
    console.log(`fit SE = ${Number(pool.fit.a).toFixed(4)} / sqrt(n_user_clusters), R^2 = ${Number(pool.fit.r2).toFixed(4)}`);
    console.log('\n| K | U | J | repeats | exp runs | exp pos | mean diff pts | outer SD pts | power | MC SE | prec-only | MC SE | valid/inc/undef |');
    console.log('|---|---|---|:---:|---:|---:|---:|---:|---:|---:|---:|---:|---|');
    for (const r of pool.designs) console.log(`| ${r.K} | ${r.U} | ${r.J} | ${r.repeats_tasks ? 'yes' : 'no'} | ${Math.round(r.expected_runs)} | ${Math.round(r.expected_positives)} | ${pts(r.mean_precision_diff)} | ${pts(r.outer_sd)} | ${f3(r.power)} | ${f3(r.power_mc_se)} | ${f3(r.power_precision_only)} | ${f3(r.power_precision_mc_se)} | ${r.n_valid}/${r.n_inconclusive}/${r.n_undefined} |`);
    console.log('\n| K | U | J | se_fit pts | power δ=2 | power δ=4 | power δ=6 |');
    console.log('|---|---|---:|---:|---:|---:|---:|');
    for (const a of pool.analytic) console.log(`| ${a.K} | ${a.U} | ${a.J} | ${pts(a.se_fit)} | ${f3(a.power_delta_2)} | ${f3(a.power_delta_4)} | ${f3(a.power_delta_6)} |`);
  }
} else {
  console.log(`endpoint: ${d.endpoint}`);
  console.log(`alpha=${d.alpha}; recall_margin=${d.recall_margin}; precision_margin=${d.precision_margin}; recall_ref=${d.recall_ref}`);
  sim();
  for (const key of ['S2', 'S1']) {
    const pool = d.pools[key];
    if (!pool) continue;
    const o = pool.observed;
    console.log(`\n## ${key}\n`);
    console.log(`observed: runs=${o.runs} positives=${o.positives} precision ${f3(o.precision_v2)}→${f3(o.precision_v3)} (${pts(o.precision_diff)} pts) recall V3=${f3(o.recall_v3)} vs ${d.recall_ref}=${f3(o.recall_ref)} (${pts(o.recall_diff)} pts)`);
    console.log(`fit SE = ${Number(pool.fit.a).toFixed(4)} / sqrt(n_user_clusters), R^2 = ${Number(pool.fit.r2).toFixed(4)}`);
    console.log(`\n| K | U | J | repeats | exp runs | exp pos | mean prec pts | mean recall pts | outer SD pts | power joint | MC SE | prec-only | MC SE | recall-only m=${d.recall_margin} | MC SE | valid/inc/undef |`);
    console.log('|---|---|---|:---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|');
    for (const r of pool.designs) console.log(`| ${r.K} | ${r.U} | ${r.J} | ${r.repeats_tasks ? 'yes' : 'no'} | ${Math.round(r.expected_runs)} | ${Math.round(r.expected_positives)} | ${pts(r.mean_precision_diff)} | ${pts(r.mean_recall_diff)} | ${pts(r.outer_sd)} | ${f3(r.power_joint)} | ${f3(r.power_joint_mc_se)} | ${f3(r.power_precision_only)} | ${f3(r.power_precision_mc_se)} | ${f3(r.power_recall_guard_only)} | ${f3(r.power_recall_guard_mc_se)} | ${r.n_valid}/${r.n_inconclusive}/${r.n_undefined} |`);
  }
}
