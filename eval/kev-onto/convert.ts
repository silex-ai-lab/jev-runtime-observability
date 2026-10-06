// T3 (plan §4; KO_SPEC §1–§3): manifest-driven converter. Generalizes eval/ontology/runs-convert.ts `convertRun`:
// cohort regex/counts come from the manifest, impact comes from a binding map (KO_SPEC §2), every observation is
// sanitized (sanitize.ts), the raw envelope schema is enforced (exactly ENVELOPE_FIELDS), and only prediction-contract
// fields plus a separate label record are emitted.
import { ENVELOPE_FIELDS, DATA_READ_EFFECT } from './contract.ts';
import type { Action, Manifest, Observation, RunLabel } from './contract.ts';
import { sanitizeString, sanitizeValue } from '../ontology/pr/sanitize.ts';

export interface Binding { tools: Record<string, { effects: string[] }> }
export type BindingInput = Binding | Record<string, string[]>;

export interface CohortMeta {
  pipeline: string; suite: string; user_task: number; injection_task: number | null; attacked: boolean;
}

/** The id prefix a binding/manifest uses for a tool (e.g. `agentdojo` from id `agentdojo-e5`). */
export const sourceLabel = (manifest: Manifest): string => manifest.id.split('-')[0];

export const textContent = (c: unknown): string => typeof c === 'string' ? c : Array.isArray(c)
  ? c.map(p => typeof p === 'string' ? p : String((p as { content?: unknown; text?: unknown })?.content ?? (p as { text?: unknown })?.text ?? '')).join(' ')
  : '';

/** Parse a run file path (already relative to the root prefix) against the manifest (KO_SPEC §1). */
export function cohortFor(manifest: Manifest, relPath: string): CohortMeta | null {
  const m = new RegExp(manifest.path_regex).exec(relPath);
  if (!m || !m.groups) return null;
  const { pipeline, suite } = m.groups as { pipeline: string; suite: string };
  if (!manifest.pipelines.includes(pipeline) || !manifest.suites.includes(suite)) return null;
  const attacked = m.groups.injection_task != null;
  return { pipeline, suite, user_task: Number(m.groups.user_task), injection_task: attacked ? Number(m.groups.injection_task) : null, attacked };
}

const effectsOf = (binding: BindingInput, toolId: string): string[] | undefined =>
  'tools' in binding ? (binding as Binding).tools[toolId]?.effects : (binding as Record<string, string[]>)[toolId];

/** KO_SPEC §2: `write` iff the tool's bound effects include anything other than data-read; missing tool is a hard error. */
export function impactOf(binding: BindingInput, source: string, suite: string, name: string): 'read' | 'write' {
  const toolId = `${source}:${suite}/${name}`;
  const effects = effectsOf(binding, toolId);
  if (!effects) throw new Error(`tool not in the binding: ${toolId}`);
  return effects.some(e => e !== DATA_READ_EFFECT) ? 'write' : 'read';
}

/** KO_SPEC §3: exactly the ENVELOPE_FIELDS; any other top-level field is a hard error. */
export function assertEnvelope(run: Record<string, unknown>): void {
  const allowed = new Set<string>(ENVELOPE_FIELDS);
  for (const k of Object.keys(run)) if (!allowed.has(k)) throw new Error(`unknown envelope field: ${k}`);
}

export function runId(meta: CohortMeta): string {
  return `${meta.pipeline}/${meta.suite}/user_task_${meta.user_task}/${meta.injection_task == null ? 'none' : `injection_task_${meta.injection_task}`}`;
}

export function convertRun(run: any, meta: CohortMeta, binding: BindingInput, source: string): { observations: Observation[]; label: RunLabel } {
  assertEnvelope(run);
  const { pipeline, suite, user_task, injection_task } = meta;
  const rid = runId(meta);
  const messages = run.messages ?? [];
  const task = sanitizeString(textContent(messages.find((m: any) => m.role === 'user')?.content));
  const recent: string[] = [], results: { ref: string; text: string }[] = [], observations: Observation[] = [];
  let pending: { id: unknown; name: string; index: number }[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      pending = [];
      const priorResults = [...results].reverse();
      for (const call of message.tool_calls ?? []) {
        const name = typeof call.function === 'string' ? call.function : call.function?.name;
        if (!name || typeof name !== 'string') throw new Error(`invalid tool call in ${rid}`);
        let args = call.args ?? call.function?.arguments ?? {};
        if (typeof args === 'string') args = JSON.parse(args);
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(`invalid args in ${rid}`);
        const index = observations.length;
        const action: Action = { tool: `${suite}/${name}`, name, impact: impactOf(binding, source, suite, name),
          args: sanitizeValue(args) as Record<string, unknown> };
        observations.push({ obs_id: `${rid}#${index}`, run_id: rid, call_index: index, task,
          action, recent: [...recent], low_authority: priorResults.map(x => ({ ref: x.ref, text: x.text })) });
        recent.push(name);
        pending.push({ id: call.id ?? null, name, index });
      }
    } else if (message.role === 'tool') {
      let index = message.tool_call_id != null ? pending.findIndex(p => p.id === message.tool_call_id) : 0;
      if (index < 0 || !pending[index]) throw new Error(`unpaired result in ${rid}`);
      const call = pending.splice(index, 1)[0];
      results.push({ ref: `tool_result:${call.name}#${call.index}`, text: sanitizeString(textContent(message.content)) });
    }
  }
  const security = typeof run.security === 'boolean' ? run.security : null;
  const attacked = injection_task != null;
  const label: RunLabel = { run_id: rid, pipeline, suite, user_task, injection_task, attacked, security,
    label_error: attacked && typeof run.security !== 'boolean', positive: attacked && run.security === true, n_calls: observations.length };
  return { observations, label };
}
