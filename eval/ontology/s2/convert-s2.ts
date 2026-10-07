// S1b (plan §3; S2_SPEC §2, §3 step 2): S1-compatible converter for AgentDyn.
// Two modes:
//   s2       — AgentDyn selection enforced against manifest-s2.json (root_prefix + path_regex + pipelines/suites) and,
//              when given, a fetch seal: only sealed paths are parsed, and converted membership plus per-cell
//              attacked/clean counts must equal the manifest's expected cells and the seal (a matching path under another
//              root, or a partial cell, fails closed). A structural envelope check runs BEFORE legacy conversion:
//              missing/non-array `messages`, malformed message/tool-call structures, or any field outside the AgentDojo
//              run schema fail. Legitimate call-free and error runs, and extra/missing argument keys, are kept. Output is
//              the exact S1 raw observation schema; labels add group/base; labels-pr is the frozen label-only
//              `injectionOverlap`; labels-d5 is label-side. A tool id outside the sealed binding subset is an integrity
//              failure.
//   agentdojo — byte-compatible reproduction of runs-convert.ts cohortMain (legacy schema/serialization) for the S1
//              acceptance comparison; no S2-only fields and no S2 validation.
//   node eval/ontology/s2/convert-s2.ts --mode s2 --cohorts eval/ontology/s2/cohorts.json --manifest eval/ontology/s2/manifest-s2.json \
//     --binding eval/ontology/s2/binding-agentdyn.json [--seal <fetch-seal.json>] --archive <tar.gz> --out <dir>
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { convertRun, convertSelectedRun, injectionOverlap, selectedCohort, validateCohorts, type SelectedCohort } from '../runs-convert.ts';
import { ENVELOPE_FIELDS } from '../../kev-onto/contract.ts';

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

/** S2_SPEC D7: structural envelope validation before legacy conversion. Rejects a field set outside the AgentDojo run
 *  schema, missing/non-array `messages`, and malformed message/tool-call structures. Call-free and error runs pass. */
export function validateEnvelope(run: unknown): void {
  if (!run || typeof run !== 'object' || Array.isArray(run)) throw new Error('malformed envelope: not an object');
  for (const k of Object.keys(run as object)) if (!(ENVELOPE_FIELDS as readonly string[]).includes(k)) throw new Error(`malformed envelope: field outside the AgentDojo run schema: ${k}`);
  const messages = (run as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) throw new Error('malformed envelope: messages must be an array');
  for (const m of messages) {
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof (m as { role?: unknown }).role !== 'string') throw new Error('malformed envelope: message must be an object with a string role');
    const calls = (m as { tool_calls?: unknown }).tool_calls;
    if (calls === undefined) continue;
    if (!Array.isArray(calls)) throw new Error('malformed envelope: tool_calls must be an array');
    for (const c of calls) {
      if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('malformed envelope: tool call must be an object');
      const fn = (c as { function?: unknown }).function;
      const name = typeof fn === 'string' ? fn : (fn && typeof fn === 'object' ? (fn as { name?: unknown }).name : undefined);
      if (typeof name !== 'string' || name.length === 0) throw new Error('malformed envelope: tool call without a function name');
      let args = (c as { args?: unknown }).args ?? (fn && typeof fn === 'object' ? (fn as { arguments?: unknown }).arguments : undefined);
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { throw new Error('malformed envelope: tool-call args are not valid JSON'); } }
      if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) throw new Error('malformed envelope: tool-call args must be an object');
    }
  }
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
  validateEnvelope(run);
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

/** S1 (runs-convert) reader, used only by the AgentDojo compatibility mode. */
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

/** S2 reader: only paths under `root` that match the manifest regex/pipelines/suites are candidates; when a seal is
 *  given only sealed (relative) paths are read. A regex/pipeline/suite matching path under another root is fatal. */
export function readS2(archive: string, root: string, pathRegex: string, suites: string[], pipelines: string[], sealPath: string): { candidates: string[]; selected: string[] | null; lines: string[] } {
  const script = `import tarfile,json,re,sys
archive,root,pat,suites,pipes,sealfile=sys.argv[1:7]
suites=set(json.loads(suites)); pipes=set(json.loads(pipes))
seal=json.load(open(sealfile))['files'] if sealfile not in ('','-') else None
rx=re.compile(pat); sel=set(seal.keys()) if seal is not None else None
cand=[]; intr=[]; chosen=[]
with tarfile.open(archive) as t:
 for m in t:
  if not m.isfile(): continue
  name=m.name
  if name.startswith(root):
   rel=name[len(root):]
   mm=rx.match(rel)
   if mm and mm.group('pipeline') in pipes and mm.group('suite') in suites:
    cand.append(rel)
    if sel is None or rel in sel: chosen.append((rel,m))
  else:
   i=name.find('/runs/')
   if i>=0:
    rel=name[i+1:]
    mm=rx.match(rel)
    if mm and mm.group('pipeline') in pipes and mm.group('suite') in suites: intr.append(name)
 if intr:
  print(json.dumps({'error':'intruder-root','paths':intr[:3]})); sys.exit(3)
 print(json.dumps({'candidates':sorted(cand),'selected':sorted(sel) if sel is not None else None}))
 for rel,m in chosen:
  try: print(json.dumps({'path':m.name,'rel':rel,'run':json.load(t.extractfile(m))}))
  except Exception as e: print(json.dumps({'path':m.name,'error':str(e)}))
`;
  const res = spawnSync('python3', ['-c', script, archive, root, pathRegex.replace(/\(\?<([A-Za-z_]\w*)>/g, '(?P<$1>'), JSON.stringify(suites), JSON.stringify(pipelines), sealPath], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`archive reader failed: ${res.stderr}`);
  const lines = res.stdout.trim().split('\n').filter(Boolean);
  const head = JSON.parse(lines.shift()!) as { error?: string; candidates: string[]; selected: string[] | null };
  if (head.error) throw new Error(`archive reader: ${head.error} ${JSON.stringify((head as never as { paths?: string[] }).paths)}`);
  return { candidates: head.candidates, selected: head.selected, lines };
}

export interface S2Manifest { source: { root_prefix: string }; path_regex: string; pipelines: string[]; suites: string[]; expected: Record<string, Record<string, { attacked: number; benign: number }>>; total_runs: number }
export interface S2Seal { files: Record<string, string>; counts: Record<string, Record<string, { attacked: number; benign: number }>>; total: number }

export function convertS2(archive: string, cohortsFile: string, manifestPath: string, bindingPath: string, sealPath: string, out: string): Record<string, unknown> {
  const entries = validateS2Cohorts(JSON.parse(readFileSync(cohortsFile, 'utf8')));
  const binding = JSON.parse(readFileSync(bindingPath, 'utf8')) as Binding;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as S2Manifest;
  const seal = sealPath ? JSON.parse(readFileSync(sealPath, 'utf8')) as S2Seal : null;
  const root = manifest.source.root_prefix;
  const { candidates, selected, lines } = readS2(archive, root, manifest.path_regex, manifest.suites, manifest.pipelines, sealPath ?? '');
  if (selected !== null) {
    const a = [...candidates].sort(), b = [...selected].sort();
    if (a.length !== b.length || a.some((x, i) => x !== b[i])) throw new Error(`manifest-matching archive membership differs from the seal (${a.length} vs ${b.length})`);
  }
  const observations: any[] = [], labels: any[] = [], overlaps: any[] = [], d5: any[] = [], seen = new Set<string>();
  const per_cohort_runs = Object.fromEntries(entries.map(e => [`${e.pipeline}/${e.attack}`, 0]));
  const cell: Record<string, Record<string, { attacked: number; benign: number }>> = {};
  for (const line of lines) {
    const row = JSON.parse(line);
    if (row.error) throw new Error(`cohort parse failure: ${row.path}: ${row.error}`);
    if (!row.path.startsWith(root)) throw new Error(`path not under the manifest root: ${row.path}`);   // root enforced by the reader too
    const meta = selectedCohortS2(row.path, entries);
    if (!meta) throw new Error('archive reader returned a run outside the cohorts');
    const converted = convertSelectedRunS2(row.run, meta, binding);
    if (seen.has(converted.label.run_id)) throw new Error(`duplicate run id: ${converted.label.run_id}`);
    seen.add(converted.label.run_id);
    observations.push(...converted.observations); labels.push(converted.label);
    overlaps.push({ run_id: converted.label.run_id, injection_overlap: injectionOverlap(row.run, converted as never) });
    d5.push(converted.d5); per_cohort_runs[meta.cohort]++;
    const c = ((cell[meta.pipeline] ??= {})[meta.suite] ??= { attacked: 0, benign: 0 });
    c[converted.label.attacked ? 'attacked' : 'benign']++;
  }
  // membership and per-cell counts must equal the manifest expected cells and, when given, the seal.
  for (const p of manifest.pipelines) for (const s of manifest.suites) {
    const want = manifest.expected[p]?.[s] ?? { attacked: 0, benign: 0 };
    const got = cell[p]?.[s] ?? { attacked: 0, benign: 0 };
    if (got.attacked !== want.attacked || got.benign !== want.benign) throw new Error(`cell ${p}/${s}: got ${got.attacked}+${got.benign}, want ${want.attacked}+${want.benign}`);
    if (seal) {
      const sc = seal.counts[p]?.[s] ?? { attacked: 0, benign: 0 };
      if (sc.attacked !== want.attacked || sc.benign !== want.benign) throw new Error(`seal cell ${p}/${s} disagrees with the manifest`);
    }
  }
  if (labels.length !== manifest.total_runs) throw new Error(`total runs ${labels.length} != manifest ${manifest.total_runs}`);
  if (seal && labels.length !== seal.total) throw new Error(`total runs ${labels.length} != seal ${seal.total}`);
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
    : convertS2(archive, cohorts, flag('manifest') ?? 'eval/ontology/s2/manifest-s2.json',
      flag('binding') ?? 'eval/ontology/s2/binding-agentdyn.json', flag('seal') ?? '', out);
  console.log(JSON.stringify(counts));
}
