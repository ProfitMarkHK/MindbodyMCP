#!/usr/bin/env bash
# Definition-of-done gate runner for MindbodyMCP
#
# Runs every automated quality gate in one command and exits non-zero on any
# automated failure, so the same command serves the pre-commit hook and any
# local or remote automation.
#
#   Gate 6  bun run typecheck   — tsc --noEmit
#   Gate 1  bun test            — full suite (tests + hermetic E2E tier)
#   Gate 2  (derived from Gate 1)— end-to-end acceptance suite, see below
#   Gate 13 (derived from Gate 1)— mandatory pagination (tests/pagination-gate.test.ts),
#                                 scanning src/ AND nextjs-app/src/
#   Gate 7  bun run build       — tsc && chmod +x dist/index.js  (writes dist/, gitignored)
#   Gate 14 nextjs-app typecheck— tsc --noEmit in nextjs-app/ (needs nextjs-app/node_modules)
#   Gate 15 nextjs-app build    — next build in nextjs-app/ (writes nextjs-app/.next/, gitignored)
#
# Gates 3, 4, 5, 8, 9, 10, 11 and 12 are NOT run here. Gates 4, 5, 9, 10 and 11
# need human judgement. Gate 3 is a gap (no linter or complexity rule is wired;
# nextjs-app has no ESLint config either, `next lint` only offers to create one).
# Gates 8 and 12 are green but deliberately not yet wired in; both are documented
# in docs/quality-gates.md rather than run here.
#
# The opt-in live E2E tier (tests/live/mindbody-live.e2e.ts) is also not run here:
# it needs real sandbox credentials and is excluded from `bun test` by filename on
# purpose, so no sentinel from Gate 1 can extend to it. See docs/quality-gates.md.
#
# Usage:
#   bash scripts/check-gates.sh
#   bun run check
#
# Full checklist, including every gap and no-op:
#   docs/quality-gates.md

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

# ── Loop guard (optional) ─────────────────────────────────────────────────────
# If someone wires this into a Stop-style hook, Claude Code re-invokes the hook
# with STOP_HOOK_ACTIVE=true. Honour it only when explicitly enabled, so a
# pre-commit hook is never affected. stdin is never read, so this cannot hang.
if [ "${QUALITY_GATES_RESPECT_STOP_HOOK:-0}" = "1" ] && [ "${STOP_HOOK_ACTIVE:-false}" = "true" ]; then
  echo "SKIP  gates already ran on this stop (STOP_HOOK_ACTIVE=true). Verify manually before pushing."
  exit 0
fi

LOG_DIR=$(mktemp -d)
trap 'rm -rf "$LOG_DIR"' EXIT

FAILURES=()

pass() { printf 'PASS   %s\n' "$1"; }
fail() { printf 'FAIL   %s\n' "$1"; FAILURES+=("$1"); }

# ── Gate 1: all tests pass ───────────────────────────────────────────────────
# bunfig.toml sets [test] coverageThreshold = 0.10. Bun 1.4.0 reads that as a
# FRACTION (0.0-1.0) enforced PER FILE against % Funcs, and 0.10 is the measured
# floor, so a green suite exits 0 today. The gate still tells the two reasons a
# run can exit non-zero apart: a real test failure, and anything else — a coverage
# threshold breach, a crash after the last assertion, an unhandled rejection.
# Both fail the runner; they are reported separately because the fix differs, and
# because the second must never be mistaken for "tests are fine, ignore it".
echo "=== Gate 1: bun test ==="
TEST_LOG="$LOG_DIR/test.log"
bun test >"$TEST_LOG" 2>&1
TEST_RC=$?
sed 's/^/    /' "$TEST_LOG"

TEST_FAILS=$(grep -Eo '^[[:space:]]*[0-9]+[[:space:]]+fail' "$TEST_LOG" | grep -Eo '[0-9]+' | tail -1)
TEST_PASSES=$(grep -Eo '^[[:space:]]*[0-9]+[[:space:]]+pass' "$TEST_LOG" | grep -Eo '[0-9]+' | tail -1)
TEST_FAILS=${TEST_FAILS:-0}
TEST_PASSES=${TEST_PASSES:-0}

if [ "$TEST_FAILS" -gt 0 ]; then
  fail "Gate 1  bun test  (${TEST_FAILS} failing, ${TEST_PASSES} passing)"
elif [ "$TEST_RC" -ne 0 ]; then
  fail "Gate 1  bun test  (0 failing, ${TEST_PASSES} passing; exit ${TEST_RC} with no test failure — most likely a bunfig.toml coverageThreshold breach; see Gate 1 in docs/quality-gates.md)"
else
  pass "Gate 1  bun test  (${TEST_PASSES} passing)"
fi

# ── Gate 2: end-to-end / acceptance suite ────────────────────────────────────
# Gate 1 ALREADY SUBSUMES GATE 2, deliberately.
#
# tests/e2e-mcp-server.test.ts is named *.test.ts, so `bun test` above already
# spawned it: it starts a real MCP server subprocess over STDIO, speaks real MCP
# JSON-RPC to it, and points it at a local stub Mindbody API. Running it again
# here would spawn that whole subprocess suite a second time for no extra signal,
# so Gate 2's verdict is derived from Gate 1's log rather than re-run.
#
# The suite prints its own result line, `GATE2_E2E_RESULT tests=N failures=M`,
# from its afterAll hook. That is the only reliable "it ran" signal: bun prints a
# file header only when a test in that file FAILS, so on a green run the file name
# never appears in the output at all.
#
# Gate 2 is a real failing gate, and fail-closed:
#   - sentinel missing  => the suite did not run (renamed, deleted, excluded, or
#                          beforeAll threw) => FAIL;
#   - failures > 0      => an acceptance test failed => FAIL;
#   - otherwise         => PASS.
echo
echo "=== Gate 2: end-to-end acceptance suite (derived from Gate 1's bun test run) ==="
E2E_RESULT=$(grep -E '^GATE2_E2E_RESULT tests=[0-9]+ failures=[0-9]+$' "$TEST_LOG" | tail -1)

if [ -z "$E2E_RESULT" ]; then
  fail "Gate 2  E2E acceptance suite did not run (no GATE2_E2E_RESULT from tests/e2e-mcp-server.test.ts)"
else
  E2E_TESTS=$(printf '%s\n' "$E2E_RESULT" | sed -n 's/^GATE2_E2E_RESULT tests=\([0-9][0-9]*\).*/\1/p')
  E2E_FAILURES=$(printf '%s\n' "$E2E_RESULT" | sed -n 's/.* failures=\([0-9][0-9]*\)$/\1/p')

  if [ "$E2E_TESTS" -eq 0 ]; then
    fail "Gate 2  E2E acceptance suite reported 0 tests (the file ran but asserted nothing)"
  elif [ "$E2E_FAILURES" -gt 0 ]; then
    fail "Gate 2  E2E acceptance suite (${E2E_FAILURES} of ${E2E_TESTS} failing)"
  else
    pass "Gate 2  E2E acceptance suite (${E2E_TESTS} tests; spawns src/index.ts over STDIO, real MCP JSON-RPC, stub Mindbody API)"
  fi
fi

# ── Gate 13: mandatory pagination ────────────────────────────────────────────
# Also subsumed by Gate 1, for the same reason as Gate 2: the static check lives
# in tests/pagination-gate.test.ts, a *.test.ts file the single `bun test` above
# already ran. It scans src/ and nextjs-app/src/ (.ts and .tsx) for every Mindbody
# GET call site and fails if any endpoint that docs/openapi.json paginates
# (request.limit + request.offset) is called with a single GET instead of
# fetchAllPages (src/api/client.ts or nextjs-app/src/lib/mindbody/paging.ts, same
# contract). There is no allowlist.
#
# The suite prints `GATE13_PAGINATION_RESULT sites=N violations=M` from its
# afterAll hook, and only once its scan completed. Fail-closed on all three:
#   - sentinel missing  => the suite did not run, or the scan crashed => FAIL;
#   - sites == 0        => the scanner found nothing (vacuous)          => FAIL;
#   - violations > 0    => at least one rule failed                     => FAIL.
echo
echo "=== Gate 13: mandatory pagination (derived from Gate 1's bun test run) ==="
PAGINATION_RESULT=$(grep -E '^GATE13_PAGINATION_RESULT sites=[0-9]+ violations=[0-9]+$' "$TEST_LOG" | tail -1)

if [ -z "$PAGINATION_RESULT" ]; then
  fail "Gate 13 mandatory pagination did not run (no GATE13_PAGINATION_RESULT from tests/pagination-gate.test.ts)"
else
  PAGINATION_SITES=$(printf '%s\n' "$PAGINATION_RESULT" | sed -n 's/^GATE13_PAGINATION_RESULT sites=\([0-9][0-9]*\).*/\1/p')
  PAGINATION_VIOLATIONS=$(printf '%s\n' "$PAGINATION_RESULT" | sed -n 's/.* violations=\([0-9][0-9]*\)$/\1/p')

  if [ "$PAGINATION_SITES" -eq 0 ]; then
    fail "Gate 13 mandatory pagination scanned 0 API GET call sites (scanner found nothing)"
  elif [ "$PAGINATION_VIOLATIONS" -gt 0 ]; then
    fail "Gate 13 mandatory pagination (${PAGINATION_VIOLATIONS} violation(s) across ${PAGINATION_SITES} call sites; see tests/pagination-gate.test.ts output above)"
  else
    pass "Gate 13 mandatory pagination (${PAGINATION_SITES} API GET call sites across src/ and nextjs-app/src/; every paginated endpoint goes through fetchAllPages)"
  fi
fi

# ── Gate 6: type checking ────────────────────────────────────────────────────
echo
echo "=== Gate 6: bun run typecheck ==="
if bun run typecheck; then
  pass "Gate 6  bun run typecheck"
else
  fail "Gate 6  bun run typecheck"
fi

# ── Gate 7: build ────────────────────────────────────────────────────────────
echo
echo "=== Gate 7: bun run build (writes dist/, which is gitignored) ==="
if bun run build; then
  pass "Gate 7  bun run build"
else
  fail "Gate 7  bun run build"
fi

# ── Gates 14 and 15: nextjs-app typecheck and build ─────────────────────────
# nextjs-app/ is a second code base with its own Mindbody client, its own
# tsconfig and its own dependency tree. Gate 13 scans its source statically, but
# that proves only that every call is paged, not that the app compiles. These two
# gates do, from inside nextjs-app/, using the binaries pinned in its lockfile.
#
# Fail-closed: if nextjs-app/node_modules is absent the gates FAIL with the
# install command, never SKIP. A gate that cannot run must not read as green.
#
# `next build` is the heavier of the two (~15s warm) and writes nextjs-app/.next/
# plus nextjs-app/tsconfig.tsbuildinfo, both gitignored by nextjs-app/.gitignore.
# It also type-checks, but Gate 14 runs tsc separately so a type error is
# reported as a type error, and so a build-tool failure is distinguishable from
# a code failure.
#
# `next lint` and a nextjs-app test suite are NOT gates: there is no ESLint
# config (and no eslint dependency) in nextjs-app, so `next lint` only offers to
# create one, and the app has no test runner. The pager's tests live in the root
# tests/nextjs-paging.test.ts and are already run by Gate 1. See
# docs/quality-gates.md for both gaps.
NEXT_DIR="nextjs-app"
echo
echo "=== Gate 14: nextjs-app typecheck (tsc --noEmit in ${NEXT_DIR}/) ==="
if [ ! -x "$NEXT_DIR/node_modules/.bin/tsc" ]; then
  fail "Gate 14 nextjs-app typecheck could not run: ${NEXT_DIR}/node_modules is missing (run: cd ${NEXT_DIR} && bun install)"
elif (cd "$NEXT_DIR" && ./node_modules/.bin/tsc --noEmit); then
  pass "Gate 14 nextjs-app typecheck"
else
  fail "Gate 14 nextjs-app typecheck"
fi

echo
echo "=== Gate 15: nextjs-app build (next build in ${NEXT_DIR}/, writes ${NEXT_DIR}/.next/, which is gitignored) ==="
if [ ! -x "$NEXT_DIR/node_modules/.bin/next" ]; then
  fail "Gate 15 nextjs-app build could not run: ${NEXT_DIR}/node_modules is missing (run: cd ${NEXT_DIR} && bun install)"
else
  BUILD_LOG="$LOG_DIR/next-build.log"
  # `next build` is given no stdin and no telemetry prompt so it can never block a hook.
  if (cd "$NEXT_DIR" && NEXT_TELEMETRY_DISABLED=1 ./node_modules/.bin/next build </dev/null >"$BUILD_LOG" 2>&1); then
    grep -E '^\s*(✓|Route \(app\)|RESULT|Failed)' "$BUILD_LOG" | sed 's/^/    /'
    pass "Gate 15 nextjs-app build"
  else
    sed 's/^/    /' "$BUILD_LOG"
    fail "Gate 15 nextjs-app build"
  fi
fi

# ── Report ───────────────────────────────────────────────────────────────────
echo
echo "=== Summary ==="
if [ "${#FAILURES[@]}" -gt 0 ]; then
  echo "Failed gates:"
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  echo
  echo "RESULT: FAIL — fix the code, not the gate."
  exit 1
fi

echo "RESULT: PASS — all automated gates green."
exit 0