# Nightly cross-version conformance

`.github/workflows/conformance.yml` runs the repo's **own** test suites every night
across runtime versions, records every cell's result and timings into an
accumulating JSON history, and renders a static dashboard of the last 30 runs.

| suite | command (unchanged from ci.yml / package.json) | versions | cells |
|---|---|---|---|
| API (`packages/api`, vitest) | `npm ci` → `npm test --workspace=packages/api` | Node 20, 22, 24 | 3 |
| TS SDK (`packages/sdk`, vitest) | `npm ci` → `npm test --workspace=packages/sdk` | Node 22, 24 | 2 |
| Python SDK (`packages/python`, pytest) | `pip install -e "packages/python[dev]"` → `pytest packages/python/tests` | Python 3.9 (declared floor), 3.13 | 2 |

7 matrix cells, `fail-fast: false`, so one red runtime never hides another.
The suites run against in-process code (vitest, pytest with mocked HTTP); the
matrix makes **no** calls to the production registry.

A separate job, **"Production smoke — single read-only GET (not part of
matrix)"**, sends exactly one unauthenticated `GET https://api.basedagents.ai/v1/status`
(no retries, redirects not followed) and records HTTP code + latency on its own
dashboard row. It has `permissions: {}` and does not gate the matrix.

## What each run produces

| artifact | contents | retention |
|---|---|---|
| `cell-<cell>` (×7) | `result.json` (status, runtime actually used, install ms, test ms, JUnit totals, first failing tests), `install.log`, `test.log`, `junit.xml` | 90 d |
| `prod-smoke` | `smoke.json`, response body | 90 d |
| `conformance-history` | `history.json` — every run so far (cap 100), newest last | 90 d |
| `conformance-dashboard` | rendered `index.html` + `history.json` + `run.json` | 90 d |
| `github-pages` | same site, deployed by the `pages` job | — |

Per-cell timings are visible three ways: the job's step summary table, the
`result.json` (`install.ms`, `test.ms`), and the dashboard (test-step seconds in
every square, plus install / test / whole-job seconds for the latest run — the
whole-job figure comes from GitHub's own jobs API).

## How the history accumulates (the mechanism)

1. Each cell runs `conformance/scripts/run-cell.mjs`, which times install and
   test separately, tees logs, parses JUnit, writes `result.json`, and exits
   non-zero when the cell is red. The result is uploaded even when red.
2. The `history` job (`if: always()`) downloads all `cell-*` artifacts and
   `prod-smoke`, then `conformance/scripts/fetch-history.sh` finds the newest
   **earlier run** of this workflow that still has a `conformance-history`
   artifact and downloads its `history.json` (`gh run list` / `gh run download`,
   `actions: read`). If none is reachable (first run, or > 90 days idle) it
   falls back to `docs/history.json` on the `conformance-dashboard` branch, and
   only then starts a fresh history.
3. `conformance/scripts/aggregate.mjs` folds this run into one record
   (expected cells that produced no result are recorded as `missing`, never
   silently dropped; a re-run attempt replaces its own record instead of
   double-counting) and appends it. History is capped at 100 runs.
4. `conformance/dashboard/render.mjs` turns `history.json` into one static
   `index.html` — no JavaScript, no external requests. Rows are cells, columns
   the newest 30 runs; hover for counts and failing tests, click for the job log.
5. The site is uploaded as the `conformance-history` / `conformance-dashboard`
   artifacts and as a Pages artifact; the `pages` job deploys it. As a
   fallback that needs no Pages setting, `conformance/scripts/publish-branch.sh`
   commits it to `conformance-dashboard:docs/` (commit message carries
   `[skip ci]`; the branch contains only `docs/` and never touches `main`).

Re-render locally from any history: `node conformance/dashboard/render.mjs history.json index.html`.

## Adopting this upstream in one afternoon

1. **Copy four things** into the repo: `.github/workflows/conformance.yml`,
   `conformance/scripts/`, `conformance/dashboard/`, this README. No package
   or lockfile changes; the workflow only calls existing npm/pytest commands.
2. **Pages**: Settings → Pages → Build and deployment → Source: **GitHub
   Actions**. (The `pages` job uses the `github-pages` environment; if the repo
   restricts environments to protected branches, allow `main`.) If you would
   rather not use Pages, set `PUBLISH_BRANCH` and serve
   `conformance-dashboard` / `docs` — or set `PUBLISH_BRANCH: ''` and read the
   `conformance-dashboard` artifact.
3. **Branch protection**: if `main` rules forbid pushes from Actions, that does
   not matter — the fallback pushes only to `conformance-dashboard`. If *all*
   branches are protected, add an exception for it or disable the fallback.
4. **Run it once by hand**: Actions → "Conformance (nightly cross-version)" →
   Run workflow. Expect ~5–8 min. Run it a second time to see history accumulate
   (the second dashboard shows 2 columns).
5. **Tune**: versions live in each job's `matrix:` (keep `EXPECTED_CELLS` in
   sync so a missing cell shows as `?`); `HISTORY_KEEP`, `DASHBOARD_WINDOW`,
   and the cron (`37 3 * * *` UTC) are in `env:` / `on:`.
6. **Optional**: make a red night notify someone — GitHub already emails the
   workflow's last editor on scheduled-run failure; add a Slack step to the
   `history` job if you want more.

No secrets are needed. Permissions are least-privilege per job:
`contents: read` by default; `history` adds `actions: read` (find the previous
history) and `contents: write` (fallback branch only); `pages` gets
`pages: write` + `id-token: write`; `prod-smoke` gets none.

## Status in this fork (kang250827-source/basedagents)

- Runs: https://github.com/kang250827-source/basedagents/actions/workflows/conformance.yml
- Dashboard: GitHub Pages is **not enabled** in this fork yet, so the `pages`
  job is red (`continue-on-error`, it does not fail the run) with
  "Ensure GitHub Pages has been enabled". The same static site is published by
  the fallback to the `conformance-dashboard` branch, `docs/` folder
  (`docs/index.html`, `docs/history.json`) and as the `conformance-dashboard`
  artifact of every run. Once Settings → Pages → Source = GitHub Actions is
  set, the next run deploys it to https://kang250827-source.github.io/basedagents/.

### Known red cell: `api-node24` (honest red, diagnosed)

6 of 7 cells are green. The API suite on **Node 24** is red on every run so far:
vitest reports `Test Files 53 passed (75)` / `Tests 775 passed (1289)` /
`Errors 22 errors` (run 1) and `749 passed`, `24 errors` (run 2). No test
assertion fails; 22–26 vitest fork workers abort while tearing down, with

```
# node::RemoveEnvironmentCleanupHook(...) at ../src/api/hooks.cc:142
# Assertion failed: (env) != nullptr
 4: Database::~Database()   [.../better-sqlite3/build/Release/better_sqlite3.node]
 4: Statement::~Statement() [.../better-sqlite3/build/Release/better_sqlite3.node]
```

Cause: `package-lock.json` pins **better-sqlite3 11.10.0**, which publishes no
Node 24 (ABI 137) prebuild (only `node-v127` for Linux x64), so on Node 24 it is
compiled from source during `npm ci` (install 88–93 s vs 4–6 s on Node 20/22)
and that build aborts in its native destructors when a worker exits.
better-sqlite3 **v12.0.0** release notes: "Add node v24 to build matrix".

Experiment (`.github/workflows/diagnose-node24.yml`, same suite, Node 24.21.0,
run https://github.com/kang250827-source/basedagents/actions/runs/39141777570):

| variant | better-sqlite3 | result |
|---|---|---|
| locked | 11.10.0 | Test Files 49 passed (75), Tests 723 passed (1289), Errors 26 — **red** |
| bsql-12 | 12.11.1 (bumped in the runner only) | Test Files 75 passed (75), Tests 1289 passed (1289) — **green** |

Suggested upstream fix (not applied here, the matrix tests the repo as it is):
bump `better-sqlite3` in `packages/api` to `^12` (Node ≥ 20 required, which
matches the matrix). Node 20/22 production paths are unaffected today; the
API's production runtime is Cloudflare Workers/D1, so this is a local/test and
self-hosting compatibility issue, not a production outage.

Note for forks: GitHub disables scheduled workflows in forks until Actions are
enabled there, and pauses schedules in any repo after 60 days without activity.
