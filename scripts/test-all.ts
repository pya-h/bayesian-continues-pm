#!/usr/bin/env bun
// Aggregated test runner. Runs every workspace's own `test` script (so each keeps
// its native flags — the api suite still gets `--isolate --env-file`), tees the
// live output to per-package logs under `.test-logs/`, then prints one combined
// table with grand totals. Exits non-zero if any package fails or errors.
// bun run test # = this script
// bun run scripts/test-all.ts core api # only those packages

import { mkdirSync, writeFileSync } from 'node:fs';

interface Pkg {
  name: string;
  filter: string;
}
const ALL: Pkg[] = [
  { name: 'core', filter: '@bmm/core' },
  { name: 'shared', filter: '@bmm/shared' },
  { name: 'api', filter: '@bmm/api' },
  { name: 'web', filter: '@bmm/web' },
];

const wanted = process.argv.slice(2);
const PKGS = wanted.length ? ALL.filter((p) => wanted.includes(p.name)) : ALL;

const LOG_DIR = '.test-logs';
mkdirSync(LOG_DIR, { recursive: true });

interface Result {
  name: string;
  pass: number;
  fail: number;
  expects: number;
  tests: number;
  files: number;
  ms: number;
  exitCode: number;
}

// ESC[…m colour codes — built from char code so the source has no literal control char.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
function lastNum(text: string, re: RegExp): number {
  const ms = [...text.matchAll(re)];
  return ms.length ? Number(ms[ms.length - 1][1]) : 0;
}

async function runPkg(pkg: Pkg): Promise<Result> {
  const started = Date.now();
  process.stdout.write(`\n\x1b[1m▶ ${pkg.name}\x1b[0m  (${pkg.filter})\n`);
  const proc = Bun.spawn(['bun', 'run', '--filter', pkg.filter, 'test'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let buf = '';
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    // @ts-expect-error Bun ReadableStream is async-iterable
    for await (const chunk of stream) {
      const s = dec.decode(chunk);
      buf += s;
      process.stdout.write(s);
    }
  };
  await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
  const exitCode = await proc.exited;
  writeFileSync(`${LOG_DIR}/${pkg.name}.log`, buf);

  const clean = buf.replace(ANSI, '');
  return {
    name: pkg.name,
    pass: lastNum(clean, /(\d+) pass\b/g),
    fail: lastNum(clean, /(\d+) fail\b/g),
    expects: lastNum(clean, /(\d+) expect\(\) calls/g),
    tests: lastNum(clean, /Ran (\d+) tests? across/g),
    files: lastNum(clean, /across (\d+) files?/g),
    ms: Date.now() - started,
    exitCode,
  };
}

const results: Result[] = [];
for (const pkg of PKGS) results.push(await runPkg(pkg));

const G = '\x1b[32m';
const R = '\x1b[31m';
const DIM = '\x1b[2m';
const B = '\x1b[1m';
const X = '\x1b[0m';

const pad = (s: string | number, n: number) => String(s).padStart(n);
const padr = (s: string, n: number) => s.padEnd(n);

let anyBad = false;
const total = { pass: 0, fail: 0, expects: 0, tests: 0, files: 0, ms: 0 };

const rows = results.map((r) => {
  const errored = r.exitCode !== 0 || r.fail > 0;
  if (errored) anyBad = true;
  total.pass += r.pass;
  total.fail += r.fail;
  total.expects += r.expects;
  total.tests += r.tests;
  total.files += r.files;
  total.ms += r.ms;
  const status = errored ? `${R}✗ FAIL${X}` : r.tests === 0 ? `${DIM}∅ none${X}` : `${G}✓ pass${X}`;
  return { ...r, status };
});

process.stdout.write(`\n${B}━━━ test summary ━━━${X}\n`);
const head = `${B}${padr('package', 10)}${pad('status', 9)}${pad('pass', 7)}${pad('fail', 6)}${pad('tests', 7)}${pad('files', 7)}${pad('asserts', 9)}${pad('time', 9)}${X}\n`;
process.stdout.write(head);
for (const r of rows) {
  process.stdout.write(
    `${padr(r.name, 10)}${pad(r.status, 9 + 9)}${pad(r.pass, 7)}${pad(r.fail, 6)}${pad(r.tests, 7)}${pad(r.files, 7)}${pad(r.expects, 9)}${pad(`${(r.ms / 1000).toFixed(1)}s`, 9)}\n`,
  );
}
const totColor = anyBad ? R : G;
process.stdout.write(`${DIM}${'─'.repeat(64)}${X}\n`);
process.stdout.write(
  `${B}${padr('TOTAL', 10)}${X}${pad(`${totColor}${anyBad ? '✗' : '✓'}${X}`, 9 + 9)}${pad(total.pass, 7)}${pad(total.fail, 6)}${pad(total.tests, 7)}${pad(total.files, 7)}${pad(total.expects, 9)}${pad(`${(total.ms / 1000).toFixed(1)}s`, 9)}\n`,
);

const verdict = anyBad
  ? `${R}${B}FAILED${X} — see .test-logs/<package>.log`
  : `${G}${B}ALL PASSED${X} — ${total.pass} tests across ${PKGS.length} packages`;
process.stdout.write(`\n${verdict}\n`);

writeFileSync(
  `${LOG_DIR}/summary.txt`,
  [
    'package  status  pass  fail  tests  files  asserts  time',
    ...rows.map(
      (r) =>
        `${r.name}  ${r.exitCode !== 0 || r.fail > 0 ? 'FAIL' : 'pass'}  ${r.pass}  ${r.fail}  ${r.tests}  ${r.files}  ${r.expects}  ${(r.ms / 1000).toFixed(1)}s`,
    ),
    `TOTAL  ${anyBad ? 'FAIL' : 'pass'}  ${total.pass}  ${total.fail}  ${total.tests}  ${total.files}  ${total.expects}  ${(total.ms / 1000).toFixed(1)}s`,
  ].join('\n'),
);

process.exit(anyBad ? 1 : 0);
