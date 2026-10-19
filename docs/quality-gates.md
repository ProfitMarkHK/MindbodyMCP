# Quality gates for MindbodyMCP

The single source of truth for what **done-done** means in this project. Any
team member should be able to run these checks and know the answer. Keep this
file in sync with the tooling. An out-of-date checklist is a bug.

## Run everything

```bash
bun run check
```

Equivalent to `bash scripts/check-gates.sh`, which lives in
[`scripts/check-gates.sh`](../scripts/check-gates.sh). It runs every automated
gate and exits non-zero on any automated failure, so it also works in the
pre-commit hook and in local or remote automation.

Local enforcement is the enforcement point. The runner is installed as a
pre-commit hook with one command per clone:

```bash
git config core.hooksPath .githooks
```

That command is also the repo's `prepare` script, so `bun install` sets it on a
fresh clone without anyone typing it. It is idempotent (`git config` overwrites
one key) and it is a no-op outside a git checkout — the `prepare` line guards
with `git rev-parse --git-dir` and swallows the error — so an install inside a
Docker build that has no `.git` still succeeds. `core.hooksPath` is repo-local
config and is **not** copied by a clone, which is exactly why the `prepare`
script exists; run the command by hand if you ever clone with `--no-scripts`.
The path is relative, so git resolves it against each worktree's own root.

The hook file itself is committed at [`.githooks/pre-commit`](../.githooks/pre-commit),
so it survives a fresh clone and needs no dependency install. It is wired with
`core.hooksPath` rather than `husky` on purpose: husky would add a devDependency
and a post-install step for a repo that deliberately has no tooling beyond
Bun and TypeScript, and `core.hooksPath` is a single local `git config` line
that needs no network access. Enforcement is local by design; the GitHub Actions
workflow in `.github/workflows/ci.yml` is not the enforcement mechanism for
these gates and is out of scope for this checklist.

The hook execs `scripts/check-gates.sh`, so the runner is the only place a gate
is wired and nothing is duplicated between hook and runner. It runs the whole
suite on every commit; a warm run measured **13.7s wall** on 2026-10-18 (Gate 8
alone is ~1.5s), which is why it is deliberately not split into a faster hook:
a second entry point would be a second source of truth, and the suite is cheap
enough that the trade buys nothing. It is the same command as `bun run check`,
so nothing a commit passes can fail a manual check and vice versa.

`bun run build` writes to `dist/`, which is gitignored, and Gate 15's
`next build` writes to `nextjs-app/.next/`, ignored by `nextjs-app/.gitignore`.
The runner prints both in its output so the side effects are never a surprise.
Gates 14 and 15 need `nextjs-app/node_modules`, installed once per clone with
`cd nextjs-app && bun install`; without it they fail rather than skip.

## Gates

| # | Gate | State | Command / note |
|---|------|-------|----------------|
| 1 | All tests pass | applies | `bun test` — every test passes, 0 failing, exits **0**. (Deliberately no test/file count here: it went stale on nearly every change, so read it from the run.) `bunfig.toml` sets `[test] root = "./tests"`, so discovery never walks nested worktrees or scratch checkouts in the repo root (Bun ignores `.gitignore` for discovery) — see gate 1 below. It also sets `[test] coverageThreshold = 0.10`, read by Bun 1.4.0 as a **fraction** (0.0–1.0) enforced **per file against both % Funcs and % Lines**, not against the aggregate row; the worst file is `src/api/auth.ts` at 16.67% funcs / 11.25% lines. **Read the units before changing that number** — see gate 1 below. Includes `tests/nextjs-paging.test.ts`, the tests for the Next.js app's pager and service (the app has no test runner of its own). |
| 2 | End-to-end / acceptance tests pass | applies | `bun test tests/e2e-mcp-server.test.ts` — 0 failing, ~2s. Spawns the real `src/index.ts` as a STDIO subprocess, speaks real MCP JSON-RPC (`initialize`, `tools/list`, `tools/call`) to it over stdin/stdout, and points it at a local stub Mindbody API via `MINDBODY_API_URL`. Run by the runner as part of Gate 1's single `bun test` invocation; see Gate 2 below. |
| 3 | Linters / formatters / static analysis pass (incl. complexity ≤ 10, tests excluded) | **gap** | No linter is configured, in the root or in `nextjs-app/` (`next lint` has no config to run and only offers to create one). See gaps 3a, 3b and 3c below. |
| 4 | New code covered by non-trivial tests | applies | manual review — the change's tests must exercise real logic paths, assert on outputs or state, and cover error paths, not just "returns without error". |
| 5 | Documentation updated | applies | manual review — `README.md`, `Claude.md`, `AGENTS.md`, and `docs/` (notably `docs/quality-gates.md`) stay in sync with the change. |
| 6 | Type checking passes | applies | `bun run typecheck` (`tsc --noEmit`) — currently exits 0. Run by the runner. |
| 7 | Build / compile succeeds | applies | `bun run build` (`tsc && chmod +x dist/index.js`) — currently exits 0, writes gitignored `dist/`. Run by the runner. |
| 8 | Security / secrets checks pass | applies | `npm audit --audit-level=moderate` → **found 0 vulnerabilities** (exit 0), plus the fail-closed secret scan below. The audit was verified green 2026-10-15; the secret scan passed on 2026-10-17 (see Gate 8). **The secret scan half is wired into the runner and runs on every `bun run check` and every commit** — `bash scripts/secret-scan.sh .`, then an index-only guard that refuses a staged `.env*` file. The scan prints filenames only and fails closed. `npm audit` stays CI-only: it needs the registry, and a pre-commit hook must not depend on the network. |
| 9 | Change reviewed | applies | manual — peer review via `.github/PULL_REQUEST_TEMPLATE.md`. Never a gate that always passes. |
| 10 | Tracker / ticket reconciled | **no-op** | This project uses GitHub Issues, not Jira (`.github/ISSUE_TEMPLATE/`, `docs/agents/issue-tracker.md`). There is no Jira integration to reconcile, so the Jira-specific part of this gate does not apply. Reconciling the GitHub Issue remains manual. |
| 11 | Implementation aligns with functional & technical specs | applies | manual review against [`docs/ARCHITECTURE.md`](ARCHITECTURE.md), [`docs/API.md`](API.md), and the OpenAPI spec [`docs/openapi.json`](openapi.json). Note `tests/classManagement.test.ts` already validates tool calls against `docs/openapi.json` at runtime. **Spec provenance:** `docs/openapi.json` is the Mindbody public API v6 Swagger 2.0 export, fetched **unauthenticated** from `https://api.mindbodyonline.com/public/v6/swagger/doc` — the same URL `scripts/update-spec.ts` already uses. It is not a rare hand-supplied artifact: it is served publicly and matches the stored file byte for byte, so it is always recoverable by running `bun run spec:update`. That command fetches, refreshes **both** `docs/openapi.json` and `docs/openapi.lock`, and verifies the result. The file's SHA-256 is pinned in `docs/openapi.lock` (`970ffa101a254868290056081b062ee128c74b04d880190aa1605bfbb0068941`) and is enforced offline by Gate 16. The spec is **pinned, not auto-followed** — see the drift policy under Gate 16. |
| 12 | Agent skill structure validates | **no-op** | **no-op for Claude Code extension keys** — `skills-ref` validates the open Agent Skills spec (6 fields), while Claude Code's schema is a strict superset. All 29 skills pass every portable property (name/description present, name lowercase, name matches directory, description within limits). **Do not edit the skills to satisfy the validator** — see gate 12 below. |
| 13 | Mandatory pagination | applies | `bun test tests/pagination-gate.test.ts` — static scan of `src/**/*.ts` **and `nextjs-app/src/**/*.ts(x)`** against `docs/openapi.json`: every GET endpoint the spec paginates (`request.limit` + `request.offset`) must be called through `fetchAllPages` (`src/api/client.ts`, or its port `nextjs-app/src/lib/mindbody/paging.ts`). Every GET call site under `src/` and `nextjs-app/src/` is scanned, 0 violations; the suite prints the live `GATE13_PAGINATION_RESULT sites=N violations=0` line, so read N from the run rather than from this table. **No allowlist.** Run by the runner as part of Gate 1's `bun test` and derived from its `GATE13_PAGINATION_RESULT` line, fail-closed; see Gate 13 below. Gate 13 reads the spec, so Gate 16 runs before it. |
| 14 | nextjs-app type checking passes | applies | `cd nextjs-app && ./node_modules/.bin/tsc --noEmit` — exits 0. Run by the runner; **fails, never skips, when `nextjs-app/node_modules` is absent** (it prints the `bun install` to run). See Gates 14 and 15 below. |
| 15 | nextjs-app build succeeds | applies | `cd nextjs-app && next build` — exits 0, ~11s warm, 8 routes; writes `nextjs-app/.next/` and `tsconfig.tsbuildinfo`, both ignored by `nextjs-app/.gitignore`. Run by the runner with `NEXT_TELEMETRY_DISABLED=1` and no stdin so it can never block a hook; fail-closed on missing dependencies like Gate 14. |
| 16 | OpenAPI spec integrity | applies | `sha256` of [`docs/openapi.json`](openapi.json) must equal the value pinned in [`docs/openapi.lock`](openapi.lock). **Offline, no network, no credentials**, ~1s. Runs **second, right after Gate 8's two parts and before Gate 1** — see the positioning rationale under Gate 16. Fail-closed on four conditions (missing spec, missing lock, unparseable digest, mismatch), never skip, and the failure message names both digests and points at `bun run spec:update`. |

State legend: **applies** (must pass), **no-op** (does not apply, reason
given), **gap** (should apply but not yet possible, tracked as work).

## No-ops and gaps

State every no-op and gap here with its reason, so a reader can tell "checked
and not needed" from "forgotten":

- **Gate 1 — coverage threshold (applies, passes; read the units).**
  `bunfig.toml` sets `[test] coverageThreshold = 0.10` with `coverage = true`,
  and `bun test` now exits **0** (0 fail). Four facts a reader must
  have before touching that number:

  - **Units — the trap.** Bun 1.4.0 reads the value as a **fraction (0.0–1.0)**,
    not a percentage, and enforces it **per file**, not against the aggregate
    `All files` row. The previous value of `80` therefore meant **8000%**: a
    gate that **no run could ever satisfy**. It was **dead, not strict**. Anyone
    who reads `40` or `80` in an older copy of this file and types it back in
    has set a value that cannot pass.
  - **Both columns, not only % Funcs.** A single number sets the threshold for
    **% Funcs and % Lines alike**, and either column can trip it. Observed
    2026-10-17: with every file above 10% funcs, `bun test` still exited 1
    (0 tests failing) because `nextjs-app/src/lib/mindbody/service.ts`
    sat at 16.33% funcs but **7.10% lines**. Bun prints no message naming the
    file; the runner reports the exit as a probable threshold breach, and the
    reader must find the row below 10% in *either* column. An earlier version of
    this entry said "% Funcs" only, which is why that failure was a surprise.
    Any file a test imports is in the table, including files outside `src/`.
  - **What actually changed.** The threshold is `0.10`, which was the measured
    per-file floor when it was set (`src/api/client.ts`, 10.00% funcs). It is
    still green today, but it is no longer the floor: the lowest file is now
    `src/api/auth.ts` at 16.67% funcs. **Setting it to `0.10` was a lowering of the
    bar, NOT a coverage improvement.** For the record, the `All files` row is now
    62.76% funcs and 62.36% lines. That is a different fact and must not be cited
    as justification for the threshold.
  - **Tightening it.** Raise `coverageThreshold` above `0.10` and the gate starts
    biting. The lowest file is `src/api/auth.ts` at 16.67% funcs, so anything
    above ≈`0.1667` is red today. Next are `src/utils/dates.ts` (20.00% funcs),
    `src/api/client.ts` (35.71% funcs) and `src/cache/index.ts` (37.50% funcs). The real work is tests for
    `src/api/auth.ts` and `src/api/client.ts`, the two lowest-covered files.

  **Discovery is scoped to `tests/` — do not remove `[test] root`.** `bunfig.toml`
  also sets `[test] root = "./tests"`. Without it, a bare `bun test` walks the
  entire working tree, and this repo's layout puts git worktrees *inside* the
  main checkout (`chore-spec-integrity-gate/`, `fix-sandbox-observed-behaviour/`,
  `t3-*/`). Each one was collected as another copy of the whole suite: observed
  2026-10-19 from the main checkout, **1586 tests across 47 files** with **four**
  `GATE2_E2E_RESULT` lines (75–76 tests) and **four** `GATE13_PAGINATION_RESULT`
  lines (`sites=65`, `65`, `68`, `65`) — different numbers because each checkout
  was at a different commit. Anyone reading "one" count was reading whichever copy
  sorted last. Bun does **not** honour `.gitignore` for test discovery (verified:
  gitignoring a nested copy still collected it), so `root` is the only fix that
  holds for every invocation, including a bare `bun test` typed by hand and
  `bun run test`. Explicit paths still resolve as before — `bun test ./tests` and
  the opt-in live tier `bun test ./tests/live/mindbody-live.e2e.ts` both work.
  `scripts/check-gates.sh` additionally passes `./tests` as belt-and-braces.

  **Coverage-collection caveat — `bun test` reports files it never ran.** This is
  separate from the threshold and matters precisely when the threshold is
  tightened. `bun test --coverage` emits a row for files that were **not
  executed**, not only for the ones a test actually exercised. Verified by running
  the live tier on its own (`SKIP_LIVE_E2E=1 bun test --coverage ./tests/live/mindbody-live.e2e.ts`):

  ```
   tests/live/live-config.ts       |   75.00 |   20.99 |
   tests/live/mindbody-live.e2e.ts |   25.45 |   15.29 |
  ```

  on a run that reported **0 pass, all skipped, 0 fail**. Those figures describe
  module-level top-level statements only; nothing in either file's bodies ran.

  Today this is harmless, because the default `bun test` never loads
  `tests/live/` at all — the file is absent from the table and the aggregate
  stays accurate. It becomes a trap the moment `coverageThreshold` is raised
  toward its real per-file semantics: **a file that was never executed can be the
  row that trips the gate.** So when you tighten the threshold, read the table for
  rows you did not expect, and treat an unexplained low row as *this file never
  ran*, not *this file needs tests*. The same trap applies to any future suite
  kept out of the default run.
- **Gate 2 — end-to-end / acceptance suite (applies).**
  [`tests/e2e-mcp-server.test.ts`](../tests/e2e-mcp-server.test.ts) is the
  acceptance gate. It is deliberately **not** the same thing as
  `tests/classManagement.test.ts`, which imports tool functions and injects a fake
  client — that proves the transform logic and says nothing about transport
  wiring, tool registration, JSON-RPC framing, or schema conformance.

  What the E2E suite actually does, top to bottom:

  1. Starts `tests/support/mindbody-stub.ts`, a `node:http` server on an ephemeral
     **loopback** port that serves `POST /public/v6/usertoken/issue` plus 28 endpoints with Mindbody-shaped payloads:
     `/client/clients`, `/client/addclient`, `/client/updateclient`,
     `/client/clientvisits`, `/client/clientaccountbalances`,
     `/client/activeclientmemberships`, `/client/clientschedule`, `/client/addarrival`,
     `/class/classes`, `/class/classdescriptions`, `/class/waitlistentries`,
     `/class/classschedules`, `/staff/staff`,
     `/sale/services`, `/sale/packages`, `/sale/products`, `/sale/contracts`,
     `/sale/checkoutshoppingcart`, `/sale/purchasecontract`,
     `/appointment/staffappointments`, `/appointment/bookableitems`,
     `/appointment/activesessiontimes`, `/appointment/addappointment`,
     `/appointment/updateappointment`, `/site/sessiontypes`, `/site/sites`,
     `/site/locations` and `/site/programs`. Any other path is a
     hard 404 with a Mindbody `Error` envelope, so an unexpected call fails loudly.
     Every GET list route pages through one shared `paginate()` helper: it honours
     `Limit`/`Offset` and answers with a spec-shaped `PaginationResponse`
     (`RequestedLimit`, `RequestedOffset`, `PageSize`, `TotalResults`). Two routes
     also cap rows per page below the asked `Limit` — `/class/classes` at 3 and
     `/staff/staff` at 1 — so multi-page walks are exercised end to end.
  2. Spawns the **real** `src/index.ts` with `@modelcontextprotocol/sdk`'s
     `StdioClientTransport` — a genuine subprocess, not an import.
  3. Drives it with the SDK `Client`: `initialize`, `tools/list`, `tools/call`,
     `ping`.

  `MINDBODY_API_URL` is honoured by **both** consumers, which the suite asserts
  rather than assumes: the OAuth token fetch in `src/api/auth.ts` and the axios
  client in `src/api/client.ts` each read it independently. The test proves the
  token endpoint was hit on the stub with the right `Api-Key`/`SiteId` headers and
  source-credential body, and that the token it issued is then attached to the
  API calls.

  What it covers, in the terms the gate is for:

  | Concern | Where |
  |---|---|
  | Handshake: protocol version negotiated, server name/version reported, `tools` capability declared, diagnostics on stderr not stdout | `handshake` |
  | Tool registration: the exact 40-name set from `index.ts`, unique, well-formed names, non-empty descriptions | `tools/list` |
  | Schema conformance: every `inputSchema` parses as JSON Schema, is `type: "object"`, every `required` entry exists in `properties`, every property has a `type` | `tools/list` |
  | Real dispatch across four domains: clients (`getClients`, `addClient`, `updateClient`, `getClientVisits`, `getClientAccountBalances`, `addClientArrival`), orders (`getPackages`, `getProducts`, `getContracts`, `checkoutShoppingCart`, `purchaseContract`), appointments (`getStaffAppointments`, `getBookableItems`, `getActiveSessionTimes`, `addAppointment`, `updateAppointment`, `cancelAppointments`), and the site and service-definition reads (`getSites`, `getServices`, `getSessionTypes`) | `domain — clients`, `domain — orders`, `domain — appointments`, `domain — site`, `domain — service definitions` |
  | Pagination end to end: `getClasses` reads all 7 classes over three capped pages (`Offset` 0, 3, 6, each `Limit=200`); `getTeacherSchedule` finds a teacher who is only on staff page two and reads both pages of her classes; `getClassDescriptions`, `getWaitlistEntries`, `getClassSchedules`, `getLocations`, `getPrograms`, `getClientMemberships` and `getClientEnrollments` (via `/client/clientschedule`) each go through the pager; every GET in the session carried `Limit=200` and an `Offset` | `pagination — multi-page walks through the real server`, `process health` |
| OAuth user token: issue and attach, 60s expiry skew, 23-hour fallback when `Expires` is absent, API-key-only fallback on failure, no source credentials | `OAuth user token — …` |
  | Error paths: unknown tool name → `isError` result, missing required argument → Mindbody error message + code, upstream 4xx → error result then recovery | `tools/call — error handling` |
  | Process health: still alive and answering after every call above, and every outbound request landed on the loopback stub | `process health` |
  | Startup rejection: exits 1 with `Missing required environment variable: …` for each of the four required vars | `startup rejection` |

  The schema checks are the **replacement for the deleted `validate-mcp` CI
  step**: they run against the schemas the server actually advertises over the
  wire, not against a copy in the repo.

  **Hermeticity.** No network, no real credentials, no dependence on the repo
  `.env`:
  - the child's environment is built from scratch in `buildStubEnv()`; only
    `PATH` is inherited, and the suite asserts the exact key set. `bunfig.toml`
    sets `dotenv = true`, so the *test* process holds the developer's real
    credentials in its own environment — none of them reach the child;
  - the child's `cwd` and `HOME` are an empty `mkdtemp` scratch directory, so
    neither `dotenv.config()` in `src/index.ts` nor bun's own loader can find a
    `.env` (asserted);
  - all Mindbody values the child can see are hard-coded fakes
    (`e2e-fake-api-key`, site `-99`, …);
  - `HTTP_PROXY`/`HTTPS_PROXY` point at a closed loopback port with
    `NO_PROXY=127.0.0.1`, an **egress trap**: loopback bypasses the proxy, so
    anything aimed off-box fails with `ECONNREFUSED` instead of quietly reaching
    `api.mindbodyonline.com`. Verified live — repointing `MINDBODY_API_URL` at the
    real host under this env yields
    `Network Error: connect ECONNREFUSED 127.0.0.1:1`. The suite passing with the
    trap armed is therefore positive evidence that it made no off-box request.

  **How the runner executes it.** Gate 2 is **subsumed by Gate 1**: the file is
  named `*.test.ts`, so the runner's single `bun test` already spawns it. Running
  it a second time would re-spawn the whole subprocess suite for no extra signal,
  so `scripts/check-gates.sh` derives Gate 2's verdict from Gate 1's log instead of
  re-running it. Because bun only prints a file header when a test in that file
  *fails*, the file name is absent from a green log — so the suite prints its own
  result line, `GATE2_E2E_RESULT tests=N failures=M`, from `afterAll`. Gate 2 is
  fail-closed on all three: sentinel missing (suite did not run, or `beforeAll`
  threw) → FAIL; `failures > 0` → FAIL; `tests == 0` → FAIL; otherwise PASS.
  Demonstrated: sabotaging the stub's payload shape gives
  `FAIL Gate 2 E2E acceptance suite (N of M failing)` (M is whatever the suite
  held at the time) and a non-zero runner exit;
  removing the file gives
  `FAIL Gate 2 E2E acceptance suite did not run …`.

  **What Gate 2 does NOT prove (residual gap).** It proves the MCP server's own
  behaviour against a stub it fully controls. Still uncovered:
  - **live-credential tool calls against the real Mindbody API.** Whether the
    real v6 endpoints return the shapes modelled in `tests/support/mindbody-stub.ts`
    and `docs/openapi.json` is not proven. The stub was written from the tools'
    reading of the API; if Mindbody renames a field, Gate 2 stays green and
    production breaks. `bun run test:tool` remains the manual check for that. An
    opt-in live tier targets exactly this gap (see the live-tier entry below). It
    has now been run against the sandbox, but its last recorded run is not all
    green (see [`tests/live/README.md`](../tests/live/README.md)), so the gap is not closed.
  - **SSE transport.** Everything here is STDIO. `bun run test:sse` is still a
    manual script needing a server already listening.
  - **Retry-on-5xx.** `src/api/client.ts` retries network errors and 5xx with a
    1s + 2s + 4s backoff; exercising it would add ~7s to a pre-commit hook, so the
    upstream-fault test deliberately uses a 4xx. The retry path is untested.
  - **Retry/refresh on 401** (`src/api/client.ts` response interceptor) is also
    untested — the token-failure path falls back to API-key-only auth instead.
  - **Per-property `description` coverage** in `inputSchema` is not asserted:
    `updateClient.updates` and its 13 nested properties carry no `description`, so
    a universal check would fail on the current source. Tool-level descriptions
    are asserted; per-property `type` is asserted for all. Adding the missing
    descriptions is a `src/index.ts` change, i.e. Gate 11 work, not gate work.
- **Live E2E tier against a real Mindbody sandbox (gap — opt-in, not in the runner).**
  A second, opt-in acceptance tier now exists at
  [`tests/live/mindbody-live.e2e.ts`](../tests/live/mindbody-live.e2e.ts),
  documented in [`tests/live/README.md`](../tests/live/README.md). It is
  not a passing gate and not wired into the runner. It has now been run against
  the sandbox; its last recorded result is in the Status section of that README.
  With `SKIP_LIVE_E2E=1` it reports `0 pass, all skipped, 0 fail` (exit 0), which
  proves only the skip path, not the live calls.

  **What it is.** The same mechanics as Gate 2 — `src/index.ts` spawned as a real
  subprocess over STDIO, real MCP JSON-RPC (`initialize`, `tools/list`,
  `tools/call`), `beforeAll`/`afterAll` owning the lifecycle with teardown in
  `finally` — with exactly one substitution. The local stub
  `tests/support/mindbody-stub.ts` becomes the **real** Mindbody environment at
  SiteId `-99` (the sandbox). It therefore also proves the credentials, the SiteId
  and the sandbox IP allow-list are wired correctly, which Gate 2 structurally
  cannot.

  **How it is run — by filename, deliberately.**
  ```bash
  bun test ./tests/live/mindbody-live.e2e.ts
  ```
  It is **not** part of `bun test`, and that is the design, not an oversight. The
  file is named `mindbody-live.e2e.ts`, and `.e2e.ts` matches none of Bun's
  collection patterns (`*.test.ts`, `*_test.ts`, `*.spec.ts`, `*_spec.ts`), so a
  bare `bun test` ignores `tests/live/` entirely and the default suite stays
  hermetic and fast.

  **Why it is not wired into `scripts/check-gates.sh`.** Two independent reasons,
  and the second is the one that decides it:
  1. The tier is *designed to be absent* from `bun test`. Gate 2 works because it
     derives its verdict from a sentinel line (`GATE2_E2E_RESULT`) printed by a
     suite `bun test` really did run. A file the run never collects cannot print a
     sentinel, so Gate 2's mechanism cannot be extended to it. The runner would
     have to invoke the tier directly instead — which would put live sandbox
     credentials, real record writes and a rate-limited third party behind every
     `bun run check`, every pre-commit hook and every CI job.
  2. The tier **skips** rather than passes when credentials are absent, so a gate
     wiring it in would have to treat "skipped" as its own reported outcome,
     visibly distinct from "passed" and never rolled up into a pass. How a
     credential-gated, non-blocking, never-green tier should appear in a pass/fail
     summary is a **policy decision, not a mechanical one**, so it is recorded
     here rather than silently baked into the runner.

  **Status: run against the authenticated `-99` sandbox (2026-10-17).** Token
  issue, the site-zone lookup and the default appointment lifecycle (including the comp-paid checkout)
  (client, booking, reschedule, arrival, guard checks, cancellation) run for real.
  The last recorded result, including what is still failing, is in the Status
  section of [`tests/live/README.md`](../tests/live/README.md); read that rather
  than a copy here. Read every `LIVE …` block a run prints, not only the
  pass/fail tally.

  **Credentials — names only, never values.** The tier reads a separate
  `MINDBODY_TEST_*` namespace and never `MINDBODY_*`. That separation is
  load-bearing: `bunfig.toml` sets `dotenv = true`, so the repo `.env` — which
  points at a **real business site** — is already loaded into `process.env` before
  any test runs. Inheriting it would create clients and appointments inside
  somebody's live account on first use.

  | Variable | Required | Meaning |
  |---|---|---|
  | `MINDBODY_TEST_API_KEY` | yes | Sandbox API key |
  | `MINDBODY_TEST_SOURCE_NAME` | yes | Source name for the user-token flow |
  | `MINDBODY_TEST_SOURCE_PASSWORD` | yes | Source password |
  | `MINDBODY_TEST_SITE_ID` | no | Defaults to `-99`. **Any other value is refused**, not skipped |

  Values go in the shell environment or a gitignored file — never in the repo
  `.env`, never in this document.

  **Financial writes always commit, and the server forces that.** Both Mindbody
  endpoints accept `Test: true`, which validates without committing, and the MCP
  server exposes neither (see the product limitations below). So through this
  server every checkout really commits: `checkoutShoppingCart` creates a Sale with
  tax lines and a payment transaction, and `purchaseContract` creates a
  ClientContract with an AutoPay schedule. The `-99` sandbox is shared and its data
  is not private. Every default run leaves records that cannot be removed: a
  comp-paid sale and an account-credit ClientContract, neither reversible through
  this server, and a client that v6 has no delete endpoint for. Both financial
  writes move no money of the operator's and touch no payment instrument — see
  tests/live/README.md.

  **Skip vs fail.** Exactly two automatic skips, both statements about the machine
  rather than the code: `SKIP_LIVE_E2E` is set, or no `MINDBODY_TEST_*`
  credentials are configured. Everything else fails — a non-sandbox SiteId, HTTP
  403, HTTP 404, HTTP 5xx and any unexpected payload. There is deliberately no
  "the network is down, never mind" escape hatch, because a gate that goes quietly
  green while testing nothing is worse than no gate. A banner prints the decision
  before any test runs, so "skipped" and "passed" are never indistinguishable.
- **Product limitations exposed by the live tier (independent of testing).**
  Both are gaps in the MCP server's tool surface against Mindbody v6, not test
  problems. They surfaced while writing the live tier and are recorded here so they
  are not rediscovered later as bugs:
  - **Appointment cancellation (resolved, with one limit).** `updateAppointment`
    refuses `execute: cancel` and `latecancel` client-side, with no API call.
    Cancellation goes through `cancelAppointments`, which verifies ownership, start
    time and status before it writes. The remaining limit: an appointment that has
    been checked out is `Completed`, the guard refuses it, and no MCP path reverses
    a sale (`returnsale` is not exposed). The live tier cancels its appointment
    through `cancelAppointments` during cleanup, and re-notes it as a LEFTOVER only
    when it was checked out first.
  - **Financial writes always commit.** Neither `checkoutShoppingCart` nor
    `purchaseContract` exposes v6's `Test: true` flag, so both always create real
    records, with no dry-run mode. `returnsale` can reverse a sale but is not
    exposed either, and a return is a second record, not a deletion. Nothing in
    v6 deletes a ClientContract, so `purchaseContract`'s leftover stands until it
    is removed by hand.
- **Gate 3a — no linter (gap).** There is no `eslint`, `prettier`, or `biome`
  configuration in the repo. `bun run lint` is `tsc --noEmit --strict`, which is
  Gate 6 run again, not a linter — it cannot catch style or static-analysis
  drift. `shellcheck` 0.11.0 is installed, but the only two tracked `.sh` files
  are vendored skill scripts under `.agents/skills/`, not project code, so it has
  nothing to check here. To close it: `bun add -d eslint prettier`, add a config
  with `prettier --check src tests` and `eslint src --ext .ts`, and repoint
  `lint` in `package.json` at the real linter instead of `tsc --strict`.
- **Gate 3b — no complexity budget (gap).** The budget is strict McCabe
  complexity ≤ 10 per function, tests excluded, no grandfathering. Nothing
  enforces it: there is no eslint config, so the `complexity` rule does not
  exist. To close it, after 3a: add `"complexity": ["error", 10]` to the
  eslint config and run it scoped to source (`eslint src --ext .ts`) so `tests/`
  is excluded. Do not raise the threshold or grandfather existing functions.
- **Gate 3c — nextjs-app has no linter either (gap).** `nextjs-app/package.json`
  declares `"lint": "next lint"`, but there is no `.eslintrc*` and no `eslint` /
  `eslint-config-next` dependency, so `next lint` does not lint: it prints
  `? How would you like to configure ESLint?` and waits for a keypress
  (checked 2026-10-17). It is therefore **not** wired into the runner — a gate
  that blocks on stdin would hang the pre-commit hook, and one answered with a
  default would silently write config. To close it: `cd nextjs-app && bun add -d
  eslint eslint-config-next`, commit a `.eslintrc.json` with
  `{"extends": "next/core-web-vitals"}`, then add `next lint` as a gate next to
  Gates 14 and 15 in `scripts/check-gates.sh`. `next build` currently prints
  "Linting and checking validity of types" but, with no config, that step is the
  type check only.
- **Gate 8 — security and secret scan (applies; secret scan passes).**
  - **Audit.** `npm audit --audit-level=moderate` → **`found 0 vulnerabilities`**,
    exit 0. The 12 advisories that made this gate red were **lockfile staleness,
    not bad dependency declarations**: `package.json` was never edited — it already
    declared `@modelcontextprotocol/sdk ^1.17.2` and `axios ^1.7.7`, both of which
    permit the patched releases. Regenerating both lockfiles *after* purging the
    hidden `node_modules/.package-lock.json` was what fixed it, which is why simply
    deleting the lockfiles was not enough. Resolution moved
    `@modelcontextprotocol/sdk` 1.17.2 → 1.32.1 and `axios` 1.10.0 → 1.20.0; no
    direct dependency crossed a major version.
  - **Compatibility check after any bump.** A version bump is not done until these
    are also green: `bun run typecheck`, `bun run lint`, `bun test` (0 fail).
  - **Secret scan.** The single source of truth is the committed script
    [`scripts/secret-scan.sh`](../scripts/secret-scan.sh). Both workflows call
    it; neither embeds the pattern:
    ```bash
    bash scripts/secret-scan.sh          # scans "."
    bash scripts/secret-scan.sh <path>   # scans <path>
    ```
    **Run the script — do not copy its contents out of it.** A hand-written
    local variant, or an inline copy in a workflow, is exactly how copies drift
    apart; the pattern and the exclusion list now change in one place.

    **Scope: the current checkout.** The scan covers the checkout it is run in,
    not every directory beneath it. A linked git worktree nested inside the target
    is a separate checkout on its own branch, so it is excluded. The script lists
    `git worktree list --porcelain`, keeps the paths nested under the target, and
    skips only those whose `.git` is a **file** (a linked worktree; a clone has a
    `.git` directory and is not skipped). Each excluded worktree scans itself when
    the script runs from its own root. Every exclusion is **printed** before the
    result, so a pass is auditable: the log names what was not scanned. If the
    worktree list cannot be read, nothing is excluded. This exists because one
    branch's in-flight edit to `ci.yml` or `deploy/k8s-deployment.yaml` must not
    turn another branch's gate red on a file that is not its own.

    **Residual gap, stated plainly.** `grep --exclude-dir` matches on the
    **basename** anywhere under the target. A directory elsewhere in the checkout
    that shares a worktree's name is therefore skipped as well. The script finds
    such directories and emits a `::warning::` naming them, so the gap is reported
    rather than silent, but it is not closed: files inside one of them are not
    scanned. This check is not gap-free.

    What it does, so the guarantees can be checked by reading it rather than
    trusted: it runs under `set -uo pipefail` (deliberately **no** `set -e`,
    because the `grep` exit code is the control signal and is captured with
    `||`), takes an optional path argument defaulting to `.`, and scans it with
    `grep -rlE` — **filenames only**, so a matched secret value can never reach
    a terminal or a CI log — under an exclusion list that skips `.git`,
    `node_modules`, `dist`, `.next`, `coverage`, `*.md`, `.env` / `.env.*`,
    `*.local` / `*.local.*`, `*.example` / `*.example.*`, both lockfiles, and the
    nested linked worktrees described under Scope above. The
    `.env` exclusions are load-bearing in the other direction: real credentials
    are never scanned in the first place. A `case "$rc"` block then resolves the
    grep exit and **fails closed**: `1` → `[PASS] No hardcoded secrets found`,
    `0` → `[FAIL]` with the sorted filenames and "Remove it and ROTATE the
    credential.", anything else → `[FAIL] Secret scan could not complete`,
    because a *broken* scan must not pass silently. It prints `[PASS]`/`[FAIL]`
    and exits non-zero on failure.
  - **Current result: passes.** `bash scripts/secret-scan.sh` run from the repo root
    exits 0 with `[PASS] No hardcoded secrets found`, after printing the one nested
    worktree it excludes, `fix-sandbox-observed-behaviour/` (checked 2026-10-18).
    The exclusion is listed in the output, not inferred from this line; re-run the
    script rather than trusting the date. The script **is** run by
    `bun run check` (`scripts/check-gates.sh`), as Gate 8 and the first thing the
    runner does, and therefore on every commit — see the Gate 8 runner section
    below. CI (`ci.yml`, `security` job) and all five jobs in
    `release.yml` do call it.

  - **In the runner: two parts, both offline and fail-closed.**
    `scripts/check-gates.sh` runs Gate 8 first, before any build, so a credential
    is refused in the first seconds of a commit instead of after a full suite:

    ```bash
    bash scripts/secret-scan.sh .        # part 1 — the CI script, verbatim
    git diff --cached --name-only        # part 2 — names only, never contents
    ```

    Part 2 exists because of a gap part 1 has **by design**: the scan excludes
    `.env` and `.env.*`, since a scanner must never read a real credential file to
    prove it cannot contain one. That makes `.gitignore` the only thing keeping
    `.env.production` out of a commit, and `git add -f` defeats `.gitignore`
    silently. Part 2 refuses any staged path matching `.env` / `.env.*`, with
    `.env.example` (the one tracked `.env*` file) allowed. It reads the index
    only, prints names only, and passes on an empty list — with nothing staged,
    a bare `bun run check` has nothing to check.

    Wiring the scan in is also what surfaced its strictness: the first version of
    this gate named its own log file `SECRET_LOG="$LOG_DIR/secret-scan.log"`, and
    the scan correctly flagged the runner, because `SECRET_LOG=` plus a quoted
    8+ character value is credential-shaped. It is now `SCAN_LOG`. CI never saw
    that, because CI calls the scan directly and not the runner.
  - **Not in the runner: `npm audit`.** `npm audit --audit-level=moderate` needs
    the npm registry, so a pre-commit hook that ran it would depend on the
    network and would fail closed on someone being offline — blocking every
    commit for a check that CI already performs and that is green. The scan is
    wired; the audit is not, by choice.
  - **Coverage.** The scan runs in `.github/workflows/ci.yml` (`security` job,
    "Check for secrets") **and** in all five jobs of `.github/workflows/release.yml`
    (`preflight`, `publish-npm`, `publish-github`, `publish-bun`, `create-docker`) —
    before anything is published, since a secret reaching a release commit reaches
    npm, a public registry and its mirrors within minutes. `ci.yml` now declares `permissions: { contents: read }`; it previously
    had no `permissions:` block at all, so `bun install` inherited the repository
    default token, often `contents: write`.
  - **Known false negative (intentional).** `deploy/k8s-deployment.yaml` carries
    Kubernetes Secret `stringData:` placeholders set to the literal `"REPLACE"`
    (7 characters — deliberately under the pattern's 8-character minimum) rather
    than an allowlist. Any allowlist entry is a maintenance burden and an obvious
    next target for a real credential to hide behind.
  - `.env` is untracked and gitignored; never read or print it, and refer to
    variable names and lengths only.
- **Gate 13 — mandatory pagination (applies; passes; no allowlist).**
  **The rule.** Every Mindbody GET endpoint that accepts both `request.limit` and
  `request.offset` in [`docs/openapi.json`](openapi.json) (or
  `getCoursesRequest.limit`/`offset`, the one endpoint that names them
  differently) **must** be called through `fetchAllPages`: in
  [`src/api/client.ts`](../src/api/client.ts) for the MCP server, and in
  [`nextjs-app/src/lib/mindbody/paging.ts`](../nextjs-app/src/lib/mindbody/paging.ts)
  for the Next.js app — a port with the same name and the same contract (below),
  which is what lets one scanner rule cover both code bases. A paginated
  endpoint called with a single GET is a failure, because it silently returns
  page one as if it were the whole list. **There is no allowlist and no
  per-endpoint exemption.** The fix for a violation is to page the call, never
  to exempt it.

  **The command.**
  ```bash
  bun test tests/pagination-gate.test.ts
  ```
  It is static and deterministic: no network, no subprocess, no credentials. It
  loads `docs/openapi.json`, classifies every GET path (prefix
  `/public/v{version}` stripped, lowercased) as paginated or not, then scans every
  `.ts` and `.tsx` file under **both** `src/` and `nextjs-app/src/` (the roots
  are listed in `SCAN_ROOTS`; `node_modules` and `.next` are outside them) with
  comments blanked out (line numbers preserved), so a commented-out call is not
  counted. Rule 4 also asserts that every root contributed at least one call
  site, so a root silently dropped from the scan cannot pass.

  **What counts as a violation** — one `test` per rule; each failure lists every
  offender as `file:line → path`:
  1. a `.get('/…')` / `.get<T>('/…')` call (single line or multi-line, any
     receiver) whose path the spec paginates;
  2. any GET path — through `.get` or `fetchAllPages` — that is not a GET in the
     spec (an unknown endpoint cannot be classified, so it fails);
  3. a `fetchAllPages` call on a path the spec does **not** paginate;
  4. fewer than 58 call sites found, or a scan root with none (the count
     observed on 2026-10-17 and cross-checked by an independent grep: `src/` 32 =
     30 `fetchAllPages` calls plus single GETs to the two non-paginated endpoints
     `/class/classvisits` and `/site/activationcode`; `nextjs-app/src/` 26 = 25
     `fetchAllPages` calls plus one single GET to `/site/activationcode`), so a
     broken scanner can never pass vacuously. The number is a floor; lower it
     only when call sites are really removed;
  5. a call site the scanner cannot resolve to a literal path: `fetchAllPages`
     with a non-literal path, `client.get(…)` / `mindbodyClient.get(…)` /
     `this.client.get(…)` with a non-literal path, or any `.request(…)` on those
     receivers. Two exemptions, both found structurally (by parsing the file),
     never by line number: the request `fetchAllPages` itself issues (inside
     that function's body), and the forwarding calls inside the body of `class
     MindbodyApiClient` — the axios wrapper both code bases define under that
     name, whose `get(endpoint)` hands a caller-supplied path to `this.client`.
     Those are the transport; the wrapper's own callers are what the scan checks.
  A scanner self-test runs the scanner over a fixture covering multi-line,
  generic, chained, commented-out and unresolvable calls, `this.client`
  receivers, the wrapper-class exemption and `.tsx` discovery, so a regex
  regression fails the suite directly rather than only lowering the count.

  **How `fetchAllPages` pages.** It sends `Limit` = page size (default 200, set
  per call) and advances `Offset` by the number of rows actually received. An
  empty page ends the walk. When the server reports `TotalResults`, the walk
  continues until that many rows are collected, so a server that serves fewer
  rows than asked (a silent cap) is still read to the end. Without
  `TotalResults`, it stops on the first page shorter than the smaller of
  `RequestedLimit` and the first page's length. (`PageSize` is the row count of
  that response per the spec, so it is not a cap.) It throws, never truncates:
  after `MAX_PAGES` = 100 pages (exported) with the path and the row count, and
  when a page's first row repeats the previous page's first row, which means the
  server is ignoring `Offset`. Covered by `tests/fetchAllPages.test.ts`.
  The live API does honour a `Limit` above 200: `Limit=500` returned
  `RequestedLimit 500, PageSize 141, TotalResults 141`.

  The Next.js port in `nextjs-app/src/lib/mindbody/paging.ts` has the same
  constants (`DEFAULT_PAGE_SIZE` 200, `MAX_PAGES` 100), termination rules and
  two throws. `tests/nextjs-paging.test.ts` (run by Gate 1) holds it to
  that contract and then drives the real `MindbodyService` against a paging fake
  server: every one of its list methods is asserted to send `Limit=200`, walk
  `Offset` 0 → 2 → 4 over a server that caps pages at 2 rows, hit the spec path
  under the spec's list key, and return all rows; `getClientVisits`,
  `getClientAccountBalances`, `getClientEnrollments` and the one legitimate
  single GET (`getActivationCode`) are covered individually.

  **How the runner executes it.** Like Gate 2, Gate 13 is subsumed by Gate 1: the
  file is a `*.test.ts`, so the runner's single `bun test` already runs it. The
  suite prints `GATE13_PAGINATION_RESULT sites=N violations=M` from `afterAll`,
  only once the scan has completed, and `scripts/check-gates.sh` derives the
  verdict from that line. It is fail-closed: sentinel missing (file renamed,
  deleted or excluded, or the scan crashed) → FAIL; `sites=0` → FAIL;
  `violations>0` → FAIL; otherwise PASS. Demonstrated 2026-10-17: reverting the
  `/class/waitlistentries` call in `src/tools/classManagement.ts` to a single
  `client.get` gave
  `src/tools/classManagement.ts:233 → /class/waitlistentries (get)` under rule 1
  and `FAIL Gate 13 mandatory pagination (1 violation(s) across 30 call sites; …)`,
  with a non-zero runner exit. Moving the gate file away gave
  `FAIL Gate 13 mandatory pagination did not run (no GATE13_PAGINATION_RESULT …)`.
  Demonstrated again for the Next.js root, same day: reverting `getPackages` in
  `nextjs-app/src/lib/mindbody/service.ts` to a single `this.client.get('/sale/packages', …)`
  gave `nextjs-app/src/lib/mindbody/service.ts:1103 → /sale/packages (get)` under
  rule 1 and `GATE13_PAGINATION_RESULT sites=58 violations=1`; restoring the
  call gave `violations=0` again.

  **What was found when the scan was widened (2026-10-17).** Before this, the
  Next.js app issued 26 GETs and paged none of them: 24 single GETs to
  paginated endpoints, one single GET to the non-paginated
  `/site/activationcode`, and one to `/client/clientenrollments`, a path that is
  not in the spec and that the live API answers with HTTP 404. All 24 now go
  through the pager; `getClientEnrollments` reads `GET /client/clientschedule`
  (list key `Visits`, `IncludeWaitlistEntries: true`, optional `startDate` /
  `endDate`) and returns `ClientScheduleVisit` rows, mirroring the MCP server's
  tool, instead of the dead endpoint — the feature was kept rather than removed
  because it is part of the app's exported service, tRPC router and hook
  surface. Three unrelated type errors that stopped `nextjs-app` from compiling
  at all were fixed in passing so that Gates 14 and 15 could exist (see below).

  **Runtime counterpart.** The E2E suite's `process health` block asserts that
  every GET the server sent during the session carried `Limit=200` and an
  `Offset`. That holds because every GET route the stub serves is paginated in
  the spec, so a single-GET regression on a stubbed route also fails Gate 2.

  **Scope limits (residual gap).** The scan covers `src/` and `nextjs-app/src/`;
  any further code base must be added to `SCAN_ROOTS`. The scanner recognises
  the receiver names `client`, `mindbodyClient` and `this.client` for rule 5; a
  GET issued through a differently named client object with a non-literal path,
  or through axios directly, would not be seen. The scan checks paths, not query
  parameters, so a call that sends a parameter the spec does not document (for
  example `Days` on `/appointment/activesessiontimes`) passes Gate 13. That is
  Gate 11 work.
- **Gates 14 and 15 — nextjs-app type check and build (apply; pass).**
  [`nextjs-app/`](../nextjs-app/README.md) is a second code base in the repo: a
  Next.js 14 app with its own axios Mindbody client, tRPC routers, Prisma schema
  and `package.json`, sharing no code with `src/`. Gate 13 proves its reads are
  paged; these two prove it compiles. Both run from inside `nextjs-app/` using
  the binaries its own lockfile pins:

  | Gate | Command (in `nextjs-app/`) | Result 2026-10-17 |
  |---|---|---|
  | 14 | `./node_modules/.bin/tsc --noEmit` | exit 0 |
  | 15 | `NEXT_TELEMETRY_DISABLED=1 ./node_modules/.bin/next build </dev/null` | exit 0, "Compiled successfully", 8 routes, ~11s warm |

  **Fail-closed.** If `nextjs-app/node_modules` is missing, each gate **fails**
  with the install command (`cd nextjs-app && bun install`); neither skips. A
  gate that cannot run must not read as green. Both need that one `bun install`
  per clone, which the root install does not do.

  **Why two gates when `next build` also type-checks.** Gate 14 reports a type
  error as a type error, in seconds; Gate 15 additionally bundles and prerenders
  every route, so a build-tool failure is distinguishable from a code failure.
  Gate 15 writes `nextjs-app/.next/` and `nextjs-app/tsconfig.tsbuildinfo`,
  ignored by `nextjs-app/.gitignore`. The runner prints this in its output.

  **What they were red on before.** When first run on 2026-10-17 both failed on
  11 pre-existing type errors: the tRPC router mounted as `client` collides with
  a built-in of the tRPC React proxy (now mounted as `clients`; the hooks were
  updated), a Prisma `Json` column assigned `null` instead of `Prisma.JsonNull`
  in `src/lib/sync/index.ts`, and the checkout cart's `metadata.id` typed as
  required although a `Tip` item carries `amount` instead. All three were code
  bugs, fixed in the code.

  **Not gates, and why (nextjs-app).** `next lint` — see gap 3c. **Tests** — the
  app has no test runner, no test script (`npm test` → `Missing script: "test"`)
  and no test files; its pager and service are tested from the root suite
  (`tests/nextjs-paging.test.ts`, `tests/nextjs-enrollment.test.ts`,
   `tests/nextjs-sitetime.test.ts`, Gate 1) so no second runner is needed. Adding
  a runner inside `nextjs-app/` would also pull `bun:test` types into a tsconfig
  that `next build` type-checks. The app's own `README.md` says the same.
- **Gate 16 — OpenAPI spec integrity (applies; passes; offline).**
  `sha256(docs/openapi.json)` must equal the single value in
  [`docs/openapi.lock`](openapi.lock). Purely local: it reads two files and
  compares, with no network, no credentials and no Mindbody API call, and costs
  about a second. Fail-closed on all four ways this can go wrong — spec missing,
  lock missing, either digest not 64 lowercase hex digits, or a mismatch — and it
  **fails, never skips**. The mismatch message names both digests and points at
  `bun run spec:update`.

  The two "unparseable digest" checks are the load-bearing ones. Without them an
  **empty or truncated lock file compares equal to an empty digest and passes**,
  so deleting the lock — the one failure mode that most needs to be loud — would
  have read as green. Validating the shape before comparing removes that whole
  class of false pass.

  **Why it runs second, after Gate 8 and before Gate 1.** Gate 8 stays first: a
  committed credential is the highest-harm thing this runner can catch and cannot
  be un-published by waiting. Gate 16 is next, and before the ~13.7s test run,
  because two later gates *read this file*: `tests/classManagement.test.ts`
  validates tool calls against it at runtime (Gate 1), and Gate 13's scanner
  classifies its GET paths to decide what must be paged. If the spec had
  drifted, both would be checking the wrong document and would report green on
  evidence that does not exist — so a spec-integrity failure is cheaper to
  discover before the test suite than after it, and the gates downstream of it
  are only as trustworthy as this one. It is cheap and offline for the same
  reason Gate 8's scan is.

  **What it does not prove.** Only that the two committed files agree with each
  other. It does **not** check the spec against upstream — that would put a
  network call in a pre-commit hook, and would make every commit depend on a
  third party's uptime and on Mindbody's own schedule. Agreement with upstream is
  a separate, deliberate question, handled by the drift policy below.

  **Drift policy — the spec is pinned, not auto-followed.**
  `docs/openapi.json` is a live mirror of a document Mindbody controls, so it
  will change and the SHA-256 will move. That is expected and is not in itself a
  problem. The policy:

  - The spec is **pinned**. Gate 16 verifies the pin; nothing follows upstream
    automatically, and no CI job updates the file.
  - When `bun run spec:update` changes the SHA, that is a trigger to **re-run the
    reconciliation audit**, not a routine sync. The 46 call sites in
    [`docs/mindbody-spec-discrepancies.md`](mindbody-spec-discrepancies.md) were
    reasoned against one specific document, and **those verdicts do not transfer
    automatically to a different one**. A moved SHA invalidates the audit until
    it is re-run.
  - The SHA-256 every verdict in that audit depends on is recorded at the top of
    the audit document, so a future reader can tell in one glance whether the
    audit still applies to the file in front of them.
  - Refreshing a spec whose SHA an audit depends on must **never happen
    silently**. `scripts/update-spec.ts` prints both digests and the added and
    removed paths on any move, which is the raw material for the re-run decision
    and is sufficient for that purpose; what it lacked was any statement that an
    audit is at stake, so it now prints a banner naming the audit and this
    policy alongside the diff. It still writes both files and still exits 0 — it
    is a maintenance command, not a gate, and only Gate 16 blocks a commit.

- **Gate 12 — agent skill structure (no-op for Claude Code extension keys).**
  `npx --yes skills-ref validate <dir>` passes for 24 of the 29
  `.agents/skills/*/` directories and fails for `handoff`,
  `setup-matt-pocock-skills`, `teach`, `ubiquitous-language`, and `zoom-out` — all
  five on disallowed frontmatter keys `argument-hint` and
  `disable-model-invocation`. **This is a schema mismatch, not malformed skills.**
  `skills-ref` implements the open Agent Skills spec, which permits exactly six
  fields: `name`, `description`, `license`, `allowed-tools`, `metadata`,
  `compatibility`. Claude Code's schema is a **strict superset** of that, and both
  extension keys are documented, current, non-deprecated Claude Code fields. The
  validator is behaving consistently — every passing skill has exactly `name` +
  `description` and no extension keys — so there is no validator bug either. Both
  sides are correct in their own domain.

  **Do not edit the skills to satisfy the validator.** Four of the five keys are
  load-bearing:

  - `disable-model-invocation: true` on `setup-matt-pocock-skills` and
    `ubiquitous-language` stops skills that **write files into the repo** from being
    auto-triggered. Removing it would let the model mutate repo config unprompted.
    It also keeps those two descriptions out of the always-in-context catalogue.
  - `argument-hint` on `handoff` is referenced by the skill's own body text ("If the
    user passed arguments...") and is the only thing telling the user to pass one.

  **Do not relocate the keys into `metadata:` either — that is a trap.** Claude Code
  reads `disable-model-invocation` only as a **top-level** field, so moving it under
  `metadata:` turns Gate 12 green while silently destroying all four guards, with
  nothing failing anywhere. Recorded here so nobody repeats it.

  What is still true and worth keeping: all 29 skills pass the *portable* properties
  the validator usefully checks — `name` and `description` present, name lowercase,
  name matches its directory, description within limits. The correct automated check
  for this repo would validate against the **Claude Code** schema rather than
  `skills-ref`, and a full `npx --yes` sweep still needs network access, so it is not
  in the pre-commit runner.

  Provenance, because it affects durability. The 29 skills were vendored by the
  `vercel-labs/skills` CLI from a third-party repo. `skills-lock.json` records a
  `computedHash` but **no version pin**, so a future `npx skills add` / `update`
  tracks upstream HEAD. `.claude/skills/` is 29 **symlinks** into
  `.agents/skills/`, so the two trees cannot drift — editing one updates both.
  Upstream has since deleted `zoom-out` and `ubiquitous-language` outright, so
  "fix it upstream" is not available for 2 of the 5.
- **Not in the runner, and why.** Gates 4, 5, 9, 10 and 11 need human judgement
  and are enforced by the done-done block in `AGENTS.md`, `Claude.md`, and
  `.github/copilot-instructions.md` pointing at this file. Gates 3 and 12 are
  excluded for different reasons: Gate 3 is still red (no linter, no complexity
  budget); Gate 12's check needs `npx --yes` network access and, for
  the skills that matter, the Claude Code schema rather than `skills-ref`. Gate 8
  is **half** in: its secret scan and staged-`.env` guard run as the first gate of
  the runner, so every commit is covered; only `npm audit` is left out, because it
  needs the registry and CI runs it. The runner covers Gates 1, 2, 6, 7, 8, 13,
  14, 15 and 16. Gates 2
  and 13 are executed by Gate 1's single `bun test` run and their verdicts read
  out of that run's log; see the Gate 2 and Gate 13 entries for why neither is
  invoked a second time. Gate 16 runs second, before Gate 1, because Gates 1 and
  13 both read the spec it verifies. Gates 14 and 15 run inside `nextjs-app/` and need its
  own `bun install` once per clone; they fail, not skip, without it. The opt-in live
  E2E tier is likewise not in the runner; see its own entry above for why it is
  credential-gated and cannot run unattended.
- **Follow-up, tracked — closed.** Wiring the Gate 8 secret scan into the local
  runner and the pre-commit hook is **done** (2026-10-18): the scan runs as Gate 8
  in `scripts/check-gates.sh`, the hook execs that same script, and `bun install`
  installs the hook through the `prepare` script. The duplication blocker named
  here earlier stays resolved: the scan still lives in one committed script,
  `scripts/secret-scan.sh`, called by the runner and by both workflows, so the
  pattern and the exclusion list change in exactly one place. Nothing further is
  outstanding on this item. What is still **not** covered, deliberately: `npm
  audit` (needs the registry; CI runs it) and the basename-collision residual gap
  named under Gate 8, which the script reports as a warning but does not close.

## When a gate fails

Fix the code, not the gate. Diagnose the failure, fix all failures in the same
session where practical, and re-run until every gate is green. Never weaken a
check to force a pass.