# Mindbody Next.js Integration

A complete Next.js 14+ application that integrates with the Mindbody API, providing a unified, strongly-typed service layer with Prisma ORM for local data caching and tRPC for type-safe API access.

## Features

- **Unified MindbodyService**: Single service class with 50+ methods covering all Mindbody API operations
- **Strongly Typed**: Full TypeScript support with comprehensive type definitions
- **Prisma ORM**: Local database with proper foreign key relationships for caching and offline access
- **tRPC Integration**: End-to-end type safety from database to frontend
- **React Query Hooks**: Pre-built hooks for all data fetching operations
- **Data Sync**: Background synchronization between Mindbody API and local database
- **Example Pages**: Ready-to-use UI components for common operations

## Project Structure

```
nextjs-app/
├── prisma/
│   └── schema.prisma         # Database schema with all Mindbody entities
├── src/
│   ├── app/                  # Next.js App Router pages
│   │   ├── api/
│   │   │   ├── trpc/        # tRPC API handler
│   │   │   └── sync/        # Sync API endpoint
│   │   ├── clients/         # Client management pages
│   │   ├── classes/         # Class schedule pages
│   │   ├── staff/           # Staff management pages
│   │   ├── sites/           # Site records
│   │   ├── locations/       # Studio locations
│   │   ├── enrollments/     # Courses, workshops and series
│   │   ├── appointments/    # Appointments and bookable items
│   │   ├── sales/           # Services, packages, products, contracts
│   │   └── page.tsx         # Dashboard
│   ├── hooks/
│   │   └── useMindbody.ts   # React hooks for all operations
│   ├── lib/
│   │   ├── mindbody/
│   │   │   ├── client.ts    # HTTP client with auth
│   │   │   ├── paging.ts    # fetchAllPages (mandatory for every list read)
│   │   │   ├── service.ts   # Unified service class
│   │   │   ├── siteTime.ts  # Site-local time (default date ranges)
│   │   │   ├── types.ts     # Type definitions
│   │   │   └── index.ts     # Public API
│   │   ├── sync/
│   │   │   └── index.ts     # Data synchronization service
│   │   ├── trpc/
│   │   │   ├── client.ts    # tRPC client
│   │   │   └── provider.tsx # React provider
│   │   └── db.ts            # Prisma client singleton
│   └── server/
│       ├── trpc.ts          # tRPC initialization
│       └── routers/         # tRPC routers by domain
│           ├── _app.ts      # Root router
│           ├── site.ts
│           ├── staff.ts
│           ├── client.ts
│           ├── class.ts
│           ├── appointment.ts
│           ├── enrollment.ts
│           └── sales.ts
```

## Getting Started

### Prerequisites

- Node.js 18+ or Bun
- PostgreSQL database
- Mindbody API credentials

### Installation

1. **Install dependencies**:
```bash
cd nextjs-app
npm install
# or
bun install
```

2. **Set up environment variables**:
```bash
cp .env.example .env
# Edit .env with your credentials
```

3. **Initialize the database**:
```bash
npm run db:generate  # Generate Prisma client
npm run db:push      # Push schema to database
```

4. **Run the development server**:
```bash
npm run dev
```

5. **Open [http://localhost:3000](http://localhost:3000)**

## Usage

### Using the MindbodyService directly

```typescript
import { getMindbodyService } from '@/lib/mindbody';

const mindbody = getMindbodyService();

// Get all clients
const { items: clients, total } = await mindbody.getClients({
  searchText: 'john',
});

// Add a client to a class
const result = await mindbody.addClientToClass({
  clientId: '123',
  classId: 456,
});

// Get teacher schedule
const schedule = await mindbody.getTeacherSchedule(staffId, startDate, endDate);
```

### Using React Hooks

```typescript
import { useClients, useAddClientToClass } from '@/hooks/useMindbody';

function ClientList() {
  const { data, isLoading } = useClients({ searchText: 'john' });
  const addToClass = useAddClientToClass();

  const handleBookClass = (clientId: string, classId: number) => {
    addToClass.mutate({ clientId, classId });
  };

  // ...
}
```

### Using tRPC directly

```typescript
import { trpc } from '@/lib/trpc/client';

function StaffSchedule({ staffId }: { staffId: number }) {
  const { data: schedule } = trpc.staff.getSchedule.useQuery({
    teacherId: staffId,
  });

  // ...
}
```

### Data Synchronization

```typescript
// Sync all entities
const response = await fetch('/api/sync', { method: 'POST' });
const results = await response.json();

// Sync specific entities
const response = await fetch('/api/sync', {
  method: 'POST',
  body: JSON.stringify({
    entities: ['clients', 'classes', 'staff'],
  }),
});

// Check sync status
const status = await fetch('/api/sync').then(r => r.json());
```

## Pagination (mandatory)

Every Mindbody GET endpoint that accepts `Limit`/`Offset` in the repo's
`docs/openapi.json` is read through `fetchAllPages` in
`src/lib/mindbody/paging.ts`, a port of the MCP server's pager with the same
contract: `Limit` 200 per page, `Offset` advanced by the rows actually
received, the walk continues until the server's `TotalResults` is reached, and
it throws rather than truncate (after 100 pages, or when the server ignores
`Offset`). The `limit` field on list parameters is the page size, not a cap on
the result. This is enforced statically by Gate 13 in the repo root
(`tests/pagination-gate.test.ts`, run by `bun run check`), which scans
`nextjs-app/src/**/*.ts(x)` as well as `src/`; a single `this.client.get()` to
a paginated endpoint fails the build. Add new list reads through
`fetchAllPages(this.client, '/path', params, 'ListKey')`.

The tRPC client router is mounted as `trpc.clients` (not `trpc.client`, which
collides with a built-in method of the tRPC React proxy).

## Site-local time (default date ranges)

Mindbody returns and accepts every date-time in the **site's** local timezone
with no UTC offset (`"2026-10-18T08:00:00"`), so "today" at a Los Angeles studio
is not `new Date().toISOString()` on a server in Hong Kong. Every default date
range in `src/lib/mindbody/service.ts` — today's classes, a teacher's week,
bookable items, client visits, the enrollment window — is therefore resolved in
the site's calendar by `src/lib/mindbody/siteTime.ts`, a port of the MCP
server's `src/utils/siteTime.ts` with the same exported names and semantics:

- the site zone comes from `GET /site/sites` (read through `fetchAllPages`, like
  every other list) and is cached for 60 minutes;
- `withDefaultDates(start, end, days)` returns the caller's dates **unchanged and
  with no extra request** when both are given, and otherwise fills in
  [site today, site today + days] for `days >= 0`, [site today + days, site
  today] for `days < 0`;
- a day boundary is the site's: `2026-10-18T02:00:00Z` is still the 17th in
  `America/Los_Angeles`, and that is the date the defaults use.

### Displaying times: studio zone, always

**Product rule: every timestamp in the UI renders in the studio's timezone,
never the viewer's.** Do not use `new Date(value).toLocale*()` in a component —
those run in the browser's zone, so the clock silently becomes the reader's while
looking like the studio's. Use `src/lib/mindbody/formatSiteTime.ts`, reached
through the `useSiteTimeZone()` hook:

```tsx
const timeZone = useSiteTimeZone();               // string | undefined
formatSiteDateTime(appointment.startDateTime, timeZone, { withZone: true });
```

`withZone: true` appends the studio's zone (`PDT`) so the clock cannot be
misread as local; `formatSiteTimeOfDay` defaults it on, because a bare clock with
no date is where the zone matters most.

The formatters handle the three shapes Mindbody returns, and never consult the
viewer zone for any of them:

| Shape | Example | Handling |
|-------|---------|----------|
| Site-local, no offset (the common case) | `2026-10-18T08:00:00` | The wall clock is **already** the studio's, so those fields are printed unchanged — no conversion, no DST guesswork. |
| Explicit offset (an instant) | `2026-10-18T15:00:00Z`, `...+09:00` | Converted into the studio's zone, then labelled. |
| Bare date | `1990-05-03` | The studio's calendar fields are printed as-is, and **no time of day is invented** for it. |

The bare-date case was a real off-by-one-day: `new Date('1990-05-03')` parses as
UTC midnight, so a viewer in `America/Los_Angeles` or `Pacific/Kiritimati` saw the
**previous** day. `tests/nextjs-format-sitetime.test.ts` asserts the fix by
rendering in child processes under four host `TZ` values and requiring
byte-identical output.

The zone reaches the browser via a dedicated `site.getTimeZone` tRPC query, not
`getSites().items[0].timeZone` — with a multi-site API key the latter would label
one studio's schedule with another studio's zone. When the zone cannot be
resolved the formatters render the studio's clock **unlabelled** rather than
falling back to the viewer's zone.

### Environment variables

| Variable | Purpose |
|----------|---------|
| `MINDBODY_SITE_ID` | Already required; also pins the `SiteIds` filter on the site lookup, so a multi-site API key resolves **its** site and never a neighbour's. An ambiguous key with no site chosen raises `SiteSelectionError` listing the reachable sites. |
| `MINDBODY_SITE_TIMEZONE` | Optional IANA override, used **only** when the site record is reachable but has no usable `TimeZone`. It is never consulted when the site lookup fails (including the multi-site refusal), and a disagreeing override is refused on write paths. A valid one is honoured; an invalid one raises a clear error. |

When neither source yields a usable zone, **reads do not fail**: they fall back
to UTC and log one `console.error` per process
(`[siteTime] … using UTC for default date ranges.`). Write operations and
explicit caller dates are unaffected — an explicit window is always sent as
given.

### DST

Wall times are disambiguated the way Temporal and `java.time` do in "compatible"
mode: an ambiguous fall-back wall time (e.g. `2026-11-01T01:30` in Los Angeles)
resolves to the **earlier** instant, and a nonexistent spring-forward wall time
(e.g. `2026-03-08T02:30`) is read with the pre-transition offset, moving it
forward by the gap.

## API Reference

### MindbodyService Methods

#### Site & Locations
- `getSites()` - Get all sites
- `getLocations()` - Get all locations
- `getResources()` - Get all resources
- `getActivationCode()` - Get activation code
- `getPrograms(params?)` - Get programs
- `getSessionTypes(params?)` - Get session types

#### Staff
- `getStaff(params?)` - Get staff members
- `getStaffById(staffId)` - Get single staff member
- `getTeacherSchedule(teacherId, startDate?, endDate?)` - Get teacher's schedule

#### Clients
- `getClients(params?)` - Search/list clients
- `getClientById(clientId)` - Get single client
- `addClient(params)` - Add new client
- `updateClient(params)` - Update client
- `getClientVisits(params)` - Get visit history
- `getClientMemberships(clientId, locationId?)` - Get memberships
- `getClientContracts(clientId)` - Get contracts
- `getClientAccountBalances(clientId)` - Get balances
- `addClientArrival(clientId, locationId)` - Check in client

#### Classes
- `getClasses(params?)` - Get classes
- `getClassById(classId)` - Get single class
- `getClassDescriptions()` - Get class types
- `getClassSchedules(params?)` - Get schedules
- `addClientToClass(params)` - Book class
- `removeClientFromClass(params)` - Cancel booking
- `getWaitlistEntries(classIds?, clientIds?, hidePastEntries?)` - Get waitlist
- `substituteClassTeacher(params)` - Substitute teacher

#### Appointments
- `getAppointments(params)` - Get appointments
- `addAppointment(params)` - Book appointment
- `updateAppointment(params)` - Update appointment
- `getBookableItems(params)` - Get available slots
- `getScheduleItems(params?)` - Get schedule items
- `getActiveSessionTimes(params?)` - Get active times

#### Enrollments
Mindbody has no enrollment record of its own. An enrollment is a class schedule whose program has `ScheduleType: Enrollment`; each session is a class on that schedule; a client's seat in a session is a visit on the client's schedule. These methods mirror `src/tools/enrollmentManagement.ts` in the MCP server, field for field against `docs/openapi.json`.
- `getEnrollments(params?)` - `GET /enrollment/enrollments` (paged). Filters are the only ones the spec defines: `locationIds`, `classScheduleIds`, `staffIds`, `programIds`, `sessionTypeIds`, `startDate`, `endDate` (default today through 365 days). Each row is a ClassSchedule mapped to `{ id, name, description, courseId, courseName, programId, programName, sessionTypeId, sessionTypeName, staffId, staffName, locationId, locationName, semesterId, startDate, endDate, startTime, endTime, days, allowOpenEnrollment, allowDateForwardEnrollment, isAvailable }`. `id` is the `classScheduleId` that `addClientToEnrollment` takes. A schedule carries no capacity; use `getClasses({ classScheduleIds })` for the sessions.
- `addClientToEnrollment(params)` - `POST /enrollment/addclienttoenrollment`. `clientId`, `classScheduleId` (singular), `enrollDateForward` (book every session from this date-time on; takes priority), `enrollOpenDates` (an array of session date-times to book), `waitlist`, `waitlistEntryId`, `sendEmail`, `test`. With neither date option the client is booked into the whole enrollment. Returns `{ success, data: { classScheduleId, name, sessions: [{ classId, startDateTime, endDateTime, totalBooked }] }, message }`.
- `getClientEnrollments(clientId, startDate?, endDate?)` - A client's enrollment sessions. Reads `GET /client/clientschedule` (paged, with waitlist entries), then `GET /class/classes` by `ClassIds` (paged, chunks of 50) to resolve each visit's class, and keeps a visit only when its class's program is an `Enrollment` program. Drop-in classes and appointments are excluded. There is no `/client/clientenrollments` endpoint (the live API returns 404). Default window: today through 365 days, so past sessions appear only when `startDate` is given. Each row: `{ id (visit ID), classId, classScheduleId, name, programId, programName, staffId, staffName, locationId, locationName, startDateTime, endDateTime, isWaitlisted, waitlistEntryId, signedIn, lateCancelled, missed, makeUp }`.

#### Sales
- `getServices(params?)` - Get services
- `getPackages(locationId?, classScheduleId?)` - Get packages
- `getProducts(params?)` - Get products
- `getContracts(params?)` - Get contracts
- `checkoutShoppingCart(params)` - Process checkout
- `purchaseContract(params)` - Purchase contract

## Database Schema

The Prisma schema includes all Mindbody entities with proper relationships:

- **Site** → Locations, Staff, Clients, Programs, etc.
- **Location** → Classes, Appointments, Enrollments
- **Staff** → Classes, Appointments, ClassSchedules
- **Client** → ClassBookings, Appointments, Memberships, Contracts, Visits
- **Class** → ClassSchedule, ClassDescription, Location, Staff, Bookings
- **Appointment** → Client, Staff, Location, SessionType, Resources

See `prisma/schema.prisma` for the complete schema.

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `MINDBODY_API_KEY` | Mindbody API key | Yes |
| `MINDBODY_SITE_ID` | Site ID (-99 for sandbox) | Yes |
| `MINDBODY_SOURCE_NAME` | Source name | Yes |
| `MINDBODY_SOURCE_PASSWORD` | Source password | Yes |
| `MINDBODY_API_URL` | API URL (default: v6 API) | No |
| `MINDBODY_SITE_TIMEZONE` | IANA zone used for default date ranges when the site record has none | No |
| `NEXT_PUBLIC_APP_URL` | Public app URL | No |

## Scripts

```bash
npm run dev          # Start development server
npm run build        # Build for production
npm run start        # Start production server
npm run lint         # Run linter
npm run db:generate  # Generate Prisma client
npm run db:push      # Push schema to database
npm run db:migrate   # Run migrations
npm run db:studio    # Open Prisma Studio
npm run typecheck    # Run TypeScript check
```

## License

MIT
