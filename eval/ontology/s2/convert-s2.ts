// S1b (plan §3; S2_SPEC §2, §3 step 2): S1-compatible converter for AgentDyn.
// Two modes:
//   s2       — AgentDyn selection from cohorts.json; S1 raw observation schema plus the S2-only bound impact; labels
//              with group/base; labels-pr with the frozen label-only injectionOverlap for every run; labels-d5 label-side.
//              A tool id outside the sealed binding subset is an integrity failure.
//   agentdojo — byte-compatible reproduction of runs-convert.ts cohortMain (legacy schema/serialization) for the S1
//              acceptance comparison. Omitted every S2-only field.
//   node eval/ontology/s2/convert-s2.ts --mode s2 --cohorts eval/ontology/s2/cohorts.json --manifest eval/ontology/s2/manifest-s2.json \
//     --binding eval/ontology/s2/binding-agentdyn.json --archive <tar.gz> --out <dir>
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { convertRun, convertSelectedRun, injectionOverlap, selectedCohort, validateCohorts, type SelectedCohort } from '../runs-convert.ts';

export interface S2Entry extends SelectedCohort { group: string; base: string }
export interface S2Meta { pipeline: string; suite: string; user_task: number; injection_task: number | null; attack: string | null; cohort: string; group: string; base: string }
export interface Binding { tools: Record<string, { effects: string[] }> }

export function validateS2Cohorts(value: unknown): S2Entry[] {
  const entries = validateCohorts(value) as S2Entry[];
  for (const e of entries as unknown as S2Entry[]) {
    if (typeof (e as S2Entry).group !== 'string' || typeof (e as S2Entry).base !== 'string') throw new Error('S2 cohort entry needs group and base');
  }
  return entries as S2Entry[];
}

/** S2 selection: AgentDyn suites; mirrors runs-convert.ts selectedCohort but with the S2 suite set and group/base. */
export function selectedCohortS2(path: string, entries: S2Entry[]): S2Meta | null {
  const m = path.match(/(?:^|\/)runs\/([^/]+)\/(dailylife|github|shopping)\/user_task_(\d+)\/(?:(none)\/none|([^/]+)\/injection_task_(\d+))\.json$/);
  if (!m) return null;
  const clean = m[4] === 'none';
  const entry = entries.find(e => e.pipeline === m[1] && (clean ? e.clean : e.attack === m[5]));
  if (!entry) return null;
  return { pipeline: m[1], suite: m[2], user_task: Number(m[3]), injection_task: clean ? null : Number(m[6]),
    attack: clean ? null : m[5], cohort: `${entry.pipeline}/${entry.attack}`, group: entry.group, base: entry.base };
}

export function convertSelectedRunS2(run: any, meta: S2Meta, binding: Binding) {
  const converted = convertRun(run, { model: meta.pipeline, suite: meta.suite, user_task: meta.user_task, injection_task: meta.injection_task } as never);
  const run_id = `${meta.pipeline}/${meta.attack ?? 'none'}/${meta.suite}/user_task_${meta.user_task}/${meta.injection_task == null ? 'none' : `injection_task_${meta.injection_task}`}`;
  const observations = converted.observations.map((o: any, i: number) => {
    const id = `agentdyn:${meta.suite}/${o.action.name}`;
    if (!binding.tools[id]) throw new Error(`tool id outside the sealed binding subset: ${id}`);   // S2_SPEC §2 integrity failure
    return { ...o, run_id, obs_id: `${run_id}#${i}` };                                             // raw observations = exact S1 schema
  });
  const label = { ...converted.label, run_id, pipeline: meta.pipeline, attack: meta.attack, cohort: meta.cohort, group: meta.group, base: meta.base };
  const d5 = { run_id, error_present: run.error != null, utility: typeof run.utility === 'boolean' ? run.utility : null,
    security: typeof run.security === 'boolean' ? run.security : null };
  return { observations, label, d5 };
}

const jl = (rows: any[]): string => rows.map(r => JSON.stringify(r)).join('\n') + '\n';

export function readSelected(archive: string, entries: { pipeline: string; attack: string; clean: boolean }[], suiteAlt: string): { expected: Record<string, number>; lines: string[] } {
  const script = `import tarfile,json,re,sys
entries=json.loads(sys.argv[2]); expected={e['pipeline']+'/'+e['attack']:0 for e in entries}; selected=[]
with tarfile.open(sys.argv[1]) as t:
 for m in t:
  match=re.search(r'/runs/([^/]+)/(${suiteAlt})/user_task_\\d+/(?:(none)/none|([^/]+)/injection_task_\\d+)\\.json$',m.name)
  if not m.isfile() or not match: continue
  pipeline=match[1]; clean=match[3]=='none'; attack=match[4]
  entry=next((e for e in entries if e['pipeline']==pipeline and (e['clean'] if clean else e['attack']==attack)),None)
  if entry is not None:
   selected.append(m); expected[entry['pipeline']+'/'+entry['attack']]+=1
 print(json.dumps({'expected':expected}))
 for m in selected:
  try: print(json.dumps({'path':m.name,'run':json.load(t.extractfile(m))}))
  except Exception as e: print(json.dumps({'path':m.name,'error':str(e)}))
`;
  const res = spawnSync('python3', ['-c', script, archive, JSON.stringify(entries)], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`archive reader failed: ${res.stderr}`);
  const lines = res.stdout.trim().split('\n').filter(Boolean);
  const expected = JSON.parse(lines.shift()!).expected as Record<string, number>;
  return { expected, lines };
}

export function convertS2(archive: string, cohortsFile: string, bindingPath: string, out: string): Record<string, unknown> {
  const entries = validateS2Cohorts(JSON.parse(readFileSync(cohortsFile, 'utf8')));
  const binding = JSON.parse(readFileSync(bindingPath, 'utf8')) as Binding;
  const { expected, lines } = readSelected(archive, entries, 'dailylife|github|shopping');
  for (const e of entries) if (!expected[`${e.pipeline}/${e.attack}`]) throw new Error(`cohort has no files: ${e.pipeline}/${e.attack}`);
  const observations: any[] = [], labels: any[] = [], overlaps: any[] = [], d5: any[] = [], seen = new Set<string>();
  const per_cohort_runs = Object.fromEntries(entries.map(e => [`${e.pipeline}/${e.attack}`, 0]));
  for (const line of lines) {
    const row = JSON.parse(line), meta = selectedCohortS2(row.path, entries);
    if (!meta) throw new Error('archive reader returned an unselected run');
    if (row.error) throw new Error(`cohort parse failure: ${row.path}: ${row.error}`);
    const converted = convertSelectedRunS2(row.run, meta, binding);
    if (seen.has(converted.label.run_id)) throw new Error(`duplicate run id: ${converted.label.run_id}`);
    seen.add(converted.label.run_id);
    observations.push(...converted.observations); labels.push(converted.label);
    overlaps.push({ run_id: converted.label.run_id, injection_overlap: injectionOverlap(row.run, converted as never) });
    d5.push(converted.d5); per_cohort_runs[meta.cohort]++;
  }
  for (const [key, n] of Object.entries(expected)) if (per_cohort_runs[key] !== n) throw new Error(`filename cohort count mismatch: ${key}`);
  const counts = { runs: labels.length, calls: observations.length, parse_failures: 0,
    pooled_positives: labels.filter(l => l.attacked && l.security === true).length, per_cohort_runs };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'observations.jsonl'), jl(observations));
  writeFileSync(join(out, 'labels.jsonl'), jl(labels));
  writeFileSync(join(out, 'labels-pr.jsonl'), jl(overlaps));
  writeFileSync(join(out, 'labels-d5.jsonl'), jl(d5));
  writeFileSync(join(out, 'counts.json'), JSON.stringify(counts, null, 2) + '\n');
  return counts;
}

/** AgentDojo compatibility: byte-compatible with runs-convert.ts cohortMain (legacy schema/serialization). */
export function convertAgentDojo(archive: string, cohortsFile: string, out: string): Record<string, unknown> {
  const sha = createHash('sha256').update(readFileSync(archive)).digest('hex');
  if (!sha.startsWith('d7e0ee02')) throw new Error('archive SHA-256 does not match pinned archive');
  const entries = validateCohorts(JSON.parse(readFileSync(cohortsFile, 'utf8')));
  const { expected, lines } = readSelected(archive, entries, 'banking|slack|travel|workspace');
  for (const e of entries) if (!expected[`${e.pipeline}/${e.attack}`]) throw new Error(`cohort has no files: ${e.pipeline}/${e.attack}`);
  const observations: any[] = [], labels: any[] = [], overlaps: any[] = [], seen = new Set<string>();
  const per_cohort_runs = Object.fromEntries(entries.map(e => [`${e.pipeline}/${e.attack}`, 0]));
  for (const line of lines) {
    const row = JSON.parse(line), meta = selectedCohort(row.path, entries);
    if (!meta) throw new Error('archive reader returned an unselected run');
    if (row.error) throw new Error(`cohort parse failure: ${row.path}: ${row.error}`);
    const converted = convertSelectedRun(row.run, meta as never) as unknown as { observations: any[]; label: any };
    const run_id = converted.label.run_id;
    if (seen.has(run_id)) throw new Error(`duplicate run id: ${run_id}`);
    seen.add(run_id);
    observations.push(...converted.observations); labels.push(converted.label);
    overlaps.push({ run_id, injection_overlap: injectionOverlap(row.run, converted as never) });
    per_cohort_runs[meta!.cohort]++;
  }
  for (const [key, n] of Object.entries(expected)) if (per_cohort_runs[key] !== n) throw new Error(`filename cohort count mismatch: ${key}`);
  const counts = { runs: labels.length, calls: observations.length, parse_failures: 0,
    pooled_positives: labels.filter(l => l.attacked && l.security === true).length, per_cohort_runs };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'observations.jsonl'), jl(observations));
  writeFileSync(join(out, 'labels.jsonl'), jl(labels));
  writeFileSync(join(out, 'labels-pr.jsonl'), jl(overlaps));
  writeFileSync(join(out, 'counts.json'), JSON.stringify(counts, null, 2) + '\n');
  return counts;
}

function flag(k: string): string | undefined { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; }
if (process.argv[1] != null && import.meta.url === `file://${process.argv[1]}`) {
  const mode = flag('mode') ?? 's2';
  const archive = flag('archive')!, cohorts = flag('cohorts')!, out = flag('out')!;
  if (!archive || !cohorts || !out) throw new Error('need --archive --cohorts --out');
  const counts = mode === 'agentdojo' ? convertAgentDojo(archive, cohorts, out)
    : convertS2(archive, cohorts, flag('binding') ?? 'eval/ontology/s2/binding-agentdyn.json', out);
  console.log(JSON.stringify(counts));
}
