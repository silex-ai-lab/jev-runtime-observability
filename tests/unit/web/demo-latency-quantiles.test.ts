// The demo's measured latency tables (web/demo/js/engine/types.js) must equal the quantiles of the committed
// round trips in runs/latency-2026-10-04: one value per item, nearest-rank, as eval/run/latency-json.ts computes them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// @ts-expect-error browser modules without declaration files
import { KEV_RTT_QUANTILES_MS, GPT4O_MINI_RTT_QUANTILES_MS, LATENCY_BUDGET } from '../../../web/demo/js/engine/types.js';

function series(label: string): number[] {
  const byItem = new Map<string, any>();
  for (const l of readFileSync(new URL(`../../../runs/latency-2026-10-04/predictions-${label}.jsonl`, import.meta.url), 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(l); if (!byItem.has(r.item_id)) byItem.set(r.item_id, r);
  }
  return [...byItem.values()].filter(r => r.status === 'ok').map(r => Math.round(r.rtt_ms)).sort((a, b) => a - b);
}
const q = (s: number[], p: number) => (p === 0 ? s[0] : s[Math.max(0, Math.ceil(p * s.length) - 1)]);
const twentieths = (s: number[]) => Array.from({ length: 20 }, (_, i) => q(s, i / 20));

test('Kev table: p0..p95 and p98 of the measured Kev-0.8B-ft round trips; top stays under the 400 ms deadline', () => {
  const s = series('kev-0.8b-ft');
  assert.deepEqual([...KEV_RTT_QUANTILES_MS], [...twentieths(s), q(s, 0.98)]);
  assert.ok(KEV_RTT_QUANTILES_MS.at(-1) < 400);
  assert.deepEqual([...LATENCY_BUDGET.jev], [KEV_RTT_QUANTILES_MS[0], KEV_RTT_QUANTILES_MS.at(-1)]);
});
test('gpt-4o-mini table: p0..p100 of the measured round trips', () => {
  const s = series('gpt-4o-mini');
  assert.deepEqual([...GPT4O_MINI_RTT_QUANTILES_MS], [...twentieths(s), q(s, 1)]);
  assert.deepEqual([...LATENCY_BUDGET.llm], [GPT4O_MINI_RTT_QUANTILES_MS[0], GPT4O_MINI_RTT_QUANTILES_MS.at(-1)]);
});
