#!/usr/bin/env node
// Runs one conformance matrix cell: an install command, then a test command,
// each timed and logged, and writes <out>/result.json describing the cell.
//
//   node conformance/scripts/run-cell.mjs \
//     --cell api-node22 --suite api --runtime node --requested 22 \
//     --install "npm ci --no-audit --no-fund" \
//     --test "npm test --workspace=packages/api -- --reporter=default --reporter=junit --outputFile.junit=$OUT/junit.xml" \
//     --junit "$OUT/junit.xml" --out "$OUT"
//
// Exit code: 0 when install and tests both pass, otherwise non-zero, so the
// matrix cell itself goes red. result.json is written in every case (the
// aggregate job reads it even for red cells). No network calls are made here
// beyond whatever the install command itself does (package registries).
import { spawn, execSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}
const a = args(process.argv.slice(2));
for (const k of ['cell', 'suite', 'runtime', 'requested', 'test', 'out']) {
  if (!a[k]) { console.error(`run-cell: missing --${k}`); process.exit(64); }
}
mkdirSync(a.out, { recursive: true });

function run(label, cmd, logFile) {
  return new Promise((resolve) => {
    const log = createWriteStream(logFile);
    const started = Date.now();
    console.log(`::group::${label}: ${cmd}`);
    const child = spawn(cmd, { shell: '/bin/bash', stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { process.stdout.write(d); log.write(d); });
    child.stderr.on('data', (d) => { process.stderr.write(d); log.write(d); });
    child.on('close', (code, signal) => {
      const ms = Date.now() - started;
      console.log('::endgroup::');
      console.log(`${label}: exit=${code}${signal ? ` signal=${signal}` : ''} in ${(ms / 1000).toFixed(1)}s`);
      // Wait for the log file to be fully flushed before anyone reads it.
      log.end(() => resolve({ exit: code ?? 128, ms }));
    });
  });
}

function actualRuntime(runtime) {
  try {
    if (runtime === 'node') return execSync('node -v').toString().trim();
    if (runtime === 'python') return execSync('python -V 2>&1').toString().trim().replace(/^Python\s+/, '');
  } catch { /* fall through */ }
  return 'unknown';
}

// Minimal JUnit reader: totals from the root <testsuites> (vitest) or summed
// <testsuite> elements (pytest writes <testsuites><testsuite .../>).
function readJunit(file) {
  if (!file || !existsSync(file)) return null;
  const xml = readFileSync(file, 'utf8');
  const attr = (tag, name) => { const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`)); return m ? Number(m[1]) : 0; };
  const suites = [...xml.matchAll(/<testsuite\b[^>]*>/g)].map((m) => m[0]);
  const t = { tests: 0, failures: 0, errors: 0, skipped: 0, time_s: 0 };
  for (const s of suites) {
    t.tests += attr(s, 'tests'); t.failures += attr(s, 'failures'); t.errors += attr(s, 'errors');
    t.skipped += attr(s, 'skipped'); t.time_s += attr(s, 'time');
  }
  t.time_s = Math.round(t.time_s * 1000) / 1000;
  // First few failing test names, for the dashboard tooltip / diagnosis.
  t.failed_cases = [...xml.matchAll(/<testcase\b[^>]*classname="([^"]*)"[^>]*name="([^"]*)"[^>]*>\s*<(failure|error)\b/g)]
    .slice(0, 20).map((m) => `${m[1]} › ${m[2]}`);
  t.passed = t.tests - t.failures - t.errors - t.skipped;
  return t;
}

const startedAt = new Date().toISOString();
const install = a.install ? await run('install', a.install, join(a.out, 'install.log')) : { exit: 0, ms: 0, skipped: true };
let test = { exit: null, ms: 0, skipped: true };
if (install.exit === 0) test = await run('test', a.test, join(a.out, 'test.log'));
const finishedAt = new Date().toISOString();

// Vitest's own end-of-run summary is authoritative when a worker crashes: its
// JUnit file can still list every test case without a <failure>, while the
// summary says e.g. "Tests 775 passed (1289)" and "Errors 22 errors".
function readVitestSummary(logFile) {
  if (!existsSync(logFile)) return null;
  const log = readFileSync(logFile, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
  const num = (re) => { const m = log.match(re); return m ? Number(m[1]) : null; };
  const files = log.match(/Test Files\s+(.*?)\((\d+)\)/);
  const tests = log.match(/^\s*Tests\s+(.*?)\((\d+)\)/m);
  if (!files && !tests) return null;
  const count = (str, word) => { const m = str?.match(new RegExp(`(\\d+) ${word}`)); return m ? Number(m[1]) : 0; };
  return {
    files_total: files ? Number(files[2]) : null, files_passed: count(files?.[1], 'passed'), files_failed: count(files?.[1], 'failed'),
    tests_total: tests ? Number(tests[2]) : null, tests_passed: count(tests?.[1], 'passed'), tests_failed: count(tests?.[1], 'failed'),
    tests_skipped: count(tests?.[1], 'skipped'),
    unhandled_errors: num(/^\s*Errors\s+(\d+) errors?/m) ?? 0,
  };
}

const status = install.exit !== 0 ? 'error' : test.exit === 0 ? 'pass' : 'fail';
const result = {
  schema: 1,
  cell: a.cell,
  suite: a.suite,
  runtime: { name: a.runtime, requested: a.requested, actual: actualRuntime(a.runtime) },
  status,
  install,
  test,
  junit: readJunit(a.junit),
  vitest_summary: a.suite === 'python' ? null : readVitestSummary(join(a.out, 'test.log')),
  started_at: startedAt,
  finished_at: finishedAt,
  run_id: process.env.GITHUB_RUN_ID ?? null,
  run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  sha: process.env.GITHUB_SHA ?? null,
  runner: { os: process.env.RUNNER_OS ?? null, arch: process.env.RUNNER_ARCH ?? null, image: process.env.ImageOS ?? null },
};
writeFileSync(join(a.out, 'result.json'), JSON.stringify(result, null, 2) + '\n');

if (process.env.GITHUB_STEP_SUMMARY) {
  const j = result.junit;
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `| cell | runtime | status | install | tests | passed/total |\n|---|---|---|---|---|---|\n` +
    `| ${a.cell} | ${a.runtime} ${result.runtime.actual} | ${status} | ${(install.ms / 1000).toFixed(1)}s | ${(test.ms / 1000).toFixed(1)}s | ${j ? `${j.passed}/${j.tests}` : 'n/a'} |\n`);
}
console.log(`RESULT ${a.cell}: ${status} (install ${(install.ms / 1000).toFixed(1)}s, test ${(test.ms / 1000).toFixed(1)}s)`);
process.exit(status === 'pass' ? 0 : (install.exit || test.exit || 1));
