# Write to observed Mindbody sandbox behaviour where it differs from the spec

## Status

Accepted. Recording date 2026-10-17.

## Context

`docs/openapi.json` is the Mindbody v6 Swagger 2.0 export this project is
written against, and `docs/openapi.lock` pins its SHA-256 so it cannot drift
quietly. It is a good specification and this project follows it almost
everywhere. It is also not always what the API does.

A read-only audit of all 46 API call sites in `src/**/*.ts` compared each one
against the specification and against the real `-99` sandbox. The result is
recorded in full in
[`docs/mindbody-spec-discrepancies.md`](../mindbody-spec-discrepancies.md).
Two findings came out of it that force a decision here.

**First, the sandbox mostly agrees with the spec.** Every response model
probed — 38 of them — returned the same key set the specification documents,
with one exception (`Program` carries two extra keys). So "follow the spec" is
also "follow the sandbox", and the spec is the right default. This decision is
about the minority of cases, not a licence to guess.

**Second, where the two disagree, the sandbox wins.** The published
specification is a document. The API is the thing that has to work, and the
only way to find out what it accepts is to call it. So a divergence that the
sandbox demonstrates gets accommodated in code, and gets written down so that
the accommodation reads as a decision rather than as a bug.

The uncomfortable consequence is that some of these accommodations are ugly.
`POST /client/addclient` on site `-99` demands a `Birthday` field that its own
request schema does not define, so the code sends both `BirthDate` and
`Birthday`. `GET /site/resources` returns HTTP 500 for an unknown query
parameter that every other endpoint in the API ignores. Neither can be fixed
from this side, only survived and documented.

## Decision

**Where the specification and the sandbox disagree, the sandbox is the source
of truth, and the divergence is recorded in all three places below. Nothing
else is left to judgement.**

Every deliberate accommodation is marked at its call site with a comment whose
first line is exactly:

```
// SANDBOX-OBSERVED (differs from spec): <one line of reason>
```

followed by one more line naming the section of
`docs/mindbody-spec-discrepancies.md` that holds the evidence. Two comment
lines, no more. The marker is fixed text so that a reader — or a grep — can
find every one of them without knowing what to look for.

It also appears in a *Deliberate deviations from the spec* section in
[`docs/API.md`](../API.md), naming the endpoint, what the specification says,
what the sandbox does, and what the code does about it.

And it appears in the deviations table below.

### The rule for adding a new one

A deviation may be added only when all of the following hold.

1. **The specification and the sandbox genuinely disagree.** Not "the
   specification is silent" and not "the specification is inconvenient". If the
   specification is silent, follow it and say nothing.
2. **There is captured evidence**, with the request, the HTTP status, and the
   response, recorded in `docs/mindbody-spec-discrepancies.md`. A belief about
   what the API probably does is not evidence.
3. **The sandbox is the only authority.** Not the documentation site, not a
   forum post, not a previous version of this code.
4. **The accommodation is load-bearing**, meaning the call fails or silently
   does the wrong thing without it. A workaround for a problem that does not
   occur is not an accommodation; it is noise.
5. **All three records above are updated in the same change.** A deviation in
   code that is not in this ADR and in `API.md` is a defect, not a shortcut.

A write that cannot be probed without creating a real record — and there are
two, `POST /class/substituteclassteacher` and `POST /sale/purchasecontract` —
is aligned to the specification and marked at the call site with a
`// SPEC-ALIGNED BUT UNVERIFIED:` comment instead. That marker is a different
claim and a weaker one: it says the shape is the specification's, not that it
was observed. It never gets added to the table below, because the table is a
record of what the API was seen to do.

### The converse: what the sandbox does not get to change

The sandbox does not get to invent response fields. Eleven read tools used to
map fields that exist in neither the specification nor the sandbox, so their
output was always empty — a waitlist queue position, a package price, a
client-visit instructor name. Inventing a field to fill that gap would be the
same error in the opposite direction. Where such a field can be recovered it is
resolved through one of three endpoints the project already reads and caches
(`/site/locations`, `/staff/staff`, `/site/sessiontypes`); where it cannot, the
field is dropped and the tool's own documentation says so in plain words. A
field that renders as `''` or `"Unknown"` without saying why is a defect under
this decision too.

## Deviations

Eight deviations are recorded. Sections D-1, D-2, D-4, D-5, D-6, D-8 and D-10
of the reconciliation carry call-site comments in code.

| # | Endpoint | The specification says | The sandbox does | The code does |
|---|---|---|---|---|
| D-1 | `GET /appointment/activesessiontimes` | `GetActiveSessionTimesResponse` documents `PaginationResponse`, `ActiveSessionTimes: string[]` and `SessionTypeActiveSessionTimes`, the last described as "omitted when `SessionTypeIds` is not supplied". | Matches: the array is present with `SessionTypeIds` and absent without it. The types are plain `HH:MM:SS` strings, which the schema does not say. | Handles both shapes and merges the per-session-type grid across pages, because a field documented as conditionally omitted is simply absent on half of all calls. Marked at the call site. |
| D-2 | `GET /site/resources` | The 200 body is typed `{"type": "object"}`. No `Resource` model is referenced, so there is no documented list key. | Returns `{PaginationResponse, Resources: [{Id, Name}]}`. The documented `locationIds` and `resourceIds` filters return the full list on `-99`. An unrecognised `SessionTypeIds` returns HTTP 500 instead of being ignored. | Sends only documented parameters, reads the undocumented `Resources` key, and says so at the call site and in `API.md`. |
| D-4 | `GET /appointment/staffappointments` | `Appointment.Status` documents `Cancelled` and `LateCancelled`, and no filter or exclusion is documented. | Never returns either status. All 6,919 rows paged through a ±730-day window were `NoShow`, `Completed`, `Arrived`, `Booked` or `Confirmed`; a just-cancelled appointment simply disappears. | Treats absence as cancelled. `cancelAppointments` already verifies against the list, so an absent row is the expected result of a cancellation. Marked at the call site. |
| D-5 | `POST /client/addclient` | `AddClientRequest` requires only `FirstName` and `LastName`, and its date-of-birth field is `BirthDate`. There is no `Birthday`. | Answers `The following are required: Birthday (Code: MissingRequiredFields)` when no date of birth is sent. Required fields are site-configurable. | Sends `BirthDate` and `Birthday`, plus the undocumented aliases `Street` and `MobileNumber`. Marked at the call site. Not independently re-probed; the evidence is the repository's recorded live run, and see D-10 for why it cannot be probed here. |
| D-6 | `POST /client/updateclient` | `CrossRegionalUpdate` is documented as propagating to every site in the region and as falling back to a single-site update for a region that is not enabled. No default is stated. | Defaults to true and answers HTTP 400 `The current site does not belong to a region. If you are attempting to update a client at a single site, set CrossRegionalUpdate to false. (ValidationFailed)`. With `false` it returns 200. | Always sends `CrossRegionalUpdate: false`. Marked at the call site. |
| D-8 | `POST /sale/checkoutshoppingcart` | `CartItem.Appointments` is described as "the IDs of the appointments that were reconciled by this cart item" but typed as `Appointment[]`. A sibling `AppointmentIds` carries the placeholder description "Gets or sets the item." | A committed sale that sent `AppointmentIds: [<id>]` reconciled the appointment — it read back `Completed` — yet returned `CartItems[].Appointments`, `CartItems[].AppointmentIds` and the top-level `Appointments` all empty. | Accepts both shapes of `Appointments`, and states at the call site and in the tool's documentation that an absent reconciliation list does not mean the sale failed. The caller must re-read the appointment to confirm. |
| D-10 | `POST /client/addclient` and `POST /sale/purchasecontract` | Both request definitions document `Test: boolean`, meaning "input information is validated, but not committed". | `addclient` with `Test: true` answers HTTP 400 `Test mode is not allowed for this endpoint. (InvalidParameter)`. `purchasecontract` with `Test: true` and no card answers HTTP 400 demanding a payment instrument, so validation-only runs need payment details the sandbox cannot supply. | Sends no `Test` flag to either, and says at the call site and in the tool's documentation that these tools always commit. There is no dry-run mode on either endpoint. |

## Consequences

**The sandbox becomes a dependency of the build.** A deviation is only as good
as the observation behind it, and observations age. Nothing here is
re-verified automatically. When Mindbody ships a spec that matches the
behaviour, the accommodation should come out — and the rule above is what
makes that a five-minute job, because each one is a comment, a table row, and
a parameter in a single known file.

**Some tools have no dry run.** D-10 means `addClient` always creates a real
client. That is already true of the financial endpoints, and it is recorded as
a product limitation in
[`docs/quality-gates.md`](../quality-gates.md).

**The specification is still the default.** This decision does not loosen
anything for the other 38 response models that matched. Code that sends an
undocumented parameter with no evidence attached is still a bug, and
`tests/spec-validating-client.ts` still fails it.

**The cost is visible duplication.** Sending `BirthDate` and `Birthday`
together is the kind of line that invites a well-meaning cleanup. The ADR is
what protects it, and it is why the deviation table above exists rather than a
comment in a pull request.

## When this changes

This decision stops being right if one of three things happens.

**Mindbody publishes schemas that match the observed behaviour.** Then the
deviations are no longer deviations. Remove each one from the table, delete its
call-site comment, drop its `API.md` entry, and let the specification be the
only description — in that order, so no record of why it was there is lost
while it is still there.

**A production site behaves differently from the sandbox.** D-5 is already
known to be environment-specific: the `Birthday` requirement is a site setting,
not an API rule. If another site in a region does not require it, the
accommodation is a sandbox workaround wearing a general rule's clothes, and it
should be scoped to the site rather than sent unconditionally. Until then it is
sent unconditionally, because the code cannot know which kind of site it is
talking to without another request.

**The evidence goes stale without anyone noticing.** The reconciliation is a
point-in-time audit with a date on it. If the sandbox is ever upgraded and the
findings are not re-run, the table below becomes folklore. Re-running the audit
against `docs/openapi.json` and the live sandbox is what keeps this decision
honest, and it is the reason the deviations table names its evidence
sections rather than restating them.
