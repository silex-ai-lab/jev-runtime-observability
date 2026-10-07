// S1a (plan §3): thin wrapper over eval/kev-onto/fetch.ts for the S2 manifest. Path-only selection, per-file sha256,
// per-cell counts checked against the manifest; any mismatch fails closed. Never parses a run JSON.
//   node eval/ontology/s2/fetch-s2.ts --manifest eval/ontology/s2/manifest-s2.json --tar <tar.gz> --out <seal.json>
//   node eval/ontology/s2/fetch-s2.ts --manifest ... --download <dir> [--out ...]
import { readFileSync, writeFileSync } from 'node:fs';
import { download, sealTarball, verifyCounts } from '../../kev-onto/fetch.ts';
import type { Manifest } from '../../kev-onto/contract.ts';

function flag(k: string): string | undefined { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; }

export function fetchSeal(manifestPath: string, tar: string): ReturnType<typeof sealTarball> {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  const seal = sealTarball(tar, manifest);
  verifyCounts(seal, manifest);                       // per-cell, total and strata; throws on any mismatch
  return seal;
}

if (process.argv[1] != null && import.meta.url === `file://${process.argv[1]}`) {
  const manifestPath = flag('manifest') ?? 'eval/ontology/s2/manifest-s2.json';
  let tar = flag('tar');
  if (flag('download')) { const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest; tar = download(m.source.tarball_url, flag('download')!); }
  if (!tar) throw new Error('pass --tar <tarball> or --download <dir>');
  const seal = fetchSeal(manifestPath, tar);
  const out = flag('out');
  if (out) writeFileSync(out, JSON.stringify(seal, null, 1) + '\n');
  console.log(JSON.stringify({ tarball_sha256: seal.tarball_sha256, total: seal.total, total_bytes: seal.total_bytes, counts: seal.counts }));
}
