// Summarises judge HTTP round trips from prediction files (run.ts, run-openai.ts) into the JSON behind the
// Runtime Observation "judge latency" card. One value per item (questions of an item share one call).
// Percentiles are nearest-rank, as in the demo's KPI tiles.
//   node eval/run/latency-json.ts --out ../silex-mockup/data/judge-latency.json \
//        kev-0.8b-ft=runs/latency-2026-10-04/predictions-kev-0.8b-ft.jsonl gpt-4o-mini=runs/latency-2026-10-04/predictions-gpt-4o-mini.jsonl
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cpus } from 'node:os';

const argv = process.argv.slice(2);
const oi = argv.indexOf('--out');
const out = oi >= 0 ? argv[oi + 1] : null;
if (!out) throw new Error('--out is required');
const pairs = argv.filter((_, i) => i !== oi && i !== oi + 1).map(a => a.split('='));

const rank = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.max(0, Math.ceil(q * s.length) - 1)]; };
const r1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);
const BUDGET_MS = 400; // gate-mode judge budget (docs/GATE.md)

const judges = pairs.map(([label, path]) => {
  const byItem = new Map<string, Record<string, any>>();
  for (const l of readFileSync(path, 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(l); if (!byItem.has(r.item_id)) byItem.set(r.item_id, r); }
  const rows = [...byItem.values()];
  const ok = rows.filter(r => r.status === 'ok' && typeof r.rtt_ms === 'number');
  const rtt = ok.map(r => r.rtt_ms as number);
  const vendor = ok.map(r => r.vendor_ms).filter((x): x is number => typeof x === 'number');
  const meta = JSON.parse(readFileSync(join(dirname(path), `meta-${label}.json`), 'utf8'));
  return {
    label, judge_source: meta.judge_source, runtime: meta.served?.runtime ?? null, model_served: ok.find(r => r.model_served)?.model_served ?? null,
    started_at: meta.started_at, items: rows.length, ok: ok.length, failed: rows.length - ok.length,
    rtt_ms: { p50: r1(rank(rtt, 0.5)), p95: r1(rank(rtt, 0.95)), mean: r1(rtt.reduce((s, x) => s + x, 0) / rtt.length) },
    within_budget: { budget_ms: BUDGET_MS, share: rtt.filter(x => x <= BUDGET_MS).length / rtt.length },
    // Every successful call's round trip, in the order calls completed, for the card's real-time replay.
    rtt_series_ms: ok.map(r => Math.round(r.rtt_ms)),
    vendor_processing_ms: vendor.length ? { p50: r1(rank(vendor, 0.5)), p95: r1(rank(vendor, 0.95)), n: vendor.length } : null,
    source: path,
  };
});

writeFileSync(out, JSON.stringify({
  version: 1, generated_by: 'jev-runtime-observability eval/run/latency-json.ts', host: cpus()[0]?.model ?? null,
  method: 'Judge HTTP round trip per item, monotonic clock, request sent to full body read, last attempt; two concurrent workers; nearest-rank percentiles.',
  items_file: 'eval/splits/items.jsonl (calibration, dev and test splits)', judges,
}, null, 1) + '\n');
console.log(judges.map(j => `${j.label}: n=${j.ok}/${j.items} p50 ${j.rtt_ms.p50} ms p95 ${j.rtt_ms.p95} ms`).join('\n'));
