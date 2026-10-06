// T2 (plan §4; KO_SPEC §1): fetch and seal the AgentDyn tarball WITHOUT parsing run JSON.
// The seal is a sha256 manifest of every cohort file, computed by streaming the tarball entries (tar listing + a hash of
// each entry's bytes only); no entry is JSON-decoded. Per-cell counts derived from the paths are checked against
// `manifest.agentdyn.json` and any mismatch is a hard error. The real tarball is fetched and sealed only after F1; this
// tool is exercised against synthetic fixture tarballs before then.
//   node eval/kev-onto/fetch.ts --manifest eval/kev-onto/manifest.agentdyn.json --tar <tarball> --out runs/kev-onto/agentdyn/seal.json
//   node eval/kev-onto/fetch.ts --manifest ... --download runs/kev-onto/agentdyn
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CellCount, Manifest } from './contract.ts';

export interface TarEntry { path: string; sha256: string; size: number }
export interface CohortFile { path: string; pipeline: string; suite: string; user_task: number; injection_task: number | null; attacked: boolean }
export interface Seal {
  tarball_sha256: string;
  root_prefix: string;
  files: Record<string, string>;                                        // cohort path (after root_prefix) -> sha256
  counts: Record<string, Record<string, CellCount>>;                    // pipeline -> suite -> counts
  total: number;
  total_bytes: number;
}
export interface CellPath { pipeline: string; suite: string; user_task: number; injection_task: number | null; attacked: boolean }

export const sha256File = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

/** A path is in the cohort iff, after its `root_prefix` is removed, it matches the manifest regex and its pipeline/suite
 *  are listed (KO_SPEC §1). Nothing is parsed beyond the path string. */
export function cohortPath(manifest: Manifest, path: string, rootPrefix = manifest.source.root_prefix): CellPath | null {
  if (!path.startsWith(rootPrefix)) return null;
  const rel = path.slice(rootPrefix.length);
  const m = new RegExp(manifest.path_regex).exec(rel);
  if (!m || !m.groups) return null;
  const pipeline = m.groups.pipeline, suite = m.groups.suite;
  if (!manifest.pipelines.includes(pipeline) || !manifest.suites.includes(suite)) return null;
  const attacked = m.groups.injection_task != null;
  return { pipeline, suite, user_task: Number(m.groups.user_task), injection_task: attacked ? Number(m.groups.injection_task) : null, attacked };
}

/** Stream every regular-file entry of a tarball and hash its bytes; returns {path, sha256, size}. No JSON is parsed. */
export function listTarEntries(tarPath: string): TarEntry[] {
  const script = `import tarfile,hashlib,json,sys
t=tarfile.open(sys.argv[1],'r:*')
for m in t:
    if not m.isfile(): continue
    f=t.extractfile(m); h=hashlib.sha256(); n=0
    while True:
        b=f.read(1<<20)
        if not b: break
        h.update(b); n+=len(b)
    sys.stdout.write(json.dumps({'path':m.name,'sha256':h.hexdigest(),'size':n})+'\\n')
`;
  const out = execFileSync('python3', ['-c', script, tarPath], { encoding: 'utf8', maxBuffer: 1 << 30 });
  return out.split('\n').filter(Boolean).map(l => JSON.parse(l) as TarEntry);
}

/** Seal a tarball: hash it, hash each cohort entry, and tally per-cell counts from the paths. */
export function sealTarball(tarPath: string, manifest: Manifest): Seal {
  const tarball_sha256 = sha256File(tarPath);
  const files: Record<string, string> = {};
  const counts: Record<string, Record<string, CellCount>> = {};
  let total = 0, totalBytes = 0, seen = new Set<string>();
  for (const e of listTarEntries(tarPath)) {
    const meta = cohortPath(manifest, e.path);
    if (!meta) continue;
    const rel = e.path.slice(manifest.source.root_prefix.length);
    if (seen.has(rel)) throw new Error(`duplicate cohort path in tarball: ${rel}`);
    seen.add(rel);
    files[rel] = e.sha256; totalBytes += e.size; total++;
    counts[meta.pipeline] ??= {};
    counts[meta.pipeline][meta.suite] ??= { attacked: 0, benign: 0 };
    counts[meta.pipeline][meta.suite][meta.attacked ? 'attacked' : 'benign']++;
  }
  return { tarball_sha256, root_prefix: manifest.source.root_prefix, files, counts, total, total_bytes: totalBytes };
}

/** Refuse on any count mismatch against the manifest's pinned expectations (KO_SPEC §1). */
export function verifyCounts(seal: Seal, manifest: Manifest): void {
  const strata = new Set<string>();
  for (const [pipeline, suites] of Object.entries(manifest.expected)) {
    for (const [suite, want] of Object.entries(suites)) {
      const got = seal.counts[pipeline]?.[suite] ?? { attacked: 0, benign: 0 };
      if (got.attacked !== want.attacked || got.benign !== want.benign)
        throw new Error(`cohort count mismatch ${pipeline}/${suite}: got ${got.attacked} attacked + ${got.benign} benign, want ${want.attacked} + ${want.benign}`);
      strata.add(`${suite}/${pipeline}`);
    }
  }
  for (const [pipeline, suites] of Object.entries(seal.counts))
    for (const suite of Object.keys(suites))
      if (!manifest.expected[pipeline]?.[suite]) throw new Error(`unexpected cohort cell ${pipeline}/${suite}`);
  if (seal.total !== manifest.total_runs) throw new Error(`total runs mismatch: got ${seal.total}, want ${manifest.total_runs}`);
  if (strata.size !== manifest.strata) throw new Error(`strata mismatch: got ${strata.size}, want ${manifest.strata}`);
}

export function download(url: string, destDir: string, name = 'agentdyn.tar.gz'): string {
  mkdirSync(destDir, { recursive: true });
  const out = join(destDir, name);
  execFileSync('curl', ['-fsSL', '--retry', '3', '-o', out, url], { stdio: ['ignore', 'ignore', 'inherit'] });
  return out;
}

function flag(k: string): string | undefined { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; }

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifestPath = flag('manifest') ?? join(here, 'manifest.agentdyn.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  let tar = flag('tar');
  if (flag('download')) tar = download(manifest.source.tarball_url, resolve(flag('download')!));
  if (!tar) throw new Error('pass --tar <tarball> or --download <dir>');
  const seal = sealTarball(tar, manifest);
  verifyCounts(seal, manifest);
  const out = flag('out');
  if (out) writeFileSync(out, JSON.stringify(seal, null, 1) + '\n');
  console.log(`sealed ${seal.total} cohort files (${seal.total_bytes} bytes) from ${tar}\n${JSON.stringify(seal.counts)}`);
  if (!out) console.log('(no --out: seal not written)');
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
