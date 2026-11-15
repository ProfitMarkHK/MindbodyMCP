#!/usr/bin/env bash
# Prints code=true or code=false for GitHub Actions: false only when every file
# the push or pull request changes is documentation (*.md, LICENSE), the same
# rule as .githooks/pre-commit. Anything it cannot work out prints code=true,
# so CI runs rather than skips.
#
# Inputs (env): EVENT (github.event_name), PR_BASE (pull_request base sha),
# PUSH_BEFORE (push "before" sha). Compares against HEAD.

set -uo pipefail

if [ "${EVENT:-}" = pull_request ]; then
  base="${PR_BASE:-}"
  range="$base...HEAD"
else
  base="${PUSH_BEFORE:-}"
  range="$base..HEAD"
fi

# A new branch pushes with an all-zero "before"; there is nothing to diff against.
if [ -z "$base" ] || [ -z "${base//0/}" ] || ! files=$(git diff --name-only "$range" 2>/dev/null); then
  echo code=true
  exit 0
fi

if [ -n "$files" ] && ! printf '%s\n' "$files" | grep -qvE '(\.md|^LICENSE)$'; then
  echo code=false
else
  echo code=true
fi
