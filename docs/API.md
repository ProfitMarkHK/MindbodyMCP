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

Updates an existing appointment: reschedule it (new `startDateTime`), change staff, session type or notes, or apply one status action with `execute`. It does not cancel. Use `cancelAppointments`.

Ownership, status and timing are verified before anything is written, and none of the guards can be skipped by omitting an argument. An appointment that fails a guard is reported in `rejected` and nothing is sent.

#### Parameters

| Parameter | Type | Required | Description | Default |
|-----------|------|----------|-------------|---------|
| `clientId` | string | Yes | Client ID who owns the appointment | - |
| `appointmentId` | number | Yes | Appointment ID | - |
| `startDateTime` | string | No | New start date/time (reschedule) | - |
| `endDateTime` | string | No | New end date/time | - |
| `staffId` | number | No | Change staff | - |
| `sessionTypeId` | number | No | Change the session type (service), sent as `SessionTypeId`. A positive integer. Allowed on `Booked`, `Confirmed` and `Arrived`; refused on `Completed`, `NoShow`, `Cancelled` and `LateCancelled`. Not a reschedule, so it may be combined with `applyPayment`. | - |
| `resourceIds` | number[] | No | Resource IDs | - |
| `notes` | string | No | Notes | - |
| `execute` | string | No | One of `confirm`, `unconfirm`, `arrive`, `unarrive`, `complete`. `cancel` and `latecancel` are refused client-side with no API call. `complete` additionally requires the appointment to have started. | - |
| `executePayment` | boolean | No | Deprecated and ignored: not part of the Mindbody API | - |
| `sendEmail` | boolean | No | Send email | - |
| `applyPayment` | boolean | No | Apply a current applicable client service from that client's account. Refused alongside a reschedule, and on an appointment that has already taken place. | - |

#### Guards

| Guard | Rule |
|-------|------|
| Request shape | `clientId` is a non-empty string, `appointmentId` a positive integer, and `sessionTypeId`, when given, a positive integer. No API call is made if any fails. |
| Ownership | The appointment must belong to `clientId`, looked up with `GET /appointment/staffappointments`. Someone else's appointment — or one outside the window, one year back through two years ahead — is reported as `not found for this client`, which never names the real owner. |
| Terminal status | A `Cancelled` or `LateCancelled` appointment is final: no update of any kind is accepted. |
| Attendance-final status | A `Completed` or `NoShow` appointment accepts no status action, no `applyPayment`, no reschedule and no `sessionTypeId` change: a completed appointment has been checked out, so changing its service would desync it from the sale. Notes, staff and resources are still accepted. |
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
    sessionTypeId?: number; // as Mindbody returns it after the update
  };
  message: string;
}
```

#### Session type changes

The use case is a booking made under the wrong service (for example "Extensions – Application" when the client had "Extensions – Removal"), corrected before checkout so the sale uses the right pricing option. The appointment is usually already `Arrived`. Cancelling and rebooking is not an alternative: an `Arrived` appointment cannot be cancelled here (see "Arrived appointments"), and a rebooked appointment loses its history.

| Status | Session type change |
|---|---|
| `Booked`, `Confirmed`, `Arrived` | allowed |
| `Completed`, `NoShow` | refused: the appointment has been checked out or has taken place |
| `Cancelled`, `LateCancelled` | refused: final for every update |

Mindbody may reset the end time to the new session type's default duration, so the response's `startDateTime`, `endDateTime` and `sessionTypeId` are returned for the caller to check. If the staff member is not set up for the new session type, Mindbody's error is returned unchanged as `success: false`.

#### Examples

```json
{ "appointmentId": 987654, "startDateTime": "2026-10-23T15:00:00" }
```

```json
{ "appointmentId": 987654, "execute": "arrive" }
```

```json
{ "clientId": "100015", "appointmentId": 987654, "sessionTypeId": 88 }
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
| `lateCancel` | boolean | No | Record as late cancellations. Honoured only inside the site's late-cancel window (see below) | false |
| `sendEmail` | boolean | No | Email the client about the cancellation | false |

#### Guards

All guards run before any cancellation is sent. The request is all-or-nothing: if any appointment fails a guard, none are cancelled.

- Exactly one client per call.
- 1 to 3 appointment IDs (`MAX_CANCELLATIONS_PER_REQUEST`), no duplicates.
- Each appointment must belong to `clientId`. Ownership is checked with `GET /appointment/staffappointments` filtered by `ClientId`. An appointment that belongs to another client, or falls outside the lookup window (today through two years out), is reported as "not found for this client".
- Each appointment must start in the future, compared in the site's timezone. If the site timezone cannot be resolved, nothing is written (see the error table).
- Each appointment must not already be `Cancelled`, `LateCancelled`, `Completed`, `NoShow` or `Arrived` (see below).

Once the guards pass, each cancellation is sent through `POST /appointment/updateappointment` with `Execute: cancel` (or `latecancel`), one at a time.

#### Arrived appointments

`Arrived` is non-cancellable through this tool, even when the start time is still in the future (a client can be marked arrived on an appointment booked for later). An arrived client is physically present, so cancelling, and especially late-cancelling, which forfeits the service, is a staff-side correction that belongs in the Mindbody front desk, not in an AI-driven tool. The tool fails closed and its error tells the caller to un-arrive the appointment or cancel it in Mindbody directly.

The `Cancelled` / `LateCancelled` status check is defence in depth. The sandbox never returns those rows from `GET /appointment/staffappointments` (D-4 in `docs/mindbody-spec-discrepancies.md`), so re-cancelling an already-cancelled appointment normally ends at `not found for this client` before the status check is reached.

#### Email is not dry-run

There is no dry-run for cancellation. `sendEmail` defaults to `false`, but `sendEmail: true` makes Mindbody email the real client (only if the client has an email address and automatic emails have been set up), and the cancellation itself is committed. Nothing in the tool previews or undoes either.

#### Late-cancel window

A late cancel forfeits the service, so `lateCancel: true` is bounded. The Mindbody v6 spec does not expose the site's late-cancel window: no `Site`, `Location`, `SessionType` or `Program` field states it (`Program.CancelOffset` exists but is described only as "The offset to use for the service category", with no unit or meaning, so it is not used). The operator therefore states it in `MINDBODY_LATE_CANCEL_WINDOW_HOURS`:

- Set to a positive number of hours: `lateCancel: true` is honoured only for an appointment that starts within that many hours of now, compared in the site's timezone. Any appointment further out fails the all-or-nothing guard with `late cancel refused: it starts more than N hour(s) from now, outside the site's late-cancel window; cancel without lateCancel`.
- Unset, empty, non-numeric or not positive: a `lateCancel: true` request is refused before any lookup or write, with `late cancel refused: the site's late-cancel window is unknown. Set MINDBODY_LATE_CANCEL_WINDOW_HOURS ...` (id `-1`).
- `lateCancel: false` (the default) is unaffected.

`cancelEnrollmentVisits` applies the same bound to enrollment sessions, and so does `removeClientFromClass` (drop-in classes). With `lateCancel: true` the latter, before any write: refuses if the window is unset or invalid (no lookup, no write); resolves the site timezone (refuses if it cannot); looks the class up with `GET /class/classes` filtered by `ClassIds`, from now through two years ahead in the site's zone; and refuses if the class is not found (including one that has already started), is returned more than once, or starts more than the window from now. It returns `{ success: false, message }` with the same refusal texts as above. `lateCancel: false` (the default) makes no extra read.

`removeClientFromClass` also takes `sendEmail` (default `false`), sent as `SendEmail` on `POST /class/removeclientfromclass`. As above, it is not a dry run: `true` can email a real client. A late cancel that the window refuses makes no POST, so no email is sent.

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
| `appointment status is <Status>, which cannot be cancelled` | Already Cancelled, LateCancelled, Completed, NoShow or Arrived. Nothing is cancelled. For `Arrived` the message adds how to proceed. | Completed means checked out; it cannot be cancelled here. For Arrived, un-arrive it (`updateAppointment` with `execute: "unarrive"`) or cancel it in Mindbody directly |
| `duplicate appointment id in request` | The same ID appears twice | Remove the duplicate |
| `late cancel refused: it starts more than N hour(s) from now, ...` | `lateCancel: true` on an appointment outside `MINDBODY_LATE_CANCEL_WINDOW_HOURS`. Nothing is cancelled. | Cancel without `lateCancel` |
| `late cancel refused: the site's late-cancel window is unknown. ...` (id `-1`) | `lateCancel: true` with `MINDBODY_LATE_CANCEL_WINDOW_HOURS` unset or invalid. Nothing is looked up or cancelled. | Set the variable, or cancel without `lateCancel` |
| `at most 3 appointments may be cancelled per request` | More than 3 IDs. Nothing is cancelled. | Split into several calls |
| `appointment lookup failed` | Verification lookup failed. Nothing is cancelled. | Retry |
| `site timezone unavailable: <reason>` (id `-1`) | The site's timezone could not be resolved, so start times cannot be compared. Nothing is cancelled. | Check the site record's `TimeZone`; set `MINDBODY_SITE_TIMEZONE` only if the record has none, and unset it if it disagrees with the record |
| Mindbody write error | Cancellations already made stand and appear in `cancelled`; the call stops at the failing ID. | Re-check the listed appointments with `getStaffAppointments` |

### checkoutShoppingCart

Processes a shopping cart checkout. A cart item can carry `appointmentIds` to reconcile existing booked appointments.

#### Parameters

| Parameter | Type | Required | Description | Default |
|-----------|------|----------|-------------|---------|
| `clientId` | string | Yes | Client ID | - |
| `items` | array | Yes | Cart items: `{ item: { type, metadata }, quantity, appointmentIds?, discountAmount?, appointmentBookingRequests? }`. `item.type` is `Service`, `Product`, `Package` or `Tip`. See "Cart items" below. | - |
| `payments` | array | Yes | Payment methods: `{ type, metadata: { amount, ... } }`. `type` is `Cash`, `Check`, `CreditCard`, `Comp`, `Custom` or `StoredCard`. | - |
| `inStore` | boolean | No | In-store purchase | false |
| `promotionCode` | string | No | Promotion code | - |
| `sendEmail` | boolean | No | Send email receipt | true |
| `locationId` | number | No | Location ID | - |
| `test` | boolean | No | Dry run, sent as `Test: true`: Mindbody validates the cart and computes its totals but records no sale. See "Dry run" below. Omitted or false, `Test` is not sent. | false |

#### Cart items

The tool builds each cart item's `Item.Metadata` itself; it does not pass the caller's `metadata` through. The accepted keys are:

| `item.type` | `item.metadata` | Sent as |
|---|---|---|
| `Service` | `{ id }`: the pricing option ID | `Item: { Type: 'Service', Metadata: { Id } }` |
| `Product` | `{ id }`: the product ID | `Item: { Type: 'Product', Metadata: { Id } }` |
| `Package` | `{ id }`: the package ID | `Item: { Type: 'Package', Metadata: { Id } }` |
| `Tip` | `{ amount }` | `Item: { Type: 'Tip', Metadata: { Amount } }` |

Any other key (`price`, `name`, a second `id` on a tip, ...) is dropped without error. `docs/openapi.json` types `CheckoutItem.Metadata` as a bare `object` and points to Mindbody's "Cart Item Metadata" page for its contents, so the table above is this tool's contract, not a schema the spec publishes.

Per-item fields beside `item` and `quantity`, all optional. Each maps to a property of `CheckoutItemWrapper` in the spec:

- `appointmentIds` → `AppointmentIds`: existing appointments this item reconciles. See "Guards".
- `discountAmount` → `DiscountAmount`: amount taken off the item. It must be a non-negative number, or the checkout is refused before any request. Omitted, no `DiscountAmount` key is sent. The spec says it "is ignored for packages". The discount shows only in the cart's `discountTotal` and `grandTotal`: on `-99` (2026-11-16) a 5 discount on a 30 service gave `DiscountTotal` 5 and `GrandTotal` 25, but the line's `DiscountAmount` came back 0. So a result line's `discountAmount` is passed through as reported, and its `total` is `price × quantity` before discount.
- `appointmentBookingRequests` → `AppointmentBookingRequests`: new appointments to book and pay for with this item. The spec says it "applies only to pricing option items" (`Service`). Each entry is `{ staffId, locationId, sessionTypeId, startDateTime, notes? }`, sent as `StaffId`, `LocationId`, `SessionTypeId`, `StartDateTime` (site-local `yyyy-mm-ddThh:mm:ss`) and `Notes`. Mindbody ignores `Notes`: the spec's `CheckoutAppointmentBookingRequest` has no such property, and on `-99` (2026-11-16) an appointment booked with notes came back with `Notes: null`, in the checkout response and on a read-back. Set notes afterwards with `updateAppointment`. Its `EndDateTime`, `Resources` and `ProviderId` are not exposed. Unlike `appointmentIds`, these entries pass no ownership guard: they create appointments rather than pay for existing ones.

The spec's other wrapper fields (`SalesNotes`, `ClassIds`, `VisitIds`, `EnrollmentIds`, `CourseIds`, `Id`) are not exposed.

#### No per-sale price override

Every item sells at its catalogue price. The REST API has no field that sets a different price for one sale, and `DiscountAmount` only lowers one. A sale that needs another price, including any 0-priced option billed by the hour, must be recorded in the Mindbody web app. A client purchases read (`GET /client/clientpurchases`, the `getClientPurchases` tool where this server has it) can then confirm it.

The evidence, from `Test: true` probes on the `-99` sandbox on 2026-10-28 (issue #32). The sandbox currently refuses user tokens, so none of this could be re-run for this write-up:

- `CheckoutItemWrapper` in `docs/openapi.json` has no price field. Its properties are `Item`, `Quantity`, `DiscountAmount`, `SalesNotes`, `AppointmentIds`, `AppointmentBookingRequests`, `ClassIds`, `VisitIds`, `EnrollmentIds`, `CourseIds` and `Id`.
- 68 checkouts placed 22 candidate keys at three levels: inside `Item.Metadata`, on `Item`, and on the cart item. The keys were `Price`, `price`, `UnitPrice`, `SalePrice`, `CustomPrice`, `OverridePrice`, `PriceOverride`, `ItemPrice`, `NewItemPrice`, `NewPrice`, `ManualPrice`, `OnlinePrice`, `PricePaid`, `Total`, `TotalAmount`, `Subtotal`, `SubTotal`, `Cost`, `Rate`, `Value`, `Amount` and `amount`. Every one was ignored without an error.
- A committed (`Test: false`) checkout carrying several of those keys, with a payment matching the intended price, was refused: `The input payment total (107) does not match the calculated total (100)`.
- A negative `DiscountAmount` on a 0-priced service left the total at 0.
- The web app's override is a form field (`newItemPrice`) posted to the classic ASP Point of Sale page, not to the REST API. A sale at an overridden price reads back through `GET /client/clientpurchases` and `GET /sale/sales` as `PurchasedItems[].UnitPrice`, with no override flag. So the API can read an overridden price but cannot write one.

Changing the catalogue price around a sale (`PUT /sale/services`) was rejected: it changes the price for every concurrent sale, and it changes the pricing option rather than overriding one checkout.

#### Guards

Every guard below runs on a dry run exactly as on a real checkout, and refuses before any request.

A `discountAmount` that is negative or not a finite number refuses the checkout.

Every `appointmentIds` entry (across all items) is verified before the sale is sent, all-or-nothing: if any one fails, nothing is charged and no partial cart is built. The check is the same ownership lookup `cancelAppointments` and `updateAppointment` use (`GET /appointment/staffappointments` filtered by `ClientId`, a year back through two years ahead). An appointment that belongs to another client, or is outside that window, is reported as `not found for this client`; the owner is never named. If the site timezone or the lookup fails, the checkout is refused (fail closed). A request with no `appointmentIds` makes no lookup.

#### Dry run (`test: true`)

Mindbody's test mode does **not** check payments. On the `-99` sandbox (2026-10-28) a Cash payment of 107 against a cart total of 100 passed with `Test: true`, while the same cart with `Test: false` was refused (`The input payment total (107) does not match the calculated total (100) for the entire cart.`). So the tool checks payments itself: it sums `payments[].metadata.amount` and compares it with the returned `GrandTotal` in whole cents. On a mismatch it returns `success: false` with both figures, as the real call would.

A dry-run result carries `dryRun: true`. The response's `ShoppingCart.SaleId` is never returned: in test mode the sandbox still hands one back, but no such sale exists (`GET /sale/sales` by that id returns no rows). `shoppingCart.id` is the cart id, not a sale id.

#### Response

The response has `success`, a `shoppingCart` with totals (`subTotal`, `discountTotal`, `taxTotal`, `grandTotal`) and `items`, and a top-level `appointments` list. Each cart item carries `appointments`: the IDs of the appointments that item reconciled. A dry run adds `dryRun: true`.

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
| `discountAmount must be a non-negative number (got ...); nothing was charged.` | A negative or non-numeric `discountAmount`. Nothing is sent. | Pass a number of 0 or more; a higher price must be sold in the web app |
| `Appointment id(s) ... are not positive integers; nothing was charged.` | A malformed ID. Nothing is charged. | Fix the ID |
| `Could not verify the appointments (site timezone unavailable: ... / appointment lookup failed: ...); nothing was charged.` | The ownership lookup could not run. Nothing is charged. | Retry; check the site record's `TimeZone` |
| `Dry run: the payment total (<sum>) does not match the calculated total (<GrandTotal>); ...` | `test: true` and the payments do not sum to the cart total. The real checkout would be refused. | Fix the payment amounts |
| `Dry run: Mindbody returned no GrandTotal, ...` | `test: true` and the response had no cart total, so payments could not be checked | Retry; check the items |
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

### getClientSchedule

A client's bookings in a window, one flat row per booking, shaped so a cancel flow can resolve "Jane's 6pm tonight" to the ids the cancel tools take. Read-only: no POST.

Reads `GET /client/clientschedule` with `ClientId`, `StartDate`, `EndDate` and `IncludeWaitlistEntries: true`, through `fetchAllPages`. The read is shared with `getClientEnrollments` and `cancelEnrollmentVisits` (`fetchClientSchedule` in `src/tools/enrollmentManagement.ts`). When some rows have a `ClassId`, it also reads `GET /class/classes` by `ClassIds` (chunks of 50, same helper as `getClientEnrollments`) to learn each class's program. An empty schedule costs one request. Staff and location names come from the cached `/staff/staff` and `/site/locations` catalogues, each read only when a row carries that id.

#### Parameters

| Parameter | Type | Required | Description | Default |
|-----------|------|----------|-------------|---------|
| `clientId` | string | Yes | Client to look up | - |
| `startDate` | string | No | Start date (YYYY-MM-DD), sent unchanged | Today at the site |
| `endDate` | string | No | End date (YYYY-MM-DD), sent unchanged | 30 days after today at the site |

#### `kind`

Checked in this order; the first match wins.

| `kind` | Rule | Cancel with |
|--------|------|-------------|
| `waitlist` | `WaitlistInfo.WaitlistId` is set | Not a seat. Remove it from the waitlist |
| `appointment` | `AppointmentId > 0` | `cancelAppointments` (`appointmentId`) |
| `enrollment` | `ClassId > 0` and the class's `ClassDescription.Program.ScheduleType` is `Enrollment` | `cancelEnrollmentVisits` (`visitId`) |
| `class` | Any other `ClassId > 0`, including a class `/class/classes` did not return | `removeClientFromClass` (`classId`) |

#### Response

```typescript
interface GetClientScheduleResponse {
  bookings: Array<{
    kind: 'waitlist' | 'appointment' | 'enrollment' | 'class';
    visitId: number;
    classId?: number;            // undefined on appointments (Mindbody sends 0)
    appointmentId?: number;      // undefined on class rows (Mindbody sends 0)
    appointmentStatus?: string;  // appointment rows only
    startDateTime: string;       // site-local, no offset
    endDateTime: string;
    name?: string;
    staffId?: number;
    staffName?: string;          // undefined when the staff catalogue lacks the id
    locationId?: number;
    locationName?: string;       // undefined when the location catalogue lacks the id
    serviceId?: number;
    serviceName?: string;
    programId?: number;          // from the class; undefined on appointments
    programName?: string;
    signedIn: boolean;
    lateCancelled: boolean;
    missed: boolean;             // the sandbox sets it on future unattended enrollment visits too
    isWaitlisted: boolean;
    waitlistEntryId?: number;
  }>;                            // sorted by startDateTime
  totalBookings: number;
}
```

The tool does not decide whether a cancellation would be late. That policy belongs to the cancel path.

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
| `lateCancel` | boolean | No | Record as late cancellations. Bounded by `MINDBODY_LATE_CANCEL_WINDOW_HOURS` exactly as in `cancelAppointments` | `false` |
| `sendEmail` | boolean | No | Email the client | `false` |

#### Guards

Every guard runs before anything is written, and one failure rejects the whole request:

1. Request shape: one client, 1 to 3 positive integer IDs, no duplicates.
2. The site timezone resolves (fail closed otherwise).
3. The visit is on the client's own schedule (`GET /client/clientschedule`, today through two years out). Another client's visit reads as "not found for this client".
4. The visit is a booked enrollment session: it has a `ClassId`, is not a waitlist entry, and its class (`GET /class/classes`) belongs to an `Enrollment` program. A drop-in class visit is refused with a pointer to `removeClientFromClass`.
5. The session starts in the future in the site's zone.
6. The visit is not already late-cancelled or signed in. Mindbody's `Missed` flag is not a guard: the sandbox sets it on every future, not-yet-attended enrollment visit.
7. With `lateCancel: true`, the session starts within `MINDBODY_LATE_CANCEL_WINDOW_HOURS` of now; with that variable unset or invalid the request is refused before any lookup (see *Late-cancel window* under `cancelAppointments`).

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

### getClientPurchases

Returns a client's purchase history with prices. It wraps `GET /client/clientpurchases` and reads every page through `fetchAllPages` on the `Purchases` key. Read-only: it makes no POST.

Use it to:
- value what a client bought (`ClientService` from `getClientCompleteInfo` has no price field);
- check whether a client already has a sale on a day before recording one with `checkoutShoppingCart` (pass the same date as `startDate` and `endDate`);
- read a sale back afterwards by `saleId`. A sale made in the Mindbody web app at an overridden price reads back as plain `price` and `purchasedItems[].unitPrice` (sandbox sale 100170630: a 10 Class Card at 77 instead of 100 reads `price: 77`, `totalAmount: 83.16`). There is no override flag.

The endpoint's own defaults are `StartDate: now` and `EndDate: end of today`, so a request that omits them returns almost nothing. The tool always sends both.

#### Parameters

| Parameter | Type | Required | Description | Default |
|-----------|------|----------|-------------|---------|
| `clientId` | string | Yes | Client to read | - |
| `startDate` | string | No | Site-local date (YYYY-MM-DD). Sent as `StartDate` `T00:00:00` | 365 days before today, site zone |
| `endDate` | string | No | Site-local date (YYYY-MM-DD). Sent as `EndDate` `T23:59:59` | Today, site zone |
| `saleId` | number | No | Sent as `SaleId`: only the record for that sale | - |

#### Response

```json
{
  "purchases": [
    {
      "description": "10 Class Card", "price": 77, "amountPaid": 83.16, "discount": 0, "tax": 6.16,
      "returned": false, "quantity": 1, "accountPayment": false,
      "sale": {
        "id": 100170630, "saleDateTime": "2026-10-28T10:15:00", "locationId": 1,
        "purchasedItems": [
          { "id": 1192, "isService": true, "description": "10 Class Card", "unitPrice": 77, "quantity": 1,
            "totalAmount": 83.16, "returned": false, "contractId": 0,
            "expDate": "2027-10-28T00:00:00", "activeDate": "2026-10-28T00:00:00" }
        ],
        "payments": [{ "id": 77001, "amount": 83.16, "method": 1, "type": "Cash", "transactionId": 555 }]
      }
    }
  ],
  "totalPurchases": 1
}
```

- Every key exists on `ClientPurchaseRecord`, `Sale`, `PurchasedItem` or `SalePayment` in `docs/openapi.json`. Nothing is computed, and no per-session value is derived.
- A record with `AccountPayment: true` is a payment onto the client's account. It is kept and reported as `accountPayment: true`.
- `sale.saleDateTime` is site-local. A trailing `Z`, which the API appends spuriously, is stripped (D-11).
- `UniqueClientId` is not exposed: `clientId` reads the same records.


Returns a client's whole wallet in one request: the client record (with `AccountBalance`), purchased services, contracts, memberships and arrival programs. It wraps `GET /client/clientcompleteinfo`, which returns all four collections in one object with no pagination (sandbox-verified: `Limit`/`Offset` are ignored silently and no `PaginationResponse` envelope exists), so the tool makes a single request and does not page it. Use it to read a client's balance before and after an action: one call instead of four.

By default the endpoint returns only services **expiring on or after today** — an undocumented behaviour that silently drops expired purchase history (verified on the sandbox: 7 of 88 services for the probe client; see [F-3](mindbody-spec-discrepancies.md#f-3-clientcompleteinfo-parameter-behaviour-probed-end-to-end)). Pass a wide past `startDate` to include expired purchases.

#### Parameters

| Parameter | Type | Required | Description | Default |
|-----------|------|----------|-------------|---------|
| `clientId` | string | Yes | Client to read | - |
| `requiredClientData` | string[] | No | Collections to return: any of `Services`, `Contracts`, `Memberships`, `ArrivalPrograms`. Omit for all four. These are the only values the API accepts; anything else is silently ignored with HTTP 200, so the tool rejects other values with an error instead | All four collections |
| `showActiveOnly` | boolean | No | `true` narrows `services` to the rows that can pay now (`current: true`). Other collections are unaffected | `false` |
| `startDate` | string | No | ISO date. Includes services **expiring on or after** this date (the observed semantics — the spec claims purchase date). Send e.g. `2000-01-01` to include expired purchase history | Today, which drops expired purchases |

#### Response

```json
{
  "client": { "id": "12345", "firstName": "Sarah", "lastName": "Johnson", "accountBalance": -42.5 },
  "services": [
    { "id": 7001, "productId": 55, "name": "10 Class Pack", "count": 10, "remaining": 6, "current": true,
      "activeDate": "2026-02-01T00:00:00", "expirationDate": "2026-08-01T00:00:00", "paymentDate": "2026-02-01T00:00:00",
      "programName": "Yoga", "programId": 3, "siteId": -99,
      "activationType": "OnFirstVisit", "cannotPayForClassesBeforeActivation": false }
  ],
  "contracts": [
    { "id": 9001, "contractId": 12, "name": "Unlimited Monthly", "soldDate": "2026-02-01T00:00:00",
      "startDate": "2026-02-01T00:00:00", "autopayStatus": "Active", "autoRenewing": true,
      "isMonthToMonth": true, "siteId": -99 }
  ],
  "memberships": [
    { "id": 3001, "name": "Unlimited Month", "remainingClasses": 8, "activeDate": "2026-02-01",
      "expirationDate": "2026-03-01", "programName": "Yoga", "programId": 3, "siteId": -99, "iconCode": "4" }
  ],
  "arrivals": [
    { "arrivalProgramId": 21, "arrivalProgramName": "Front Desk", "canAccess": true,
      "locations": [{ "id": 1, "name": "Main Studio" }] }
  ]
}
```

- `client` is omitted when the response carries no `Client`.
- `accountBalance` is omitted when the response carries no value. It is never coerced to `0`.
- `services[].remaining` maps `ClientService.Remaining`. `ClientService` has **no price field**, so the tool reports none.
- `contracts` and `memberships` use the same row shape as `getClientContracts` and `getClientMemberships`.
- `arrivals[].locations[].name` is resolved from the cached location catalogue. It is omitted when the catalogue does not hold the id.

#### What the tool does not send

Every omission below is backed by a sandbox probe (2026-10-26/27, evidence in
[F-3](mindbody-spec-discrepancies.md#f-3-clientcompleteinfo-parameter-behaviour-probed-end-to-end)):

- **`endDate` is not sent and not exposed.** It has no observable effect: `StartDate=2000-01-01&EndDate=2026-10-12` still returned every row purchased and expiring after that date. A parameter that verifiably does nothing is not exposed as if it did.
- **`useActivateDate` is not sent.** No probe could distinguish it from `false` (every probed row had `ActiveDate == PaymentDate`), so it is undetermined rather than verified, and undetermined parameters stay unsent.
- **`crossRegionalLookup`, `clientAssociatedSitesOffset`, `excludeInactiveSites` are not sent.** On a single-site client they produce no observable change, and an out-of-range offset answers HTTP 400 with a range message. Multi-site behaviour cannot be probed without creating cross-site data, so none of the three is exposed.
- **`uniqueClientId` is not exposed.** It verifiably works as an alternative lookup key (`uniqueClientId=100009444` returned the full wallet of the client whose `Id` is `008221`, and when both are sent `ClientId` wins), but it adds no capability: it reads the same data the tool already returns by `clientId`. Recorded in F-3 and raised with Mindbody, because the spec wrongly marks `clientId` as required and documents `uniqueClientId` with a description copied from the class endpoint.
- **`limit`/`offset` are not sent.** The endpoint ignores both silently and pages nothing.

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
| `GET /client/clientcompleteinfo` | `GetClientCompleteInfoResponse` types all four collections as arrays. | With `RequiredClientData` set, the unrequested collections come back as **JSON `null`**, not `[]`. Unknown `RequiredClientData` values are silently ignored with HTTP 200 and every collection is returned. | Maps every collection with `?? []` (load-bearing) and exposes `requiredClientData` validated to the four verified values, so a typo fails loudly instead of silently widening the response. | F-3 |
| `GET /client/clientcompleteinfo` | `StartDate` "Filters results to pricing options that are purchased on or after this date. Default: today's date." | Filters by **expiration** date; omitted, the window is expiry ≥ today and it silently drops expired purchase history. `EndDate` has no observable effect. | Sends no date by default — the observed default window is the snapshot the tool wants — and documents the observed semantics on `startDate` so a wide past value can recover history. | F-3 |

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
- **Override.** `MINDBODY_SITE_TIMEZONE` (an IANA name, e.g. `America/Los_Angeles`) is used only when the site record is reachable but gives no usable `TimeZone`. A valid `TimeZone` from the API takes precedence, with two refusal cases on write paths (`cancelAppointments`, `cancelEnrollmentVisits`):
  - The site lookup failed (including the multi-site refusal above): the override is never consulted, and the write is refused.
  - The record has a usable `TimeZone` and the override names a different zone: the write is refused (`... disagrees with the site record's TimeZone ...`). Read tools ignore the override and use the record's zone.
- **No site configured.** If `MINDBODY_SITE_ID` is unset or blank, no `SiteId` header is sent (never the string `undefined`) and Mindbody applies the key's default; a multi-site key is then refused as above.
- **Default date ranges** are the site's calendar date, not the host machine's. For example, `getStaffAppointments` defaults to the site's today through seven days out.
- **Cancellation guard.** `cancelAppointments` compares each start time with now in the site zone. If the zone cannot be resolved, it refuses to write. The same comparison bounds `lateCancel` by `MINDBODY_LATE_CANCEL_WINDOW_HOURS`.
- **Read tools.** If the zone cannot be resolved, read tools with a default date range fall back to UTC and print one warning to stderr per process.
- **DST.** An ambiguous wall time (fall back; e.g. 01:30 in Los Angeles on the night the clocks go back) resolves to the earlier instant. A nonexistent wall time (spring forward; e.g. 02:30) moves forward by the gap, to 03:30.

## Rate Limiting

The Mindbody API has the following rate limits:

- **2000 requests per hour** per site
- **Page size**: the server asks for 200 rows per request and reads every page (see item 4). A live check recorded in [quality-gates.md](quality-gates.md) (Gate 13) found the API also accepts a larger `Limit` (500).

The MCP server implements several strategies to work within these limits:

1. **Response Caching**: 5-minute default cache for class data
2. **Teacher ID Caching**: 60-minute cache for staff lookups
3. **Automatic Retry (GET only)**: A GET is retried up to 3 times (1s, 2s, 4s) on a network error or a 5xx. A POST is never retried: see [Write requests are not retried](#write-requests-are-not-retried)
4. **Pagination**: Every paginated GET is read to completion through `fetchAllPages`, which throws rather than returning a truncated list (`MAX_PAGES` = 100 pages). Gate 13 enforces this (see [quality-gates.md](quality-gates.md))

### Write requests are not retried

A POST (`checkoutshoppingcart`, `updateappointment`, `addclienttoclass`, ...) that fails with a 5xx or loses its response has an unknown outcome: the server may have applied it before failing. Replaying it could charge a client twice or repeat an emailed cancellation. `docs/openapi.json` defines no idempotency key or header (nothing named `Idempotency*` appears in it), so the client cannot make a replay safe, and `MindbodyApiClient.request` does not retry a POST on a network error or a 5xx. The error carries the original message plus:

```
... The POST /sale/checkoutshoppingcart was NOT retried: the server may already have applied it, and Mindbody's public API v6 documents no idempotency key that would make a replay safe. Reconcile before retrying: read the record back (appointments, visits, sales, client) and repeat the write only if it did not land.
```

A 4xx on a POST is a definitive answer and is reported unchanged. The one replay a POST still gets is after a 401: the token is refreshed and the request is sent once more, which is safe because a 401 means nothing was applied. Covered by `tests/api-client-retry.test.ts`.

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

### The staff usertoken is not optional in practice

The OpenAPI spec marks the `authorization` header as optional on every
endpoint. In practice most client-data reads **require** it: without a staff
usertoken they return **HTTP 200 with empty collections** instead of an auth
error. Verified on the sandbox (2026-10-26, site `-99`):

| Request | Result |
|---|---|
| `GET /client/clients` with `Api-Key` + `SiteId` only | `200` — `Clients: []`, `TotalResults: 0` |
| Same request plus `Authorization: Bearer <usertoken>` | `200` — 4,465 clients |

So an empty client, visit or membership list from this server can mean one of
two things: the site has no such records, **or** token acquisition failed and
every call was silently downgraded to API-key-only auth. The degradation is
endpoint-specific: it was verified on `GET /client/clients` (empty without a
token, 4,465 rows with one), while `GET /client/clientcompleteinfo` returns
full data with the API key alone (verified 2026-10-27). Treat "works without a
token" as something to verify per endpoint, never to assume. The server logs
one stderr line when the downgrade happens:

```
User token acquisition failed (<status>): <message>. Falling back to API-key-only auth.
```

If a query returns an empty collection unexpectedly, check the server log for
that line before concluding the data is absent. The failure causes observed so
far are `Unsupported IP Address …` (the sandbox API key allow-lists IPs; add
the egress IP in the Mindbody developer portal) and `Staff user was not found
for this site` (the source credentials are not a staff user of the site in the
`SiteId` header).

## Error Codes

| Code | Description | Action |
|------|-------------|--------|
| 101 | Invalid credentials | Check API key and source credentials |
| 102 | Invalid site ID | Verify site ID is correct |
| 201 | Teacher not found | Check spelling, ensure teacher is active |
| 301 | Invalid date format | Use YYYY-MM-DD format |
| 401 | Unauthorized | Token expired, will auto-refresh |
| 429 | Rate limit exceeded | Wait and retry, check cache settings |
| 500 | Server error | A GET was already retried 3 times. A POST was not retried: reconcile first (see below) |

## Pricing map (checkout service by stylist title)

Mindbody prices the same session differently by stylist title (for example "Highlights & Finish" for an Emerging stylist vs a Director). The catalogue does not say which service a session type books, so the server keeps a local map instead of guessing from names.

- **File.** `<MINDBODY_PRICING_MAP_DIR>/pricing.<siteId>.json`, keyed by the configured `MINDBODY_SITE_ID`. Holds `staff` (staff ID to title) and `sessionTypeServices` (session type ID, then title, to single-visit service ID). It is read on every call, so an edit takes effect immediately. A sibling `.bak` keeps the previous version and `pricing.<siteId>.audit.jsonl` logs each change.
- **Titles.** `emerging`, `stylist`, `senior`, `creative`, `director`. "Davy" is a stylist's personal price list in the catalogue, not a title.
- **Writes.** `setStylistTier` and `setSessionTypeService` are ungated until RBAC exists. Staff IDs must be on the live staff list; services must be offered for the session type and be single-visit.
- **Checkout.** `resolveCheckoutService(staffId, sessionTypeId)` returns `resolved` with the `serviceId` to pass as the cart item's `metadata.id`, and the live price. Any other status is a reason to stop and ask, never to fall back to a default title.

| `status` | Meaning |
|----------|---------|
| `resolved` | Title and service found, and the service is still offered in the live catalogue |
| `map_absent` | `MINDBODY_PRICING_MAP_DIR` unset, or no file for this site yet |
| `map_invalid` | File fails validation (bad title, wrong site ID, non-numeric key) |
| `no_tier` | The staff member has no title in the map |
| `no_service_mapping` | The title has no service for this session type |
| `service_not_in_catalogue` | The mapped service is no longer offered for the session type |
