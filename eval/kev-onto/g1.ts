// T7 (KO_SPEC §4.6): gate G1. Pure and deterministic — no I/O. `hash8` is KO_SPEC §4.3 `h(x)`; folds are
// `h(group) % 5`; (a) is out-of-fold target encoding per feature; (b) is an L2 logistic model (mean log-loss + ½Σw²,
// λ = 1) fit by 50 Newton steps solved with Cholesky. Degenerate inputs are UNDEFINED, which counts as a fail.
import { createHash } from 'node:crypto';
import { G1 } from './contract.ts';

export const hash8 = (x: string): number => parseInt(createHash('sha256').update(Buffer.from(x, 'utf8')).digest('hex').slice(0, 8), 16);
export const foldOf = (group: string): number => hash8(group) % G1.folds;

// `pipeline` is a W1c (KO_SPEC v3 §9.7) addition. It is optional so v1/v2 records (which never set it) keep identical
// feature vocabularies and identical G1 outputs; when any record carries it, `pipeline` is a single feature in (a) and
// one-hot in (b), exactly like `source`/`family`.
export interface G1Record { group: string; source: string; family: string; impact: string; state: string; label: boolean; pipeline?: string }
export interface G1Result { question: string; status: 'pass' | 'fail' | 'undefined'; features: Record<string, number>; combined: number | null; n: number; positives: number }

/** AUROC with ties ½. All-equal scores -> 0.5; one class -> NaN (caller treats as degenerate). */
export function auroc(scores: number[], labels: boolean[]): number {
  const pos = scores.filter((_, i) => labels[i]), neg = scores.filter((_, i) => !labels[i]);
  if (!pos.length || !neg.length) return NaN;
  let concordant = 0;
  for (const p of pos) for (const n of neg) concordant += p > n ? 1 : p === n ? 0.5 : 0;
  return concordant / (pos.length * neg.length);
}

/** Type-7 quantile. */
export function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const idx = (sorted.length - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

const lengthOf = (r: G1Record): number => r.state.length;
const markersOf = (r: G1Record): boolean[] => G1.markers.map(m => r.state.includes(m));

/** Per-fold decile assignment from boundaries computed over the other four folds (ties to the lower decile). */
function deciles(records: G1Record[], k: number): (r: G1Record) => number {
  const train = records.filter(r => foldOf(r.group) !== k).map(lengthOf).sort((a, b) => a - b);
  const bounds = Array.from({ length: 9 }, (_, i) => quantile(train, (i + 1) / 10));
  return r => { let d = 0; while (d < 9 && lengthOf(r) > bounds[d]) d++; return d; };
}

/** One-hot with the training-fold vocabulary sorted plus a trailing `unseen` column. */
function oneHot(vocab: string[]): (v: string) => number[] {
  const index = new Map(vocab.map((v, i) => [v, i]));
  return v => { const vec = new Array(vocab.length + 1).fill(0); const i = index.get(v); vec[i ?? vocab.length] = 1; return vec; };
}

/** Solve A x = b for symmetric positive definite A by Cholesky; null if it fails. */
export function choleskySolve(A: number[][], b: number[]): number[] | null {
  const n = A.length, L = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = A[i][j];
    for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
    if (i === j) { if (!(s > 0)) return null; L[i][j] = Math.sqrt(s); } else L[i][j] = s / L[j][j];
  }
  const y = new Array(n).fill(0), x = new Array(n).fill(0);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i][k] * y[k]; y[i] = s / L[i][i]; }
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k]; x[i] = s / L[i][i]; }
  return x;
}

const sigmoid = (z: number): number => z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));

/** Fit logistic regression (intercept unpenalized, weights λ both in gradient and Hessian) on design X, labels y. */
function fitLogistic(X: number[][], y: boolean[], lambda: number): number[] {
  const n = X.length, d = X[0]?.length ?? 0;
  let w = new Array(d).fill(0);
  for (let iter = 0; iter < G1.newton_iters; iter++) {
    const g = new Array(d).fill(0);
    const H = Array.from({ length: d }, () => new Array(d).fill(0));
    for (let i = 0; i < n; i++) {
      const p = sigmoid(X[i].reduce((s, v, j) => s + v * w[j], 0));
      const err = p - (y[i] ? 1 : 0), wt = Math.max(p * (1 - p), 1e-12);
      for (let a = 0; a < d; a++) {
        g[a] += X[i][a] * err / n;
        for (let b = 0; b < d; b++) H[a][b] += X[i][a] * X[i][b] * wt / n;
      }
    }
    for (let a = 1; a < d; a++) { g[a] += lambda * w[a]; H[a][a] += lambda; }   // intercept unpenalized
    let step = choleskySolve(H, g);
    if (!step) { const Hj = H.map((r, i) => r.map((v, j) => v + (i === j ? 1e-12 : 0))); step = choleskySolve(Hj, g); }
    if (!step) break;
    w = w.map((v, j) => v - step[j]);
  }
  return w;
}

/** KO_SPEC §4.6 G1 for one question. `records` are the admitted records that carry the question. */
export function g1(question: string, records: G1Record[]): G1Result {
  const ys = records.map(r => r.label), positives = ys.filter(Boolean).length;
  // §9.7 pipeline: present as a string on EVERY record, or absent on every record (the independent recheck rejects
  // mixed/absent presence; v1/v2 never set it, so their feature set and output schema are unchanged).
  const withPipe = records.filter(r => r.pipeline !== undefined).length;
  const hasPipeline = withPipe > 0;
  if (hasPipeline && withPipe !== records.length) throw new Error('G1 pipeline must be present on every record or on none');
  if (hasPipeline && records.some(r => typeof r.pipeline !== 'string')) throw new Error('G1 pipeline must be a string when present');
  const degenerate = records.length === 0 || positives === 0 || positives === ys.length;
  const folds = new Map<number, G1Record[]>();
  for (const r of records) (folds.get(foldOf(r.group)) ?? folds.set(foldOf(r.group), []).get(foldOf(r.group))!).push(r);
  const emptyFold = [...Array(G1.folds).keys()].some(k => !(folds.get(k)?.length) || (folds.get(k)?.length ?? 0) === records.length);
  if (degenerate || emptyFold) return { question, status: 'undefined', features: {}, combined: null, n: records.length, positives };

  // Decile assignment per fold (boundaries from the other four folds), precomputed once so (a) stays O(n^2), not O(n^3).
  const decMaps: Array<Map<G1Record, number>> = [];
  for (let k = 0; k < G1.folds; k++) { const d = deciles(records, k); decMaps.push(new Map(records.map(r => [r, d(r)]))); }

  // (a) single features: out-of-fold target encoding. `pipeline` is added only when the records carry it (W1c); v1/v2
  // records leave it undefined, so the feature list — and every output — is unchanged for them.
  const feats: Array<[string, (r: G1Record) => string]> = [
    ['source', r => r.source], ['family', r => r.family], ['impact', r => r.impact],
    ...(hasPipeline ? [['pipeline', (r: G1Record) => r.pipeline ?? ''] as [string, (r: G1Record) => string]] : []),
    ...G1.markers.map((m, i) => [m, (r: G1Record) => String(markersOf(r)[i])] as [string, (r: G1Record) => string]),
  ];
  const out: Record<string, number> = {};
  for (const [name, key] of feats) {
    // KO_SPEC §4.6(a): a feature with a single value over all records has AUROC 0.5 by definition.
    if (new Set(records.map(key)).size === 1) { out[name] = 0.5; continue; }
    const scores: number[] = [];
    for (const r of records) {
      const k = foldOf(r.group);
      const others = records.filter(x => foldOf(x.group) !== k);
      const group = others.filter(x => key(x) === key(r));
      const rate = group.length ? group.filter(x => x.label).length / group.length : others.filter(x => x.label).length / others.length;
      scores.push(rate);
    }
    const a = auroc(scores, ys);
    out[name] = Number.isNaN(a) ? 0.5 : a;
  }
  // decile feature (value target-encoded like the others; constant over all records => 0.5).
  {
    const scores: number[] = [];
    for (const r of records) {
      const k = foldOf(r.group); const dd = decMaps[k].get(r);
      const others = records.filter(x => foldOf(x.group) !== k);
      const group = others.filter(x => decMaps[k].get(x) === dd);
      scores.push(group.length ? group.filter(x => x.label).length / group.length : others.filter(x => x.label).length / others.length);
    }
    const decilesAll = new Set(records.map(r => decMaps[foldOf(r.group)].get(r)));
    out['length_decile'] = decilesAll.size === 1 ? 0.5 : auroc(scores, ys);
  }
  const aPass = Object.values(out).every(a => a >= G1.single_lo && a <= G1.single_hi);

  // (b) combined model.
  const preds = new Array(records.length).fill(0.5);
  for (let k = 0; k < G1.folds; k++) {
    const tr = records.map((r, i) => [r, i] as const).filter(([r]) => foldOf(r.group) !== k);
    const te = records.map((r, i) => [r, i] as const).filter(([r]) => foldOf(r.group) === k);
    if (!tr.length || !te.length) return { question, status: 'undefined', features: out, combined: null, n: records.length, positives };
    const trY = tr.map(([r]) => r.label), trPos = trY.filter(Boolean).length;
    if (trPos === 0 || trPos === trY.length) { const rate = trPos / trY.length; for (const [, i] of te) preds[i] = rate; continue; }
    const srcVocab = [...new Set(tr.map(([r]) => r.source))].sort(), famVocab = [...new Set(tr.map(([r]) => r.family))].sort();
    const srcHot = oneHot(srcVocab), famHot = oneHot(famVocab);
    const pipeVocab = hasPipeline ? [...new Set(tr.map(([r]) => r.pipeline ?? ''))].sort() : [];
    const pipeHot = hasPipeline ? oneHot(pipeVocab) : null;
    const lens = tr.map(([r]) => Math.log(1 + lengthOf(r)));
    const mu = lens.reduce((a, b) => a + b, 0) / lens.length;
    const sigma = Math.sqrt(lens.reduce((a, b) => a + (b - mu) ** 2, 0) / lens.length);
    const row = (r: G1Record): number[] => {
      const l = Math.log(1 + lengthOf(r)), z = sigma === 0 ? 0 : (l - mu) / sigma;
      const decileVec = new Array(10).fill(0); decileVec[decMaps[k].get(r) ?? 0] = 1;
      return [1, ...srcHot(r.source), ...famHot(r.family), ...decileVec, r.impact === 'write' ? 1 : 0,
        ...markersOf(r).map(m => m ? 1 : 0), z, ...(pipeHot ? pipeHot(r.pipeline ?? '') : [])];
    };
    const w = fitLogistic(tr.map(([r]) => row(r)), trY, G1.penalty);
    for (const [r, i] of te) preds[i] = sigmoid(row(r).reduce((s, v, j) => s + v * w[j], 0));
  }
  const combined = auroc(preds, ys);
  if (Number.isNaN(combined)) return { question, status: 'undefined', features: out, combined: null, n: records.length, positives };
  const status: G1Result['status'] = aPass && combined <= G1.combined_max ? 'pass' : 'fail';
  return { question, status, features: out, combined, n: records.length, positives };
}
