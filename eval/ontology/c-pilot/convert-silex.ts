// convert-silex.ts — C pilot P2 (PILOT_SPEC §2). Seal-first converter for the 40 sealed Silex runs.
// Every seal entry is verified and the runs/*.json set must equal the seal set BEFORE any file is parsed; the 40 runs
// are then converted in one pass, integrity failures are collected and written to integrity-report.json, and on any
// failure the converter throws with no observations or labels written. Unlisted envelope fields are ignored (names
// counted, values never read); a call to a tool outside the binding is kept and counted by name per suite (A-S2-2);
// an attacked run with a non-boolean `security` is kept with security=null and counted as label_error (A-S2-3).
//   node eval/ontology/c-pilot/convert-silex.ts --silex <dir> --binding <f> --out <dir>
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { convertRun } from '../runs-convert.ts';
import { validateEnvelope, writeJsonl, IntegrityError } from '../s2/convert-s2.ts';

const PATH_RE = /^runs\/(ap|soc)\/user_task_(\d+)\/(?:(none)\/none|([^/]+)\/injection_task_(\d+))\.json$/;
export const SILEX_SUITES = ['ap', 'soc'];
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** Relative paths (from the seal root, i.e. beginning `runs/`) of every *.json file under `<dir>/runs`. */
function runsJsonPaths(dir: string): string[] {
  const out: string[] = [];
  const root = join(dir, 'runs');
  const walk = (d: string, rel: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name), r = rel ? `${rel}/${name}` : name;
      if (statSync(p).isDirectory()) walk(p, r);
      else if (name.endsWith('.json')) out.push(r);
    }
  };
  if (existsSync(root)) walk(root, 'runs');
  return out.sort();
}

function writeIntegrityReport(out: string, failures: Record<string, string[]>, runsChecked: number): void {
  const categories = Object.fromEntries(Object.entries(failures).map(([cat, ids]) => [cat, { count: ids.length, ids: [...new Set(ids)].sort() }]));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'integrity-report.json'),
    JSON.stringify({ integrity_failures: Object.values(failures).reduce((a, ids) => a + ids.length, 0), runs_checked: runsChecked, categories }, null, 2) + '\n');
}

export function convertSilex(silexDir: string, bindingPath: string, out: string): Record<string, unknown> {
  const binding = JSON.parse(readFileSync(bindingPath, 'utf8')) as { tools: Record<string, { effects: string[] }> };
  const failures: Record<string, string[]> = {};
  const fail = (category: string, id: string): void => { (failures[category] ??= []).push(id); };

  // §2.1 Seal first: parse, verify each entry, and require the runs/*.json set to equal the seal set. The 40 entries
  // of PILOT_SPEC §1 are the real input's count; the enforced invariant is exact set equality, so a synthetic fixture
  // with fewer runs (P2 acceptance) is converted the same way.
  const sealLines = readFileSync(join(silexDir, 'SEAL.sha256'), 'utf8').split('\n');
  const entries: Array<{ hash: string; path: string }> = [];
  sealLines.forEach((line, i) => {
    if (!line.trim()) return;
    const m = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/);
    if (!m) { fail('seal_malformed', `SEAL.sha256#${i + 1}`); return; }
    entries.push({ hash: m[1], path: m[2] });
  });
  if (!entries.length) fail('seal_empty', 'SEAL.sha256');
  const sealSet = new Set(entries.map(e => e.path));
  if (sealSet.size !== entries.length) fail('seal_duplicate', 'SEAL.sha256');
  for (const e of entries) {
    const p = join(silexDir, e.path);
    if (!existsSync(p)) { fail('seal_missing', e.path); continue; }
    if (sha256(readFileSync(p)) !== e.hash) fail('seal_mismatch', e.path);
  }
  const actual = runsJsonPaths(silexDir);
  const actualSet = new Set(actual);
  for (const p of actual) if (!sealSet.has(p)) fail('seal_extra', p);
  for (const p of sealSet) if (!actualSet.has(p)) fail('seal_missing', p);
  if (Object.keys(failures).length) {
    writeIntegrityReport(out, failures, entries.length);
    throw new IntegrityError('seal_failure', '', 'seal integrity failure(s); see integrity-report.json');
  }

  // §2.2–§2.7 One-pass conversion over every sealed run.
  const observations: Array<Record<string, unknown>> = [], labels: Array<Record<string, unknown>> = [], seen = new Set<string>();
  // §2.9: both suite keys are always present ({} when a suite has no unregistered call).
  const unregistered: Record<string, Record<string, number>> = Object.fromEntries(SILEX_SUITES.map(s => [s, {}]));
  const extraFields: Record<string, number> = {};
  let labelErrors = 0;
  for (const e of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const m = e.path.match(PATH_RE);   // §2.2 path -> meta; a non-matching seal path is a bad_path integrity failure
    if (!m) { fail('bad_path', e.path); continue; }
    const suite = m[1], user_task = Number(m[2]), clean = !!m[3], attack = clean ? null : m[4], injection_task = clean ? null : Number(m[5]);
    let run: any;
    try { run = JSON.parse(readFileSync(join(silexDir, e.path), 'utf8')); }
    catch { fail('parse_failure', e.path); continue; }
    let extra: string[];
    try { extra = validateEnvelope(run); }                                          // §2.4 unlisted fields ignored, names returned
    catch { fail('malformed_envelope', e.path); continue; }
    const run_id = `silex-authored/${attack ?? 'none'}/${suite}/user_task_${user_task}/${injection_task == null ? 'none' : `injection_task_${injection_task}`}`;
    if (seen.has(run_id)) { fail('duplicate_run_id', run_id); continue; }
    seen.add(run_id);
    const converted = convertRun(run, { model: 'silex-authored', suite, user_task, injection_task } as never);   // §2.5
    const obs = converted.observations.map((o: any, i: number) => ({ ...o, run_id, obs_id: `${run_id}#${i}` }));
    const label = { ...converted.label, run_id, pipeline: 'silex-authored', attack,
      cohort: `silex-authored/${attack ?? 'none'}`, group: 'P', base: 'silex' };                                 // §2.7
    for (const o of obs) { const id = `silex:${suite}/${o.action.name}`;                                          // §2.6 tool ids
      if (!binding.tools[id]) { const u = (unregistered[suite] ??= {}); u[o.action.name] = (u[o.action.name] ?? 0) + 1; } }
    for (const f of extra) extraFields[f] = (extraFields[f] ?? 0) + 1;
    if (injection_task !== null && typeof run.security !== 'boolean') labelErrors++;                              // §2.7 A-S2-3
    observations.push(...obs); labels.push(label);
  }
  if (Object.keys(failures).length) {   // §2.8 all runs checked before anything is written
    writeIntegrityReport(out, failures, entries.length);
    throw new IntegrityError('integrity_failure', '', 'integrity failure(s); see integrity-report.json');
  }

  const counts = {
    runs: labels.length,
    attacked: labels.filter(l => l.attacked).length,
    clean: labels.filter(l => !l.attacked).length,
    calls: observations.length,
    call_free_runs: labels.filter(l => (l as { n_calls: number }).n_calls === 0).length,
    label_error: labelErrors,
    unregistered_tool_calls: unregistered,
    envelope_extra_fields: extraFields,
  };
  mkdirSync(out, { recursive: true });
  writeJsonl(join(out, 'observations.jsonl'), observations);
  writeJsonl(join(out, 'labels.jsonl'), labels);
  writeFileSync(join(out, 'counts.json'), JSON.stringify(counts, null, 2) + '\n');
  return counts;
}

const arg = (k: string): string | undefined => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
if (process.argv[1] != null && import.meta.url === `file://${process.argv[1]}`) {
  const silex = arg('silex'), binding = arg('binding'), out = arg('out');
  if (!silex || !binding || !out) throw new Error('convert-silex: need --silex <dir> --binding <f> --out <dir>');
  console.log(JSON.stringify(convertSilex(silex, binding, out)));
}
