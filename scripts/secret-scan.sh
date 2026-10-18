#!/usr/bin/env bash
#
# Fail-closed scan for hardcoded credentials.
#
# Single source of truth: this script was copy-pasted into five places in the
# GitHub Actions workflows. Extracted here so the pattern and the exclusions are
# changed in exactly one place.
#
# Pattern: a key-shaped name, a separator, then a quoted value of 8+ characters,
# or a PEM private-key header.
#
# `grep -rl` prints FILENAMES ONLY. A matched line is never echoed to the log,
# so a real credential that lands in the repo cannot be re-published by the scan
# that catches it.
#
# Scope: the CURRENT checkout. A linked git worktree nested inside the target is
# a separate checkout on its own branch, not part of this working tree; the
# session working in it runs this same script from its own root. Without this,
# one branch's in-flight edit to ci.yml turns another branch's gate red on a
# file that is not its own. The exclusions are verified (a `.git` FILE, i.e. a
# linked worktree rather than a clone) and always printed, so nothing is skipped
# silently — and if the worktree list cannot be read, nothing is excluded.
#
# Usage: bash scripts/secret-scan.sh [path]   (path defaults to ".")
# Exits 0 when clean, 1 when a secret is found, 1 when the scan itself breaks.

# No `set -e`: the grep exit code is the control signal and is captured via `||`.
set -uo pipefail

TARGET="${1:-.}"

# Linked worktrees nested inside TARGET are out of this checkout's scope. Worktree
# paths come back absolute, so TARGET is resolved before they are compared.
exclude_flags=()
excluded=""
worktrees=$(git -C "$TARGET" worktree list --porcelain 2>/dev/null) || worktrees=""
self_root=$(git -C "$TARGET" rev-parse --show-toplevel 2>/dev/null) || self_root=""
target_abs=$(cd "$TARGET" 2>/dev/null && pwd -P) || target_abs="$TARGET"

if [ -n "$worktrees" ]; then
  while IFS= read -r wt; do
    wt=${wt#worktree }
    wt=${wt%\"}; wt=${wt#\"}
    [ -n "$wt" ] || continue
    [ "$wt" = "$self_root" ] && continue
    case "$wt" in "$target_abs"/*) ;; *) continue ;; esac
    # A linked worktree has a .git FILE pointing into .git/worktrees; a clone has
    # a .git directory. Only the former is another checkout of this repo.
    [ -f "$wt/.git" ] || continue
    exclude_flags+=("--exclude-dir=$(basename "$wt")")
    excluded="${excluded}    ${wt}"$'\n'
    # grep's --exclude-dir matches on the basename anywhere under TARGET, so a
    # same-named directory that is NOT this worktree would be skipped too. That is
    # the one way this exclusion can hide a file; say so rather than pass quietly.
    others=$(find "$target_abs" -type d -name "$(basename "$wt")" -not -path "$wt" -not -path "*/.git/*" -not -path "*/node_modules/*" 2>/dev/null | head -5)
    if [ -n "$others" ]; then
      echo "::warning::Excluded by name, so these are unscanned too (not worktrees):"
      printf '%s\n' "$others" | sed 's/^/    /'
    fi
  done <<<"$worktrees"
fi

if [ -n "$excluded" ]; then
  echo "Nested linked worktrees inside ${TARGET} are separate checkouts and are out of"
  echo "scope for this scan (each one runs this script from its own root):"
  printf '%s' "$excluded"
fi

secret_pattern="([A-Z0-9_]*(API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|ACCESS_KEY)[A-Z0-9_]*)[[:space:]]*[:=][[:space:]]*[\"'][^\"']{8,}[\"']|-----BEGIN [A-Z ]*PRIVATE KEY-----"

rc=0
hits=$(grep -rlE "$secret_pattern" \
    --exclude-dir=.git \
    --exclude-dir=node_modules \
    --exclude-dir=dist \
    --exclude-dir=.next \
    --exclude-dir=coverage \
    --exclude='*.md' \
    --exclude='.env' --exclude='.env.*' \
    --exclude='*.local' --exclude='*.local.*' \
    --exclude='*.example' --exclude='*.example.*' \
    --exclude='bun.lock' --exclude='package-lock.json' \
    ${exclude_flags[@]+"${exclude_flags[@]}"} \
    "$TARGET" ) || rc=$?

case "$rc" in
  1) echo "[PASS] No hardcoded secrets found in target: $TARGET"
     exit 0 ;;
  0) echo "::error::Possible hardcoded secret. Filenames only - values are never printed."
     printf '%s\n' "$hits" | sort
     echo "Remove it and ROTATE the credential."
     echo "[FAIL] Secret scan found matches in target: $TARGET"
     exit 1 ;;
  *) echo "::error::Secret scan itself failed (grep exit $rc). Failing closed, not open."
     echo "[FAIL] Secret scan could not complete for target: $TARGET"
     exit 1 ;;
esac
