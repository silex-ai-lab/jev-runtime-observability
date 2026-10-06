// T6a (plan §4 T6a): tool manifests from source only. Three inputs, each written to its own manifest:
//   (i)   AgentDyn suites shopping/github/dailylife at the pinned commit, from a local src/ checkout (never runs/);
//   (ii)  AgentDojo four suites banking/slack/travel/workspace, from the pinned archive (src/ entries only);
//   (iii) every training-source tool appearing in eval/splits/items.jsonl train split (asb, injecagent, taubench, toolemu).
// A tool's name/description/params are parsed from the Python source (suites register a `TOOLS` list of functions defined
// in the tools/ modules). Nothing under any runs/ directory is read.
//   node eval/kev-onto/binding/extract.ts agentdyn --src <AgentDyn clone>            --out binding/manifest-agentdyn.json
//   node eval/kev-onto/binding/extract.ts agentdojo --archive <tar.gz>               --out binding/manifest-agentdojo.json
//   node eval/kev-onto/binding/extract.ts train --repo .                             --out binding/manifest-train.json
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export interface ToolParam { name: string; type: string }
export interface ToolEntry { id: string; name: string; description: string; params: ToolParam[]; source: string }

/** name -> module id parsed from a Python file's import statements. */
export function importMap(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of text.matchAll(/from\s+([\w.]+)\s+import\s+\(([\s\S]*?)\)/g))
    for (const n of m[2].split(/[,\n]/)) { const t = n.trim(); if (/^[A-Za-z_]\w*$/.test(t)) map.set(t, m[1]); }
  for (const m of text.matchAll(/from\s+([\w.]+)\s+import\s+([^\n(]+)/g))
    for (const n of m[2].split(',')) { const t = n.trim(); if (/^[A-Za-z_]\w*$/.test(t)) map.set(t, m[1]); }
  return map;
}

/** The uncommented function names in a suite's `TOOLS = [ ... ]` list. */
export function toolsList(text: string): string[] {
  const start = text.search(/^TOOLS\s*=\s*\[/m);
  if (start < 0) return [];
  const rest = text.slice(start);
  const end = rest.search(/^\]/m);
  const body = rest.slice(0, end < 0 ? rest.length : end);
  const names: string[] = [];
  for (const line of body.split('\n').slice(1))
    for (const m of line.matchAll(/(^|,)\s*([A-Za-z_]\w*)\s*(?=,|$)/g)) if (!line.trim().startsWith('#')) names.push(m[2]);
  return names;
}

/** Split a signature's parameter list on top-level commas (brackets respected). */
function splitParams(s: string): string[] {
  const out: string[] = []; let depth = 0, cur = '';
  for (const ch of s) {
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const normType = (t: string): string => t.replace(/\s+/g, ' ').trim();

/** Parse `def <name>( ... ) -> ...:` for its data parameters (Depends(...) params excluded) and docstring description. */
export function parseDef(text: string, name: string): { params: ToolParam[]; description: string } | null {
  const re = new RegExp(`^def\\s+${name}\\s*\\(`, 'm');
  const m = re.exec(text); if (!m) return null;
  const open = m.index + m[0].length;
  let depth = 1, i = open;
  for (; i < text.length && depth > 0; i++) { if (text[i] === '(') depth++; else if (text[i] === ')') depth--; }
  const sig = text.slice(open, i - 1);
  const params: ToolParam[] = [];
  for (const raw of splitParams(sig)) {
    const p = raw.trim(); if (!p || p.startsWith('*')) continue;
    const ci = p.indexOf(':'); if (ci < 0) continue;
    const pname = p.slice(0, ci).trim();
    let type = p.slice(ci + 1);
    const eq = type.indexOf('='); if (eq >= 0) type = type.slice(0, eq);
    if (/Depends\s*\(/.test(type)) continue;                      // runtime-injected, not part of the tool schema
    params.push({ name: pname, type: normType(type.replace(/^Annotated\[([^,]*),[\s\S]*\]$/, '$1')) });
  }
  const after = text.slice(i);
  const dm = /:\s*(?:->[^\n:]*)?:\s*\n\s*(?:"""|''')([\s\S]*?)(?:"""|''')/.exec(after) ?? /:\s*\n\s*(?:"""|''')([\s\S]*?)(?:"""|''')/.exec(after);
  let description = '';
  if (dm) {
    const lines = dm[1].split('\n').map(l => l.trim()).filter(l => l && !l.startsWith(':param') && !l.startsWith(':return'));
    description = lines.join(' ').trim();
  }
  return { params, description };
}

/** Parse one suite's TOOLS list, resolving each function to its defining module. */
export function suiteTools(suite: string, suiteFile: string, files: Map<string, string>, source: string): { tools: ToolEntry[]; undescribed: string[] } {
  const text = files.get(suiteFile) ?? readFileSync(suiteFile, 'utf8');
  const imports = importMap(text);
  const moduleRel = (mod: string): string | null => /^agentdojo\./.test(mod) ? mod.replace(/\./g, '/') + '.py' : null;
  const tools: ToolEntry[] = [], undescribed: string[] = [];
  for (const name of toolsList(text)) {
    const mod = imports.get(name);
    const rel = mod ? moduleRel(mod) : null;
    const defText = files.get(rel ?? '') ?? text;
    const def = parseDef(defText, name);
    if (!def) { undescribed.push(`${suite}/${name}`); continue; }
    tools.push({ id: `${source}:${suite}/${name}`, name, description: def.description, params: def.params, source });
  }
  return { tools, undescribed };
}

function readPyFiles(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) { if (f !== '__pycache__') walk(p); }
      else if (f.endsWith('.py')) out.set(relative(root, p), readFileSync(p, 'utf8'));
    }
  };
  walk(root);
  return out;
}

export function extractAgentdyn(srcRoot: string): { tools: ToolEntry[]; undescribed: string[] } {
  const files = readPyFiles(srcRoot);
  return extractSuites(['shopping', 'github', 'dailylife'], 'agentdojo/default_suites/v1', files, 'agentdyn');
}

function extractSuites(suites: string[], base: string, files: Map<string, string>, source: string): { tools: ToolEntry[]; undescribed: string[] } {
  const tools: ToolEntry[] = [], undescribed: string[] = [];
  for (const suite of suites) {
    const r = suiteTools(suite, `${base}/${suite}/task_suite.py`, files, source);
    tools.push(...r.tools); undescribed.push(...r.undescribed);
  }
  return { tools, undescribed };
}

/** Extract only `src/agentdojo/default_suites/v1/**` from the pinned archive into a temp dir; returns its src root. */
export function extractArchiveSrc(archive: string, suites: string[]): { srcRoot: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'kev-ao-'));
  const script = `import tarfile,os,sys
t=tarfile.open(sys.argv[1],'r:*'); root=sys.argv[2]
for m in t:
    if not m.isfile(): continue
    parts=m.name.split('/')
    if 'src' not in parts: continue
    rel='/'.join(parts[parts.index('src'):])
    if not rel.startswith('src/agentdojo/default_suites/v1/'): continue
    if '__pycache__' in rel: continue
    dest=os.path.join(root, rel)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    open(dest,'wb').write(t.extractfile(m).read())
`;
  execFileSync('python3', ['-c', script, archive, dir]);
  return { srcRoot: join(dir, 'src'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function extractAgentdojo(archive: string): { tools: ToolEntry[]; undescribed: string[] } {
  const { srcRoot, cleanup } = extractArchiveSrc(archive, ['banking', 'slack', 'travel', 'workspace']);
  try {
    const files = readPyFiles(srcRoot);
    return extractSuites(['banking', 'slack', 'travel', 'workspace'], 'agentdojo/default_suites/v1', files, 'agentdojo');
  } finally { cleanup(); }
}

/** Training-source tools: names come from the train split; descriptions/params are best-effort from raw + taubench. */
/** τ-bench tool definitions straight from the tau_bench source (`get_info`), family-scoped by directory. */
export function taubenchToolDefs(rawRoot: string): Array<{ family: string; name: string; description: string; params: ToolParam[] }> {
  const script = `import ast, json, os, sys
root = sys.argv[1]
out = []
for fam in ['retail','airline']:
    d = os.path.join(root, 'tau_bench','envs',fam,'tools')
    if not os.path.isdir(d): continue
    for fn in sorted(os.listdir(d)):
        if not fn.endswith('.py') or fn == '__init__.py': continue
        tree = ast.parse(open(os.path.join(d,fn), encoding='utf-8').read())
        info = None
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == 'get_info':
                for b in ast.walk(node):
                    if isinstance(b, ast.Return):
                        try: info = ast.literal_eval(b.value)
                        except Exception: info = None
                        break
                if info is not None: break
        if not info: continue
        f = info.get('function', {})
        props = (f.get('parameters', {}) or {}).get('properties', {}) or {}
        out.append({'family': fam, 'name': f.get('name'), 'description': f.get('description',''),
                    'params': [{'name': k, 'type': (v or {}).get('type','')} for k, v in props.items()]})
sys.stdout.write(json.dumps(out))
`;
  return JSON.parse(execFileSync('python3', ['-c', script, rawRoot], { encoding: 'utf8', maxBuffer: 1 << 30 }));
}

export function extractTrain(repo: string): { tools: ToolEntry[]; undescribed: string[] } {
  const R = (p: string) => join(repo, p);
  const names = new Map<string, Set<string>>();                    // source -> tool names
  for (const line of readFileSync(R('eval/splits/items.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (r.split !== 'train' || !['asb', 'injecagent', 'taubench', 'toolemu'].includes(r.source)) continue;
    const m = /^CANDIDATE ACTION: (.+?) \(registry impact:/m.exec(r.state);
    if (m) { (names.get(r.source) ?? names.set(r.source, new Set()).get(r.source)!).add(m[1].trim()); }
  }
  const asbDesc = new Map<string, string>();
  for (const f of ['all_attack_tools.jsonl', 'all_normal_tools.jsonl'])
    for (const line of readFileSync(R(`eval/sources/raw/asb/data/${f}`), 'utf8').split('\n')) {
      if (!line.trim()) continue; const d = JSON.parse(line); const n = d['Attacker Tool'] ?? d['Tool Name'];
      if (n) asbDesc.set(n, String(d.Description ?? ''));
    }
  const inj = new Map<string, { description: string; params: ToolParam[] }>();
  const injTools = JSON.parse(readFileSync(R('eval/sources/raw/injecagent/data/tools.json'), 'utf8')) as any[];
  for (const tk of injTools) for (const t of tk.tools ?? []) {
    if (!t.name) continue;
    const params = Array.isArray(t.parameters)
      ? t.parameters.map((p: any) => ({ name: String(p.name), type: normType(String(p.type ?? '')) }))
      : t.parameters?.properties ? Object.entries(t.parameters.properties).map(([k, v]: any) => ({ name: k, type: normType(String(v.type ?? '')) })) : [];
    const entry = { description: String(t.summary ?? t.description ?? t.description_for_model ?? ''), params };
    inj.set(t.name, entry);                                        // e.g. GetProductDetails
    if (tk.name_for_model) inj.set(`${tk.name_for_model}${t.name}`, entry);   // item tool ids, e.g. AmazonGetProductDetails
  }
  const tb = JSON.parse(readFileSync(R('eval/convert/fixtures/taubench.json'), 'utf8')) as Record<string, any[]>;
  const toolemuDesc = new Map<string, string>();
  for (const f of ['virtual_tools.py', 'real_tools.py']) {
    const text = readFileSync(R(`eval/sources/raw/toolemu/toolemu/tools/${f}`), 'utf8');
    for (const m of text.matchAll(/@register_toolkit\(\)\s*\nclass\s+(\w+)\s*\(FunctionToolkit\):([\s\S]*?)(?=\nclass |\n@register_toolkit|$)/g)) {
      const nm = /name_for_model\s*=\s*"([^"]*)"/.exec(m[2])?.[1] ?? m[1];
      const de = /description_for_model\s*=\s*"([^"]*)"/.exec(m[2])?.[1] ?? '';
      toolemuDesc.set(nm, de);
    }
  }

  const tools: ToolEntry[] = [], undescribed: string[] = [];
  for (const source of ['asb', 'injecagent', 'toolemu']) {
    for (const name of [...(names.get(source) ?? [])].sort()) {
      let description = '', params: ToolParam[] = [];
      if (source === 'asb') description = asbDesc.get(name) ?? '';
      else if (source === 'injecagent') ({ description, params } = inj.get(name) ?? { description: '', params: [] });
      else description = toolemuDesc.get(name) ?? '';
      const id = `${source}:${name}`;
      if (!description && !params.length) undescribed.push(id);
      tools.push({ id, name, description, params, source });
    }
  }
  // τ-bench: family-scoped identities (taubench:<family>/<name>), no cross-family dedup, for every tool used by any
  // train original or any rule-3 donor gold action. Name/description/params come from the tau_bench source, not fixtures.
  const trainTbIndices = new Map<string, Set<number>>();
  for (const line of readFileSync(R('eval/splits/items.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue; const r = JSON.parse(line);
    if (r.split !== 'train' || r.source !== 'taubench') continue;
    const parts = String(r.template_id).split(':');
    (trainTbIndices.get(parts[0]) ?? trainTbIndices.set(parts[0], new Set()).get(parts[0])!).add(Number(parts[1]));
  }
  const tbById = new Map(taubenchToolDefs(R('eval/sources/raw/taubench')).map(d => [`${d.family}/${d.name}`, d]));
  for (const fam of Object.keys(tb)) {
    const needed = new Set<string>();
    for (const i of trainTbIndices.get(fam) ?? []) for (const a of (tb[fam][i]?.actions ?? [])) if (a?.name) needed.add(a.name);
    for (const name of [...needed].sort()) {
      const d = tbById.get(`${fam}/${name}`);
      const id = `taubench:${fam}/${name}`;
      if (!d) { undescribed.push(id); tools.push({ id, name, description: '', params: [], source: 'taubench' }); continue; }
      tools.push({ id, name, description: d.description, params: d.params, source: 'taubench' });
    }
  }
  return { tools, undescribed };
}

function flag(k: string): string | undefined { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; }

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const mode = process.argv[2];
  let result: { tools: ToolEntry[]; undescribed: string[] };
  if (mode === 'agentdyn') {
    const src = flag('src'); if (!src) throw new Error('agentdyn needs --src <clone root>');
    result = extractAgentdyn(join(src, 'src'));
  } else if (mode === 'agentdojo') {
    const archive = flag('archive'); if (!archive) throw new Error('agentdojo needs --archive <tar.gz>');
    result = extractAgentdojo(archive);
  } else if (mode === 'train') {
    result = extractTrain(flag('repo') ?? join(here, '../..'));
  } else throw new Error('usage: extract.ts <agentdyn|agentdojo|train> --out <manifest.json>');
  const out = flag('out');
  if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify({ tools: result.tools }, null, 1) + '\n'); }
  const bySource = result.tools.reduce<Record<string, number>>((a, t) => (a[t.source] = (a[t.source] ?? 0) + 1, a), {});
  console.log(`${mode}: ${result.tools.length} tools ${JSON.stringify(bySource)}; ${result.undescribed.length} undescribed${result.undescribed.length ? ': ' + result.undescribed.slice(0, 12).join(', ') : ''}`);
  if (!out) console.log('(no --out)');
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
