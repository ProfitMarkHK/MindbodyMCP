# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview
The Mindbody MCP Server is a comprehensive Model Context Protocol server that provides AI assistants with complete access to the Mindbody API for fitness/wellness studio management. It's built with TypeScript, Bun, and the MCP SDK.

**Core capabilities:**
- **Complete Class Management**: View, book, cancel, substitute teachers, manage waitlists
- **Client Management**: Add/update clients, track visits, memberships, balances
- **Sales & Commerce**: Process payments, sell packages, memberships, products
- **Staff Management**: View schedules, manage appointments, track availability
- **Site Operations**: Manage locations, programs, resources, session types
- **Appointments**: Book, reschedule, check in, check out, cancel, find available slots
- **Enrollments**: Manage courses, workshops, series registrations

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Standard triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout with `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Development

### Quick Start
```bash
# Install dependencies
bun install

# Run in development mode (STDIO transport)
bun run dev

# Run with SSE transport (production-like)
bun run dev:sse

# Run tests
bun test

# Type checking and linting
bun run typecheck
bun run lint

# Build for production
bun run build
```

### Project Structure
```
src/
├── index.ts              # MCP server entry point and tool registration
├── api/                  # API client and authentication
│   ├── client.ts        # HTTP client with retry logic
│   └── auth.ts          # OAuth 2.0 token management
├── tools/               # Tool implementations (one per domain)
│   ├── classManagement.ts
│   ├── clientManagement.ts
│   ├── appointmentManagement.ts
│   ├── enrollmentManagement.ts
│   ├── siteManagement.ts
│   ├── salesManagement.ts
│   └── teacherSchedule.ts
├── cache/               # In-memory caching system
├── types/               # TypeScript type definitions
└── utils/               # Helper utilities (dates, formatting)

tests/                   # Test files and benchmarks
docs/                    # Documentation and API spec
```

### Testing
```bash
# Run all tests
bun test

# Test a specific tool manually
bun run test:tool

# Test SSE transport
bun run test:sse

# Run performance benchmarks
bun run benchmark
```

### Adding a New Tool

1. **Create the tool file** in `src/tools/yourFeature.ts`:
   ```typescript
   import { SomeResponse } from '../types/mindbody';
   
   export async function yourTool(
     param1: string,
     param2?: number
   ): Promise<SomeResponse> {
     // Implementation
   }
   ```

2. **Add types** to `src/types/mindbody.ts` for request/response shapes

3. **Register in `src/index.ts`**:
   - Import the function
   - Add to the ListToolsRequest handler
   - Add a case in CallToolRequest handler

4. **Update documentation**:
   - `README.md` with tool description
   - This file with usage examples
   - Add JSDoc comments

See `CONTRIBUTING.md` for detailed style guidelines and PR process.

## Architecture

### Layers

**MCP Server (`src/index.ts`)** → Handles protocol, routes tool requests  
**Tools Layer (`src/tools/`)** → Business logic for each domain  
**API Client (`src/api/client.ts`)** → HTTP requests with automatic retry for GET requests (POSTs are not retried)  
**Auth (`src/api/auth.ts`)** → OAuth 2.0 token refresh  
**Cache (`src/cache/`)** → TTL-based in-memory caching  
**Types (`src/types/`)** → TypeScript definitions  

### Key Design Decisions

- **Bun runtime**: 4x faster cold starts than Node.js, native TS support
- **Modular tools**: One file per domain, ~200 line limit
- **Smart caching**: 60 min for static data, 5 min for dynamic
- **Type safety**: Full TypeScript strict mode
- **Error handling**: Automatic retry with exponential backoff for GET requests, user-friendly messages

### Performance Features

- **Automatic retry**: Exponential backoff on 5xx errors for GET requests (POSTs fail loudly, not retried)
- **Token refresh**: OAuth tokens refresh before expiry
- **Connection pooling**: Axios handles reuse
- **Rate limit awareness**: Respects Mindbody's 2000 req/hour limit
- **Multi-level caching**: Teacher ID → class data → HTTP responses

## Available Tools (42 tools)

### 📅 Class Management

#### `getClasses`
Get all classes with comprehensive filtering options.

**Parameters:**
- `startDate` (optional): Start date in YYYY-MM-DD format
- `endDate` (optional): End date in YYYY-MM-DD format
- `locationIds` (optional): Array of location IDs
- `classDescriptionIds` (optional): Array of class type IDs
- `staffIds` (optional): Array of instructor IDs

**Returns:** List of classes with availability, instructor, location, and booking status

#### `getClassDescriptions`
Get all class types offered (Vinyasa, Hatha, Hot Yoga, etc.).

**Returns:** Complete list of class types with descriptions and prerequisites

#### `getClassSchedules`
Get recurring class schedules/templates.

**Parameters:**
- `locationIds` (optional): Filter by locations
- `classDescriptionIds` (optional): Filter by class types
- `staffIds` (optional): Filter by instructors
- `programIds` (optional): Filter by programs

#### `addClientToClass`
Book a client into a class.

**Parameters:**
- `clientId` (required): Client ID
- `classId` (required): Class ID to book
- `requirePayment` (optional): Require payment (default true)
- `waitlist` (optional): Add to waitlist if full

#### `removeClientFromClass`
Cancel a client's class booking.

**Parameters:**
- `clientId` (required): Client ID
- `classId` (required): Class ID
- `lateCancel` (optional): Mark as late cancellation. Refused unless `MINDBODY_LATE_CANCEL_WINDOW_HOURS` is set, and then only for a class starting within that many hours (the class is looked up first; an unknown or already-started class is refused)

#### `getWaitlistEntries`
View waitlist entries for classes.

**Parameters:**
- `classScheduleIds` (optional): Class schedule IDs
- `classIds` (optional): Specific class IDs
- `clientIds` (optional): Filter by clients

#### `substituteClassTeacher`
Substitute an instructor for a class.

**Parameters:**
- `classId` (required): Class ID
- `originalTeacherId` (required): Original instructor ID
- `substituteTeacherId` (required): Substitute instructor ID

#### `getClassVisits`
Get client visits and attendance for one class, including sign-in status and late cancellations.

**Parameters:**
- `classId` (required): Class ID
- `lastModifiedDate` (optional): Only visits modified after this date (YYYY-MM-DD)

### 👥 Client Management

#### `getClients`
Search and retrieve client information.

**Parameters:**
- `searchText` (optional): Search by name/email/phone
- `clientIds` (optional): Specific client IDs
- `lastModifiedDate` (optional): Recently modified clients
- `isProspect` (optional): Filter prospects

**Returns:** Client details including contact info, emergency contacts, membership status

#### `addClient`
Register a new client.

**Parameters:**
- `firstName` (required): First name
- `lastName` (required): Last name
- `email` (optional): Email address
- `mobilePhone` (optional): Mobile phone
- `birthDate` (optional): Birth date
- Plus address, emergency contact, and preference fields

#### `updateClient`
Update existing client information.

**Parameters:**
- `clientId` (required): Client ID
- `updates` (required): Object with fields to update

#### `getClientVisits`
Get client's attendance history.

**Parameters:**
- `clientId` (required): Client ID
- `startDate` (optional): Start date
- `endDate` (optional): End date

**Returns:** Visit history with attendance stats, no-shows, late cancels

#### `getClientMemberships`
View client's active memberships.

**Parameters:**
- `clientId` (required): Client ID
- `locationId` (optional): Filter by location

#### `addClientArrival`
Check in a client at the studio.

**Parameters:**
- `clientId` (required): Client ID
- `locationId` (required): Location ID

#### `getClientAccountBalances`
Get client's account and credit balances.

**Parameters:**
- `clientId` (required): Client ID

#### `getClientContracts`
View client's contracts and auto-renewing memberships.

**Parameters:**
- `clientId` (required): Client ID

#### `getClientCompleteInfo`
A client's whole wallet in one call (`GET /client/clientcompleteinfo`): the client record with `AccountBalance`, purchased services, contracts, memberships and arrival programs. Use it instead of four separate reads.

**Parameters:**
- `clientId` (required): Client ID

**Returns:** `{ client: { id, firstName, lastName, accountBalance }, services, contracts, memberships, arrivals }`. `arrivals[].locations` carries `{ id, name }`, where `name` is `undefined` if the location catalogue does not hold the id. See [`docs/API.md`](docs/API.md#getclientcompleteinfo) for the fields and the parameters the tool deliberately does not send.

### 💰 Sales & Commerce

#### `getServices`
Get available services (class packages, memberships).

**Parameters:**
- `programIds` (optional): Filter by programs
- `sessionTypeIds` (optional): Filter by session types
- `locationId` (optional): Filter by location
- `classId` (optional): Services for specific class

#### `getPackages`
Get class package options.

**Parameters:**
- `locationId` (optional): Filter by location
- `classScheduleId` (optional): Packages for specific class

#### `getProducts`
Get retail products (mats, blocks, apparel).

**Parameters:**
- `productIds` (optional): Specific products
- `searchText` (optional): Search products
- `categoryIds` (optional): Filter by category
- `sellOnline` (optional): Online products only

#### `getContracts`
Get membership contract types.

**Parameters:**
- `contractIds` (optional): Specific contracts
- `soldOnline` (optional): Online contracts only
- `locationId` (optional): Filter by location

#### `checkoutShoppingCart`
Process a complete purchase transaction.

**Parameters:**
- `clientId` (required): Client ID
- `items` (required): Cart items, each `{ item: { type, metadata }, quantity, appointmentIds? }`
  - `item.type`: `Service`, `Product`, `Package` or `Tip`. `item.metadata.id` identifies the service, product or package; a `Tip` uses `item.metadata.amount` instead.
  - `appointmentIds` (optional, per item): Existing appointment IDs this item pays for. Checkout reconciles them, linking the sale to the booked appointment. The response lists the reconciled IDs on each cart item as `appointments`. Every ID is verified to belong to `clientId` (same lookup as `cancelAppointments`) before anything is sent; if any fails, or the lookup cannot run, the whole checkout is refused and nothing is charged.
- `payments` (required): Payment methods, each `{ type, metadata: { amount, ... } }`. `type` is `Cash`, `Check`, `CreditCard`, `Comp`, `Custom` or `StoredCard`.
- `inStore` (optional): In-store purchase
- `promotionCode` (optional): Discount code
- `sendEmail` (optional): Send receipt (default true)
- `locationId` (optional): Location ID

#### `purchaseContract`
Purchase a membership/contract.

**Parameters:**
- `clientId` (required): Client ID
- `contractId` (required): Contract type ID
- `startDate` (required): Start date
- `firstPaymentOccurs` (optional): Payment timing
- `promotionCode` (optional): Discount code
- `locationId` (optional): Location ID
- `useAccountCredit` (optional): Bill the client's account balance. **The only way to make this tool succeed.** The API refuses the request unless one of CreditCardInfo, StoredCardInfo, UseDirectDebit or UseAccountCredit is present, and this server deliberately exposes only the last — it takes no card or bank details. The flag is accepted against a zero balance, so the contract commits and the charge is left on the client account.

Returns `clientContractId` (the id of the ClientContract that was created), `contractId`, `locationId` and `totals`. It commits for real: v6's `Test` dry-run flag is not exposed. See [`tests/live/README.md`](tests/live/README.md) for what that leaves behind.

### 🏢 Site & Location Management

#### `getSites`
Get business/site information for the site this server operates on.

**Parameters:**
- `siteId` (optional): Explicit site ID to query. Overrides the configured default `MINDBODY_SITE_ID`.

**Returns:** `{ site }` with details, payment settings, branding and IANA timezone, or `{ error, availableSites }` and no `site`.

**Multi-site policy.** The lookup sends `SiteIds` for the chosen site, and the result must resolve to exactly one site. When the API key reaches more than one site and neither a default (`MINDBODY_SITE_ID`) nor an explicit `siteId` picks one, no site data is returned; `availableSites` lists the reachable IDs and names so the operator can choose. The server never falls back to the first site returned. The site timezone used for date handling follows the same selection.

#### `getLocations`
Get all studio locations.

**Returns:** Locations with addresses, hours, amenities, coordinates

#### `getPrograms`
Get programs offered (Yoga, Pilates, Barre, etc.).

**Parameters:**
- `scheduleType` (optional): Filter by type (Class/Enrollment/Appointment)
- `onlineOnly` (optional): Online programs only

#### `getResources`
Get resources (rooms, equipment).

**Parameters:**
- `sessionTypeIds` (optional): Filter by session type
- `locationId` (optional): Filter by location
- `startDateTime` (optional): Available from
- `endDateTime` (optional): Available until

#### `getSessionTypes`
Get session types (class formats, appointment types).

**Parameters:**
- `programIds` (optional): Filter by programs
- `onlineOnly` (optional): Online sessions only

#### `getStaff`
Get all staff members.

**Parameters:**
- `staffIds` (optional): Specific staff IDs
- `filters` (optional): Apply filters
- `sessionTypeIds` (optional): Staff for session types
- `locationIds` (optional): Staff at locations

#### `getTeacherSchedule`
Get a teacher's complete schedule.

**Parameters:**
- `teacherName` (required): Teacher's name
- `startDate` (optional): Start date
- `endDate` (optional): End date

**Returns:** Detailed schedule with classes, locations, and availability

#### `getActivationCode`
Get the site activation code. Takes no parameters.

### 📆 Appointments

#### `getStaffAppointments`
View appointments. Every filter is optional. With no dates, it covers today through seven days out.

**Parameters:**
- `staffIds` (optional): Staff member IDs
- `locationIds` (optional): Filter by location
- `startDate` (optional): Start date (YYYY-MM-DD), default today
- `endDate` (optional): End date (YYYY-MM-DD), default seven days from today
- `appointmentIds` (optional): Specific appointment IDs
- `clientId` (optional): A single client ID (not a list)

#### `addAppointment`
Book a new appointment.

**Parameters:**
- `clientId` (required): Client ID
- `staffId` (required): Staff member ID
- `locationId` (required): Location ID
- `sessionTypeId` (required): Service type ID
- `startDateTime` (required): Start time (ISO format)
- `notes` (optional): Appointment notes

#### `updateAppointment`
Update an existing appointment: reschedule, change staff or notes, or apply a status action. Rescheduling is an update with a new `startDateTime`. This tool does not cancel; use `cancelAppointments`.

**Parameters:**
- `clientId` (required): Client ID who owns the appointment. Ownership is verified before anything is written.
- `appointmentId` (required): Appointment ID
- `startDateTime` (optional): New start date/time (reschedule)
- `endDateTime` (optional): New end date/time
- `staffId` (optional): Change staff
- `resourceIds` (optional): Resource IDs
- `notes` (optional): Update notes
- `execute` (optional): Status action: `confirm`, `unconfirm`, `arrive`, `unarrive` or `complete`. `cancel` and `latecancel` are refused with no API call.
- `executePayment` (optional): Deprecated and ignored (not part of the Mindbody API)
- `sendEmail` (optional): Send email
- `applyPayment` (optional): Apply a current applicable client service from that client's account

**Guards.** All are checked before any write, and none can be skipped by omitting an argument:
- `clientId` must be a non-empty string and `appointmentId` a positive integer.
- Ownership: the appointment must belong to `clientId`, checked with the same `GET /appointment/staffappointments` lookup `cancelAppointments` uses. Someone else's appointment, or one outside the lookup window (a year back through two years ahead, so a finished appointment can still be annotated), is reported as "not found for this client".
- Status: a `Cancelled` or `LateCancelled` appointment is final and accepts no update at all. A `Completed` or `NoShow` one accepts no status action, no `applyPayment` and no reschedule — but notes, staff and resources are still fine, because staff do annotate a finished appointment.
- Timing: `execute: complete` needs the appointment to have started, compared in the site's timezone. `arrive`/`unarrive` are deliberately *not* time-gated: arrival is recorded against a booked appointment, including one booked for a later day. If the site timezone cannot be resolved, nothing is looked up or written.
- `applyPayment` is refused in the same call as a reschedule. It applies a service chosen against the appointment's current time, so move first, pay second; no MCP path reverses a sale.

**Returns:** `{ success, appointment?, rejected: [{ id, reason }], message }`

#### `cancelAppointments`
Cancel future appointments for one client. This is the only cancel path in the server.

**Parameters:**
- `clientId` (required): Client ID who owns every appointment
- `appointmentIds` (required): 1 to 3 appointment IDs, no duplicates
- `lateCancel` (optional): Record as late cancellations (default false). Refused unless `MINDBODY_LATE_CANCEL_WINDOW_HOURS` is set, and then only for an appointment starting within that many hours (the v6 spec does not expose the site's window)
- `sendEmail` (optional): Email the client about the cancellation (default false)

**Guards.** All are checked before any cancellation is sent:
- One client per call.
- 1 to 3 IDs (`MAX_CANCELLATIONS_PER_REQUEST`), no duplicates.
- Each appointment must belong to `clientId`. Ownership is checked with `GET /appointment/staffappointments` filtered by `ClientId`. An appointment that belongs to someone else, or falls outside the lookup window (today through two years out), is reported as "not found for this client".
- Each appointment must start in the future, compared in the site's timezone (see "Dates and timezones" under Configuration). If that zone cannot be resolved, nothing is written.
- Each appointment must not already be `Cancelled`, `LateCancelled`, `Completed`, `NoShow` or `Arrived`. `Arrived` is refused by decision: see "Arrived appointments" in `docs/API.md`.

All-or-nothing: if any ID fails a guard, nothing is cancelled and `rejected` gives the reason for each failing ID. If the verification lookup itself fails, nothing is cancelled. Once the guards pass, cancellations are sent one at a time via `POST /appointment/updateappointment` with `Execute: cancel` (or `latecancel`). If one of those writes fails, the cancellations already made stand: they are listed in `cancelled`, and the failing ID appears in `rejected`.

**Returns:** `{ success, cancelled: [{ id, status, startDateTime }], rejected: [{ id, reason }], message }`

#### `getBookableItems`
Find availability windows in which a session could be booked — **windows, not slots**. Each row spans a range (typically 120–750 minutes), so a start must still be validated against `getActiveSessionTimes` before it can be booked.

**Naming:** "bookable items" is only the endpoint and tool name. No response field is called `BookableItems`; the list key is `Availabilities`, and reading `BookableItems` silently yields an empty list. The same `Availabilities` key also appears nested under `StaffMembers[]` from `getScheduleItems`, where it serves schedule display rather than booking discovery. See "getBookableItems" in `docs/API.md` for the distinction and use cases.

**Parameters:**
- `sessionTypeIds` (required): Service types
- `locationIds` (optional): Locations
- `staffIds` (optional): Specific staff
- `startDate` (optional): Search from
- `endDate` (optional): Search until
- `appointmentId` (optional): Appointment ID for rescheduling

**Reads:** only the `Availabilities` list of the response, the one list key `docs/openapi.json` documents for `GetBookableItemsResponse`. Other keys are ignored. All pages are fetched through `fetchAllPages`.

#### `getActiveSessionTimes`
Get the active session start times: the business-hours increments at which a session can start. This is not bookable availability; use `getBookableItems` for that. A booking's start must also be one of these times.

**Parameters:**
- `scheduleType` (optional): Type filter (`All`, `Class`, `Enrollment`, `Appointment`; default `All`)
- `sessionTypeIds` (optional): Session types
- `startTime`, `endTime` (optional): Time-of-day window
- `days` (optional): Days of week

**Returns:** `{ activeTimes: string[], bySessionType: [{ sessionTypeId, activeTimes }], totalActiveTimes }`. Times are `HH:MM:SS` strings.

#### `getScheduleItems`
Get detailed schedule availability.

**Parameters:**
- `locationIds` (optional): Locations
- `staffIds` (optional): Staff members
- `startDate` (optional): Start date
- `endDate` (optional): End date

### 🎓 Enrollments (Courses/Workshops)

Mindbody has no enrollment record of its own. An enrollment is a class schedule whose program has `ScheduleType: Enrollment`; each session is a class on that schedule; a client's seat in a session is a visit on the client's schedule. The visit record carries no enrollment marker (`VisitType`/`TypeGroup` are identical for enrollment and drop-in visits on the sandbox), so the tools resolve each visit's class and keep it only when the class's program is an enrollment program. Changing a client's dates has no API operation: cancel the sessions with `cancelEnrollmentVisits`, then `addClientToEnrollment` again with `enrollOpenDates` or `enrollDateForward`.

#### `getEnrollments`
List enrollments scheduled at the site (`GET /enrollment/enrollments`, paginated, list key `Enrollments`). Each row is a ClassSchedule; its `id` is the `classScheduleId` that `addClientToEnrollment` takes. Sessions are not included (`Classes` is null on this endpoint); use `getClasses` with `classScheduleIds` for them.

**Parameters** (all optional; these are the only filters the spec defines):
- `locationIds`, `staffIds`, `programIds`, `sessionTypeIds`, `classScheduleIds`
- `startDate`, `endDate`: default today through 365 days ahead in the site's zone

**Returns:** `{ enrollments: [{ id, name, description, courseId, courseName, programId, programName, sessionTypeId, sessionTypeName, staffId, staffName, locationId, locationName, semesterId, startDate, endDate, startTime, endTime, days, allowOpenEnrollment, allowDateForwardEnrollment, isAvailable }], totalEnrollments }`

#### `addClientToEnrollment`
Book one client into one enrollment (`POST /enrollment/addclienttoenrollment`). Body field names follow the spec exactly: `ClientId`, `ClassScheduleId` (singular), `EnrollDateForward`, `EnrollOpen`, `Waitlist`, `WaitlistEntryId`, `SendEmail`, `Test`. The sandbox refuses a plural `ClassScheduleIds` with `MissingRequiredFields`.

**Parameters:**
- `clientId` (required)
- `classScheduleId` (required): the enrollment `id` from `getEnrollments`
- `enrollDateForward` (optional): book every session from this site-local date-time on (the enrollment must allow date-forward enrollment); takes priority over `enrollOpenDates`
- `enrollOpenDates` (optional): book only these session date-times (the enrollment must allow open enrollment)
- `waitlist` (optional, default false), `waitlistEntryId` (optional), `sendEmail` (optional, default false), `test` (optional, default false: validate only)

**Returns:** `{ success, classScheduleId, name, sessions: [{ classId, startDateTime, endDateTime, totalBooked }], message }`. With neither date option the client is booked into the whole enrollment.

**Duplicate guard.** Mindbody books the same client into the same session twice without complaint (verified on the sandbox). Before writing, the tool reads the enrollment's window (`GET /enrollment/enrollments`) and the client's sessions in it; if the client already holds a seat in any session the request would book, nothing is booked and the message lists the held visit IDs. Late-cancelled visits and waitlist entries do not count as seats, and `waitlist: true` requests skip the check.

#### `getClientEnrollments`
A client's enrollments with every session they hold, grouped by enrollment. Reads `GET /client/clientschedule` (paginated, `IncludeWaitlistEntries: true`), then `GET /class/classes` by `ClassIds` (paginated, in chunks of 50) to resolve each visit's class. A visit is kept only when its class's `ClassDescription.Program.ScheduleType` is `Enrollment`; drop-in classes and appointments are excluded.

**Parameters:**
- `clientId` (required)
- `startDate`, `endDate` (optional): default today through 365 days ahead in the site's zone, so past sessions appear only when `startDate` is given

**Returns:** `{ enrollments: [{ classScheduleId, name, programId, programName, staffId, staffName, locationId, locationName, semesterId, sessions: [{ visitId, classId, startDateTime, endDateTime, signedIn, lateCancelled, missed, makeUp, isWaitlisted, waitlistEntryId }], totals: { sessions, attended, missed, lateCancelled, waitlisted } }], totalEnrollments, totalSessions }`. `visitId` is what `cancelEnrollmentVisits` takes.

#### `cancelEnrollmentVisits`
Cancel 1 to 3 future enrollment sessions for one client, by visit ID, via `POST /class/removeclientfromclass` (`ClientId`, `ClassId`, `VisitId`, `LateCancel`, `SendEmail`). This is the only path that drops a client from an enrollment.

**Parameters:**
- `clientId` (required): owner of every visit
- `visitIds` (required): 1 to 3 visit IDs (`MAX_ENROLLMENT_CANCELLATIONS_PER_REQUEST`), no duplicates
- `lateCancel` (optional, default false; bounded by `MINDBODY_LATE_CANCEL_WINDOW_HOURS` as in `cancelAppointments`), `sendEmail` (optional, default false)

**Guards.** All are checked before any cancellation is sent:
- One client per call; 1 to 3 IDs; no duplicates.
- The site timezone must resolve (see "Dates and timezones"); otherwise nothing is written.
- Each visit must be on the client's own schedule (`GET /client/clientschedule`, today through two years out). A visit that belongs to someone else, or is outside that window, is reported as "not found for this client".
- Each visit must be a booked enrollment session: not an appointment (no `ClassId`), not a waitlist entry, and its class must belong to an `Enrollment` program (a drop-in class is refused with a pointer to `removeClientFromClass`).
- Each session must start in the future in the site's zone, and the visit must not already be late-cancelled or signed in. Mindbody's `Missed` flag is not a guard: the sandbox sets it on every future, not-yet-attended enrollment visit.

All-or-nothing: if any ID fails a guard, nothing is cancelled and `rejected` gives the reason per ID. If a lookup fails, nothing is cancelled. Once the guards pass, cancellations are sent one at a time; if one write fails, the ones already made stand and are listed in `cancelled`, and the failing ID is in `rejected`.

**Returns:** `{ success, cancelled: [{ visitId, classId, classScheduleId, startDateTime }], rejected: [{ visitId, reason }], message }`

## Architecture & Performance

### High Performance
- Built on Bun runtime for 4x faster execution
- Intelligent caching system (5-min classes, 60-min static data)
- Automatic retry with exponential backoff for GET requests
- Rate limit aware (2000 req/hour limit)

### Pagination
Every Mindbody GET that accepts `Limit`/`Offset` in `docs/openapi.json` is read through `fetchAllPages` (`src/api/client.ts`). It asks for 200 rows per page (`DEFAULT_PAGE_SIZE`; callers may pass another page size), advances `Offset` by the rows actually received, and, when the server reports `TotalResults`, keeps going until that many rows are collected. It never returns a silently truncated list: it throws after `MAX_PAGES` (100) pages, or when the server ignores `Offset` and repeats a page.

Gate 13 (`tests/pagination-gate.test.ts`, run by `bun run check`) enforces this statically. A paginated endpoint called with a single `.get()`, a path the spec does not define, or a call the scanner cannot resolve to a literal path fails the build. There is no allowlist, so fix a violation by paging the call, never by exempting it. When you add an endpoint that the spec paginates, call it through `fetchAllPages`. See [docs/quality-gates.md](docs/quality-gates.md).

### Authentication
- OAuth 2.0 with automatic token refresh
- Secure credential management via environment variables
- Site-specific authentication support

### Error Handling
- User-friendly error messages
- Graceful API failure handling
- Detailed debug logging available

## Common Use Cases

### Daily Operations
```
"Show me today's yoga classes"
"Check in Sarah Johnson" 
"Book John into the 6pm Vinyasa class"
"Who's on the waitlist for tomorrow's Hot Yoga?"
```

### Staff Management
```
"Get Alexia's teaching schedule this week"
"Find a substitute for Maria's Thursday class"
"Show me which instructors teach Pilates"
"What appointments does Dr. Smith have today?"
```

### Client Services
```
"Add new client Jennifer Wilson"
"What's Michael's attendance this month?"
"Show Sarah's active memberships"
"Get client balance for ID 12345"
```

### Sales Operations
```
"What class packages are available?"
"Show me unlimited membership options"
"Process purchase of 10-class package for Amy"
"What products do we sell online?"
```

### Business Analytics
```
"How many spots available in this week's classes?"
"Show class attendance by instructor"
"Get waitlist counts by class type"
"List all studio locations and hours"
```

### Salon/Spa Appointment Lifecycle
One appointment, followed from booking to checkout. Each step names its tool.
```
"Book Sarah Johnson a 60-minute massage with Lena on Friday at 2pm"
"Move Sarah's Friday massage to 3pm"
"Check Sarah in for her massage"
"Check Sarah out and charge the massage to her card"
"Cancel Sarah's Friday massage"
```
- **Book:** `getBookableItems` finds a window, then `addAppointment` books it (`clientId`, `staffId`, `locationId`, `sessionTypeId`, `startDateTime`). A window is not enough: the start must be one of the session type's active times (`getActiveSessionTimes`), or Mindbody refuses it with `InvalidBookingTime`. Choose a `startDateTime` on one of those times.
- **Reschedule:** `updateAppointment` with a new `startDateTime`.
- **Check in:** `updateAppointment` with `execute: "arrive"` marks the appointment arrived. `addClientArrival` checks the client in at the location. It is a no-op in the live tier by decision, because it consumes a paid visit (see [No-op policy](tests/live/README.md#no-op-policy)).
- **Check out:** `checkoutShoppingCart`. Pay with the pricing option that covers the appointment: find it with `getServices` filtered by `sessionTypeIds` (an array, e.g. `[sessionTypeId]`), and send that service as the cart item with the booked appointment's ID in `appointmentIds`, so the sale reconciles it.
- **Cancel:** `cancelAppointments` (`clientId`, `appointmentIds`). It works only before check-out. A checked-out appointment is `Completed`, and the guard refuses it.

The live tier ([`tests/live/README.md`](tests/live/README.md)) runs this lifecycle against the Mindbody sandbox. By default it covers booking, reschedule, appointment arrival, a comp-paid checkout, a contract purchase funded by account credit, and cancellation (which the checkout prevents: the appointment is re-noted as a LEFTOVER instead). One workflow is a deliberate no-op there: `addClientArrival`, because it consumes a paid visit. See the [No-op policy](tests/live/README.md#no-op-policy). The tier has run against the sandbox with authentication; its last recorded result is in that file's Status section, and the field behaviour it asserts is still being verified.

## Configuration

### Required Environment Variables
```
MINDBODY_API_KEY=your_api_key
MINDBODY_SITE_ID=your_site_id
MINDBODY_SOURCE_NAME=your_source_name
MINDBODY_SOURCE_PASSWORD=your_source_password
```

### Optional Settings
```
MINDBODY_API_URL=https://api.mindbodyonline.com/public/v6
CACHE_TTL_MINUTES=5
MCP_SERVER_NAME=mindbody-mcp
MCP_SERVER_VERSION=2.0.0
# MINDBODY_SITE_TIMEZONE=America/Los_Angeles  # Fallback only; normally read from the API
# MINDBODY_LATE_CANCEL_WINDOW_HOURS=24  # lateCancel is refused unless set; then only within N hours of the start
```

### Dates and timezones
Mindbody takes and returns every date and time as the site's local time with no UTC offset (`2026-10-18T08:00:00`). Pass dates and times the same way; the server does the zone arithmetic.
- The site's IANA timezone comes from `GET /site/sites` (cached 60 minutes). `MINDBODY_SITE_TIMEZONE` is used only when that record has no usable zone.
- Default date ranges are the site's calendar date, not the host's.
- `cancelAppointments` compares start times in the site zone and refuses to write if the zone cannot be resolved. Read tools fall back to UTC for default ranges, with one warning on stderr.
- DST: an ambiguous wall time (fall back) resolves to the earlier instant; a nonexistent one (spring forward) moves forward by the gap.

## Best Practices

### Searching
- Use exact names when known for better performance
- Provide date ranges to limit data returned
- Use IDs instead of names when available

### Booking
- Always check availability before booking
- Handle waitlist scenarios gracefully
- Verify payment requirements

### Caching
- Class data cached for 5 minutes
- Static data (locations, staff) cached for 60 minutes
- Cache clears automatically on write operations

## Troubleshooting

### Common Issues

**"Teacher not found"**
- Check exact spelling
- Try first name only or last name only
- Use getStaff to list all teachers

**"Class is full"**
- Check waitlist availability
- Suggest alternative times
- Show similar classes

**Rate limits**
- Implement request throttling
- Use caching effectively
- Batch operations when possible

**Empty results**
- Verify date ranges
- Check location filters
- Ensure teacher has scheduled classes

## Configuration for Development

### Environment Setup
Create `.env` with Mindbody sandbox credentials:
```bash
MINDBODY_API_KEY=your_key
MINDBODY_SITE_ID=-99
MINDBODY_SOURCE_NAME=your_source
MINDBODY_SOURCE_PASSWORD=your_password
MINDBODY_API_URL=https://api.mindbodyonline.com/public/v6
```

### Running Locally with Claude Desktop
Update `~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "mindbody": {
      "command": "bun",
      "args": ["run", "dev"],
      "cwd": "/path/to/MindbodyMCP",
      "env": {
        "MINDBODY_API_KEY": "...",
        "MINDBODY_SITE_ID": "-99",
        "MINDBODY_SOURCE_NAME": "...",
        "MINDBODY_SOURCE_PASSWORD": "..."
      }
    }
  }
}
```

## Debugging

### Enable Verbose Logging
The API client logs all requests and responses. Check console output when running `bun run dev`.

### Common Issues
- **"Teacher not found"**: Check exact spelling, try first/last name only
- **"Class is full"**: Check waitlist and alternative times
- **Auth failures**: Verify environment variables, check token expiry
- **Rate limits**: Use caching, batch requests, implement backoff

## Future Enhancements
- Webhook support for real-time updates
- Advanced reporting and analytics tools
- Multi-site synchronization
- AI-powered substitute recommendations
- Mobile app integration
- GraphQL API layer

---

<!-- BEGIN QUALITY GATES (managed) -->
## Definition of done. Quality gates

No task is **done-done** (safe to merge, ship, or close) until every applicable
quality gate below passes. Gates catch regressions and omissions. They do not
replace design or review judgement.

Run all gates with one command before marking any unit of work complete:

```bash
bun run check
```

The full, project-specific checklist lives in
[`docs/quality-gates.md`](docs/quality-gates.md). It names every gate, its exact command,
and the gates that are no-ops or gaps for this project. Keep it current.
Out-of-sync documentation is a bug.

Rules when a gate fails:

- Fix the code, not the gate. Do not weaken a test, silence a linter, or skip a
  doc update to force a green result.
- Fix all failures in the same session where practical, then re-run until every
  gate is green.
- Never commit or push secrets, even transiently.
<!-- END QUALITY GATES (managed) -->