#!/usr/bin/env bash
# Fallback publisher: commits the rendered dashboard (<site>/*) to
# <branch>:docs/ so it can be served by "Pages → Deploy from a branch
# (<branch>, /docs)" or browsed as files when Pages-from-Actions is not on.
# The branch only ever contains docs/; it never touches main.
set -euo pipefail
site=$1
branch=$2
wt=$(mktemp -d)
git config --global user.name  "conformance-bot"
git config --global user.email "41898282+github-actions[bot]@users.noreply.github.com"
if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  git fetch -q --depth 1 origin "$branch"
  git worktree add -q --detach "$wt" FETCH_HEAD
else
  git worktree add -q --detach "$wt"
  git -C "$wt" checkout -q --orphan tmp-publish
  git -C "$wt" rm -rfq . >/dev/null 2>&1 || true
  git -C "$wt" clean -fdq
fi
rm -rf "$wt/docs"
mkdir -p "$wt/docs"
cp -R "$site"/. "$wt/docs/"
cat > "$wt/README.md" <<EOF
# conformance-dashboard (generated)

Written by .github/workflows/conformance.yml on every run. docs/index.html is the
static dashboard, docs/history.json the accumulating run history. Do not edit by hand.
EOF
git -C "$wt" add -A
if git -C "$wt" diff --cached --quiet; then echo "nothing to publish"; exit 0; fi
git -C "$wt" commit -qm "conformance: run ${GITHUB_RUN_NUMBER:-?} (${GITHUB_RUN_ID:-local}) [skip ci]"
git -C "$wt" push -q origin "HEAD:refs/heads/$branch"
echo "published to $branch:docs/ ($(git -C "$wt" rev-parse --short HEAD))"
