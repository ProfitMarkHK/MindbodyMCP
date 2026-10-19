# API Reference

## Tools

### getTeacherSchedule

Retrieves a teacher's class schedule for a specified date range.

#### Parameters

| Parameter | Type | Required | Description | Default |
|-----------|------|----------|-------------|---------|
| `teacherName` | string | Yes | Full name of the teacher | - |
| `startDate` | string | No | Start date (YYYY-MM-DD) | Today |
| `endDate` | string | No | End date (YYYY-MM-DD) | 7 days from start |

#### Response

```typescript
interface TeacherSchedule {
  teacher: {
    id: number;
    name: string;
    email?: string;
  };
  dateRange: {
    start: string;  // YYYY-MM-DD
    end: string;    // YYYY-MM-DD
  };
  totalClasses: number;
  classes: Array<{
    id: number;
    name: string;
    startTime: string;      // ISO 8601 datetime
    endTime: string;        // ISO 8601 datetime
    duration: number;       // minutes
    location: string;
    isSubstitute: boolean;
    isCanceled: boolean;
    spotsAvailable: number;
    totalSpots: number;
  }>;
  summary: {
    byDay: Record<string, number>;      // "Monday": 3
    byLocation: Record<string, number>;  // "Main Studio": 5
    byClassType: Record<string, number>; // "Yoga": 8
  };
}
```

#### Examples

```typescript
// Basic usage
await getTeacherSchedule("Alexia Bauer");

// With date range
await getTeacherSchedule("John Smith", "2024-03-15", "2024-03-22");

// Next week
const nextMonday = getNextMonday();
const nextSunday = addDays(nextMonday, 6);
await getTeacherSchedule("Sarah Johnson", nextMonday, nextSunday);
```

#### Error Handling

| Error | Description | Solution |
|-------|-------------|----------|
| Teacher not found | The specified teacher name doesn't match any staff member | Check spelling, try partial match |
| Invalid date range | End date is before start date | Ensure dates are in correct order |
| API rate limit | Too many requests to Mindbody API | Wait and retry, increase cache TTL |
| Authentication failed | Invalid or expired credentials | Check environment variables |

### getStaffAppointments

View appointments. Every parameter is optional. Dates default to today through seven days out, using the site's calendar date (see [Dates and Timezones](#dates-and-timezones)).

#### Parameters

| Parameter | Type | Required | Description | Default |
|-----------|------|----------|-------------|---------|
| `staffIds` | number[] | No | Staff IDs to filter by | - |
| `locationIds` | number[] | No | Location IDs to filter by | - |
| `startDate` | string | No | Start date (YYYY-MM-DD) | Today |
| `endDate` | string | No | End date (YYYY-MM-DD) | 7 days from today |
| `appointmentIds` | number[] | No | Specific appointment IDs | - |
| `clientId` | string | No | A single client ID (not a list) | - |

#### Response

```typescript
interface StaffAppointmentsResponse {
  appointments: Array<{
    id: number;
    status: string;
    staffId: number;
    staffName: string;
    sessionTypeId: number;
    sessionTypeName: string;
    locationId: number;
    locationName: string;
    startDateTime: string;   // site-local, no UTC offset
    endDateTime: string;
    clientId?: string;
    clientName?: string;
    clientEmail?: string;
    clientPhone?: string;
    notes?: string;
    staffRequested: boolean;
    providerId?: string;
    duration: number;        // minutes
    confirmed?: boolean;
    firstAppointment: boolean;
    resources?: Array<{ id: number; name: string }>;
  }>;
  totalAppointments: number;
}
```

#### Examples

```json
{ "clientId": "12345", "startDate": "2026-10-20", "endDate": "2026-10-27" }
```

#### Error Handling

| Error | Description | Solution |
|-------|-------------|----------|
| Mindbody error | Thrown by the API client and returned as an error result (`isError: true`) with Mindbody's message | Check the dates, IDs and credentials |

### updateAppointment

Updates an existing appointment: reschedule it (new `startDateTime`), change staff or notes, or apply one status action with `execute`. It does not cancel. Use `cancelAppointments`.

Ownership, status and timing are verified before anything is written, and none of the guards can be skipped by omitting an argument. An appointment that fails a guard is reported in `rejected` and nothing is sent.

#### Parameters

| Parameter | Type | Required | Description | Default |
|-----------|------|----------|-------------|---------|
| `clientId` | string | Yes | Client ID who owns the appointment | - |
| `appointmentId` | number | Yes | Appointment ID | - |
| `startDateTime` | string | No | New start date/time (reschedule) | - |
| `endDateTime` | string | No | New end date/time | - |
| `staffId` | number | No | Change staff | - |
| `resourceIds` | number[] | No | Resource IDs | - |
| `notes` | string | No | Notes | - |
| `execute` | string | No | One of `confirm`, `unconfirm`, `arrive`, `unarrive`, `complete`. `cancel` and `latecancel` are refused client-side with no API call. `complete` additionally requires the appointment to have started. | - |
| `executePayment` | boolean | No | Deprecated and ignored: not part of the Mindbody API | - |
| `sendEmail` | boolean | No | Send email | - |
| `applyPayment` | boolean | No | Apply a current applicable client service from that client's account. Refused alongside a reschedule, and on an appointment that has already taken place. | - |

#### Guards

| Guard | Rule |
|-------|------|
| Request shape | `clientId` is a non-empty string, `appointmentId` a positive integer. No API call is made if either fails. |
| Ownership | The appointment must belong to `clientId`, looked up with `GET /appointment/staffappointments`. Someone else's appointment — or one outside the window, one year back through two years ahead — is reported as `not found for this client`, which never names the real owner. |
| Terminal status | A `Cancelled` or `LateCancelled` appointment is final: no update of any kind is accepted. |
| Attendance-final status | A `Completed` or `NoShow` appointment accepts no status action, no `applyPayment` and no reschedule. Notes, staff and resources are still accepted. |
| Timing | `execute: complete` requires the appointment to have started, compared in the site's timezone. `arrive` and `unarrive` are not time-gated, because arrival is recorded against a booked appointment. |
| Timezone | If the site timezone cannot be resolved, nothing is looked up and nothing is written. |

#### Response

```typescript
interface UpdateAppointmentResponse {
  success: boolean;
  appointment?: {
    id: number;
    status: string;
    startDateTime: string;
    endDateTime: string;
    staffName: string;
  };
  message: string;
}
```

#### Examples

```json
{ "appointmentId": 987654, "startDateTime": "2026-10-23T15:00:00" }
```

```json
{ "appointmentId": 987654, "execute": "arrive" }
```

#### Error Handling

| Error | Description | Solution |
|-------|-------------|----------|
| `execute` is `cancel` or `latecancel` | Refused with `success: false`; no API call is made | Use `cancelAppointments` |
| Unsupported `execute` value | Refused with `success: false`; the message lists the allowed values | Use one of the allowed values |
| Mindbody error | Returned as `success: false` with Mindbody's message | Check the appointment ID and its status |

### cancelAppointments

Cancels future appointments for one client. This is the only cancel path in the server.

#### Parameters

| Parameter | Type | Required | Description | Default |
|-----------|------|----------|-------------|---------|
| `clientId` | string | Yes | Client ID who owns every appointment | - |
| `appointmentIds` | number[] | Yes | 1 to 3 appointment IDs, no duplicates | - |
| `lateCancel` | boolean | No | Record as late cancellations | false |
| `sendEmail` | boolean | No | Email the client about the cancellation | false |

#### Guards

All guards run before any cancellation is sent. The request is all-or-nothing: if any appointment fails a guard, none are cancelled.

- Exactly one client per call.
- 1 to 3 appointment IDs (`MAX_CANCELLATIONS_PER_REQUEST`), no duplicates.
- Each appointment must belong to `clientId`. Ownership is checked with `GET /appointment/staffappointments` filtered by `ClientId`. An appointment that belongs to another client, or falls outside the lookup window (today through two years out), is reported as "not found for this client".
- Each appointment must start in the future, compared in the site's timezone. If the site timezone cannot be resolved, nothing is written (see the error table).
- Each appointment must not already be `Cancelled`, `LateCancelled`, `Completed` or `NoShow`.

Once the guards pass, each cancellation is sent through `POST /appointment/updateappointment` with `Execute: cancel` (or `latecancel`), one at a time.

#### Response

```typescript
interface CancelAppointmentsResponse {
  success: boolean;
  cancelled: Array<{ id: number; status: string; startDateTime: string }>;
  rejected: Array<{ id: number; reason: string }>; // id -1 means the whole request was rejected
  message: string;
}
```

#### Examples

```json
{ "clientId": "12345", "appointmentIds": [987654, 987655], "lateCancel": false, "sendEmail": true }
```

#### Error Handling

| Error (`rejected[].reason`) | Description | Solution |
|-----------------------------|-------------|----------|
| `not found for this client` | Missing, owned by another client, or outside the lookup window. Nothing is cancelled. | Check the ID and client ID |
| `appointment has already started or is in the past` | Start time is not in the future. Nothing is cancelled. | Nothing to cancel |
| `appointment status is <Status>, which cannot be cancelled` | Already Cancelled, LateCancelled, Completed or NoShow. Nothing is cancelled. | Completed means checked out; it cannot be cancelled here |
| `duplicate appointment id in request` | The same ID appears twice | Remove the duplicate |
| `at most 3 appointments may be cancelled per request` | More than 3 IDs. Nothing is cancelled. | Split into several calls |
| `appointment lookup failed` | Verification lookup failed. Nothing is cancelled. | Retry |
| `site timezone unavailable: <reason>` (id `-1`) | The site's timezone could not be resolved, so start times cannot be compared. Nothing is cancelled. | Check the site record's `TimeZone`, or set `MINDBODY_SITE_TIMEZONE` |
| Mindbody write error | Cancellations already made stand and appear in `cancelled`; the call stops at the failing ID. | Re-check the listed appointments with `getStaffAppointments` |

### checkoutShoppingCart

Processes a shopping cart checkout. A cart item can carry `appointmentIds` to reconcile existing booked appointments.

#### Parameters

| Parameter | Type | Required | Description | Default |
|-----------|------|----------|-------------|---------|
| `clientId` | string | Yes | Client ID | - |
| `items` | array | Yes | Cart items: `{ item: { type, metadata }, quantity, appointmentIds? }`. `item.type` is `Service`, `Product`, `Package` or `Tip`. `item.metadata.id` identifies the item; a `Tip` uses `item.metadata.amount`. | - |
| `payments` | array | Yes | Payment methods: `{ type, metadata: { amount, ... } }`. `type` is `Cash`, `Check`, `CreditCard`, `Comp`, `Custom` or `StoredCard`. | - |
| `inStore` | boolean | No | In-store purchase | false |
| `promotionCode` | string | No | Promotion code | - |
| `sendEmail` | boolean | No | Send email receipt | true |
| `locationId` | number | No | Location ID | - |

#### Guards

Every `appointmentIds` entry (across all items) is verified before the sale is sent, all-or-nothing: if any one fails, nothing is charged and no partial cart is built. The check is the same ownership lookup `cancelAppointments` and `updateAppointment` use (`GET /appointment/staffappointments` filtered by `ClientId`, a year back through two years ahead). An appointment that belongs to another client, or is outside that window, is reported as `not found for this client`; the owner is never named. If the site timezone or the lookup fails, the checkout is refused (fail closed). A request with no `appointmentIds` makes no lookup.

#### Response

The response has `success`, a `shoppingCart` with totals and `items`, and a top-level `appointments` list. Each cart item carries `appointments`: the IDs of the appointments that item reconciled.

#### Examples

```json
{
  "clientId": "12345",
  "items": [
    { "item": { "type": "Service", "metadata": { "id": 111 } }, "quantity": 1, "appointmentIds": [987654] }
  ],
  "payments": [{ "type": "CreditCard", "metadata": { "amount": 75 } }]
}
```

#### Error Handling

| Error | Description | Solution |
|-------|-------------|----------|
| `Appointment(s) failed verification (<id>: not found for this client; ...); nothing was charged.` | An `appointmentIds` entry is not this client's. Nothing is charged. | Check the appointment ID and `clientId` |
| `Appointment id(s) ... are not positive integers; nothing was charged.` | A malformed ID. Nothing is charged. | Fix the ID |
| `Could not verify the appointments (site timezone unavailable: ... / appointment lookup failed: ...); nothing was charged.` | The ownership lookup could not run. Nothing is charged. | Retry; check the site record's `TimeZone` |
| Mindbody error | Returned as `success: false` with Mindbody's message | Check item IDs, payment amounts and the appointment IDs |

### getActiveSessionTimes

Returns the active session start times: the business-hours increments at which a session of each type can start. This is not bookable availability; use `getBookableItems` for that. A booking's start must also be one of these times, or Mindbody refuses it with `InvalidBookingTime`.

#### Parameters

| Parameter | Type | Required | Description | Default |
|-----------|------|----------|-------------|---------|
| `scheduleType` | string | No | `All`, `Class`, `Enrollment` or `Appointment` | `All` |
| `sessionTypeIds` | number[] | No | Session types to report | - |
| `startTime` | string | No | Time-of-day window start | - |
| `endTime` | string | No | Time-of-day window end | - |
| `days` | string[] | No | Days of the week | - |

#### Response

```typescript
interface GetActiveSessionTimesResponse {
  activeTimes: string[];                                  // "HH:MM:SS" start times
  bySessionType: Array<{ sessionTypeId: number; activeTimes: string[] }>;
  totalActiveTimes: number;                               // activeTimes.length
}
```

The API returns the per-session-type breakdown in `SessionTypeActiveSessionTimes`. That field was absent from the older `docs/openapi.json` and **is present in the current one** (the refreshed spec pinned at SHA-256 `970ffa101a254868290056081b062ee128c74b04d880190aa1605bfbb0068941`).

#### Examples

```json
{ "scheduleType": "Appointment", "sessionTypeIds": [111] }
```

### getBookableItems

Searches for windows in which a session could be booked. Read the name carefully: **"bookable items" is only the name of the endpoint and the tool — no response field is called `BookableItems`.** The response list key is `Availabilities`.

```
GET /appointment/bookableitems   →  { PaginationResponse, Availabilities: Availability[] }
```

`docs/openapi.json` agrees: `GetBookableItemsResponse` has exactly `PaginationResponse` and `Availabilities`, whose items are `#/definitions/Mindbody.PublicApi.Dto.Models.V6.Availability`.

#### The trap

Reading `BookableItems` off the response returns `undefined`, which reads back as an empty list — so a correct answer from the API is indistinguishable from "nothing is bookable". One probe hit exactly this: the response carried `PaginationResponse | Availabilities` with `TotalResults: 125`, while `response.BookableItems ?? []` yielded `0`. Always read `Availabilities`.

#### `Availabilities` appears in two endpoints with two different jobs

The same key name, and the same `Availability` item type, is returned in two places. The placement differs:

| Where | Path | Shape | Use case |
|-------|------|-------|----------|
| Top level | `GET /appointment/bookableitems` | `response.Availabilities[]` | **Booking discovery.** "Is there room for this session type, for whom, and roughly when?" Input to `addAppointment`. |
| Nested per staff | `GET /appointment/scheduleitems` | `response.StaffMembers[].Availabilities[]` | **Schedule display.** Rendering one staff member's working day (alongside their `Appointments[]` and `Unavailabilities[]`). Not a booking pre-check. |

`GET /appointment/scheduleitems` has no top-level `Availabilities` at all: `GetScheduleItemsResponse` is `{ PaginationResponse, StaffMembers }`, so a `scheduleitems` row is only reachable through its staff member.

#### An availability row is a window, not a slot

Live shape from `-99`, session type 23, on 2026-10-20:

```
row keys   : Id, Staff, SessionType, Programs, StartDateTime, EndDateTime,
             BookableEndDateTime, Location, PrepTime, FinishTime, IsMasked,
             ShowPublic, ResourceAvailabilities
StartDateTime      = 2026-10-20T05:00:00
EndDateTime        = 2026-10-20T10:00:00
BookableEndDateTime= 2026-10-20T09:55:00
```

Observed row spans run from 120 to 750 minutes. So a row says "staff 100000061 is available for session type 23 at location 1 between 05:00 and 10:00" — it does **not** assert that `05:00:00` is bookable. Three separate filters apply after this read:

1. **Active session times.** A start must also fall on one of the session type's active times, or the booking fails with `InvalidBookingTime`. Get them from `getActiveSessionTimes`.
2. **Staff must actually be able to sell it.** A window can belong to staff who cannot take that booking, refused at `addAppointment` with a validation error availability alone cannot predict. Observed on `-99`: `ValidationFailed — The staff member does not have availability configured for the requested service.` (`tests/live/README.md` records the sibling refusal `The staff member is not an instructor for the requested service`.)
3. **The session must fit.** `BookableEndDateTime` is the last permitted start, per the spec's own description.

Treat `bookableitems` as narrowing the search space, never as a pre-flight that guarantees `addAppointment` will succeed.

#### Parameters

| Parameter | Type | Required | Description | Default |
|-----------|------|----------|-------------|---------|
| `sessionTypeIds` | number[] | **Yes in practice** | Session types to find availability for. The spec marks it optional; `-99` answers `SessionTypeIds is a required parameter.` (`MissingRequiredFields`) without it. On `-99`, 66 of 95 session types are `Type: "Appointment"`; the live tier filters to those, since the other types (e.g. `Type: "Enrollment"`) are not what an appointment booking needs. | - |
| `locationIds` | number[] | No | Locations. Leave it out when discovering: filtering can narrow to nothing (`locationIds=98` → `0` rows for session type 23, while the same unfiltered query reports `TotalResults: 125`). | all |
| `staffIds` | number[] | No | Restrict to specific staff | all |
| `startDate` | string | No | Window start (`YYYY-MM-DD`) | today |
| `endDate` | string | No | Window end (`YYYY-MM-DD`) | - |
| `limit`, `offset` | number | No | Pagination — see `PaginationResponse` (`TotalResults` counts beyond the returned page) | 100 |

#### Use case summary

- **"Where can I book this client in?"** → `getBookableItems` (`Availabilities`), then intersect with `getActiveSessionTimes`, then attempt `addAppointment`.
- **"What does this staff member's day look like?"** → `getScheduleItems` and read `StaffMembers[].Availabilities`.
- **"At what times of day can this type of session start at all?"** → `getActiveSessionTimes`. That answer is neither an availability nor a bookable item; it is a repeating list of times-of-day with no date attached.

### updateClient

Updates an existing client. The server nests the changed fields under `Client`, sets `Id` to the client, and sends `CrossRegionalUpdate: false`. Mindbody refuses the fields at the top level with `Client (Code: MissingRequiredFields)`, and it refuses `CrossRegionalUpdate: true` at a site outside a region ("The current site does not belong to a region").

#### Parameters

| Parameter | Type | Required | Description | Default |
|-----------|------|----------|-------------|---------|
| `clientId` | string | Yes | Client to update | - |
| `updates` | object | Yes | Any of `firstName`, `lastName`, `email`, `mobilePhone`, `birthDate`, `addressLine1`, `city`, `state`, `postalCode`, `emergencyContactName`, `emergencyContactPhone`, `sendAccountEmails`. Only the fields given are sent. | - |

#### Request body

`POST /client/updateclient` is sent as:

```json
{
  "Client": { "Id": "12345", "FirstName": "Sarah", "Email": "sarah@example.com" },
  "CrossRegionalUpdate": false
}
```

### getClientEnrollments

A client's enrollments (courses, workshops, series) with every session they hold, grouped by enrollment.

Two reads, both paginated: `GET /client/clientschedule` (`IncludeWaitlistEntries: true`) for the client's visits, then `GET /class/classes` with `ClassIds` (chunks of 50) to resolve each visit's class. A visit is an enrollment session when its class's `ClassDescription.Program.ScheduleType` is `Enrollment`. Drop-in class visits and appointment visits (no `ClassId`) are excluded. The visit record itself has no enrollment marker; on the sandbox `VisitType` and `TypeGroup` are identical for enrollment and drop-in visits, which is why the class is resolved.

Earlier versions read `/client/clientenrollments`, which is not in `docs/openapi.json` and returns HTTP 404.

#### Parameters

| Parameter | Type | Required | Description | Default |
|-----------|------|----------|-------------|---------|
| `clientId` | string | Yes | Client to look up | - |
| `startDate` | string | No | Start date (YYYY-MM-DD) | Today at the site |
| `endDate` | string | No | End date (YYYY-MM-DD) | 365 days after today at the site |

Past sessions appear only when `startDate` is given.

#### Response

```typescript
interface GetClientEnrollmentsResponse {
  enrollments: Array<{
    classScheduleId: number;   // the enrollment; addClientToEnrollment's classScheduleId
    name: string;
    programId?: number;
    programName?: string;
    staffId?: number;
    staffName: string;
    locationId?: number;
    locationName: string;
    semesterId?: number;
    sessions: Array<{
      visitId: number;         // what cancelEnrollmentVisits takes
      classId: number;
      startDateTime: string;   // site-local, no UTC offset
      endDateTime: string;
      signedIn: boolean;
      lateCancelled: boolean;
      missed: boolean;         // Mindbody's flag; set on future unattended sessions too, so not "absent"
      makeUp: boolean;
      isWaitlisted: boolean;   // the visit carries a waitlist entry
      waitlistEntryId?: number;
    }>;
    totals: { sessions: number; attended: number; missed: number; lateCancelled: number; waitlisted: number };
  }>;
  totalEnrollments: number;
  totalSessions: number;
}
```

#### Examples

```json
{ "clientId": "12345", "startDate": "2026-10-01", "endDate": "2026-12-31" }
```

### cancelEnrollmentVisits

Cancel 1 to 3 future enrollment sessions for one client, by visit ID, via `POST /class/removeclientfromclass` with `ClientId`, `ClassId`, `VisitId`, `LateCancel`, `SendEmail`. Mindbody has no operation that moves a client between enrollment dates: cancel here, then call `addClientToEnrollment` again.

#### Parameters

| Parameter | Type | Required | Description | Default |
|-----------|------|----------|-------------|---------|
| `clientId` | string | Yes | Owner of every visit | - |
| `visitIds` | number[] | Yes | 1 to 3 visit IDs from getClientEnrollments, no duplicates | - |
| `lateCancel` | boolean | No | Record as late cancellations | `false` |
| `sendEmail` | boolean | No | Email the client | `false` |

#### Guards

Every guard runs before anything is written, and one failure rejects the whole request:

1. Request shape: one client, 1 to 3 positive integer IDs, no duplicates.
2. The site timezone resolves (fail closed otherwise).
3. The visit is on the client's own schedule (`GET /client/clientschedule`, today through two years out). Another client's visit reads as "not found for this client".
4. The visit is a booked enrollment session: it has a `ClassId`, is not a waitlist entry, and its class (`GET /class/classes`) belongs to an `Enrollment` program. A drop-in class visit is refused with a pointer to `removeClientFromClass`.
5. The session starts in the future in the site's zone.
6. The visit is not already late-cancelled or signed in. Mindbody's `Missed` flag is not a guard: the sandbox sets it on every future, not-yet-attended enrollment visit.

Writes are sequential. If one fails, the cancellations already made stand and are reported in `cancelled`; the failing ID is in `rejected`.

#### Response

```typescript
interface CancelEnrollmentVisitsResponse {
  success: boolean;
  cancelled: Array<{ visitId: number; classId: number; classScheduleId: number; startDateTime: string }>;
  rejected: Array<{ visitId: number; reason: string }>;
  message: string;
}
```

#### Examples

```json
{ "clientId": "12345", "visitIds": [100002, 100003] }
```

## Planned Tools

### getClassSchedule (Coming Soon)

Get all classes for a date range, optionally filtered by location or class type.

```typescript
interface GetClassScheduleParams {
  startDate?: string;
  endDate?: string;
  locationIds?: number[];
  classTypeIds?: number[];
  limit?: number;
}
```

### createSubstitution (Coming Soon)

Create a substitute teacher assignment for a class.

```typescript
interface CreateSubstitutionParams {
  classId: number;
  originalTeacherId: number;
  substituteTeacherId: number;
  date: string;
  reason?: string;
}
```

### updateEvent (Coming Soon)

Update class or event details.

```typescript
interface UpdateEventParams {
  eventId: number;
  updates: {
    description?: string;
    capacity?: number;
    location?: number;
    startTime?: string;
  };
}
```

## Deliberate deviations from the spec

[`docs/openapi.json`](openapi.json) is the specification this server is written
against, and [`docs/adr/0001-write-to-observed-sandbox-behaviour.md`](adr/0001-write-to-observed-sandbox-behaviour.md)
records the rule this section exists to serve: **where the specification and
the live API disagree, the API wins and the disagreement is written down here,
at the call site, and in the ADR.** Every entry below is deliberate. Anything
not listed here is expected to match the specification exactly.

Evidence for each row — the request, the HTTP status and the response — is in
[`docs/mindbody-spec-discrepancies.md`](mindbody-spec-discrepancies.md), which
names the section quoted in the last column.

| Endpoint | The spec says | The sandbox does | What the code does |
|---|---|---|---|
| `GET /appointment/activesessiontimes` | `GetActiveSessionTimesResponse` documents `PaginationResponse`, `ActiveSessionTimes: string[]` and `SessionTypeActiveSessionTimes`, described as "omitted when `SessionTypeIds` is not supplied". | `SessionTypeActiveSessionTimes: [{SessionTypeId, ActiveSessionTimes}]` is present when `SessionTypeIds` is sent and absent otherwise, exactly as described. `ActiveSessionTimes` are `HH:MM:SS` strings, not objects. | Handles both shapes and merges the per-session-type grid across pages rather than reading page one. Marked at the call site. | D-1 |
| `GET /site/resources` | The 200 body is typed `{"type": "object"}`. No `Resource` model is referenced, so there is no documented list key. | Returns `{PaginationResponse, Resources: [{Id, Name}]}`. The documented `locationIds` and `resourceIds` filters return the full list. An unrecognised `SessionTypeIds` returns **HTTP 500** instead of being ignored. | Sends only documented parameters, reads the undocumented `Resources` key, and says so at the call site. | D-2 |
| `GET /appointment/staffappointments` | `Appointment.Status` documents `Cancelled` and `LateCancelled`; no status filter or exclusion is documented. | Never returns either status. A just-cancelled appointment disappears from the list instead of coming back as `Cancelled`. | Reads back a cancellation as *absent*. `cancelAppointments` verifies ownership, time and status against this list, so an absent row is the expected result. Marked at the call site. | D-4 |
| `POST /client/addclient` | `AddClientRequest` requires only `FirstName` and `LastName`. Its date-of-birth field is `BirthDate`; there is no `Birthday`. Required fields are not described as site-configurable. | Answers `The following are required: Birthday (Code: MissingRequiredFields)` when no date of birth is sent. | Sends `BirthDate` **and** `Birthday`, plus the undocumented aliases `Street` and `MobileNumber`. `addClient` therefore always creates a real client — see the next row. | D-5 |
| `POST /client/updateclient` | `CrossRegionalUpdate` is documented as propagating to every site in the region, falling back to a single-site update for a region that is not enabled. No default is stated. | Defaults to true and answers HTTP 400 `The current site does not belong to a region. If you are attempting to update a client at a single site, set CrossRegionalUpdate to false.` | Always sends `CrossRegionalUpdate: false`. Marked at the call site. | D-6 |
| `POST /sale/checkoutshoppingcart` | `CartItem.Appointments` is described as "the IDs of the appointments that were reconciled by this cart item" but typed as `Appointment[]`. The sibling `AppointmentIds` has the placeholder description "Gets or sets the item." | A committed sale that sent `AppointmentIds: [<id>]` did reconcile the appointment (it read back `Completed`), yet `CartItems[].Appointments`, `CartItems[].AppointmentIds` and the top-level `Appointments` all came back empty. | Accepts both shapes of `Appointments`, and states that an absent reconciliation list does not mean the sale failed. **To confirm which appointment a sale paid for, re-read the appointment.** | D-8 |
| `POST /client/addclient` and `POST /sale/purchasecontract` | Both request definitions document `Test: boolean` — "input information is validated, but not committed". | `addclient` with `Test: true` answers HTTP 400 `Test mode is not allowed for this endpoint.` `purchasecontract` with `Test: true` and no card demands a payment instrument the sandbox cannot supply. | Sends no `Test` flag to either. **`addClient` and `purchaseContract` always commit.** The endpoint behind `purchaseContract` does accept `Test: true` when paired with `UseAccountCredit: true` (D-10), but the tool does not expose it. | D-10 |
| `GET /sale/services` | Only the array filter `request.sessionTypeIds` is documented; there is no singular form. | `SessionTypeId=23` returns the unfiltered 21 services; `SessionTypeIds=23` returns 1. Unknown query names are dropped without error, as they are across the API. | Sends the documented plural only. Worth knowing when a filter appears to do nothing: a mis-pluralised filter degrades to a full-table read with a 200, not an error. | D-7 |

Adding a new entry is not a judgement call. The ADR states the five conditions
— the specification and the sandbox must genuinely disagree, there must be
captured evidence, the sandbox must be the only authority, the accommodation
must be load-bearing, and all three records must change together.

## Type Definitions

### Core Types

```typescript
// Staff member information
interface Staff {
  Id: number;
  FirstName: string;
  LastName: string;
  Name: string;
  Email?: string;
  MobilePhone?: string;
  ImageUrl?: string;
  Bio?: string;
  isMale?: boolean;
}

// Location information
interface Location {
  Id: number;
  Name: string;
  Description?: string;
  Address?: string;
  Address2?: string;
  City?: string;
  State?: string;
  PostalCode?: string;
}

// Class description
interface ClassDescription {
  Id: number;
  Name: string;
  Description?: string;
  ImageUrl?: string;
}

// Individual class instance
interface Class {
  Id: number;
  ClassScheduleId: number;
  Location: Location;
  ClassDescription: ClassDescription;
  Staff: Staff;
  StartDateTime: string;
  EndDateTime: string;
  IsCanceled: boolean;
  IsWaitlistAvailable: boolean;
  IsAvailable: boolean;
  IsSubstitute: boolean;
  MaxCapacity: number;
  TotalBooked: number;
  WebCapacity: number;
  TotalBookedWaitlist: number;
}
```

### API Response Types

```typescript
// Pagination information
interface PaginationResponse {
  PaginationResponse: {
    RequestedLimit: number;
    RequestedOffset: number;
    PageSize: number;
    TotalResults: number;
  };
}

// Get classes response
interface GetClassesResponse extends PaginationResponse {
  Classes: Class[];
}

// Get staff response
interface GetStaffResponse extends PaginationResponse {
  StaffMembers: Staff[];
}
```

## Dates and Timezones

Mindbody takes and returns every date and time as the site's local time with no UTC offset (for example `2026-10-18T08:00:00`). Send dates and times the same way.

- **Site zone.** The server reads the site's IANA timezone from `GET /site/sites` (`TimeZone`), cached for 60 minutes under the same key `getSites` uses.
- **Multi-site keys.** The lookup sends `SiteIds` for the chosen site (explicit `siteId` argument, else `MINDBODY_SITE_ID`) and must resolve to exactly one site. If the key reaches several sites and none was chosen, or the chosen one is not reachable, `getSites` returns `{ error, availableSites }` with no `site`, and the timezone cannot be resolved (so `cancelAppointments` refuses to write). The first site returned is never used by default.
- **Override.** `MINDBODY_SITE_TIMEZONE` (an IANA name, e.g. `America/Los_Angeles`) is used only when the site record gives no usable `TimeZone`. A valid `TimeZone` from the API takes precedence.
- **Default date ranges** are the site's calendar date, not the host machine's. For example, `getStaffAppointments` defaults to the site's today through seven days out.
- **Cancellation guard.** `cancelAppointments` compares each start time with now in the site zone. If the zone cannot be resolved, it refuses to write.
- **Read tools.** If the zone cannot be resolved, read tools with a default date range fall back to UTC and print one warning to stderr per process.
- **DST.** An ambiguous wall time (fall back; e.g. 01:30 in Los Angeles on the night the clocks go back) resolves to the earlier instant. A nonexistent wall time (spring forward; e.g. 02:30) moves forward by the gap, to 03:30.

## Rate Limiting

The Mindbody API has the following rate limits:

- **2000 requests per hour** per site
- **Page size**: the server asks for 200 rows per request and reads every page (see item 4). A live check recorded in [quality-gates.md](quality-gates.md) (Gate 13) found the API also accepts a larger `Limit` (500).

The MCP server implements several strategies to work within these limits:

1. **Response Caching**: 5-minute default cache for class data
2. **Teacher ID Caching**: 60-minute cache for staff lookups
3. **Automatic Retry**: Exponential backoff on rate limit errors
4. **Pagination**: Every paginated GET is read to completion through `fetchAllPages`, which throws rather than returning a truncated list (`MAX_PAGES` = 100 pages). Gate 13 enforces this (see [quality-gates.md](quality-gates.md))

## Authentication

The server uses OAuth 2.0 for authentication:

1. **Initial Token Request**: Uses API key and source credentials
2. **Token Caching**: Tokens cached until 1 minute before expiration
3. **Automatic Refresh**: Expired tokens automatically refreshed
4. **Error Recovery**: 401 errors trigger token refresh

Required credentials:
- `MINDBODY_API_KEY`: Your API key from Mindbody
- `MINDBODY_SITE_ID`: Your site ID (use -99 for sandbox)
- `MINDBODY_SOURCE_NAME`: Source credentials username
- `MINDBODY_SOURCE_PASSWORD`: Source credentials password

## Error Codes

| Code | Description | Action |
|------|-------------|--------|
| 101 | Invalid credentials | Check API key and source credentials |
| 102 | Invalid site ID | Verify site ID is correct |
| 201 | Teacher not found | Check spelling, ensure teacher is active |
| 301 | Invalid date format | Use YYYY-MM-DD format |
| 401 | Unauthorized | Token expired, will auto-refresh |
| 429 | Rate limit exceeded | Wait and retry, check cache settings |
| 500 | Server error | Retry with exponential backoff |
