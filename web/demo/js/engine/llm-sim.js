// Simulated slow path (T1): a single-thread LLM judge for escalation rationale
// (R p.13). Latency follows gpt-4o-mini's measured judge round trips (GPT4O_MINI_RTT_QUANTILES_MS);
// the verdict and rationale stay simulated. No cost is sourced, so none is reported.

import { LLM_SIM_VERSION, GPT4O_MINI_RTT_QUANTILES_MS as Q } from './types.js';
import { rngFor } from './rng.js';

const FEATURE_ORDER = [
  'payee_similarity', 'amount_ratio', 'injection_marker_score', 'domain_allowed',
  'unsupported_claims', 'repeat_failures', 'tool_status_error',
];

function summarize(features) {
  const parts = [];
  for (const k of FEATURE_ORDER) {
    const v = features[k];
    if (v == null) continue;
    parts.push(`${k}=${typeof v === 'number' ? Math.round(v * 1000) / 1000 : v}`);
  }
  return parts.length ? parts.join(', ') : 'no notable features';
}

export function judgeSlow(safeView, { seed, spanId, reason }) {
  const r = rngFor(seed, spanId, 'llm');
  // One uniform draw, as before, mapped through the measured quantiles (linear between knots).
  const x = r.uniform(0, Q.length - 1), i = Math.min(Q.length - 2, Math.floor(x));
  const latency_ms = Math.round(Q[i] + (Q[i + 1] - Q[i]) * (x - i));
  const tokens_in = Math.ceil(JSON.stringify(safeView).length / 4);
  const tokens_out = Math.round(r.uniform(60, 180));
  return {
    judge: LLM_SIM_VERSION,
    async: true,
    latency_ms,
    verdict: 'REVIEW',
    rationale: `Simulated rationale: ${summarize(safeView.features)}`,
    reason: reason ?? null,
    tokens_in,
    tokens_out,
  };
}
