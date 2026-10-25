# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Brought the tool set from 38 to 41 with `getClassVisits` (attendance for a single class), `cancelAppointments` and `cancelEnrollmentVisits`.
- Added dependency injection for the API client and cache in every tool, so tests run without the global client.
- Added an OpenAPI-validated stub client for tool tests, so test requests are checked against the Mindbody v6 spec.
- Added cached lookups that resolve location and session type IDs to names.
- Added a Next.js companion app with pages for classes, appointments, enrollments, sales, locations, sites, clients, and staff.
- Added a `spec:update` script to track changes to the Mindbody OpenAPI spec, and an offline check that the committed spec matches its lock.
- Added a quality-gate runner (`scripts/check-gates.sh`) and a pre-commit hook that runs every gate.
- Added agent guidance: `AGENTS.md` as the canonical guide, role definitions for Claude Code and OpenCode, and the ponytail plugin configuration.

### Changed
- List reads now page through every result: each Mindbody list GET is fetched 200 rows at a time until the server's total is reached, instead of returning only the first page.
- All dates and times use the studio's own timezone, read from the site record. `MINDBODY_SITE_TIMEZONE` is used only when the site record has no usable zone, and write operations refuse it when it disagrees with the record.
- The `SiteId` header is no longer sent when `MINDBODY_SITE_ID` is unset.
- Late cancellations are refused unless `MINDBODY_LATE_CANCEL_WINDOW_HOURS` is set, and then apply only to appointments, enrollment sessions and class bookings starting within that many hours. The example configuration sets 24 hours.
- `getContracts` requires `locationId`, because the API rejects requests without it.
- `purchaseContract` sends `useAccountCredit` and reads the flat response the sandbox returns, matching observed sandbox behaviour (ADR 0001).
- `getBookableItems` returns availability windows rather than bookable slots; book only at a start time from `getActiveSessionTimes`.
- The pagination gate (Gate 13) uses the TypeScript compiler to find paginated reads, with a minimum count per source root.
- CI fails the build on type, test, build and audit errors, and the release workflow runs a shared preflight before publishing.
- Replaced relaxed types across the server, tests and the Next.js app: `catch (error: any)` now uses `unknown`-narrowing through `errorMessage()` helpers, and `Record<string, any>` / `CacheEntry<any>` / `post(…data?: any)` are `unknown`-typed.
- Typed the client domain against the OpenAPI spec in both the MCP server and the Next.js app: `fetchAllPages<any>` and ad-hoc `(row: any)` mappers are now spec-derived types (`Client`, `Visit`, `ClientMembership`, `ClientContract`, and the POST response wrappers).

### Fixed
- Non-idempotent POST requests are no longer retried. A POST that fails transiently is reported for reconciliation, because the v6 API has no idempotency key. Retries apply only to GET, HEAD and OPTIONS.
- The pager fails loudly instead of truncating a result: it throws on an empty page before the server's total is reached, on a total that contradicts the rows received, and on a server that ignores `Offset`.
- Corrected how the OAuth token expiry is read, and made user token authentication optional, which resolves `DeniedAccess` errors on the sandbox.
- `getClassVisits` reads visits from the class in the response and includes the class details.
- The Next.js app renders every timestamp in the studio's timezone and syncs classes over the site's calendar day rather than the host's.
- `ClientMembership.IconCode` was typed `number`; it is a string on the wire (e.g. `"6"`). Retyped to `string` everywhere, including the Next.js Prisma schema (`Int?` → `String?`), after a live sandbox probe.
- The Next.js client reads no longer use phantom fields that the server had already dropped: `LiabilityRelease` read as an object, `Location.Name`/`Staff.Name` on `Visit`, `Program` mapped to a string, `ClientCreditCards[]` with `Balance`, and `Description`/`SoldDate`/`Balance`/`ContractType` on `ClientContract`.
- The Next.js class/staff/sales reads now use the spec field names: `ClassDescription.ImageURL` (not `ImageUrl`), `Class.Substitute` (not `IsSubstitute`), `Staff.IsMale` (not `isMale`), and `Contract.IntroOffer` as a string (not an object).
- The Next.js date-time render no longer depends on the runtime's ICU/CLDR data: `formatSiteDateTime` and `formatSiteDateTimeLong` format the date and the clock with two separate `Intl.DateTimeFormat`s joined by an explicit separator (`" at "` and `", "`), because a single combined pattern lets ICU insert the CLDR date-time combination glue, which changed for en-US in CLDR 42 (`"{date}, {time}"` → `"{date} 'at' {time}"`). The same code printed "Sun, Oct 18 at 8:00 AM" on a newer ICU and "Sun, Oct 18, 8:00 AM" on the GitHub ubuntu runner, failing five `formatSiteTime` tests in CI only.

### Security
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

[Unreleased]: https://github.com/vespo92/MindbodyMCP/compare/v2.0.2...HEAD
[2.0.2]: https://github.com/vespo92/MindbodyMCP/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/vespo92/MindbodyMCP/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/vespo92/MindbodyMCP/compare/2b75b9e...v2.0.0
[1.0.0]: https://github.com/vespo92/MindbodyMCP/commit/2b75b9e
