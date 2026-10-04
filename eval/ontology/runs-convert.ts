// E5 converter: only decision-time observations cross the model boundary.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODELS = ['meta-llama_Llama-3.3-70B-Instruct', 'Meta-SecAlign-70B'];
const EXPECTED = { banking: [144, 16], slack: [105, 21], travel: [140, 20], workspace: [560, 40] };
const IMPACT_WRITE = /(send|update|schedule|add|delete|create|remove|post|transfer|reset|rename|modify|revoke|block|grant|set|remove|rename|delete|unsubscribe|subscribe|share|write|insert|append)/i;
export const textContent = (c: unknown): string => typeof c === 'string' ? c : Array.isArray(c)
  ? c.map(p => typeof p === 'string' ? p : String(p?.content ?? p?.text ?? '')).join(' ') : '';

export function cohort(path: string, models = MODELS) {
  const m = path.match(/(?:^|\/)runs\/([^/]+)\/(banking|slack|travel|workspace)\/user_task_(\d+)\/(?:important_instructions\/injection_task_(\d+)|none\/none)\.json$/);
  if (!m || !models.includes(m[1])) return null;
  return { model: m[1], suite: m[2], user_task: Number(m[3]), injection_task: m[4] == null ? null : Number(m[4]) };
}

export function convertRun(run: any, meta: ReturnType<typeof cohort>) {
  if (!meta) throw new Error('not a cohort run');
  const { model, suite, user_task, injection_task } = meta;
  const run_id = `${model}/${suite}/user_task_${user_task}/${injection_task == null ? 'none' : `injection_task_${injection_task}`}`;
  const messages = run.messages ?? [];
  const task = textContent(messages.find((m: any) => m.role === 'user')?.content);
  const recent: string[] = [], results: { ref: string; text: string }[] = [], observations: any[] = [];
  let pending: { id: unknown; name: string; index: number }[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      pending = [];
      const priorResults = [...results].reverse();
      for (const call of message.tool_calls ?? []) {
        const name = typeof call.function === 'string' ? call.function : call.function?.name;
        if (!name || typeof name !== 'string') throw new Error(`invalid tool call in ${run_id}`);
        let args = call.args ?? call.function?.arguments ?? {};
        if (typeof args === 'string') args = JSON.parse(args);
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(`invalid args in ${run_id}`);
        const index = observations.length;
        observations.push({ obs_id: `${run_id}#${index}`, run_id, model, suite, user_task, injection_task,
          call_index: index, task, action: { tool: `${suite}/${name}`, name, impact: IMPACT_WRITE.test(name) ? 'write' : 'read', args },
          recent: [...recent], low_authority: priorResults.map(x => ({ ...x })) });
        recent.push(name);
        pending.push({ id: call.id ?? null, name, index });
      }
    } else if (message.role === 'tool') {
      let index = message.tool_call_id != null ? pending.findIndex(p => p.id === message.tool_call_id) : 0;
      if (index < 0 || !pending[index]) throw new Error(`unpaired result in ${run_id}`);
      const call = pending.splice(index, 1)[0];
      results.push({ ref: `tool_result:${call.name}#${call.index}`, text: textContent(message.content) });
    }
  }
  const injectionTexts = Object.values(run.injections ?? {}).map(textContent).filter(Boolean);
  const taskHasInjection = injectionTexts.some(s => task.includes(s));
  return { observations, label: { run_id, model, suite, user_task, injection_task,
    security: typeof run.security === 'boolean' ? run.security : null, attacked: injection_task != null, n_calls: observations.length }, taskHasInjection };
}

function main() {
  const flag = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
  const archive = resolve(flag('archive', '../silex-mockup/swm/.cache/agentdojo-repo-089ed468cf3e.tar.gz'));
  const models = flag('models', MODELS.join(',')).split(',');
  if (!models.length || models.some(m => !/^[\w.-]+$/.test(m)) || new Set(models).size !== models.length) throw new Error('invalid --models');
  const explicitOut = process.argv.includes('--out');
  const out = resolve(flag('out', 'runs/onto-e5-input'));
  const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
  if (!sha256.startsWith('d7e0ee02')) throw new Error('archive SHA-256 does not match pinned archive');
  // Python's stdlib handles PAX/long-name tar headers without extracting files to disk.
  const script = `import tarfile,json,re,sys\nmodels=set(json.loads(sys.argv[2])); expected={}\nt=tarfile.open(sys.argv[1])\nselected=[]\nfor m in t:\n match=re.search(r'/runs/([^/]+)/(banking|slack|travel|workspace)/user_task_\\d+/(important_instructions/injection_task_\\d+|none/none)\\.json$',m.name)\n if m.isfile() and match and match[1] in models:\n  selected.append(m); expected[match[1]]=expected.get(match[1],0)+1\nprint(json.dumps({'expected':expected}))\nfor m in selected:\n try: print(json.dumps({'path':m.name,'run':json.load(t.extractfile(m))}))\n except Exception as e: print(json.dumps({'path':m.name,'error':str(e)}))\n`;
  const extracted = spawnSync('python3', ['-c', script, archive, JSON.stringify(models)], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (extracted.status !== 0) throw new Error(`archive reader failed: ${extracted.stderr}`);
  const observations: any[] = [], labels: any[] = [], seen = new Set<string>();
  const counts: any = { archive_sha256: sha256, files: {}, calls: 0, usable_runs: 0, parse_failures: [], task_contains_injection_observations: 0, zero_call_runs: [], security: {} };
  for (const model of models) {
    counts.files[model] = {};
    counts.security[model] = {};
    for (const suite of Object.keys(EXPECTED)) {
      counts.files[model][suite] = { attacked: 0, clean: 0, calls: 0 };
      counts.security[model][suite] = { true: 0, false: 0, null: 0 };
    }
  }
  const records = extracted.stdout.trim().split('\n').filter(Boolean);
  const expected = JSON.parse(records.shift()!).expected as Record<string, number>;
  for (const line of records) {
    const entry = JSON.parse(line), meta = cohort(entry.path, models)!;
    counts.files[meta.model][meta.suite][meta.injection_task == null ? 'clean' : 'attacked']++;
    if (entry.error) { counts.parse_failures.push({ path: entry.path, error: entry.error }); continue; }
    try {
      const converted = convertRun(entry.run, meta);
      if (seen.has(converted.label.run_id)) throw new Error('duplicate run id');
      seen.add(converted.label.run_id);
      observations.push(...converted.observations); labels.push(converted.label);
      counts.files[meta.model][meta.suite].calls += converted.observations.length;
      counts.security[meta.model][meta.suite][String(converted.label.security)]++;
      if (converted.taskHasInjection) counts.task_contains_injection_observations += converted.observations.length;
      if (!converted.label.n_calls) counts.zero_call_runs.push(converted.label.run_id);
    } catch (error) { counts.parse_failures.push({ path: entry.path, error: String(error) }); }
  }
  if (models.some(m => !expected[m])) throw new Error('requested model absent from filename cohort');
  for (const model of models) {
    const actual = Object.values(counts.files[model] as Record<string, { attacked: number; clean: number }>).reduce((n, x) => n + x.attacked + x.clean, 0);
    if (actual !== expected[model]) throw new Error(`filename cohort count mismatch: ${model}`);
  }
  for (const model of models.filter(m => MODELS.includes(m))) for (const [suite, [attacked, clean]] of Object.entries(EXPECTED)) {
    const actual = counts.files[model][suite];
    if (actual.attacked !== attacked || actual.clean !== clean) throw new Error(`cohort count mismatch: ${model}/${suite}`);
  }
  counts.calls = observations.length; counts.usable_runs = labels.length;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'observations.jsonl'), observations.map(x => JSON.stringify(x)).join('\n') + '\n');
  writeFileSync(join(out, 'labels.jsonl'), labels.map(x => JSON.stringify(x)).join('\n') + '\n');
  const publicCounts = { runs: labels.length, calls: observations.length, parse_failures: counts.parse_failures.length,
    pooled_positives: labels.filter(l => l.attacked && l.security === true).length,
    per_model_runs: Object.fromEntries(models.map(m => [m, labels.filter(l => l.model === m).length])) };
  writeFileSync(join(out, 'counts.json'), JSON.stringify(explicitOut ? publicCounts : counts, null, 2) + '\n');
  console.log(JSON.stringify(explicitOut ? publicCounts : { usable_runs: labels.length, calls: observations.length, parse_failures: counts.parse_failures.length,
    task_contains_injection_observations: counts.task_contains_injection_observations, zero_call_runs: counts.zero_call_runs.length }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
