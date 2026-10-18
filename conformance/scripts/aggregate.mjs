#!/usr/bin/env node
// Folds this run's matrix cells (result.json per cell) and the production
// smoke result into one run record, appends it to the history carried forward
// from the previous run, and writes <out>/history.json + <out>/run.json.
//
//   node conformance/scripts/aggregate.mjs --cells cells --smoke smoke \
//     --prev prev/history.json --jobs jobs.json --out site
//
// History is append-only and capped at --keep runs (default 100); the
// dashboard shows the newest 30. A run that already exists in the history
// (same run_id + attempt) is replaced, so re-runs never double-count.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const a = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
const keep = Number(a.keep ?? 100);
mkdirSync(a.out, { recursive: true });

function findFiles(dir, name, acc = []) {
  if (!dir || !existsSync(dir)) return acc;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) findFiles(p, name, acc);
    else if (e === name) acc.push(p);
  }
  return acc;
}
const readJson = (p, fallback) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } };

// GitHub's own view of each job (html_url, timings, conclusion) when available.
const jobs = readJson(a.jobs, { jobs: [] }).jobs ?? [];
const jobFor = (cell) => jobs.find((j) => j.name?.includes(`[${cell}]`));

// Prefer the runner's own summary (vitest) over JUnit totals: a crashed worker
// leaves JUnit cases without <failure> although they never reported a result.
// For a non-passing cell whose JUnit shows zero failures, say so explicitly.
function testsOf(c) {
  const v = c.vitest_summary;
  if (v && v.tests_total != null) {
    return { total: v.tests_total, passed: v.tests_passed, failed: v.tests_failed, skipped: v.tests_skipped,
      unhandled_errors: v.unhandled_errors, files: `${v.files_passed}/${v.files_total}`, source: 'vitest-summary' };
  }
  if (!c.junit) return null;
  const t = { total: c.junit.tests, passed: c.junit.passed, failed: c.junit.failures + c.junit.errors, skipped: c.junit.skipped, source: 'junit' };
  if (c.status !== 'pass' && t.failed === 0) { t.passed = null; t.note = 'cell failed outside test assertions (crash/unhandled error); JUnit counts not trustworthy'; }
  return t;
}

const cells = findFiles(a.cells, 'result.json').map((p) => readJson(p, null)).filter(Boolean)
  .map((c) => {
    const j = jobFor(c.cell);
    return {
      cell: c.cell, suite: c.suite, runtime: c.runtime, status: c.status,
      install_ms: c.install?.ms ?? null, test_ms: c.test?.ms ?? null,
      job_ms: j?.started_at && j?.completed_at ? Date.parse(j.completed_at) - Date.parse(j.started_at) : null,
      tests: testsOf(c),
      failed_cases: c.junit?.failed_cases?.slice(0, 10) ?? [],
      job_url: j?.html_url ?? null,
    };
  });

// Cells that were expected but produced no result.json (job cancelled, runner
// lost, setup step failed before run-cell) are recorded as "missing" from the
// matrix definition, so a silent hole can never look green.
const expected = (a.expected ?? '').split(',').map((s) => s.trim()).filter(Boolean);
for (const name of expected) {
  if (!cells.some((c) => c.cell === name)) {
    const j = jobFor(name);
    cells.push({ cell: name, suite: name.split('-')[0], runtime: null, status: 'missing', install_ms: null, test_ms: null,
      job_ms: null, tests: null, failed_cases: [], job_url: j?.html_url ?? null, job_conclusion: j?.conclusion ?? null });
  }
}
cells.sort((x, y) => x.cell.localeCompare(y.cell, 'en', { numeric: true }));

const smoke = findFiles(a.smoke, 'smoke.json').map((p) => readJson(p, null)).filter(Boolean)[0] ?? { status: 'missing' };

const server = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
const repo = process.env.GITHUB_REPOSITORY ?? null;
const runId = process.env.GITHUB_RUN_ID ?? 'local';
const attempt = process.env.GITHUB_RUN_ATTEMPT ?? '1';
const run = {
  schema: 1,
  run_id: runId,
  run_attempt: attempt,
  run_number: process.env.GITHUB_RUN_NUMBER ?? null,
  event: process.env.GITHUB_EVENT_NAME ?? null,
  sha: process.env.GITHUB_SHA ?? null,
  ref: process.env.GITHUB_REF_NAME ?? null,
  url: repo ? `${server}/${repo}/actions/runs/${runId}/attempts/${attempt}` : null,
  recorded_at: new Date().toISOString(),
  matrix_status: cells.every((c) => c.status === 'pass') ? 'pass' : 'fail',
  cells,
  prod_smoke: smoke,
};

const prev = readJson(a.prev, { schema: 1, runs: [] });
const runs = (prev.runs ?? []).filter((r) => !(String(r.run_id) === String(runId) && String(r.run_attempt) === String(attempt)));
runs.push(run);
runs.sort((x, y) => Date.parse(x.recorded_at) - Date.parse(y.recorded_at));
const history = { schema: 1, repo, updated_at: run.recorded_at, keep, runs: runs.slice(-keep) };

writeFileSync(join(a.out, 'history.json'), JSON.stringify(history, null, 2) + '\n');
writeFileSync(join(a.out, 'run.json'), JSON.stringify(run, null, 2) + '\n');
console.log(`history: ${prev.runs?.length ?? 0} previous run(s) + this run → ${history.runs.length} stored`);
for (const c of cells) console.log(`  ${c.cell.padEnd(16)} ${c.status.padEnd(7)} install ${((c.install_ms ?? 0) / 1000).toFixed(1)}s test ${((c.test_ms ?? 0) / 1000).toFixed(1)}s ${c.tests ? `${c.tests.passed}/${c.tests.total}` : ''}`);
console.log(`  prod-smoke       ${smoke.status} ${smoke.http_code ?? ''}`);
