#!/usr/bin/env bash
# Puts the previous run's history.json into <dir>/history.json.
# 1) newest earlier run of this workflow that still has the history artifact
# 2) fallback: docs/history.json on $PUBLISH_BRANCH (if it exists)
# 3) otherwise start a fresh history (the dashboard then shows 1 run)
set -uo pipefail
dir=${1:-prev}
mkdir -p "$dir"
wf=${WORKFLOW_FILE:-conformance.yml}
art=${HISTORY_ARTIFACT:-conformance-history}

ids=$(gh run list -R "$GITHUB_REPOSITORY" --workflow "$wf" --limit 40 --json databaseId \
  -q ".[] | select(.databaseId != ${GITHUB_RUN_ID}) | .databaseId" 2>/dev/null || true)
for id in $ids; do
  if gh run download "$id" -R "$GITHUB_REPOSITORY" -n "$art" -D "$dir" >/dev/null 2>&1 && [ -s "$dir/history.json" ]; then
    echo "previous history: artifact '$art' from run $id ($(jq '.runs | length' "$dir/history.json") run(s))"
    exit 0
  fi
done

if [ -n "${PUBLISH_BRANCH:-}" ] && git ls-remote --exit-code --heads origin "$PUBLISH_BRANCH" >/dev/null 2>&1; then
  git fetch -q --depth 1 origin "$PUBLISH_BRANCH" && git show FETCH_HEAD:docs/history.json > "$dir/history.json" 2>/dev/null \
    && [ -s "$dir/history.json" ] && { echo "previous history: $PUBLISH_BRANCH:docs/history.json ($(jq '.runs | length' "$dir/history.json") run(s))"; exit 0; }
fi

rm -f "$dir/history.json"
echo "previous history: none found — starting a new history"
