#!/usr/bin/env node
// Renders the static conformance dashboard from history.json.
//
//   node conformance/dashboard/render.mjs site/history.json site/index.html
//
// Output is one self-contained HTML file: no JavaScript, no external fonts,
// scripts, images or services. The full history.json is published next to it.
// Rows = matrix cells, columns = the newest 30 runs (oldest left, newest right).
import { readFileSync, writeFileSync } from 'node:fs';

const [, , src = 'history.json', dest = 'index.html'] = process.argv;
const WINDOW = Number(process.env.DASHBOARD_WINDOW ?? 30);
const history = JSON.parse(readFileSync(src, 'utf8'));
const runs = (history.runs ?? []).slice(-WINDOW);
const latest = runs[runs.length - 1];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const secs = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`);
const when = (iso) => (iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—');
const SYMBOL = { pass: '✓', fail: '✗', error: '!', missing: '?' };

// Every cell name ever seen in the window, so a cell added later still gets a row.
const cellNames = [...new Set(runs.flatMap((r) => r.cells.map((c) => c.cell)))]
  .sort((x, y) => x.localeCompare(y, 'en', { numeric: true }));

function square(run, cell) {
  if (!cell) return `<td class="sq none" title="not in this run">·</td>`;
  const t = cell.tests ? `${cell.tests.passed}/${cell.tests.total} passed` : 'no test report';
  const tip = `run #${run.run_number ?? run.run_id} (${when(run.recorded_at)}) — ${cell.cell}: ${cell.status}; ${t}; install ${secs(cell.install_ms)}, tests ${secs(cell.test_ms)}`
    + (cell.failed_cases?.length ? `; failing: ${cell.failed_cases.slice(0, 3).join(' | ')}` : '');
  const href = cell.job_url ?? run.url;
  const inner = `${SYMBOL[cell.status] ?? '?'}<small>${secs(cell.test_ms)}</small>`;
  return `<td class="sq ${esc(cell.status)}" title="${esc(tip)}">${href ? `<a href="${esc(href)}">${inner}</a>` : inner}</td>`;
}

const header = runs.map((r) => `<th class="col" title="${esc(when(r.recorded_at))} · ${esc(r.event)} · ${esc((r.sha ?? '').slice(0, 7))}">${r.url ? `<a href="${esc(r.url)}">#${esc(r.run_number ?? r.run_id)}</a>` : `#${esc(r.run_id)}`}</th>`).join('');

const rows = cellNames.map((name) => {
  const seen = runs.map((r) => r.cells.find((c) => c.cell === name)).filter(Boolean);
  const passes = seen.filter((c) => c.status === 'pass').length;
  return `<tr><th class="row">${esc(name)}</th><td class="rate">${passes}/${seen.length}</td>${runs.map((r) => square(r, r.cells.find((c) => c.cell === name))).join('')}</tr>`;
}).join('\n');

const smokeRow = `<tr class="smoke"><th class="row">prod smoke (1 GET)</th><td class="rate">${runs.filter((r) => r.prod_smoke?.status === 'pass').length}/${runs.length}</td>${runs.map((r) => {
  const s = r.prod_smoke ?? { status: 'missing' };
  const tip = `${s.method ?? 'GET'} ${s.url ?? ''} → HTTP ${s.http_code ?? '—'} in ${s.time_total_s ?? '—'}s`;
  return `<td class="sq ${esc(s.status)}" title="${esc(tip)}">${SYMBOL[s.status] ?? '?'}<small>${esc(s.http_code ?? '')}</small></td>`;
}).join('')}</tr>`;

const latestTable = latest ? latest.cells.map((c) => `<tr class="${esc(c.status)}"><td>${esc(c.cell)}</td><td>${esc(c.runtime ? `${c.runtime.name} ${c.runtime.actual}` : '—')}</td><td class="st">${esc(c.status)}</td><td>${c.tests ? `${c.tests.passed}/${c.tests.total}${c.tests.skipped ? ` (${c.tests.skipped} skipped)` : ''}` : '—'}</td><td>${secs(c.install_ms)}</td><td>${secs(c.test_ms)}</td><td>${secs(c.job_ms)}</td><td>${c.job_url ? `<a href="${esc(c.job_url)}">job</a>` : '—'}</td></tr>`
  + (c.failed_cases?.length ? `<tr class="fails"><td colspan="8">failing: ${c.failed_cases.map(esc).join('<br>')}</td></tr>` : '')).join('\n') : '';

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BasedAgents conformance — ${latest ? esc(latest.matrix_status) : 'no runs'}</title>
<style>
:root{--pass:#1f883d;--fail:#cf222e;--error:#9a6700;--missing:#6e7781;--bg:#fff;--fg:#1f2328;--mute:#59636e;--line:#d1d9e0}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mute:#9198a1;--line:#3d444d}}
body{font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg);margin:2rem auto;max-width:1200px;padding:0 1rem}
h1{font-size:1.4rem;margin:0 0 .25rem}h2{font-size:1.05rem;margin:2rem 0 .5rem}
.meta{color:var(--mute)}a{color:inherit}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:6px}
table{border-collapse:collapse}
.grid th,.grid td{border-bottom:1px solid var(--line);padding:3px}
.grid th.row{text-align:left;white-space:nowrap;padding-right:.75rem;position:sticky;left:0;background:var(--bg)}
.grid th.col{font-weight:normal;font-size:11px;color:var(--mute);white-space:nowrap}
.grid td.rate{font-variant-numeric:tabular-nums;color:var(--mute);padding-right:.5rem}
.sq{min-width:38px;text-align:center;font-weight:600;color:#fff;border-radius:3px;font-size:13px}
.sq a{color:#fff;text-decoration:none;display:block}
.sq small{display:block;font-weight:normal;font-size:9px;opacity:.9}
.sq.pass{background:var(--pass)}.sq.fail{background:var(--fail)}.sq.error{background:var(--error)}.sq.missing{background:var(--missing)}.sq.none{color:var(--mute)}
tr.smoke th.row{font-style:italic}
.latest td,.latest th{border-bottom:1px solid var(--line);padding:4px 10px;text-align:left;font-variant-numeric:tabular-nums}
.latest tr.pass .st{color:var(--pass);font-weight:600}.latest tr.fail .st,.latest tr.error .st{color:var(--fail);font-weight:600}
.latest tr.fails td{font-size:12px;color:var(--mute)}
.badge{display:inline-block;padding:2px 10px;border-radius:999px;color:#fff;font-weight:600}
.badge.pass{background:var(--pass)}.badge.fail{background:var(--fail)}
footer{margin-top:2rem;color:var(--mute);font-size:12px}
</style></head><body>
<h1>BasedAgents nightly cross-version conformance</h1>
<p class="meta">${latest ? `Latest run <a href="${esc(latest.url)}">#${esc(latest.run_number ?? latest.run_id)}</a> · ${esc(when(latest.recorded_at))} · ${esc(latest.event)} · <code>${esc((latest.sha ?? '').slice(0, 7))}</code> · matrix <span class="badge ${esc(latest.matrix_status)}">${esc(latest.matrix_status)}</span>` : 'No runs recorded yet.'}
<br>Showing the newest ${runs.length} of ${history.runs?.length ?? 0} stored run(s) (window ${WINDOW}). Generated ${esc(when(history.updated_at))} from <a href="history.json">history.json</a>.</p>

<h2>Per-cell history (oldest → newest)</h2>
<div class="scroll"><table class="grid">
<thead><tr><th class="row">cell</th><th class="col">pass</th>${header}</tr></thead>
<tbody>
${rows}
${smokeRow}
</tbody></table></div>
<p class="meta">✓ pass · ✗ tests failed · ! install/setup failed · ? job produced no result. Small number = test-step wall time. Hover a square for counts and failing tests; click for the job log.
The prod-smoke row is a single read-only <code>GET</code> against the production API, run in its own job; it never gates the matrix.</p>

<h2>Latest run, per cell</h2>
<div class="scroll"><table class="latest">
<thead><tr><th>cell</th><th>runtime</th><th>status</th><th>tests</th><th>install</th><th>test step</th><th>job (GitHub)</th><th></th></tr></thead>
<tbody>
${latestTable}
</tbody></table></div>

<footer>Static page rendered by conformance/dashboard/render.mjs. No scripts, no external requests. History is carried run-to-run as the <code>conformance-history</code> Actions artifact (see conformance/README.md).</footer>
</body></html>
`;
writeFileSync(dest, html);
console.log(`dashboard: ${runs.length} run(s) × ${cellNames.length} cell(s) → ${dest}`);
