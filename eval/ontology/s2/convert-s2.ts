// S1b (plan §3; S2_SPEC §2, §3 step 2): S1-compatible converter for AgentDyn.
// Two modes:
//   s2       — AgentDyn selection enforced against manifest-s2.json (root_prefix + path_regex + pipelines/suites) and,
//              when given, a fetch seal: only sealed paths are parsed, and converted membership plus per-cell
//              attacked/clean counts must equal the manifest's expected cells and the seal (a matching path under another
//              root, or a partial cell, fails closed). A structural envelope check runs BEFORE legacy conversion:
//              missing/non-array `messages`, unsupported roles, role-specific tool_calls and malformed structures fail.
//              Top-level fields outside the AgentDojo run schema (e.g. progent's `build_constraints`) are ignored — their
//              values are never read — and their NAMES are counted per pipeline in counts.json (amendment A-S2-1).
//              Legitimate call-free and error runs, and extra/missing argument keys, are kept. Output is
//              the exact S1 raw observation schema; labels add group/base; labels-pr is the frozen label-only
//              `injectionOverlap`; labels-d5 is label-side. A REGISTERED tool id missing from the sealed binding is an
//              integrity failure; a call to an UNREGISTERED tool (not in binding/manifest-agentdyn.json) is kept, counted
//              by name per suite in counts.json and handled by the statistics as S1 handles a tool absent from its
//              binding (amendment A-S2-2). An attacked run whose `security` label is missing or non-boolean is NOT an
//              integrity failure: it is kept with positive=false (S1 endpoint) and counted as a label_error in
//              counts.json (amendment A-S2-3). Integrity failures are collected over every selected run in one pass and
//              written to integrity-report.json; conversion then exits non-zero writing no observations or labels.
//   agentdojo — byte-compatible reproduction of runs-convert.ts cohortMain (legacy schema/serialization) for the S1
//              acceptance comparison; no S2-only fields and no S2 validation.
//   node eval/ontology/s2/convert-s2.ts --mode s2 --cohorts eval/ontology/s2/cohorts.json --manifest eval/ontology/s2/manifest-s2.json \
//     --binding eval/ontology/s2/binding-agentdyn.json [--registered eval/kev-onto/binding/manifest-agentdyn.json] \
//     [--seal <fetch-seal.json>] --archive <tar.gz> --out <dir>
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { convertRun, convertSelectedRun, injectionOverlap, selectedCohort, validateCohorts, type SelectedCohort } from '../runs-convert.ts';
import { ENVELOPE_FIELDS } from '../../kev-onto/contract.ts';

export interface S2Entry extends SelectedCohort { group: string; base: string }
export interface S2Meta { pipeline: string; suite: string; user_task: number; injection_task: number | null; attack: string | null; cohort: string; group: string; base: string }
export interface Binding { tools: Record<string, { effects: string[] }> }
export interface ToolManifest { tools: Array<{ id: string }> }

/** A fail-closed integrity failure (S2_SPEC §6). `category` names the failure class, `id` the offending identifier
 *  (run path, run id or tool id); neither carries labels, security/utility values or message text. */
export class IntegrityError extends Error {
  readonly category: string;
  readonly id: string;
  constructor(category: string, id: string, message?: string) {
    super(message ?? `integrity failure [${category}]${id ? `: ${id}` : ''}`);
    this.name = 'IntegrityError';
    this.category = category;
    this.id = id;
  }
}

export function validateS2Cohorts(value: unknown): S2Entry[] {
  const entries = validateCohorts(value) as S2Entry[];
  for (const e of entries as unknown as S2Entry[]) {
    if (typeof (e as S2Entry).group !== 'string' || typeof (e as S2Entry).base !== 'string') throw new Error('S2 cohort entry needs group and base');
  }
  return entries as S2Entry[];
}

/** A well-formed AgentDyn/AgentDojo tool call: `{function: string, args: object|JSON-string, id?}`. */
function validateCall(c: unknown): void {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('malformed envelope: tool call must be an object');
  const fn = (c as { function?: unknown }).function;
  const name = typeof fn === 'string' ? fn : (fn && typeof fn === 'object' ? (fn as { name?: unknown }).name : undefined);
  if (typeof name !== 'string' || name.length === 0) throw new Error('malformed envelope: tool call without a function name');
  let args = (c as { args?: unknown }).args ?? (fn && typeof fn === 'object' ? (fn as { arguments?: unknown }).arguments : undefined);
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { throw new Error('malformed envelope: tool-call args are not valid JSON'); } }
  if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) throw new Error('malformed envelope: tool-call args must be an object');
}

/** S2_SPEC D7 (+ amendment A-S2-1): structural envelope validation before legacy conversion, following the pinned
 *  AgentDyn message types (types.py). Supported roles only; assistant tool_calls may be absent, null or an array of
 *  well-formed calls; only assistant messages may carry tool_calls (a non-null list elsewhere fails rather than being
 *  silently discarded); content may be a string, null or a content-block array. Call-free and error runs pass.
 *  Top-level fields outside the AgentDojo run schema are NOT failures (e.g. progent's `build_constraints`): they are
 *  ignored — their values are never read — and their NAMES are returned so the caller can count them per pipeline. */
export function validateEnvelope(run: unknown): string[] {
  const ROLES = new Set(['system', 'user', 'assistant', 'tool']);
  if (!run || typeof run !== 'object' || Array.isArray(run)) throw new Error('malformed envelope: not an object');
  const extras = Object.keys(run as object).filter(k => !(ENVELOPE_FIELDS as readonly string[]).includes(k));
  const messages = (run as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) throw new Error('malformed envelope: messages must be an array');
  for (const m of messages) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('malformed envelope: message must be an object');
    const role = (m as { role?: unknown }).role;
    if (typeof role !== 'string' || !ROLES.has(role)) throw new Error(`malformed envelope: unsupported message role: ${String(role)}`);
    const content = (m as { content?: unknown }).content;
    if (content !== undefined && content !== null && typeof content !== 'string' && !Array.isArray(content)) throw new Error('malformed envelope: message content must be a string, null or a content-block array');
    const calls = (m as { tool_calls?: unknown }).tool_calls;
    if (role === 'assistant') {
      if (calls === undefined || calls === null) continue;
      if (!Array.isArray(calls)) throw new Error('malformed envelope: assistant tool_calls must be null or an array');
      for (const c of calls) validateCall(c);
    } else {
      if (calls !== undefined && calls !== null) throw new Error(`malformed envelope: only assistant messages may carry tool_calls (role ${role})`);
      if (role === 'tool') { const id = (m as { tool_call_id?: unknown }).tool_call_id; if (id !== undefined && id !== null && typeof id !== 'string') throw new Error('malformed envelope: tool_call_id must be a string or null'); }
    }
  }
  return extras;
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

export function convertSelectedRunS2(run: any, meta: S2Meta, binding: Binding, registered: Set<string>) {
  const run_id = `${meta.pipeline}/${meta.attack ?? 'none'}/${meta.suite}/user_task_${meta.user_task}/${meta.injection_task == null ? 'none' : `injection_task_${meta.injection_task}`}`;
  const labelError = meta.injection_task != null && typeof run.security !== 'boolean';   // A-S2-3: S1 endpoint -> positive=false, counted not fatal
  let extraFields: string[];
  try { extraFields = validateEnvelope(run); }
  catch (e) { throw new IntegrityError('malformed_envelope', '', (e as Error).message); }
  const converted = convertRun(run, { model: meta.pipeline, suite: meta.suite, user_task: meta.user_task, injection_task: meta.injection_task } as never);
  const unregistered: string[] = [];
  const observations = converted.observations.map((o: any, i: number) => {
    const id = `agentdyn:${meta.suite}/${o.action.name}`;
    if (registered.has(id)) { if (!binding.tools[id]) throw new IntegrityError('registered_unbound_tool', id); }   // S2_SPEC §6
    else unregistered.push(o.action.name);                                                                        // A-S2-2: kept, counted, ineligible for M-S1
    return { ...o, run_id, obs_id: `${run_id}#${i}` };                                                            // raw observations = exact S1 schema
  });
  const label = { ...converted.label, run_id, pipeline: meta.pipeline, attack: meta.attack, cohort: meta.cohort, group: meta.group, base: meta.base };
  const d5 = { run_id, error_present: run.error != null, utility: typeof run.utility === 'boolean' ? run.utility : null,
    security: typeof run.security === 'boolean' ? run.security : null };
  return { observations, label, d5, extraFields, unregistered, labelError };
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
   rel=name[i+1:] if i>=0 else (name if name.startswith('runs/') else None)
   if rel is not None:
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

export function convertS2(archive: string, cohortsFile: string, manifestPath: string, bindingPath: string, registeredPath: string, sealPath: string, out: string): Record<string, unknown> {
  const entries = validateS2Cohorts(JSON.parse(readFileSync(cohortsFile, 'utf8')));
  const binding = JSON.parse(readFileSync(bindingPath, 'utf8')) as Binding;
  const registered = new Set((JSON.parse(readFileSync(registeredPath, 'utf8')) as ToolManifest).tools.map(t => t.id));
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
  const extraEnvelopeFields: Record<string, Record<string, number>> = {};
  const unregisteredToolCalls: Record<string, Record<string, number>> = {};
  let labelErrors = 0;   // A-S2-3: attacked runs whose security label is missing/non-boolean (kept, positive=false)
  // A-S2-2 one-pass integrity report: check every selected run before aborting; collect failures by category.
  const failures: Record<string, string[]> = {};
  const fail = (category: string, id: string): void => { (failures[category] ??= []).push(id); };
  for (const line of lines) {
    const row = JSON.parse(line);
    if (row.error) { fail('parse_failure', row.path); continue; }
    if (!row.path.startsWith(root)) { fail('not_under_root', row.path); continue; }   // root enforced by the reader too
    const meta = selectedCohortS2(row.path, entries);
    if (!meta) { fail('outside_cohorts', row.path); continue; }
    let converted: ReturnType<typeof convertSelectedRunS2>;
    try { converted = convertSelectedRunS2(row.run, meta, binding, registered); }
    catch (e) { if (e instanceof IntegrityError) fail(e.category, e.id || row.path); else fail('malformed_envelope', row.path); continue; }
    if (seen.has(converted.label.run_id)) { fail('duplicate_run_id', converted.label.run_id); continue; }
    seen.add(converted.label.run_id);
    observations.push(...converted.observations); labels.push(converted.label);
    overlaps.push({ run_id: converted.label.run_id, injection_overlap: injectionOverlap(row.run, converted as never) });
    d5.push(converted.d5); per_cohort_runs[meta.cohort]++;
    const c = ((cell[meta.pipeline] ??= {})[meta.suite] ??= { attacked: 0, benign: 0 });
    c[converted.label.attacked ? 'attacked' : 'benign']++;
    for (const f of converted.extraFields) { const m = (extraEnvelopeFields[meta.pipeline] ??= {}); m[f] = (m[f] ?? 0) + 1; }   // A-S2-1: names only, never values
    for (const name of converted.unregistered) { const m = (unregisteredToolCalls[meta.suite] ??= {}); m[name] = (m[name] ?? 0) + 1; }   // A-S2-2: names only, never args
    if (converted.labelError) labelErrors++;   // A-S2-3
  }
  if (Object.keys(failures).length) {
    const report = {
      integrity_failures: Object.values(failures).reduce((a, ids) => a + ids.length, 0),
      runs_checked: lines.length,
      categories: Object.fromEntries(Object.entries(failures).map(([category, ids]) => [category, { count: ids.length, ids: [...new Set(ids)].sort() }])),
    };
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'integrity-report.json'), JSON.stringify(report, null, 2) + '\n');
    throw new Error(`integrity failure(s): ${Object.entries(failures).map(([c, ids]) => `${c}=${ids.length}`).join(', ')}; see integrity-report.json`);
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
    pooled_positives: labels.filter(l => l.attacked && l.security === true).length, per_cohort_runs,
    extra_envelope_fields: extraEnvelopeFields, unregistered_tool_calls: unregisteredToolCalls, label_errors: labelErrors };
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
      flag('binding') ?? 'eval/ontology/s2/binding-agentdyn.json',
      flag('registered') ?? 'eval/kev-onto/binding/manifest-agentdyn.json', flag('seal') ?? '', out);
  console.log(JSON.stringify(counts));
}
