# Mindbody API: code vs spec vs sandbox reconciliation

Date: 2026-10-17. Sandbox site: `-99`. Read-only audit; no source files were changed.

## Summary

| Verdict | Call sites |
|---|---|
| OK | 16 |
| CODE-BUG (code disagrees with spec; sandbox agrees with spec) | 28 |
| SPEC-BUG only (sandbox disagrees with spec; code already works around it) | 2 |
| UNVERIFIED | 0 |
| **Total call sites** | **46** |

Distinct findings: **30 code bugs** (section C), **10 spec issues to raise with Mindbody** (section D), **5 unverified items** (section E). No call site is wholly unverified, but five individual findings could not be confirmed against the sandbox and are marked as such in C and D. A call site can carry both a code bug and a spec bug; the table in section B shows the primary verdict and notes the secondary one.

Headline items:

- Eleven read tools map response fields that do not exist in either the spec or the sandbox, so parts of their output are always empty or undefined: waitlist entries, class schedules, packages, products, contracts, client contracts, client account balances, client visits, locations, sites, schedule items.
- Three request shapes are silently ignored by the sandbox because the parameter names are not in the spec: `Days` on active session times, `IgnorePrepFinishBuffer` on schedule items, plural `LocationIds`/`SessionTypeIds` on staff. One (`SessionTypeIds` on resources) makes the sandbox return HTTP 500.
- `purchaseContract` reads a `ClientContract` object that the spec response does not contain, so a successful purchase would be reported as a failure.
- `getContracts` can omit the spec-required `locationId`; the sandbox answers HTTP 400.
- The sandbox matches the refreshed spec for every response model probed (the only extra fields are `Program.ScheduleOffset` and `Program.ScheduleOffsetEnd`, D-3). The previously committed spec was older and lacked `SessionTypeActiveSessionTimes`; the refresh, now committed as `97aa763`, supplies it (D-1).

## A. Method and scope

**Spec.** `docs/openapi.json`, Swagger 2.0, paths under `/public/v{version}/...`, schemas under `#/definitions`. The refresh this audit probed was uncommitted in the working tree when the audit ran; it is now committed on this branch as `97aa763` and pinned in `docs/openapi.lock` by SHA-256 `970ffa10...`. Two versions are recorded, because the older committed spec is what makes several findings below visible:

| Version | `shasum docs/openapi.json` (SHA-1) |
|---|---|
| Refresh, audited against, now committed (`97aa763`); pinned by SHA-256 `970ffa101a254868290056081b062ee128c74b04d880190aa1605bfbb0068941` | `a1e5abfd939ad4b6205e753e6f4acc460e47ce69` |
| Previously committed at `HEAD` (`67e0b11`) | `b1652cb00ea213038fa3889e5bc6fd40c2255308` |

`a1e5abfd` is the SHA-1 of the refreshed file, not of a different document; the two digests name the same bytes. The refresh adds, among other things, `GetActiveSessionTimesResponse.SessionTypeActiveSessionTimes`, `Staff.Active`, `request.includeInactive` on `GET /staff/staff`, `ClientCreditCard.CardId`, `AddClientToClassRequest.AutoAssignSpot` and `request.excludeTypeTakenDescriptions` on `GET /client/clientvisits`. Everything below is checked against the refreshed file.

**Code scanned.** Every `fetchAllPages(...)`, `client.get(...)` and `client.post(...)` in `src/**/*.ts`, plus the token call in `src/api/auth.ts`. Forty-six call sites across seven tool files, `src/utils/siteTime.ts` and `src/api/auth.ts`. Line numbers are from the working tree as of this audit, which is the pre-fix revision now committed as `97aa763`; three other sessions were editing the checkout, and `src/tools/enrollmentManagement.ts`, `src/tools/siteManagement.ts` and `src/utils/siteTime.ts` changed while the audit ran. Their rows were re-read after the change. The section-C fixes landed after this audit and moved many of these lines: read a `file:line` here as a pointer into `97aa763`, not into the fixed tree, and prefer the file-and-path in the same row to locate the call site.

**Checks per call site.** (1) Path and method exist in the spec. (2) Every request parameter or body field the code sends exists in the spec with the right name and type. (3) Every response field the code reads exists in the spec's response definition. (4) Spec-required parameters the code can omit.

**Sandbox probing.** Credentials from the repo `.env` (`MINDBODY_TEST_*`, copied into `MINDBODY_*` in the probe process; values never printed). Probe scripts lived under `/tmp/mbprobe/` and used the repo's `src/api/auth.ts` for headers, with axios directly so that HTTP status and error bodies could be captured. Only GET requests were made, plus POSTs with `Test: true` on endpoints whose request schema documents a `Test` flag. `POST /class/substituteclassteacher` has no `Test` flag and was not called. Query arrays were sent as repeated keys (`collectionFormat: multi`), which is also how axios sends them from `fetchAllPages`.

Evidence below quotes the request (minus auth), the HTTP status and the response keys or a trimmed sample. Only IDs appear; no names, emails or phone numbers.

**Key probe facts used repeatedly.**

| Probe | Result |
|---|---|
| Unknown query parameters | Ignored silently on every endpoint tried, except `GET /site/resources` with `SessionTypeIds`, which returns HTTP 500 |
| Query parameter name casing | Case-insensitive (`ClassId` works for `request.classID`; `ClientIds` for `request.clientIDs`) |
| `Test: true` on `POST /client/addclient` | HTTP 400 `Test mode is not allowed for this endpoint. (InvalidParameter)` |
| Sandbox response models vs working-tree spec | Identical key sets for all 38 model samples captured, except `Program` (two extra keys) |

## B. All call sites

Verdict key: OK, CODE-BUG, SPEC-BUG, UNVERIFIED. "C-n" and "D-n" refer to entries in sections C and D.

| # | File:line | Method and path | Verdict | Notes |
|---|---|---|---|---|
| 1 | `src/api/auth.ts:45` | POST `/usertoken/issue` | OK | Body `Username`, `Password`; reads `AccessToken`, `Expires`. Sandbox 200. |
| 2 | `src/utils/siteTime.ts:57` (read by `src/tools/siteManagement.ts:33-57`) | GET `/site/sites` | CODE-BUG | Sends `SiteIds`; response `Sites` matches spec. `getSitesTool` reads `Currency`, `ESI`, `TotalLocations`; spec and sandbox have `CurrencyIsoCode` and neither of the others (C-26). |
| 3 | `src/tools/appointmentManagement.ts:50` | GET `/appointment/staffappointments` | CODE-BUG | Request OK (`ClientId` singular). Reads `Client`, `SessionType`, `Location` objects and `Confirmed`, none in spec or sandbox (C-1). Hidden cancelled appointments: D-4. |
| 4 | `src/tools/appointmentManagement.ts:124` | POST `/appointment/addappointment` | CODE-BUG | Body OK. Reads `Appointment.SessionType.Name` and `Appointment.Location.Name`, not in spec; always `''` (C-2). |
| 5 | `src/tools/appointmentManagement.ts:217` | POST `/appointment/updateappointment` | OK | Body OK (`ExecutePayment` no longer sent). Reads `Appointment.Id/Status/StartDateTime/EndDateTime/Staff`. Sandbox 200 with `Test: true`. |
| 6 | `src/tools/appointmentManagement.ts:379` | GET `/appointment/staffappointments` | OK | Cancellation lookup. Sends `AppointmentIds`, `ClientId`, dates; reads `Id`, `ClientId`, `StartDateTime`, `Status`. All in spec; `AppointmentIds` and `ClientId` filters verified to narrow results. |
| 7 | `src/tools/appointmentManagement.ts:422` | POST `/appointment/updateappointment` | OK | `Execute: cancel|latecancel`, `SendEmail`. In spec enum. |
| 8 | `src/tools/appointmentManagement.ts:483` | GET `/appointment/bookableitems` | OK | `SessionTypeIds` required and always sent. Reads `Availabilities` (spec key). Fallback reads (`ScheduledItemId`, `IsAvailable`, `IsSingleSessionBookable`) are not in spec but guarded by `??`. |
| 9 | `src/tools/appointmentManagement.ts:541` | GET `/appointment/activesessiontimes` | CODE-BUG | `Days` is not a spec parameter; sandbox ignores it (C-3). Response handling matches working-tree spec; committed spec lacks `SessionTypeActiveSessionTimes` (D-1). |
| 10 | `src/tools/appointmentManagement.ts:608` | GET `/appointment/scheduleitems` | CODE-BUG | `IgnorePrepFinishBuffer` is not in spec (`request.ignorePrepFinishTimes` is). Reads `IsAvailable`, `Unavailable`, `SessionType`, `Location` on `Appointment`, none in spec (C-4, C-5). |
| 11 | `src/tools/classManagement.ts:60` | GET `/class/classes` | CODE-BUG | Request OK. Reads `IsSubstitute`; spec and sandbox have `Substitute` (C-6). |
| 12 | `src/tools/classManagement.ts:121` | GET `/class/classdescriptions` | CODE-BUG | Reads `ImageUrl`; spec and sandbox have `ImageURL` (C-7). |
| 13 | `src/tools/classManagement.ts:156` | POST `/class/addclienttoclass` | CODE-BUG | Body OK. Reads `PaymentRequired` and `ServicePaymentInfo`, not in spec; sandbox `Test: true` response has only `Visit` (C-8). |
| 14 | `src/tools/classManagement.ts:193` | POST `/class/removeclientfromclass` | OK | `ClientId`, `ClassId`, `LateCancel` all in spec. |
| 15 | `src/tools/classManagement.ts:235` | GET `/class/waitlistentries` | CODE-BUG | Request names OK. Reads `ClassName`, `ClientId`, `ClientName`, `EnrollmentDatetime`, `RequestDatetime`, `Position`; spec has `ClassSchedule`, `Client`, `EnrollmentDateForward`, `RequestDateTime`, no position (C-9). Endpoint refuses a call with no filter (C-10). |
| 16 | `src/tools/classManagement.ts:281` | POST `/class/substituteclassteacher` | CODE-BUG | Sends `SubstituteStaffId` and `SubstituteStaffName`, not in spec; spec `StaffId` is the substitute, code sends the original teacher. Reads `Class.SubstituteTeacher`, not in spec (C-11). Static only; no `Test` flag (E-1). |
| 17 | `src/tools/classManagement.ts:334` | GET `/class/classschedules` | CODE-BUG | Reads `DayOfWeek`, `IsActive`; spec and sandbox have `DaySunday`..`DaySaturday`, `IsAvailable` (C-12). |
| 18 | `src/tools/classManagement.ts:404` | GET `/class/classvisits` | CODE-BUG | `ClassId` accepted for `request.classID` (verified). Reads `Visit.Client`, `FirstName`, `LastName`, `Email`, `Phone`, `Location` on each visit; `Visit` has only `ClientId`, `LocationId` (C-13). |
| 19 | `src/tools/clientManagement.ts:44` | GET `/client/clients` | CODE-BUG | `ClientIds` accepted for `request.clientIDs` (verified). Treats `LiabilityRelease` as an object; it is a boolean, the object is `Liability` (C-14). |
| 20 | `src/tools/clientManagement.ts:139` | POST `/client/addclient` | SPEC-BUG | Sends `BirthDate` (spec) plus `Birthday`, `Street`, `MobileNumber` (not in spec) as a workaround for the sandbox demanding `Birthday` (D-5). Not probeable: `Test` refused (E-2). |
| 21 | `src/tools/clientManagement.ts:210` | POST `/client/updateclient` | SPEC-BUG | Body shape OK (`Client` wrapper required, verified). `CrossRegionalUpdate: false` is required on `-99` (D-6). |
| 22 | `src/tools/clientManagement.ts:269` | GET `/client/clientvisits` | CODE-BUG | Reads `Location.Name` and `Staff.Name`; `Visit` has only `LocationId`, `StaffId`. Output is always `'Unknown'` (C-15). |
| 23 | `src/tools/clientManagement.ts:340` | GET `/client/activeclientmemberships` | CODE-BUG | `Program` is a `Program` object in spec and sandbox; the tool returns it in a field typed `string` (C-16). |
| 24 | `src/tools/clientManagement.ts:378` | POST `/client/addarrival` | OK | Body OK. Reads `ArrivalAdded` (spec) and `Message` (not in spec, guarded by fallback). Sandbox `Test: true` 200 `{ArrivalAdded, ClientService}`. |
| 25 | `src/tools/clientManagement.ts:411` | GET `/client/clientaccountbalances` | CODE-BUG | Reads `ClientCreditCards[]` with `Balance`; spec and sandbox have a single `ClientCreditCard` object with no balance (C-17). |
| 26 | `src/tools/clientManagement.ts:448` | GET `/client/clientcontracts` | CODE-BUG | Reads `Description`, `SoldDate`, `Balance`, `ContractType`; none in `ClientContract` (C-18). |
| 27 | `src/tools/enrollmentManagement.ts:74` | GET `/class/classes` | OK | `ClassIds`, dates, `HideCanceledClasses`; reads `Id`, `ClassScheduleId`, `ClassDescription.Program.ScheduleType`, `Staff`, `Location`. All in spec. |
| 28 | `src/tools/enrollmentManagement.ts:139` | GET `/enrollment/enrollments` | OK | Current version sends only spec filters and maps the `ClassSchedule` shape. (The earlier version sent `SemesterIds`/`CourseIds`, which the sandbox ignores, and read non-existent fields; superseded during this audit.) |
| 29 | `src/tools/enrollmentManagement.ts:225` | POST `/enrollment/addclienttoenrollment` | OK | `ClassScheduleId` singular, `EnrollDateForward`, `EnrollOpen`, `Test`. Sandbox `Test: true` 200 with a `ClassSchedule` body; the plural `ClassScheduleIds` form is refused with `MissingRequiredFields` (verified). |
| 30 | `src/tools/enrollmentManagement.ts:311` | GET `/client/clientschedule` | OK | `IncludeWaitlistEntries`; reads `VisitWithWaitlistInfo` fields and `WaitlistInfo.WaitlistId`. Sandbox keys match spec. |
| 31 | `src/tools/enrollmentManagement.ts:522` | GET `/client/clientschedule` | OK | Same as row 30. |
| 32 | `src/tools/enrollmentManagement.ts:563` | POST `/class/removeclientfromclass` | OK | Adds `VisitId`, `SendEmail`, `Test`; all in spec. |
| 33 | `src/tools/salesManagement.ts:32` | GET `/sale/services` | CODE-BUG | Request OK (`SessionTypeIds` plural filters; verified). Reads `SessionTypeId` and `Prerequisite`, not in `Service`; always undefined (C-19). Singular `SessionTypeId` ignored: D-7. |
| 34 | `src/tools/salesManagement.ts:88` | GET `/sale/packages` | CODE-BUG | `ClassScheduleId` not in spec; sandbox ignores it. Reads `Count`, `Price`, `OnlinePrice`, `TaxIncluded`, `Active`, `ProductId`; `Package` has none (C-20). |
| 35 | `src/tools/salesManagement.ts:146` | GET `/sale/products` | CODE-BUG | `CategoryIds` typed string in code, integer in spec (numeric strings work). Reads `Description`, `Category`, `Subcategory`, `SellOnline`; none in `Product` (C-21). |
| 36 | `src/tools/salesManagement.ts:334` | POST `/sale/checkoutshoppingcart` | CODE-BUG | Body OK. Reads `CartItems[].Name`, `UnitPrice`, `TaxAmount`, `Total`; `CartItem` has `Item`, `DiscountAmount`, `Quantity`, `Id`, `VisitIds`, `AppointmentIds`, `Appointments` (C-22). `Appointments` description vs type and empty reconciliation list: D-8. |
| 37 | `src/tools/salesManagement.ts:418` | POST `/sale/purchasecontract` | CODE-BUG | Body OK. Reads `response.ClientContract.*`; the spec response is flat (`ClientContractId`, `ContractId`, `Totals`, ...) (C-23). Runtime shape not probeable (E-3). |
| 38 | `src/tools/salesManagement.ts:482` | GET `/sale/contracts` | CODE-BUG | `request.locationId` is spec-required; code can omit it; sandbox 400 (C-24). Reads `ContractType`, `LocationId`, `AutopaySchedule.PaymentAmount`, `IntroOffer.{Id,Name,Price}`; `IntroOffer` is a string (C-25). |
| 39 | `src/tools/siteManagement.ts:119` | GET `/site/locations` | CODE-BUG | Reads `AdditionalImageURLs[].Id/Name` (they are strings) and `BusinessHours` (not in spec or sandbox) (C-27). |
| 40 | `src/tools/siteManagement.ts:176` | GET `/site/programs` | OK | Request and reads in spec. Sandbox adds undocumented `ScheduleOffset`, `ScheduleOffsetEnd` (D-3). |
| 41 | `src/tools/siteManagement.ts:214` | GET `/site/resources` | CODE-BUG | Sends `SessionTypeIds`, `LocationId`, `StartDateTime`, `EndDateTime`; spec has `locationIds`, `programIds`, `resourceIds`, `scheduleTypes`, `includeInactive`. `SessionTypeIds` makes the sandbox return HTTP 500 (C-28). Response untyped in spec (D-2). |
| 42 | `src/tools/siteManagement.ts:261` | GET `/site/sessiontypes` | CODE-BUG | `ProgramIds` accepted for `request.programIDs`. Reads `DefaultTimeLengthType`, not in spec or sandbox (C-29). |
| 43 | `src/tools/siteManagement.ts:325` | GET `/staff/staff` | CODE-BUG | Sends `SessionTypeIds`, `LocationIds` (plural); spec has singular `sessionTypeId`, `locationId`; sandbox ignores the plural forms. Reads `isMale`; spec has `IsMale` (C-30). |
| 44 | `src/tools/siteManagement.ts:373` | GET `/site/activationcode` | OK | Reads `ActivationCode`, `ActivationLink`. Sandbox 200, same keys. |
| 45 | `src/tools/teacherSchedule.ts:32` | GET `/staff/staff` | OK | No filters; reads `Name`, `FirstName`, `LastName`, `Id`, `Email`. |
| 46 | `src/tools/teacherSchedule.ts:83` | GET `/class/classes` | CODE-BUG | Same `IsSubstitute` read as row 11 (C-6). |

Tally: OK 16 (rows 1, 5, 6, 7, 8, 14, 24, 27, 28, 29, 30, 31, 32, 40, 44, 45), CODE-BUG 28, SPEC-BUG 2 (rows 20, 21), UNVERIFIED 0. Total 46.

## C. Code bugs

Each entry: the wrong field(s), the correct field(s), evidence, and a one-line fix. **Status:** every entry in this section was implemented on the branch that carries this document (`fix/sandbox-observed-behaviour`). The audit text below describes the pre-fix state it was written against, now committed as `97aa763`; the `file:line` pointers belong to that revision.

### C-1. `getStaffAppointments` reads client, session type and location objects that `Appointment` does not carry

- **File:** `src/tools/appointmentManagement.ts:63-85`
- **Wrong:** `apt.Client.FirstName/LastName/Email/MobilePhone`, `apt.SessionType.Name`, `apt.Location.Name`, `apt.Confirmed`
- **Correct:** `Appointment` (`#/definitions/Mindbody.PublicApi.Dto.Models.V6.Appointment`) has `ClientId`, `SessionTypeId`, `LocationId`, `StaffId`, `Staff`, `Status` and no `Confirmed`. Confirmation is `Status === 'Confirmed'`.
- **Evidence:** `GET /appointment/staffappointments?StartDate=-60d&EndDate=+60d&Limit=200&Offset=0` → 200. Row keys: `GenderPreference, Duration, ProviderId, Id, Status, StartDateTime, EndDateTime, Notes, StaffRequested, ProgramId, SessionTypeId, LocationId, StaffId, Staff, ClientId, FirstAppointment, IsWaitlist, WaitlistEntryId, ClientServiceId, Resources, AddOns, OnlineDescription`. `hasClientObj: false, hasSessionTypeObj: false, hasLocationObj: false, hasConfirmed: false`. A row with `Status: "Confirmed"` has no `Confirmed` key. Embedded `Staff` has only `Id, FirstName, LastName, DisplayName`.
- **Effect:** `clientName`, `clientEmail`, `clientPhone`, `confirmed` are always undefined; `sessionTypeName`, `locationName` are always `''`.
- **Fix:** Drop the object reads; derive `confirmed` from `Status`; resolve names through `/site/sessiontypes` and `/site/locations` (both cached) if names are wanted.

### C-2. `addAppointment` reads `SessionType.Name` and `Location.Name` from the returned appointment

- **File:** `src/tools/appointmentManagement.ts:146-147`
- **Wrong:** `response.Appointment.SessionType?.Name`, `response.Appointment.Location?.Name`
- **Correct:** `Appointment.SessionTypeId`, `Appointment.LocationId` (same model as C-1).
- **Evidence:** Same model keys as C-1; the sandbox `updateappointment` response (`Test: true`) returned the identical key set.
- **Fix:** Return the IDs, or look names up as in C-1.

### C-3. `getActiveSessionTimes` sends `Days`, which the API does not define

- **File:** `src/tools/appointmentManagement.ts:547`
- **Wrong:** `Days: days`
- **Correct:** `GET /appointment/activesessiontimes` accepts only `request.endTime, request.limit, request.offset, request.scheduleType, request.sessionTypeIds, request.startTime`.
- **Evidence:** `ScheduleType=All` → 200, `ActiveSessionTimes.length = 200`. `ScheduleType=All&Days=Monday` → 200, 200 rows. `ScheduleType=All&Days=Nonsense` → 200, 200 rows. The parameter changes nothing and is never rejected.
- **Fix:** Remove the `days` parameter from the tool and its MCP schema (`src/index.ts:678`), or filter client-side if day-of-week filtering is a real need.

### C-4. `getScheduleItems` sends `IgnorePrepFinishBuffer`; the spec parameter is `ignorePrepFinishTimes`

- **File:** `src/tools/appointmentManagement.ts:614`
- **Wrong:** `IgnorePrepFinishBuffer`
- **Correct:** `request.ignorePrepFinishTimes` (boolean)
- **Evidence:** Spec parameter list for the path. Sandbox accepts both names with 200 (unknown names are ignored), so the user's flag has no effect today.
- **Fix:** Rename the key to `IgnorePrepFinishTimes`.

### C-5. `getScheduleItems` reads availability fields and objects that `Appointment` does not have

- **File:** `src/tools/appointmentManagement.ts:619-633`
- **Wrong:** `apt.IsAvailable`, `apt.Unavailable`, `apt.SessionType?.Id/Name`, `apt.Location?.Id/Name`
- **Correct:** `GetScheduleItemsResponse.StaffMembers[]` is `Staff`, whose `Appointments[]` are `Appointment` (`SessionTypeId`, `LocationId`, `Status`), `Availabilities[]` are `Availability` and `Unavailabilities[]` are `Unavailability` (`Id, StartDateTime, EndDateTime, Description`).
- **Evidence:** `GET /appointment/scheduleitems?StaffIds=<30 appointment instructors>&StartDate=-30d&EndDate=+30d` → 200, 30 staff. First appointment keys as in C-1; `SessionType: undefined, SessionTypeId: 200, Location: undefined, LocationId: 1, Status: "NoShow"`. Availability keys: `Id, Staff, SessionType, Programs, StartDateTime, EndDateTime, BookableEndDateTime, Location, PrepTime, FinishTime, IsMasked, ShowPublic, ResourceAvailabilities`. Unavailability keys: `Id, StartDateTime, EndDateTime, Description`.
- **Effect:** `isAvailable`/`isUnavailable` are always undefined, names always undefined, and availability/unavailability blocks are dropped entirely.
- **Fix:** Emit three lists (appointments, availabilities, unavailabilities) using the spec field names.

### C-6. `getClasses` and `getTeacherSchedule` read `IsSubstitute`; the field is `Substitute`

- **Files:** `src/tools/classManagement.ts:78`, `src/tools/teacherSchedule.ts:96`, type in `src/types/mindbody.ts`
- **Wrong:** `cls.IsSubstitute`
- **Correct:** `Class.Substitute` (boolean)
- **Evidence:** `GET /class/classes` 200 rows over ±30 days: `anyIsSubstituteKey: false, anySubstituteKey: true, substituteTrueCount: 15`.
- **Fix:** Read `Substitute` and rename the TypeScript field.

### C-7. `getClassDescriptions` reads `ImageUrl`; the field is `ImageURL`

- **File:** `src/tools/classManagement.ts:129`
- **Evidence:** `GET /class/classdescriptions` → keys `Description, Id, ImageURL, LastUpdated, Level, Name, Notes, Prereq, Program, SessionType, Category, CategoryId, Subcategory, SubcategoryId`.
- **Fix:** Read `ImageURL`.

### C-8. `addClientToClass` reads `PaymentRequired` and `ServicePaymentInfo`, which the response does not contain

- **File:** `src/tools/classManagement.ts:170-171`
- **Correct:** `AddClientToClassResponse` has only `Visit` (`AddClientToClassVisit`).
- **Evidence:** `POST /class/addclienttoclass` `{ClientId, ClassId: 18223, RequirePayment: false, Waitlist: false, Test: true}` → 200, top keys `["Visit"]`, `hasPaymentRequired: false, hasServicePaymentInfo: false`.
- **Fix:** Remove `requiresPayment`/`amountDue` from the result, or derive them from `Visit.ServiceId == null`.

### C-9. `getWaitlistEntries` maps a flat shape that the API does not return

- **File:** `src/tools/classManagement.ts:244-253`
- **Wrong:** `ClassName`, `ClientId`, `ClientName`, `EnrollmentDatetime`, `RequestDatetime`, `Position`
- **Correct:** `WaitlistEntry` has `Id, ClassId, ClassDate, ClassSchedule (ClassSchedule), Client (Client), EnrollmentDateForward, RequestDateTime, VisitRefNo, Web`. There is no position field; `GET /client/clientschedule` exposes `WaitlistInfo.WaitlistOrderNumber` per client instead.
- **Evidence:** `GET /class/waitlistentries?ClassScheduleIds=<22 ids>` → 200, 21 entries. Entry keys exactly as the spec. Code-field probe on the first entry: `RequestDateTime` present, `ClassDate` present, `ClassId: 0`; `ClassName`, `ClientId`, `ClientName`, `EnrollmentDatetime`, `RequestDatetime`, `Position` all undefined.
- **Effect:** Six of eight output fields are always undefined.
- **Fix:** Map `entry.Client.Id`, `entry.Client.FirstName/LastName`, `entry.ClassSchedule.ClassDescription.Name`, `entry.RequestDateTime`, `entry.EnrollmentDateForward`; drop `position` or document it as unavailable here.

### C-10. `getWaitlistEntries` can send a request the API refuses

- **File:** `src/tools/classManagement.ts:233-242`
- **Problem:** All three filters are optional in the tool, but the endpoint requires at least one of `ClassScheduleIds, ClientIds, WaitlistEntryIds, ClassIds`.
- **Evidence:** `GET /class/waitlistentries?Limit=200&Offset=0` → 400 `At least one of the following parameters must be passed: ClassScheduleIds, ClientIds, WaitlistEntryIds, ClassIds (MissingRequiredFields)`.
- **Fix:** Validate that at least one filter is present before calling, and say so in the MCP schema.

### C-11. `substituteClassTeacher` sends a body the spec does not define and misassigns `StaffId`

- **File:** `src/tools/classManagement.ts:281-300`
- **Wrong:** `StaffId: originalTeacherId`, `SubstituteStaffId`, `SubstituteStaffName`; reads `response.Class.SubstituteTeacher`
- **Correct:** `SubstituteClassTeacherRequest` = `ClassId, StaffId, OverrideConflicts, SendClientEmail, SendOriginalTeacherEmail, SendSubstituteTeacherEmail`. `StaffId` is documented as "The staff ID of the teacher to substitute", i.e. the incoming teacher; the original is implied by the class. The response `SubstituteTeacherClass` has `Staff` and a boolean `Substitute`, no `SubstituteTeacher`.
- **Evidence:** Static (spec only). Not probed: the request has no `Test` flag and the call would write.
- **Effect:** As written the call either fails or substitutes the original teacher with themselves, and never reports the substitute's name.
- **Fix:** Send `{ClassId, StaffId: substituteTeacherId}`; read `Class.Staff` and `Class.Substitute`; drop the unused name parameter.

### C-12. `getClassSchedules` reads `DayOfWeek` and `IsActive`

- **File:** `src/tools/classManagement.ts:349,354`
- **Correct:** `ClassSchedule` has seven booleans `DaySunday`..`DaySaturday` and `IsAvailable`.
- **Evidence:** `GET /class/classschedules` → 200, keys `Classes, Clients, Course, SemesterId, IsAvailable, Id, ClassDescription, DaySunday, DayMonday, DayTuesday, DayWednesday, DayThursday, DayFriday, DaySaturday, AllowOpenEnrollment, AllowDateForwardEnrollment, StartTime, EndTime, StartDate, EndDate, Staff, Location, FrequencyType, FrequencyInterval`. Sample: `DayMonday: true, DaySunday: false, IsAvailable: false`.
- **Fix:** Build `days: string[]` from the seven flags (as `enrollmentManagement.ts:scheduledDays` already does) and expose `isAvailable`.

### C-13. `getClassVisits` reads client and location objects off each `Visit`

- **File:** `src/tools/classManagement.ts:420-438`
- **Wrong:** `visit.Client.*`, `visit.FirstName`, `visit.LastName`, `visit.Email`, `visit.Phone`, `visit.Location.*`, `visit.LocationName`
- **Correct:** `Visit` carries `ClientId`, `ClientUniqueId`, `ClientPhotoUrl`, `LocationId`, `StaffId`, `Service (ClientService)`, `ServiceId`, `ServiceName`.
- **Evidence:** `GET /class/classvisits?ClassId=17941` → 200, 4 visits. Visit keys match the spec `Visit` list exactly; `hasClientObj: false`, `Location: undefined`, `LocationId: 1`, `ServiceId: 100234199`.
- **Effect:** `clientFirstName`, `clientLastName` are always `''`; `clientEmail`, `clientPhone`, `locationName` always undefined.
- **Fix:** Return IDs only, or batch-resolve names with `/client/clients?ClientIds=...`.

### C-14. `getClients` treats `LiabilityRelease` as an object

- **File:** `src/tools/clientManagement.ts:68-71`
- **Wrong:** `client.LiabilityRelease.IsReleased`, `.AgreementDate`
- **Correct:** `LiabilityRelease` is a boolean; the object is `Liability { AgreementDate, IsReleased, ReleasedBy }`.
- **Evidence:** `GET /client/clients?Limit=50` → `liabilityReleaseTypes: ["boolean"]`, `liabilityObjKeys: ["AgreementDate","IsReleased","ReleasedBy"]`.
- **Effect:** `liability.isReleased` and `agreedDate` are undefined whenever the boolean is true, and the whole block is absent when it is false.
- **Fix:** Read `client.Liability`.

### C-15. `getClientVisits` reads `Location.Name` and `Staff.Name` from `Visit`

- **File:** `src/tools/clientManagement.ts:284-285`
- **Correct:** `Visit.LocationId`, `Visit.StaffId` only.
- **Evidence:** `GET /client/clientvisits?ClientId=<id>&StartDate=-365d&EndDate=today` → 200. Keys as spec; sample `LocationId: 1, StaffId: 100000296`; no `Location`/`Staff` keys.
- **Effect:** Every visit reports `location: 'Unknown'`, `instructor: 'Unknown'`, and the three summaries group everything under `Unknown`.
- **Fix:** Resolve IDs through the cached `/site/locations` and `/staff/staff` lists.

### C-16. `getClientMemberships` returns `Program` as if it were a string

- **File:** `src/tools/clientManagement.ts:355`
- **Correct:** `ClientMembership.Program` is a `Program` object.
- **Evidence:** `GET /client/activeclientmemberships?ClientId=<id>` → `programType: "object"` with keys `Id, Name, ScheduleType, ...`.
- **Fix:** Return `membership.Program?.Name` (and optionally the ID).

### C-17. `getClientAccountBalances` reads `ClientCreditCards[]` and `Balance`

- **File:** `src/tools/clientManagement.ts:419-423`
- **Correct:** `Client.ClientCreditCard` is a single `ClientCreditCard { Address, CardHolder, CardId, CardNumber, CardType, City, ExpMonth, ExpYear, LastFour, PostalCode, State }`. No balance per card exists in the spec.
- **Evidence:** `GET /client/clientaccountbalances?ClientIds=<id>` → 200, `hasClientCreditCards: false, hasClientCreditCard: true`.
- **Effect:** `creditCardBalances` is always `[]`.
- **Fix:** Return `accountBalance` plus the single stored card's `CardType`/`LastFour`; drop the per-card balance.

### C-18. `getClientContracts` reads fields that `ClientContract` does not have

- **File:** `src/tools/clientManagement.ts:453-464`
- **Wrong:** `Description`, `SoldDate`, `Balance`, `ContractType`
- **Correct:** `ClientContract` has `AgreementDate, AutoRenewClientContractID, AutoRenewing, AutopayStatus, ContractAutoRenewed, ContractID, ContractName, ContractText, EndDate, FirstAutoPay, Id, IsMonthToMonth, LastAutoPay, MinimumCommitmentEndDate, MinimumCommitmentUnit, MinimumCommitmentValue, NormalAutoPay, OriginationLocationId, PayerClientId, SiteId, StartDate, TerminationDate, UpcomingAutopayEvents`.
- **Evidence:** `GET /client/clientcontracts?ClientId=<id>` → 200, 1 contract, keys exactly as spec; `AgreementDate: "2026-10-04T00:00:00"`, `AutopayStatus: "Active"`.
- **Fix:** Map `AgreementDate` as the sold date, add `ContractID`, `AutoRenewing`, `IsMonthToMonth`, `TerminationDate`; drop the four phantom fields.

### C-19. `getServices` reads `SessionTypeId` and `Prerequisite`

- **File:** `src/tools/salesManagement.ts:51,57`
- **Correct:** `Service` has no per-service session type or prerequisite field. Session-type applicability is a request filter (`sessionTypeIds`).
- **Evidence:** `GET /sale/services` 21 rows: `hasSessionTypeId: false, hasPrerequisite: false`.
- **Fix:** Drop both output fields.

### C-20. `getPackages` sends an undefined filter and reads six phantom fields

- **File:** `src/tools/salesManagement.ts:91,99-105`
- **Wrong request:** `ClassScheduleId` (spec: `locationId, packageIds, sellOnline, limit, offset`).
- **Wrong reads:** `Count`, `Price`, `OnlinePrice`, `TaxIncluded`, `Active`, `ProductId`.
- **Correct:** `Package { DiscountPercentage, Id, Name, Products[], SellOnline, Services[] }`; prices and counts live on the nested `Services[]`/`Products[]`.
- **Evidence:** `GET /sale/packages` → keys `Id, Name, DiscountPercentage, SellOnline, Services, Products`. `ClassScheduleId=999999` still returns 1 package; `PackageIds=999999` returns 0.
- **Fix:** Replace `classScheduleId` with `packageIds`/`sellOnline`; compute `classCount`/`price` from `Services[]`.

### C-21. `getProducts` reads `Description`, `Category`, `Subcategory`, `SellOnline`

- **File:** `src/tools/salesManagement.ts:162-169`
- **Correct:** `Product` has `ShortDescription`, `LongDescription`, `CategoryId`, `SubCategoryId`, `SecondaryCategoryId`; no name fields for categories and no `SellOnline` flag on the row (it is a request filter).
- **Evidence:** `GET /sale/products` 41 rows: `hasDescription: false, hasCategory: false, hasSubcategory: false, hasSellOnline: false, hasShortDescription: true`. `CategoryIds` as `"32"` and as `32` both return 8 rows, so the string typing is tolerated.
- **Fix:** Map `ShortDescription`/`LongDescription`, `CategoryId`/`SubCategoryId`; type `categoryIds` as numbers; drop `sellOnline` from the row.

### C-22. `checkoutShoppingCart` reads item name and money fields that `CartItem` does not carry

- **File:** `src/tools/salesManagement.ts:352-361`
- **Wrong:** `item.Name`, `item.UnitPrice`, `item.TaxAmount`, `item.Total`
- **Correct:** `CompletedSale.CartItem { Item (ItemBase), DiscountAmount, Quantity, Id, VisitIds, AppointmentIds, Appointments }`. Name and price are on `Item` (`Item.Name`, `Item.Price`, `Item.OnlinePrice`, `Item.TaxRate`); the cart carries `SubTotal`, `TaxTotal`, `GrandTotal`.
- **Evidence:** `POST /sale/checkoutshoppingcart` `{ClientId, Test: true, Items: [{Item: {Type: 'Service', Metadata: {Id: '1403'}}, Quantity: 1}], Payments: [{Type: 'Comp', Metadata: {Amount: <price>}}], InStore: true, SendEmail: false}` → 200. `CartItems[0]` keys `Item, DiscountAmount, VisitIds, AppointmentIds, Appointments, Id, Quantity`; `Item` keys `Id, Name, Count, OnlinePrice, Price, TaxRate, ProductId, ProgramId, TaxIncluded`.
- **Fix:** Read `item.Item.Name`, `item.Item.Price`; compute line tax from `TaxRate` or omit; `total` from `Price * Quantity - DiscountAmount`.

### C-23. `purchaseContract` reads a `ClientContract` object that the response does not contain

- **File:** `src/tools/salesManagement.ts:431-438`
- **Correct:** `PurchaseContractResponse { ClientId, UniqueClientId, LocationId, ContractId, ClientContractId, Totals, PaymentProcessingFailures }`.
- **Evidence:** Static. The sandbox refuses the call before producing a body (`At least one of the following parameters must be passed: CreditCardInfo, StoredCardInfo, UseDirectDebit, UseAccountCredit`), see E-3.
- **Effect:** On a real success `response.ClientContract.Id` throws, the `catch` returns `success: false`, and the purchase is reported as failed although it committed.
- **Fix:** Read `ClientContractId`, `ContractId`, `Totals.{SubTotal,Tax,Total}`, `PaymentProcessingFailures`.

### C-24. `getContracts` can omit the required `LocationId`

- **File:** `src/tools/salesManagement.ts:483-487`; MCP schema makes `locationId` optional
- **Evidence:** `GET /sale/contracts?Limit=200&Offset=0` → 400 `LocationId is a required parameter. (MissingRequiredFields)`. With `LocationId=1` → 200, 11 contracts.
- **Fix:** Make `locationId` required in the tool and schema, or default it to the first location from the cached `/site/locations`.

### C-25. `getContracts` reads `ContractType`, `LocationId`, `AutopaySchedule.PaymentAmount` and treats `IntroOffer` as an object

- **File:** `src/tools/salesManagement.ts:498-510`
- **Correct:** `Contract` has no `ContractType` or `LocationId`; `AutopaySchedule { FrequencyType, FrequencyValue, FrequencyTimeUnit }`; `IntroOffer` is a string; the money fields are `FirstPaymentAmountTotal`, `RecurringPaymentAmountTotal`, `TotalContractAmountTotal`.
- **Evidence:** `GET /sale/contracts?LocationId=1` → `hasLocationId: false, contractTypeField: false`, `introOfferValues: ["None", "NewAndReturningConsumer"]`, `autopaySample: {FrequencyType: "SetNumberOfAutopays", FrequencyValue: 1, FrequencyTimeUnit: "Monthly"}`.
- **Fix:** Map `introOffer` as a string, `autopaySchedule` with the three real fields plus `RecurringPaymentAmountTotal`, and drop `contractType`/`locationId`.

### C-26. `getSites` reads `Currency`, `ESI`, `TotalLocations`

- **File:** `src/tools/siteManagement.ts:51-56`
- **Correct:** `Site.CurrencyIsoCode`; no `ESI` or `TotalLocations` in the spec.
- **Evidence:** `GET /site/sites` → site keys `AcceptsAmericanExpress, AcceptsDiscover, AcceptsMasterCard, AcceptsVisa, AllowsDashboardAccess, ContactEmail, Description, Id, LogoUrl, Name, PageColor1-4, PricingLevel, SmsPackageEnabled, TaxInclusivePrices, CurrencyIsoCode, CountryCode, TimeZone, AcceptsDirectDebit, LeadChannels, PerStaffPricing`. Sample `CurrencyIsoCode: "USD"`.
- **Fix:** Read `CurrencyIsoCode`; drop `esi`; compute `totalLocations` from `/site/locations` if needed.

### C-27. `getLocations` builds `facilities` from image URLs and reads a non-existent `BusinessHours`

- **File:** `src/tools/siteManagement.ts:119-132`
- **Correct:** `Location.AdditionalImageURLs` is `string[]`; `Amenities[]` is `{Id, Name}`; there is no business-hours field on `Location` in the spec (active hours come from `/appointment/activesessiontimes`).
- **Evidence:** `GET /site/locations` → `additionalImageURLsType: "string"`, `amenityKeys: ["Id","Name"]`, `hasBusinessHours: false`.
- **Effect:** `facilities` is a list of `{id: undefined, name: undefined}`; `businessHours` is always undefined.
- **Fix:** Expose `imageUrls: string[]`; drop `facilities` and `businessHours`.

### C-28. `getResources` sends four parameters the endpoint does not define; one of them crashes the sandbox

- **File:** `src/tools/siteManagement.ts:216-219`
- **Wrong:** `SessionTypeIds`, `LocationId`, `StartDateTime`, `EndDateTime`
- **Correct:** `request.includeInactive, request.locationIds, request.programIds, request.resourceIds, request.scheduleTypes, request.limit, request.offset`.
- **Evidence:** `GET /site/resources?SessionTypeIds=999&LocationId=999&...` → **500** `Something went wrong. Please try again. (Unknown)`. `SessionTypeIds=999` alone → 500. `LocationId=999` alone → 200 (2 rows, versus 8 unfiltered, so the sandbox appears to coerce `LocationId` into `locationIds`). Dates alone → 200, 8 rows (ignored). `LocationIds=999` (spec) → 200, 8 rows; `ResourceIds=<first id>` → 200, 8 rows. The spec filters did not narrow on `-99` either, see D-2.
- **Fix:** Send `LocationIds`, `ProgramIds`, `ResourceIds`, `ScheduleTypes`, `IncludeInactive`; remove session type and date filters from the tool.

### C-29. `getSessionTypes` reads `DefaultTimeLengthType`

- **File:** `src/tools/siteManagement.ts:273`
- **Correct:** `SessionType { AvailableForAddOn, Category, CategoryId, DefaultTimeLength, Id, Name, NumDeducted, OnlineDescription, ProgramId, ResourceRequired, StaffTimeLength, Subcategory, SubcategoryId, Type }`.
- **Evidence:** `GET /site/sessiontypes` → keys exactly as the spec; no `DefaultTimeLengthType`.
- **Fix:** Drop `defaultDurationType`; optionally add `staffTimeLength`, `resourceRequired`.

### C-30. `getStaff` sends plural location and session-type filters and reads `isMale`

- **File:** `src/tools/siteManagement.ts:327-331, 352`
- **Wrong:** `SessionTypeIds`, `LocationIds`, `member.isMale`
- **Correct:** `request.sessionTypeId` and `request.locationId` (singular; both require `startDateTime`), `Staff.IsMale`.
- **Evidence:** `GET /staff/staff?LocationIds=999&SessionTypeIds=999` → 200, 141 staff (all). `StaffIds=999` → 0. Staff keys contain `IsMale`, not `isMale` (`hasIsMale: true, has_isMale: false`).
- **Effect:** The two filters never narrow; `isMale` is always undefined.
- **Fix:** Accept single `locationId`/`sessionTypeId` with `startDateTime`, or filter client-side; read `IsMale`.

## D. Spec issues to raise with Mindbody

Each entry: endpoint, what the spec says (JSON pointer), what the sandbox does, impact, and a paragraph ready to send.

**Status:** every entry below was raised with Mindbody support by email on 2026-10-18. D-9 is recorded for completeness only and is not a report.

### D-1. `GET /appointment/activesessiontimes`: `SessionTypeActiveSessionTimes` missing from the published response schema

**Resolved in this repository.** The refreshed spec, now committed as `97aa763` and pinned in `docs/openapi.lock`, carries `SessionTypeActiveSessionTimes`. The finding remains valid against the older published Swagger document, so the write-up below is kept for that audience.

- **Spec:** The previously committed `docs/openapi.json` (`b1652cb0...`) defines `#/definitions/Mindbody.PublicApi.Dto.Models.V6.AppointmentController.GetActiveSessionTimesResponse` with only `PaginationResponse` and `ActiveSessionTimes: string[]`. The refresh adds `SessionTypeActiveSessionTimes: SessionTypeActiveSessionTimes[]` with the description "Omitted when `SessionTypeIds` is not supplied."
- **Sandbox:** `ScheduleType=All` → `{PaginationResponse, ActiveSessionTimes}` (216 strings, e.g. `"05:00:00"`). `SessionTypeIds=23,41` → `{PaginationResponse, ActiveSessionTimes, SessionTypeActiveSessionTimes: [{SessionTypeId: 23, ActiveSessionTimes: ["06:00:00", "06:30:00", ...]}, ...]}`. `ActiveSessionTimes` is an array of plain strings in both cases.
- **Impact:** Clients built from the older published spec cannot know the per-session-type grid exists. The code already handles both.
- **Write-up:** "GET /public/v6/appointment/activesessiontimes returns an undocumented top-level `SessionTypeActiveSessionTimes` array (`[{SessionTypeId, ActiveSessionTimes: string[]}]`) whenever `SessionTypeIds` is supplied. The Swagger document served for v6 defines `GetActiveSessionTimesResponse` with only `PaginationResponse` and `ActiveSessionTimes`. Please add the property and note that `ActiveSessionTimes` are `HH:MM:SS` strings, not objects."

### D-2. `GET /site/resources`: 200 response has no schema; filters do not narrow; unknown parameter crashes

- **Spec:** `#/paths/~1public~1v{version}~1site~1resources/get/responses/200/schema` is `{"type": "object"}`; no list key, no `Resource` model is referenced.
- **Sandbox:** Returns `{PaginationResponse, Resources: [{Id, Name}]}` (matches `ResourceSlim`). `LocationIds=999` and `ResourceIds=<existing id>` both return all 8 rows, so the documented filters do nothing on `-99`. An undocumented `SessionTypeIds` parameter produces HTTP 500 `Something went wrong. Please try again. (Unknown)`.
- **Impact:** Cannot validate the response against the spec; the pagination gate relies on an undocumented key.
- **Write-up:** "GET /public/v6/site/resources is documented with an untyped 200 body. The live response is `{ PaginationResponse, Resources: ResourceSlim[] }`. Please publish a `GetResourcesResponse` definition. Two further observations on the sandbox: the `request.locationIds` and `request.resourceIds` filters return the full list regardless of value, and passing an unrecognised query parameter named `SessionTypeIds` returns HTTP 500 rather than being ignored like every other unknown parameter."

### D-3. `Program` returns undocumented `ScheduleOffset` and `ScheduleOffsetEnd`

- **Spec:** `#/definitions/Mindbody.PublicApi.Dto.Models.V6.Program` has `CancelOffset, ContentFormats, Id, Name, PricingRelationships, ScheduleType`.
- **Sandbox:** `GET /site/programs` rows carry two extra keys, `ScheduleOffset` and `ScheduleOffsetEnd`.
- **Impact:** Low; strict validators flag the extra fields.
- **Write-up:** "GET /public/v6/site/programs returns `ScheduleOffset` and `ScheduleOffsetEnd` on each Program, neither of which is in the published `Program` definition. Please document them."

### D-4. `GET /appointment/staffappointments` never returns cancelled appointments

- **Spec:** `#/definitions/...Appointment/properties/Status/description` lists `Cancelled` and `LateCancelled` among the possible values. The endpoint description says only "Returns a list of appointments by staff member"; no filter on status is documented and no exclusion is mentioned.
- **Sandbox:** All 6,919 appointments in a ±730-day window were paged through: `NoShow 3375, Completed 1950, Arrived 418, Booked 1019, Confirmed 157`, zero `Cancelled`/`LateCancelled`. The repo's live tier, which cancels an appointment it just booked, records that the row is "no longer returned by getStaffAppointments" afterwards (`tests/live/README.md`, "Sandbox facts").
- **Impact:** Any read-back of a cancellation must treat "absent" as "cancelled". `cancelAppointmentsTool` already does.
- **Write-up:** "GET /public/v6/appointment/staffappointments omits appointments whose status is Cancelled or LateCancelled, although `Appointment.Status` documents both values and the endpoint documents no status filter or exclusion. After `POST /appointment/updateappointment` with `Execute: cancel` the appointment disappears from the list instead of being returned with `Status: Cancelled`. Please document this (or add a parameter to include cancelled rows)."

### D-5. `POST /client/addclient` demands `Birthday`, a field that is not in the request schema

- **Spec:** `#/definitions/...ClientController.AddClientRequest/required` is `["FirstName", "LastName"]`; the date-of-birth property is `BirthDate`.
- **Sandbox:** Could not be reproduced in this audit because `Test: true` is refused on this endpoint (`Test mode is not allowed for this endpoint. (InvalidParameter)`). The repo's authenticated live run on `-99` recorded `The following are required: Birthday (Code: MissingRequiredFields)` when no date of birth was sent (`tests/live/mindbody-live.e2e.ts:883`, `tests/live/README.md:312`).
- **Impact:** Environment-specific (a site setting). The error names `Birthday`, a field that does not exist in the schema; the code sends both `BirthDate` and `Birthday` to be safe.
- **Write-up:** "On site -99, POST /public/v6/client/addclient without a date of birth answers `The following are required: Birthday (MissingRequiredFields)`. The published `AddClientRequest` has no `Birthday` property (the field is `BirthDate`) and lists only `FirstName` and `LastName` as required. Please align the validation message with the schema field name, and document that required client fields are site-configurable. Separately, `Test: true` is rejected on this endpoint although `AddClientRequest.Test` is documented."

### D-6. `POST /client/updateclient` fails by default on a single-site subscriber

- **Spec:** `#/definitions/...ClientController.UpdateClientRequest/properties/CrossRegionalUpdate`: "When `true`, the updated information is propagated to all of the region's sites ... If the subscriber belongs to a region that is not enabled ... the request is handled as a single-site update" (no default stated; the sandbox treats it as `true`).
- **Sandbox:** `{Client: {Id, FirstName}, Test: true}` → 400 `The current site does not belong to a region. If you are attempting to update a client at a single site, set CrossRegionalUpdate to false. (ValidationFailed)`. Same body with `CrossRegionalUpdate: false` → 200 `{Client}`. Top-level fields without the `Client` wrapper → 400 `Client (MissingRequiredFields)`.
- **Impact:** Every caller that follows the schema literally fails on a non-regional site. The code sends `false`.
- **Write-up:** "POST /public/v6/client/updateclient rejects requests from a site that is not in a region unless `CrossRegionalUpdate: false` is sent explicitly, with `The current site does not belong to a region`. The documentation for `CrossRegionalUpdate` says a non-enabled region falls back to a single-site update and states no default. Please default the flag to `false` for non-regional sites, or document that it must be sent."

### D-7. `GET /sale/services`: singular `SessionTypeId` is silently ignored

- **Spec:** The documented filter is `request.sessionTypeIds` (array). No singular form exists.
- **Sandbox:** Unfiltered → 21 services. `SessionTypeId=23` → 21 (ignored). `SessionTypeIds=23` → 1 (`"1395"`). Same behaviour everywhere: unknown query names are dropped without error.
- **Impact:** A typo in a filter name returns the full list with HTTP 200. Not strictly a spec defect; worth a note in the developer guide.
- **Write-up:** "Unknown query parameters are silently ignored across the v6 API (e.g. `SessionTypeId` on GET /sale/services returns the unfiltered list). Consider rejecting unrecognised parameters, or documenting this behaviour, since a mis-cased or mis-pluralised filter currently degrades to a full-table read with a 200."

### D-8. `CheckoutShoppingCart`: `CartItem.Appointments` description contradicts its type, and reconciliation lists come back empty

- **Spec:** `#/definitions/...SaleController.CompletedSale.CartItem/properties/Appointments` is described as "The IDs of the appointments that were reconciled by this cart item" but typed `array` of `#/definitions/...Appointment`. A sibling `AppointmentIds` ("Gets or sets the item.") also exists.
- **Sandbox:** `Test: true` checkout without `AppointmentIds` → `Appointments: [], AppointmentIds: [], VisitIds: []`. The repo's financial live run (`tests/live/README.md`, "A reconciling checkout is accepted" and "Latest financial run") sent a real `AppointmentIds: [<booked id>]`, the sale committed and the appointment read back as `Completed`, yet `CartItems[].Appointments`, `CartItems[].AppointmentIds` and the top-level `Appointments` were all empty.
- **Impact:** The response gives no confirmation of which appointment a sale reconciled; callers must re-read the appointment.
- **Write-up:** "In `CheckoutShoppingCartResponse`, `CartItem.Appointments` is documented as a list of IDs but typed as `Appointment[]`, and `CartItem.AppointmentIds` has the placeholder description 'Gets or sets the item.' On site -99 a committed sale with `AppointmentIds: [<id>]` reconciles the appointment (it reads back as Completed) but both lists and the top-level `Appointments` array are returned empty. Please fix the descriptions and populate the reconciliation lists."

### D-9. `GET /client/clientenrollments` does not exist

- **Spec:** No such path. The enrollment client view is `GET /client/clientschedule` (`VisitWithWaitlistInfo[]`).
- **Sandbox:** `GET /public/v6/client/clientenrollments` → HTTP 404 with an HTML body.
- **Impact:** Earlier versions of this server called the path; the current code reads `/client/clientschedule`. Nothing to raise with Mindbody beyond confirming that no enrollment-specific client endpoint is planned.

### D-10. `POST /client/addclient` and `POST /sale/purchasecontract` cannot be exercised in Test mode

- **Spec:** Both request definitions document `Test: boolean` ("input information is validated, but not committed").
- **Sandbox:** `addclient` with `Test: true` → 400 `Test mode is not allowed for this endpoint. (InvalidParameter)`. `purchasecontract` with `Test: true` and no card → 400 `At least one of the following parameters must be passed: CreditCardInfo, StoredCardInfo, UseDirectDebit, UseAccountCredit`, so validation-only runs need payment details the sandbox cannot supply.
- **Write-up:** "`AddClientRequest.Test` is documented but the endpoint answers `Test mode is not allowed for this endpoint`. Please either honour the flag or remove it from the schema. For `PurchaseContractRequest`, a `Test: true` request still requires a payment instrument, which makes dry-run validation impossible on the sandbox; a sandbox-only payment method or a relaxed Test path would help."

## F. Follow-ups found after this audit (not fixed here)

### F-1. `nextjs-app/` reads the same phantom fields section C fixed in `src/`

**File:** `nextjs-app/src/lib/mindbody/service.ts`

The audit's scope was the 46 call sites in `src/**/*.ts`. The Next.js app is a
second, independent Mindbody client in this repository that was not in that
scope, and it still reads fields section C established do not exist:

| Reads | Spec field | Same defect as |
|---|---|---|
| `c.LiabilityRelease.IsReleased` / `.AgreementDate` | `c.Liability`; `LiabilityRelease` is a boolean | C-14 |
| `client?.ClientCreditCards` | `client.ClientCreditCard`, a single object | C-17 |
| `ImageUrl` | `ImageURL` | C-7 |
| `c.IsSubstitute` | `c.Substitute` | C-6 |
| `isMale` | `IsMale` | C-30 |
| `IntroOffer.Id` / `.Name` / `.Price` | `IntroOffer` is a string | C-25 |

**Why it is recorded rather than fixed.** The same shapes are consumed
downstream: `nextjs-app/src/lib/sync/index.ts` and the Prisma schema depend on
them, and Gates 14 and 15 type-check and build that app. Changing them is a
migration with its own test surface, not a mechanical field rename, and it
deserves its own change rather than landing silently inside a fix to `src/`.

**Consequence if unfixed.** The Next.js app renders the same always-empty
fields this audit removed from the MCP server. Both code bases are wrong in the
same way, so a fix applied to one should be applied to the other.

## E. Unverified items

| # | Item | Why it could not be verified |
|---|---|---|
| E-1 | `POST /class/substituteclassteacher` request semantics (C-11): whether `StaffId` is the incoming substitute, and the real response shape | The request has no `Test` flag, so any call would write to the sandbox. Finding is static against the spec only. |
| E-2 | `POST /client/addclient` requiring `Birthday` (D-5) and whether `Street`/`MobileNumber` are needed | `Test: true` is refused on the endpoint; a real call would create a client. Evidence is the repo's recorded live run, not this audit. |
| E-3 | `POST /sale/purchasecontract` runtime response shape (C-23) | The sandbox rejects the call before producing a body unless a payment instrument is supplied. The code bug is certain from the spec; its runtime symptom is inferred. |
| E-4 | Whether `GET /appointment/staffappointments` can ever return `Cancelled`/`LateCancelled` rows (D-4) | Only absence was observed (6,919 rows, none cancelled; live tier saw a just-cancelled row vanish). Proving the negative needs a write. |
| E-5 | `GET /site/resources` documented filters (`locationIds`, `resourceIds`) narrowing on a real site | On `-99` they returned the full list; the sandbox may simply have every resource at every location. Not a code defect either way. |

Also not probed, by design: `POST /class/substituteclassteacher` (no Test flag), `POST /appointment/addappointment` (would need a bookable slot; the live tier covers it), and any call without `Test: true` on an endpoint that writes.
