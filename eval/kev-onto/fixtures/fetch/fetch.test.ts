// T2 acceptance (plan §4 T2; KO_SPEC §1): seal a synthetic tarball, detect a flipped byte and a missing file, and
// refuse a count mismatch. No AgentDyn run is touched.
//   node eval/kev-onto/fixtures/fetch/fetch.test.ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Manifest } from '../../contract.ts';
import { cohortPath, listTarEntries, sealTarball, verifyCounts } from '../../fetch.ts';

let fails = 0;
const ok = (name: string, cond: boolean, info: unknown = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name} ${info === '' ? '' : JSON.stringify(info)}`); if (!cond) fails++; };

const ROOT = 'Synth-0001/';
const manifest: Manifest = {
  id: 'synth', source: { repo: 'x', commit: '0', tarball_url: '', licence: 'MIT', root_prefix: ROOT },
  pipelines: ['p1'], suites: ['s1'], attack: 'important_instructions',
  path_regex: '^runs/(?<pipeline>[^/]+)/(?<suite>[^/]+)/user_task_(?<user_task>\\d+)/(?:important_instructions/injection_task_(?<injection_task>\\d+)|none/none)\\.json$',
  expected: { p1: { s1: { attacked: 2, benign: 2 } } },
  user_tasks_per_suite: { s1: 2 }, total_runs: 4, strata: 1,
};

/** Build a tarball from { relPath -> content } with a deterministic mtime (via python tarfile; no mac metadata). */
function makeTar(tarPath: string, files: Record<string, string>): void {
  const script = `import tarfile,io,json,sys
files=json.loads(sys.stdin.read()); root=sys.argv[2]
with tarfile.open(sys.argv[1],'w:gz') as t:
    for rel,text in files.items():
        data=text.encode(); ti=tarfile.TarInfo(root+rel); ti.size=len(data); ti.mtime=0
        t.addfile(ti, io.BytesIO(data))
`;
  execFileSync('python3', ['-c', script, tarPath, ROOT], { input: JSON.stringify(files), stdio: ['pipe', 'ignore', 'inherit'] });
}

const base: Record<string, string> = {
  'runs/p1/s1/user_task_0/important_instructions/injection_task_0.json': '{"security":true,"messages":[]}',
  'runs/p1/s1/user_task_0/none/none.json': '{"security":true,"messages":[]}',
  'runs/p1/s1/user_task_1/important_instructions/injection_task_0.json': '{"security":false,"messages":[]}',
  'runs/p1/s1/user_task_1/none/none.json': '{"security":false,"messages":[]}',
  'runs/p1/s1/injection_task_0/none/none.json': '{"out of cohort":"injection task utility run"}',
  'README.md': 'not a cohort file',
};

const work = mkdtempSync(join(tmpdir(), 'kev-fetch-'));
try {
  const t1 = join(work, 't1.tar.gz');
  makeTar(t1, base);
  const s1 = sealTarball(t1, manifest);
  verifyCounts(s1, manifest);
  ok('seals the synthetic tarball', s1.total === 4 && Object.keys(s1.files).length === 4, { total: s1.total, files: Object.keys(s1.files).length });
  ok('tallies per-cell counts from paths', JSON.stringify(s1.counts) === JSON.stringify({ p1: { s1: { attacked: 2, benign: 2 } } }), s1.counts);
  ok('ignores non-cohort paths (README, injection_task utility run)',
    !Object.keys(s1.files).some(p => p.endsWith('README.md') || p.includes('/injection_task_0/none/')));
  ok('listTarEntries streams every regular file', listTarEntries(t1).length === 6, listTarEntries(t1).length);

  const rel = 'runs/p1/s1/user_task_0/none/none.json';
  const t2 = join(work, 't2.tar.gz');
  makeTar(t2, { ...base, [rel]: '{"security":falsE,"messages":[]}' });   // one byte flipped (case)
  const s2 = sealTarball(t2, manifest);
  ok('detects one flipped byte (per-file sha256)', s2.files[rel] !== s1.files[rel]);
  ok('detects one flipped byte (tarball sha256)', s2.tarball_sha256 !== s1.tarball_sha256);

  const t3 = join(work, 't3.tar.gz');
  const missing = { ...base }; delete missing['runs/p1/s1/user_task_1/none/none.json'];
  makeTar(t3, missing);
  const s3 = sealTarball(t3, manifest);
  let threw = false; try { verifyCounts(s3, manifest); } catch { threw = true; }
  ok('refuses a missing cohort file (count mismatch)', threw && s3.total === 3);

  ok('cohortPath rejects an unlisted pipeline', cohortPath(manifest, ROOT + 'runs/pX/s1/user_task_0/none/none.json') === null);
  ok('cohortPath parses user_task and injection_task', (() => {
    const a = cohortPath(manifest, ROOT + 'runs/p1/s1/user_task_1/important_instructions/injection_task_0.json');
    const b = cohortPath(manifest, ROOT + 'runs/p1/s1/user_task_1/none/none.json');
    return a?.user_task === 1 && a?.injection_task === 0 && a?.attacked === true && b?.injection_task === null && b?.attacked === false;
  })());
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(fails ? `fetch tests: ${fails} FAIL` : 'fetch tests: PASS');
if (fails) process.exit(1);
