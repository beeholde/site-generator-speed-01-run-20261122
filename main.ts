// v10 driver: the harness runs `node /bot/main.ts` (node22). It reads every case
// from /input/cases.json, answers each one alone with run() from solve.js, and
// writes /output/answers.json: a JSON array of the answers, one per case and in
// the cases' order. v10's run() returns each case's answer as its JSON text, so
// this driver streams the texts straight to the file (bracket, text, comma,
// text, ...) instead of joining them into one 7 MB string first: no big
// join, no big Buffer, lower peak heap, less GC in the timed tail.
// Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for
// /input and /output.

import { readFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8 tuning, set before solve.js is imported so all of its work runs under it.
// The house baseline runs with --no-incremental-marking, and the rules say an
// entry may tune V8's flags the same way; --no-turbofan is added because the
// optimizing compiler's background threads burn CPU on a cold single run and
// never pay off here.
setFlagsFromString('--no-incremental-marking');
setFlagsFromString('--no-turbofan');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => string };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const fd = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
writeSync(fd, '[');
for (let i = 0; i < cases.length; i++) {
  if (i) writeSync(fd, ',');
  writeSync(fd, run(cases[i].input));
}
writeSync(fd, ']');
closeSync(fd);
