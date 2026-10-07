// S2-local streaming sanitizer (amendment A-S2-4). Imports the FROZEN `sanitizeObs` from pr/sanitize.ts unchanged
// (pr/sanitize.ts itself is not touched). It reads the raw observations line by line — no string longer than one line,
// never one whole-file string — and writes each sanitized row as it goes. Output bytes equal pr/sanitize.ts's
// (`obs.map(sanitizeObs).map(JSON.stringify).join('\n') + '\n'`, so the empty input is the single byte `\n`); the stdout
// line keeps the same format.
//   node eval/ontology/s2/sanitize-s2.ts --in <raw.jsonl> --out <sanitized.jsonl>
import { closeSync, openSync, readSync, writeSync } from 'node:fs';
import { sanitizeObs } from '../pr/sanitize.ts';

/** Yields each line of `path` without the trailing '\n', holding at most one line as a string (the only JS strings
 *  built are one line, or a `Buffer` chunk that is never concatenated into a string). */
export function* lines(path: string): Generator<string> {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(1 << 16);
    let pieces: Buffer[] = [];
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      let start = 0;
      for (;;) {
        const nl = buf.indexOf(0x0a, start);
        if (nl < 0 || nl >= n) break;
        const line = pieces.length ? Buffer.concat([...pieces, buf.subarray(start, nl)]) : buf.subarray(start, nl);
        yield line.toString('utf8');
        pieces = [];
        start = nl + 1;
      }
      if (start < n) pieces.push(Buffer.from(buf.subarray(start, n)));
    }
    if (pieces.length) yield Buffer.concat(pieces).toString('utf8');
  } finally { closeSync(fd); }
}

const arg = (k: string): string | null => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
if (import.meta.url === `file://${process.argv[1]}`) {
  const fin = arg('--in'), fout = arg('--out');
  if (!fin || !fout) throw new Error('--in and --out are required');
  const fd = openSync(fout, 'w');
  let count = 0;
  try {
    for (const line of lines(fin)) {
      if (line === '') continue;   // same as pr/sanitize.ts's `.filter(Boolean)`
      writeSync(fd, JSON.stringify(sanitizeObs(JSON.parse(line) as never)) + '\n');
      count++;
    }
    if (count === 0) writeSync(fd, '\n');   // pr/sanitize.ts writes the single byte '\n' for empty input
  } finally { closeSync(fd); }
  console.log(`sanitize: ${count} observations -> ${fout}`);
}
