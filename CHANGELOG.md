# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Breaking Changes
- The SSE transport now requires a bearer token, `MCP_AUTH_TOKEN`, from inbound clients. An SSE server bound to anything other than `127.0.0.1`, `::1` or `localhost` (including the default `0.0.0.0`, the systemd unit, Docker and Kubernetes examples) refuses to start until `MCP_AUTH_TOKEN` is set, and its clients must send `Authorization: Bearer <token>`. STDIO is unchanged.

### Added
- Added local launchers (`bun run launch:sandbox`, `launch:prod`) that read a 1Password service account token from the OS credential store (`bun run op-sat install <profile>`), resolve `op://` ref files with `op inject` and start the server without the token in its environment. Also added `start:platform` for hosted deployments and a local `seed-platform-secrets` tool for Railway and Azure Key Vault. See `docs/SECRETS.md`.
- Added `cancelClientBooking`, which finds one booking on a client's schedule, chooses a late or normal cancel from `MINDBODY_LATE_CANCEL_WINDOW_HOURS`, and sends the write through `cancelAppointments`, `cancelEnrollmentVisits` or `removeClientFromClass`. A failed write is never retried: the schedule is re-read once to report whether the booking is gone, and the result carries a receipt with the exact request body.
- Added `observeBalance` to `cancelClientBooking`. When it is true, the paying service's `Remaining` and the client's `AccountBalance` are read before and after the cancel and returned as `impact`, with `consumed` and the balance delta. It reports what was observed, never a fee: the API exposes no fee ledger.
- Added a Streamable HTTP transport (`--transport http`, `bun run dev:http`): stateless, serving `/mcp` plus `/health`, authenticated by a Cloudflare Access JWT (`CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`) and refusing to start without it. `MCP_ALLOW_UNAUTHENTICATED=true` serves unauthenticated on loopback only. In-flight requests drain for up to 25 s on SIGTERM. The SSE transport is unchanged and still available.
- Added Railway deployment support: `.railway/railway.ts` (Railway Infrastructure as Code: App Sleeping, a `/health` healthcheck and `drainingSeconds: 30`; Railway ignores `railway.json` for new services), a source-only `Dockerfile`, and `docs/RAILWAY.md` covering the cost model, the Cloudflare Access setup and the steps that were not verified.
- Added `scripts/mb-auth-check.ts`, a read-only probe that says which of the four Mindbody credentials is wrong, run through `scripts/mb-auth-check.ps1` or `scripts/mb-auth-check.sh`. It checks the API key and `SiteId` (`/site/activationcode`), the source credentials (`/usertoken/issue`) and, with `--client-id`, whether the issued token unlocks that client's data (a `/client/clients` search by the client's name, through the server's own request path; `/client/clientcompleteinfo` confirms the client is on the site). It exits non-zero on failure, so it can gate a sidecar restart.
- Added `scripts/mcp-sidecar.ps1` and `scripts/mcp-sidecar.sh`, which run the server as a loopback Streamable HTTP sidecar outside any agent harness: sandbox by default, `prod` on request, each profile reading its own `op://` references file (`.env.op-refs`, `.env.op-refs.prod`). See AGENTS.md, Local sidecar.
- Gate 13 rule 6 (shell scripts carry no network client) now accepts a client that names a literal loopback host (`127.0.0.1`, `localhost`, `[::1]`) on its own line. A URL held in a variable, or any other host, is still refused.
- Added `getClientFormulaNotes`, a read-only tool for a client's formula notes, filtered by client and/or appointment.
- Added `getClientCompleteInfo`, which reads a client's account balance, services, contracts, memberships and arrivals in one `/client/clientcompleteinfo` request. The tool set is now 50.
- `getClientCompleteInfo` now exposes the parameters a sandbox probe verified (evidence in `docs/mindbody-spec-discrepancies.md` F-3): `requiredClientData` (validated to `Services`/`Contracts`/`Memberships`/`ArrivalPrograms`, the only values the API accepts — anything else is silently ignored with HTTP 200), `showActiveOnly` (narrows services to the rows that can pay now), and `startDate` (includes services *expiring* on or after the date — the observed semantics; the spec claims purchase date, and the default window silently drops expired purchases). Recorded as deviations D-12/D-13.
- Documented that the `authorization` staff usertoken is not optional in practice: `GET /client/clients` silently returns an empty 200 without it (4,465 rows with it), while `/client/clientcompleteinfo` works with the API key alone. Captured in `AGENTS.md` (defect class 4), `docs/API.md` (Authentication) and the discrepancies doc (F-2).
- Brought the tool set from 38 to 41 with `getClassVisits` (attendance for a single class), `cancelAppointments` and `cancelEnrollmentVisits`.
- Added dependency injection for the API client and cache in every tool, so tests run without the global client.
- Added an OpenAPI-validated stub client for tool tests, so test requests are checked against the Mindbody v6 spec.
- Added cached lookups that resolve location and session type IDs to names.
- Added a `spec:update` script to track changes to the Mindbody OpenAPI spec, and an offline check that the committed spec matches its lock.
- Added a quality-gate runner (`scripts/check-gates.sh`) and a pre-commit hook that runs every gate.
- Added agent guidance: `AGENTS.md` as the canonical guide, role definitions for Claude Code and OpenCode, and the ponytail plugin configuration.

### Changed
- The project is Bun-first: Bun runs `src/` directly and `bin` points at `src/index.ts` (it already has a `bun` shebang). Installing no longer compiles `dist/` (`prepare` now only sets the git hooks path). Node.js remains an option through `npm run node:build` and the `node:*` scripts, and CI still builds and smoke-tests Node 18, 20 and 22. The Docker image, systemd unit and Kubernetes example run `bun src/index.ts`. Removed the stale `package.node.json` and `switch.bat` runtime switcher; `package.json` already carries both sets of scripts.
- `MCP_TRANSPORT` is now honoured. It was declared in `.env.example` and read by `parseArgs`, but the check `if (!transport && process.env.MCP_TRANSPORT)` could never fire because `transport` was always set, so the variable was silently ignored. `PORT` is now read for the HTTP transport when `MCP_PORT` is unset (Railway injects it).
- The project is now standalone: it has left the `vespo92/MindbodyMCP` fork network and lives at `ProfitMarkHK/MindbodyMCP`. The npm package is renamed `@profitmarkhk/mindbody-mcp` (the command stays `mindbody-mcp`), and the release workflow publishes to the ProfitMarkHK npm scope, GitHub Packages and `ghcr.io/profitmarkhk`. Entries for 2.0.2 and earlier describe upstream releases.
- `getClients` accepts any number of `clientIds`. Production Mindbody refuses more than 20 `ClientIds` per `GET /client/clients` (`InvalidParameter`), so the IDs are sent in sequential batches of 20 and the results merged, de-duplicated by client ID; if any batch fails the whole call fails. Client-name lookups batch the same way.
- List reads now page through every result: each Mindbody list GET is fetched 200 rows at a time until the server's total is reached, instead of returning only the first page.
- All dates and times use the studio's own timezone, read from the site record. `MINDBODY_SITE_TIMEZONE` is used only when the site record has no usable zone, and write operations refuse it when it disagrees with the record.
- The `SiteId` header is no longer sent when `MINDBODY_SITE_ID` is unset.
- Late cancellations are refused unless `MINDBODY_LATE_CANCEL_WINDOW_HOURS` is set, and then apply only to appointments, enrollment sessions and class bookings starting within that many hours. The example configuration sets 24 hours.
- `getContracts` requires `locationId`, because the API rejects requests without it.
- `purchaseContract` sends `useAccountCredit` and reads the flat response the sandbox returns, matching observed sandbox behaviour (ADR 0001).
- `getBookableItems` returns availability windows rather than bookable slots; book only at a start time from `getActiveSessionTimes`.
- The pagination gate (Gate 13) uses the TypeScript compiler to find paginated reads, with a minimum count per source root.
- CI fails the build on type, test, build and audit errors, and the release workflow runs a shared preflight before publishing.
- Replaced relaxed types across the server and tests: `catch (error: any)` now uses `unknown`-narrowing through `errorMessage()` helpers, and `Record<string, any>` / `CacheEntry<any>` / `post(…data?: any)` are `unknown`-typed.
- Typed the client domain against the OpenAPI spec: `fetchAllPages<any>` and ad-hoc `(row: any)` mappers are now spec-derived types (`Client`, `Visit`, `ClientMembership`, `ClientContract`, and the POST response wrappers).

### Fixed
- Corrected the authentication documentation: it claimed `src/api/auth.ts` falls back to API-key-only auth and logs `Falling back to API-key-only auth` when `POST /usertoken/issue` fails. No such fallback exists — every request obtains headers through `getAuthHeaders()`, which throws `MindbodyAuthError`, and that string appears in no code path. An empty collection from a tool therefore can never mean "token missing". Fixed in `AGENTS.md` (defect class 4), `docs/API.md` (Authentication), `docs/mindbody-spec-discrepancies.md` (F-2) and `tests/live/README.md`.
- `bun install` no longer fails on Windows. The `prepare` script that installs the pre-commit hook used `>/dev/null 2>&1`, which Bun's Windows shell cannot parse, and under npm on Windows it never set `core.hooksPath`. It is now shell-independent and acts only when the package root has its own `.git`.
- The SSE transport now routes message POSTs. `POST /sse?sessionId=<id>` used to answer `404` and a bare `POST /sse` hung, so no client could complete `initialize`. Each POST now reaches the session that owns the id (`202`), and is refused with `400` (no `sessionId`), `404` (unknown or closed session), `403` (DNS-rebinding check) or `401` (no bearer token). An automated SSE round trip now runs in `bun test`.
- Non-idempotent POST requests are no longer retried. A POST that fails transiently is reported for reconciliation, because the v6 API has no idempotency key. Retries apply only to GET, HEAD and OPTIONS.
- The pager fails loudly instead of truncating a result: it throws on an empty page before the server's total is reached, on a total that contradicts the rows received, and on a server that ignores `Offset`.
- Corrected how the OAuth token expiry is read. Token authentication was briefly made optional to work around sandbox `DeniedAccess` errors; that was reverted, because an API-key-only call is answered with a different data set. The client now fails closed (`tests/auth-fail-closed.test.ts`).
- `getClassVisits` reads visits from the class in the response and includes the class details.
- `ClientMembership.IconCode` was typed `number`; it is a string on the wire (e.g. `"6"`). Retyped to `string` everywhere, after a live sandbox probe.

### Security
- The SSE transport authenticates inbound clients with `MCP_AUTH_TOKEN` (constant-time compare). Every request except `GET /health` and `OPTIONS` without the token gets `401`, before a session is created and before the DNS-rebinding check. Previously anyone who could reach the port could open sessions with the server's Mindbody credentials (#40).
- `updateAppointment` and `cancelAppointments` verify that the appointment belongs to the given client and that its status allows the change, before anything is written.
- `checkoutShoppingCart` verifies that every `appointmentIds` entry belongs to the client, and refuses the whole checkout if any does not.
- Arrived appointments cannot be cancelled.

## [2.0.2] - 2025-09-10

### Fixed
- Class, appointment, enrollment and teacher-schedule reads use optional chaining on `ClassDescription`, `Staff` and `Location`, and fall back to `FirstName LastName` when a staff name is absent, so a payload without the nested object renders empty instead of throwing.
- Removed the `Staff.DisplayName` fallback added in 2.0.1; the property is not in the v6 spec.

## [2.0.1] - 2025-09-09

### Added
- SSE transport alongside STDIO, with `--transport`, `--port`, `--host`, `--ssl-cert` and `--ssl-key` flags and their `MCP_*` environment fallbacks. The HTTP server exposes `/sse`, `/health` and `/info`, supports HTTPS when a certificate and key are supplied, and handles CORS preflight requests.
- Docker Compose, Kubernetes, systemd and nginx deployment assets, plus `docs/SSE_DEPLOYMENT.md`.
- `SECURITY.md` and Dependabot configuration.

### Fixed
- `getStaffAppointments` no longer throws when the API returns flat `StaffId`, `SessionTypeId`, `LocationId` or `ClientId` instead of nested objects.

## [2.0.0] - 2025-08-13

### Added
- 37 new MCP tools, 38 in total with `getTeacherSchedule`:
  - classes: `getClasses`, `getClassDescriptions`, `getClassSchedules`, `addClientToClass`, `removeClientFromClass`, `getWaitlistEntries`, `substituteClassTeacher`
  - clients: `getClients`, `addClient`, `updateClient`, `getClientVisits`, `getClientMemberships`, `addClientArrival`, `getClientAccountBalances`, `getClientContracts`
  - sales: `getServices`, `getPackages`, `getProducts`, `getContracts`, `checkoutShoppingCart`, `purchaseContract`
  - site: `getSites`, `getLocations`, `getPrograms`, `getResources`, `getSessionTypes`, `getActivationCode`
  - appointments: `getStaffAppointments`, `addAppointment`, `updateAppointment`, `getBookableItems`, `getActiveSessionTimes`, `getScheduleItems`
  - enrollments: `getEnrollments`, `addClientToEnrollment`, `getClientEnrollments`
  - staff: `getStaff`
- GitHub Actions CI and release workflows, a multi-stage `Dockerfile`, and npm, GitHub Packages, Bun executable and Docker distribution.
- Rewritten `README.md`, `Claude.md` and the API, architecture, quick-start and setup guides.

### Changed
- Renamed the npm package to `@vespo92/mindbody-mcp`; the command name stays `mindbody-mcp`.
- The API client merges auth headers in place in its request and 401-retry interceptors instead of replacing `config.headers`.

## [1.0.0] - 2024-12-19

### Added
- Initial release of Mindbody MCP Server
- `getTeacherSchedule` tool for querying teacher schedules
- OAuth 2.0 authentication with automatic token refresh
- Intelligent caching system (5-min for classes, 60-min for teachers)
- Automatic retry logic with exponential backoff
- Support for both Bun and Node.js runtimes
- Comprehensive TypeScript types for Mindbody API
- Environment-based configuration
- Performance benchmarking tools
- Developer documentation and setup guides

### Security
- Secure credential management via environment variables
- Token caching to minimize authentication requests
- Input validation on all user inputs

### Performance
- 4x faster startup with Bun runtime
- Efficient caching to respect API rate limits
- Optimized API client with connection pooling

[Unreleased]: https://github.com/ProfitMarkHK/MindbodyMCP/commits/master
[2.0.2]: https://github.com/vespo92/MindbodyMCP/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/vespo92/MindbodyMCP/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/vespo92/MindbodyMCP/compare/2b75b9e...v2.0.0
[1.0.0]: https://github.com/vespo92/MindbodyMCP/commit/2b75b9e
