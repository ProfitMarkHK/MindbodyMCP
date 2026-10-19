# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Expanded the server from one teacher-schedule tool to 41 tools covering classes, clients, sales, staff, site, appointments and enrollments.
- Added `getClassSchedules` to list recurring class schedules and `substituteClassTeacher` to replace an instructor on a class.
- Added `getClassVisits` to list attendance for a single class.
- Added appointment tools: `addAppointment`, `updateAppointment` (reschedule, staff, notes and status actions), `cancelAppointments`, `getBookableItems`, `getActiveSessionTimes` and `getStaffAppointments`.
- Added enrollment tools: `getEnrollments`, `addClientToEnrollment`, `getClientEnrollments` and `cancelEnrollmentVisits`.
- Added `checkoutShoppingCart` and `purchaseContract` for sales, and `getSites` for site details.
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
- Late cancellations are refused unless `MINDBODY_LATE_CANCEL_WINDOW_HOURS` is set, and then apply only to appointments and enrollments starting within that many hours.
- `getContracts` requires `locationId`, because the API rejects requests without it.
- `purchaseContract` sends `useAccountCredit` and reads the flat response the sandbox returns, matching observed sandbox behaviour (ADR 0001).
- `getBookableItems` returns availability windows rather than bookable slots; book only at a start time from `getActiveSessionTimes`.
- The pagination gate (Gate 13) uses the TypeScript compiler to find paginated reads, with a minimum count per source root.
- CI fails the build on type, test, build and audit errors, and the release workflow runs a shared preflight before publishing.

### Fixed
- Non-idempotent POST requests are no longer retried. A POST that fails transiently is reported for reconciliation, because the v6 API has no idempotency key. Retries apply only to GET, HEAD and OPTIONS.
- The pager fails loudly instead of truncating a result: it throws on an empty page before the server's total is reached, on a total that contradicts the rows received, and on a server that ignores `Offset`.
- Corrected how the OAuth token expiry is read, and made user token authentication optional, which resolves `DeniedAccess` errors on the sandbox.
- `getClassVisits` reads visits from the class in the response and includes the class details.
- The Next.js app renders every timestamp in the studio's timezone and syncs classes over the site's calendar day rather than the host's.

### Security
- `updateAppointment` and `cancelAppointments` verify that the appointment belongs to the given client and that its status allows the change, before anything is written.
- `checkoutShoppingCart` verifies that every `appointmentIds` entry belongs to the client, and refuses the whole checkout if any does not.
- Arrived appointments cannot be cancelled.

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

[Unreleased]: https://github.com/yourusername/mindbody-mcp/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/yourusername/mindbody-mcp/releases/tag/v1.0.0
