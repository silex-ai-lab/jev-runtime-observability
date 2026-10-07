// S1a acceptance: synthetic tarball, path-only selection, per-cell counts, and a count mismatch that fails closed.
//   node eval/ontology/s2/fixtures/fetch/fetch.test.ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchSeal } from '../../fetch-s2.ts';

let fails = 0;
const ok = (n: string, c: boolean, info: unknown = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n} ${info === '' ? '' : JSON.stringify(info)}`); if (!c) fails++; };
const dir = mkdtempSync(join(tmpdir(), 's2fetch-'));
try {
  const tar = join(dir, 'agentdyn.tgz');
  // Two pipelines x two suites, one attacked + one clean each: 8 cohort files, plus a decoy under another pipeline.
  execFileSync('python3', ['-c', `
import tarfile,io,os
root='AgentDyn-abc/'
files=[]
def run(pref,pipeline,suite,ut,tail,obj):
    files.append((root+'runs/%s/%s/user_task_%d/%s'%(pipeline,suite,ut,tail), obj))
for pipeline in ['p1','p2']:
    for suite in ['dailylife','github']:
        run(None,pipeline,suite,0,'important_instructions/injection_task_0.json','{"messages":[]}')
        run(None,pipeline,suite,0,'none/none.json','{"messages":[]}')
files.append((root+'runs/decoy/dailylife/user_task_0/important_instructions/injection_task_0.json','{}'))
with tarfile.open('${tar}','w:gz') as t:
    for name,obj in files:
        b=obj.encode(); ti=tarfile.TarInfo(name); ti.size=len(b); t.addfile(ti, io.BytesIO(b))
`]);
  const expected = (att: number, ben: number) => ({ dailylife: { attacked: att, benign: ben }, github: { attacked: att, benign: ben } });
  const baseManifest = (exp: number) => ({ id: 'x', source: { repo: 'r', commit: 'c', tarball_url: 'u', licence: 'MIT', root_prefix: 'AgentDyn-abc/' }, pipelines: ['p1', 'p2'], suites: ['dailylife', 'github'], attack: 'important_instructions',
    path_regex: '^runs/(?<pipeline>[^/]+)/(?<suite>[^/]+)/user_task_(?<user_task>\\d+)/(?:important_instructions/injection_task_(?<injection_task>\\d+)|none/none)\\.json$',
    expected: { p1: exp === 0 ? expected(1, 1) : expected(1, 1), p2: expected(1, 1) }, user_tasks_per_suite: { dailylife: 1, github: 1 }, total_runs: exp, strata: 4 });
  const good = join(dir, 'good.json'); writeFileSync(good, JSON.stringify(baseManifest(8)));
  const seal = fetchSeal(good, tar);
  ok('seal selects path-only cohort files and counts cells', seal.total === 8 && seal.counts.p1.dailylife.attacked === 1 && seal.counts.p2.github.benign === 1, seal.counts);
  ok('seal records a per-file sha256 for every cohort file', Object.keys(seal.files).length === 8 && Object.values(seal.files).every(h => /^[0-9a-f]{64}$/.test(h)));
  const bad = join(dir, 'bad.json'); const m = baseManifest(8); m.expected.p1.github.attacked = 2; writeFileSync(bad, JSON.stringify(m));
  let threw = false; try { fetchSeal(bad, tar); } catch { threw = true; }
  ok('a count mismatch fails closed', threw);
  const badTotal = join(dir, 'badtotal.json'); writeFileSync(badTotal, JSON.stringify({ ...baseManifest(7) }));
  let threw2 = false; try { fetchSeal(badTotal, tar); } catch { threw2 = true; }
  ok('a total_runs mismatch fails closed', threw2);
  const decoy = join(dir, 'decoy.json'); const d = baseManifest(8); d.pipelines = ['p1', 'p2', 'decoy']; writeFileSync(decoy, JSON.stringify(d));
  ok('a decoy pipeline outside the expected cells is rejected', (() => { try { fetchSeal(decoy, tar); return false; } catch { return true; } })());
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log(fails ? `fetch-s2 tests: ${fails} FAIL` : 'fetch-s2 tests: PASS');
if (fails) process.exit(1);
