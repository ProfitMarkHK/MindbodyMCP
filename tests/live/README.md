# Live end-to-end tier (opt-in)

A second, opt-in acceptance tier that runs the MCP server against a **real
Mindbody environment**. It is opt-in as a whole: it runs only when `MINDBODY_TEST_*`
credentials are configured (see Configuration). Every run writes real records to the
`-99` sandbox, including one comp-paid sale. It exists to catch the class of bug the hermetic tier
structurally cannot: "the code is correct against our stub and wrong against
Mindbody."

The hermetic tier (`tests/e2e-mcp-server.test.ts`) proves transport wiring,
tool registration and payload transformation against a local stub. This tier
proves the same wiring against the actual API, and therefore also proves the
credentials, the SiteId and the IP allow-list are set up correctly.

## It is NOT part of `bun test`

The file is `mindbody-live.e2e.ts`. Bun auto-collects `*.test.ts`, `*_test.ts`,
`*.spec.ts` and `*_spec.ts`; `.e2e.ts` matches none of them, so a bare
`bun test` ignores this directory entirely. That is deliberate — this tier needs
credentials, writes records and talks to a rate-limited third party.

Run it deliberately, through the wrapper (see below):

```bash
scripts/live-e2e.sh
```

## Supplying the credentials — `scripts/live-e2e.sh`

The repo's `.env` holds a real business site and must never be reused for this
tier, so the `MINDBODY_TEST_*` values have to be entered by hand. The project's
secrets protocol is that the owner enters every secret, through a reviewed
script that prompts with no echo, and that no agent ever passes a secret in a
command-line argument. `scripts/live-e2e.sh` is that script.

```bash
scripts/live-e2e.sh                 # prompt for whatever is missing, then run
scripts/live-e2e.sh --save          # same, and remember them OUTSIDE the repo
scripts/live-e2e.sh --no-load       # ignore the saved file and prompt again
scripts/live-e2e.sh --help
```

What it guarantees:

- Each value is read with `read -r -s` — terminal echo off, nothing typed is
  shown or recorded on screen.
- **No value is ever printed.** Not truncated, not length-prefixed, not
  masked-with-a-prefix. Only variable *names* and the words `set` / `not set`
  reach the terminal.
- Values reach `bun` through the exported environment only. They are never
  command-line arguments, so they cannot appear in `ps`, in a process listing
  or in shell history.
- An `EXIT` trap unsets them, so Ctrl-C or a failure leaves nothing behind.
- **Nothing is written inside the repository.** `--save` is opt-in, writes one
  file at mode `600` under `~/.config` (`mindbody-live-e2e.env`), and is refused
  outright if that path resolves inside the repo. `.env` is never a target —
  the script exits with an error if asked to use it.
- It fails closed rather than hanging: with values missing and no terminal to
  read from, it exits `2` immediately, with instructions for the non-interactive
  form.

Fully non-interactive — for CI, or for a caller that already holds the values:

```bash
MINDBODY_TEST_API_KEY=… MINDBODY_TEST_SOURCE_NAME=… \
MINDBODY_TEST_SOURCE_PASSWORD=… scripts/live-e2e.sh
```

Values already in the environment are used as-is and never re-prompted. The
script exits with the live tier's own exit code.

## Configuration

All credentials are read from a **separate namespace**, never from `MINDBODY_*`:

| Variable | Required | Meaning |
|---|---|---|
| `MINDBODY_TEST_API_KEY` | yes | Sandbox API key |
| `MINDBODY_TEST_SOURCE_NAME` | yes | Source name for the user-token flow |
| `MINDBODY_TEST_SOURCE_PASSWORD` | yes | Source password |
| `MINDBODY_TEST_SITE_ID` | no | Defaults to `-99`, the sandbox. **Any other value is refused.** |
| `MINDBODY_TEST_API_URL` | no | Defaults to `https://api.mindbodyonline.com/public/v6` |
| `SKIP_LIVE_E2E` | no | Explicit opt-out |

### Why a separate namespace

The repo's own `.env` points at a **real business site**, and `bunfig.toml` sets
`dotenv = true`, so `bunfig.toml` has already loaded those production
credentials into `process.env` by the time any test runs. If this tier inherited
them it would create clients and appointments inside somebody's live account on
the first run anyone made. A separate namespace makes that impossible rather
than merely unlikely.

Put the live credentials in your shell environment or a gitignored file; do not
add them to the repo `.env` alongside the production ones. `.env.example` lists
the names as **commented-out, empty** entries for that reason, and never a
value.

### Required Mindbody parameters are discovered, never hardcoded

Two endpoints this tier calls declare a required parameter beyond the site id,
and answer HTTP 400 with e.g. `LocationId is a required parameter.` when it is
missing:

| Endpoint | Required parameter | Supplied from |
|---|---|---|
| `GET /sale/contracts` | `LocationId` | `getLocations` (every location is tried) |
| `GET /appointment/bookableitems` | `SessionTypeIds` | `getSessionTypes`, filtered to the `Appointment` types (first 15) |

Both are derived **at run time** from this environment. A literal id seen in one
probe would be meaningless in another Mindbody environment — `-99` is shared
and resettable — so none is hardcoded anywhere in the suite.

If a discovery read fails, the dependent test does **not** send the request with
a null: it prints a `LIVE SKIP (loud)` block naming the value it lacked and why,
and `afterAll` prints a `LIVE E2E INCOMPLETE` summary listing every test that
did not run. Bun counts such an early return as a pass, which is precisely why
that summary exists — **read it before trusting a green run.** The discovery
failure that caused it is itself a red test in the same run.

### SiteId guard

`MINDBODY_TEST_SITE_ID` is never allowed to be anything but `-99`. This tier
writes records, so a SiteId pointing at a live business is a **refusal**, not a
skip — it surfaces as a failing suite with the reason attached, because a
silently-skipped misconfiguration looks identical to a green run.

## Skip vs fail

There are exactly **two** automatic skips, and both are statements about the
machine rather than about the code:

1. `SKIP_LIVE_E2E` is set.
2. No `MINDBODY_TEST_*` credentials are configured.

Everything else fails. Specifically: a SiteId that is not the sandbox, HTTP 403
(the sandbox's IP allow-list), HTTP 404, HTTP 5xx, and any unexpected payload all
**fail the suite**. There is no "network is down, never mind" escape hatch,
because a gate that goes quietly green while testing nothing is worse than no
gate.

A banner is printed before any test runs stating the decision, the run token and
what the run writes — so "skipped" and "passed" are never
indistinguishable in a CI log.

## What it covers

| Area | Tests | Writes |
|---|---|---|
| Configuration | sandbox SiteId, no credential inheritance, STDIO + MCP handshake, host reachability | — |
| User token | `POST /usertoken/issue` outcome, token attached; a refused token fails closed (no API-key-only requests) | — |
| Clients | `getClients` | `addClient`, read-back, cleanup |
| Service definitions | `getSites` (site time zone), `getServices`, `getSessionTypes`, `getLocations`, `getStaff` | — |
| Orders | `getPackages`, `getProducts`, `getContracts` | — |
| Appointments | `getBookableItems`, `getStaffAppointments`, `getServices` filtered to the booked session type | `addAppointment`, reschedule, arrive, read-back, cancel (or LEFTOVER re-note) |
| Cancellation guards | `cancelAppointments` refusals (read-only when the guards hold) | — |
| Appointment checkout | — | `checkoutShoppingCart` with `AppointmentIds` and a Comp payment; runs by default, leaves one comp-paid sale |
| Contract purchase | `getContracts` (walked until one is purchasable), `getClientContracts` (read-back) | `purchaseContract` funded by account credit; runs by default, leaves one active ClientContract |

`addClientArrival` (`POST /client/addarrival`) is deliberately **not** in the
suite. It is a client-account check-in that consumes a paid visit, so the
sandbox refuses it for a fresh client, and it is not part of the salon
workflow: arrival there is marked on the appointment, by
`updateAppointment` with `execute: 'arrive'`, which is covered.

Mindbody endpoints the appointment lifecycle reaches through the MCP tools:

| MCP tool call | Mindbody endpoint | What it proves |
|---|---|---|
| `updateAppointment({ appointmentId, startDateTime })` | `POST /appointment/updateappointment` with `StartDateTime` | Reschedule persists: the read-back start time moved to the second slot |
| `updateAppointment({ appointmentId, execute: 'arrive' })` | `POST /appointment/updateappointment` with `Execute: arrive` | Appointment-level arrival: read-back status is `Arrived` |
| `cancelAppointments` with 4 ids, or another client's id | none — refused before any write | The count and ownership guards hold against real data; the appointment still reads back un-cancelled |
| `cancelAppointments({ clientId, appointmentIds: [id] })` | `GET /appointment/staffappointments`, then `POST /appointment/updateappointment` with `Execute: cancel` | The guarded happy path, used as cleanup when the appointment was not checked out (a Completed one is refused; see Cleanup); the appointment is returned before the cancel, and afterwards is either returned as `Cancelled`/`LateCancelled` or no longer returned (see "Sandbox facts") |
| `getServices({ sessionTypeIds: [booked type], locationId })` | `GET /sale/services` with `SessionTypeIds` and `LocationId` | Finds the pricing option that can pay for the booked appointment |
| `checkoutShoppingCart` item with that service and `appointmentIds: [id]`, Comp payment, `inStore: true` | `POST /sale/checkoutshoppingcart` with `AppointmentIds` on the cart item | The sale reconciles the booked appointment (runs by default); the appointment is read back and its status reported |

### Appointment lifecycle order

The salon/spa lifecycle runs on a single appointment, in this order. Bun runs
the tests in a file in declaration order across `describe` blocks, so the order
is fixed by the file layout.

1. `getBookableItems` is called once across the Appointment-type session
   types, with no staff or location filter, over a window starting two
   site-local days out. Each returned availability window becomes a booking
   candidate (distinct staff / session type / location), whose start is the
   first **active session time** inside the window at which the session still
   fits, plus a reschedule target: a valid start in a later window for the same
   staff, session type and location.
2. `addAppointment` books the first candidate for the client this run created.
   Exactly two Mindbody refusals move on to the next candidate, because
   availability cannot predict them: `InvalidBookingTime` and "The staff member
   is not an instructor for the requested service". Neither writes anything;
   every other refusal fails the test.
   Straight after, `getServices` is called with the BOOKED session type and
   location to find the pricing option that can pay for the appointment. An
   empty result is a `LIVE NOTE (loud)`, not a failure; the checkout
   then skips loudly.
3. `updateAppointment` reschedules it to the candidate's reschedule target
   (loud skip if the environment offers none).
4. `updateAppointment` with `execute: 'arrive'` marks it `Arrived`. If the
   sandbox reports success but the read-back is still `Booked` or `Confirmed`,
   the test passes with a `LIVE NOTE (loud)`; any other status fails.
5. Two `cancelAppointments` calls that the guards must refuse: one with four ids
   (one over the limit of 3, including the real appointment so a broken guard
   would be observable), and one naming another client (loud skip if the
   sandbox has no other client). The appointment is read back after each and
   must still be returned (cancelled rows are hidden) with a non-cancelled status.
6. `checkoutShoppingCart` sells the appointment's pricing option
   against it, paid with a Comp payment. The appointment is then read back and
   its status reported (`Completed` or still `Arrived`; neither is asserted).
7. Cleanup, in its own final `describe` block: the appointment is read back
   (it must be returned), `cancelAppointments` cancels it, and the read-back
   afterwards must show it `Cancelled`/`LateCancelled` or no longer return it.
   The test prints which.

Every write uses a run-unique token (`livee2e-<time>-<rand>`) in its name, notes
or email, so a leftover is identifiable in the Mindbody UI. Email addresses use
the RFC 2606 reserved `.invalid` TLD, which can never resolve, so no message can
be delivered even if a sandbox ignores `SendAccountEmails`.

## Cleanup — read this

Two resources are written. They are cleaned up differently:

- **Clients cannot be deleted.** v6 exposes no delete or archive endpoint. The
  full endpoint list has `client/mergeclients`, `client/terminatecontract` and
  `client/suspendcontract`, but nothing that removes a profile. The client is
  renamed to a `LEFTOVER` marker and its id is printed by `afterAll`. This is a
  limitation of the Mindbody v6 API surface, not an oversight.
- **Appointments are cancelled.** The cleanup test calls the guarded
  `cancelAppointments` tool for this run's appointment and verifies the cancel
  against a read-back taken before and after it (the sandbox hides cancelled
  rows, so "no longer returned" counts). The `LEFTOVERS` block then prints
  `appointment id: N (cancelled)`: nothing to purge by hand. That is the path when
  the checkout did not run (no pricing option for the booked session type). After a
  comp-paid checkout the appointment is `Completed` and takes the next bullet.
- **Except when it was checked out.** The comp-paid checkout runs in every default
  run, and in the verified run it moved the appointment to `Completed`. The cancel guard refuses Completed
  appointments, so cleanup falls back to re-noting it with a `LEFTOVER` marker
  and prints the reason. The `LEFTOVERS` block then shows it as
  `appointment id: N (LEFTOVER — …)`. Any other refusal of this run's own
  appointment is a test failure.

`updateAppointment` itself does not cancel: passing `execute: 'cancel'` or
`'latecancel'` is refused client-side, so `cancelAppointments` is the only
cancel path, and the only one the cleanup uses.

`afterAll` prints every leftover id on every run that actually started.

## Comp-paid checkout and on-account contracts run by default

`checkoutShoppingCart` runs in every live run, with no flag. This is the project owner's decision: a `Comp` payment moves no money and needs no payment method, so checking out a service with one is testable against the sandbox. It was verified live on 2026-10-17: Mindbody committed the sale, and the booked appointment read back as `Completed`.

`purchaseContract` also runs by default, funded by account credit. `UseAccountCredit` is a boolean meaning "bill this to the client's account balance", not a payment instrument: the sandbox accepts it against a zero balance, commits the contract and leaves the charge on account. It is the only one of the endpoint's four payment options this server exposes — it takes no card numbers, stored-card ids or bank details.

Purchasability is not readable. `getContracts` lists 11 contracts at location 1 and the API refuses 9 of them there ("Contract <id> cannot be purchased at location 1"), with no field on the contract saying which. The test therefore walks the discovered list and keeps the first the API accepts; a refusal writes nothing, so the attempts before it are free. Because the committed contract cannot be deleted, it is reported in the LEFTOVERS banner.

Both Mindbody endpoints accept `Test: true`, which validates without committing.
The MCP server exposes neither. So through this server every checkout commits:

- `checkoutShoppingCart` creates a Sale with tax lines and a payment
  transaction. `returnsale` can reverse it but is not exposed either, and a
  return is a second record, not a deletion. In this tier the sale is tied to
  the booked appointment through `AppointmentIds`, using the pricing option
  that `getServices` returns for the booked session type and location (loud
  skip if there is none). Payment is `Comp`, for the service's price when
  `getServices` exposes it, else 0, with `inStore: true`. A reconciled
  appointment may become `Completed`, which the cleanup cannot cancel (see
  above). The test requires `success: true`, printing the tool's `message` if
  not; reads the appointment back and reports its status; and, if the
  response names no reconciled appointment, prints a `LIVE NOTE (loud)` saying
  the link is unverified by the response for that run. In the verified run the response
  named no reconciled appointment, so that note prints on every default run; the
  appointment's read-back status is what the run reports as evidence of the link.
- `purchaseContract` creates a ClientContract with an AutoPay schedule and an
  account-credit charge. `FirstPaymentOccurs: StartDate` bills immediately, so
  the resulting record carries a live recurring schedule attached to the client.
  On `-99` that client has no payment instrument, so there is nothing for a
  recurring charge to take; it is still a record that cannot be deleted, and it
  is listed in LEFTOVERS for that reason. On a site where the client has a real
  card the same call would be a genuine financial obligation, which is why this
  tier remains sandbox-only.

The `-99` sandbox is shared and its data is not private. Every default run leaves
records that this server cannot delete or reverse (one client, one `Completed`
appointment, one comp-paid sale; see Cleanup), so putting this tier on a schedule
means accepting that growth.

## No-op policy

Some workflows need a real payment, or a paid visit, before Mindbody will
answer. The project owner has decided that no real payment details will ever be
supplied to any test environment. A workflow that requires one is therefore a
**deliberate no-op** in the live tier, not an incomplete run.

| Workflow | Why it is a no-op | How it appears in a run |
|---|---|---|
| `addClientArrival` | `/client/addarrival` consumes a paid visit (`Client requires payment`), and arrival is not part of the salon workflow | Not in the suite. Appointment arrival (`updateAppointment` with `execute: 'arrive'`) is covered instead |

`purchaseContract` is **no longer** in this table. It was, on the assumption that
its four payment options were all real payment details. Three of them are;
`UseAccountCredit` is a flag that bills the client's account balance and needs no
instrument, so the sandbox accepts it with a zero balance and commits the
contract. The tool now exposes that one and the test runs (see "Comp-paid
checkout and on-account contracts run by default").

`Comp` payments are **not** no-ops either. A Comp payment moves no money and needs
no payment method, so `checkoutShoppingCart` with a Comp payment runs in every
default run. The rule that separates the two cases is whether the "payment" is an
instrument or just a flag:

- **An instrument** — card number, stored card, bank/direct-debit mandate — is a
  no-op. It will never be supplied to a test environment.
- **A flag** — `Comp`, `UseAccountCredit` — is not a payment detail. A test that
  uses one is a real test and runs by default.

Rules for future tests:

- A workflow that needs a real payment or a paid visit is a no-op. It is never a
  loud skip, and no test sends a request that is known to be refused for lack
  of payment.
- Either leave it out of the suite, or declare it with `it.skip` and a
  `[NO-OP: <reason>]` name. Either way, add a row to the table above.
- A Comp payment moves no money, so a test that uses one is not a no-op.
  `checkoutShoppingCart` with a Comp payment stays in the suite and runs by default.
- Before declaring a workflow a no-op, check whether the "payment" it demands is
  actually an instrument. `purchaseContract` was wrongly parked as a no-op for a
  year's worth of runs because `UseAccountCredit` sits in the same
  `MissingRequiredFields` message as three real ones. Turning a no-op back into a
  real test still needs a decision from the project owner — but the reason to
  revisit is now "the field is a flag, not a card", not "Mindbody shipped a
  sandbox-only payment method".

## Sandbox facts

Learned from authenticated runs against `-99` on 2026-10-17. Each one shapes
the suite; none is hardcoded as an id.

- **Authentication works.** `POST /usertoken/issue` answers HTTP 200 and issues
  a token; the server attaches it (no "Falling back" line on stderr). The auth
  test probes `getClientVisits` with a never-created client id and accepts only
  `ClientNotFound`, which can only come from an authenticated request.
- **`addClient` requires a birth date** on this site: without one it answers
  `The following are required: Birthday (Code: MissingRequiredFields)`. The
  suite sends `birthDate: '1990-01-01'`.
- **Appointment discovery must start from availability.** Picking a staff
  member, a location and a session type separately lands on combinations with
  no availability. `GET /appointment/bookableitems` returns `Availabilities`
  (the server maps that key), and each item is a **window**
  (`StartDateTime`–`EndDateTime`) for one staff member, session type and
  location.
- **A window's start is not necessarily bookable.** Booking at it can answer
  `The appointment must start on an active time. (InvalidBookingTime)`: a start
  must also be one of the session type's active session times (for session type
  23, `06:00:00` to `21:00:00` every 30 minutes). The suite reads those from
  `GET /appointment/activesessiontimes` **directly**, as a discovery aid,
  because the MCP `getActiveSessionTimes` tool maps each entry as an object
  while the sandbox returns plain time strings (a `src/` defect; the suite does
  not assert on that tool).
- **Availability includes staff who cannot take the booking.** Some windows
  belong to staff without a pay rate for the service, refused with "The staff
  member is not an instructor for the requested service". Only a booking
  attempt reveals it, so several candidates are kept.
- **Cancelled appointments are hidden.** `GET /appointment/staffappointments`
  does not return them (a sample of 100 had NoShow, Completed, Arrived, Booked
  and Confirmed, and no Cancelled). A cancel is verified as "returned as
  cancelled, or no longer returned, having been returned just before".
- **Client arrivals need a pricing option.** `POST /client/addarrival` for a
  fresh client answers `Client requires payment. (Code: ValidationFailed)`,
  also with `Test: true`. That is why `addClientArrival` is not in the suite;
  appointment arrival (`execute: 'arrive'`) is.
- **Only the session type's pricing option pays for an appointment.**
  `GET /sale/services?SessionTypeIds=[23]&LocationId=1` returns exactly the
  option that pays for session-type-23 appointments (id `1395`, "Nutrition
  Consulatation", price 30). Unfiltered, the first service is a class package,
  and checking that out against an appointment fails with
  `No provided services can pay for the given appointments (Code:
  ServiceDoesNotPayForAppointment)`. The suite discovers the service with the
  filtered call; the id is not hardcoded.
- **A reconciling checkout is accepted.** In a Test-mode probe,
  `{ Items: [{ Item: { Type: 'Service', Metadata: { Id: '1395' } }, Quantity: 1,
  AppointmentIds: [<booked id>] }], Payments: [{ Type: 'Comp', Metadata:
  { Amount: 0 } }], InStore: true, LocationId: 1 }` succeeds (an `Amount` of
  the price, 30, is accepted too). The suite's checkout does not send `Test: true`, so it
  commits a real sale (see "Comp-paid checkout runs by default"). The response's `CartItems[].Appointments`,
  `CartItems[].AppointmentIds` and top-level `Appointments` are all **empty**
  arrays, so the checkout test does not fail on an empty reconciliation list:
  it prints a loud note and reports the appointment's read-back status instead.
- **`purchaseContract` succeeds with no payment details, via account credit.**
  Without one of CreditCardInfo, StoredCardInfo, UseDirectDebit or UseAccountCredit
  it answers `At least one of the following parameters must be passed:
  CreditCardInfo, StoredCardInfo, UseDirectDebit, UseAccountCredit (Code:
  MissingRequiredFields)`. `UseAccountCredit: true` satisfies it on a client whose
  balance is zero: the contract commits, `ClientContractId` is returned, and the
  sale is paid `Account` (PaymentType 16). It is a flag, not an instrument — no
  card, no bank details, no stored card. The tool exposes it and nothing else, so
  the test runs on every default run.
- **Most listed contracts cannot be purchased at the location that lists them.**
  Location 1 lists 11 and refuses 9 ("Contract <id> cannot be purchased at
  location 1"); location 2 lists 11; location 98 lists 7. Nothing on the contract
  says which are sellable, and the first one listed is not: on 2026-10-20
  `contracts[0]` was 356 (refused) and the accepted ones were 347 and 320. So
  `purchaseContract` walks the list and keeps the first accepted; the refusals
  write nothing.
- **`ClientContract` has two id fields that mean different things.**
  `Id` is the ClientContract id and is what `purchaseContract` returns as
  `ClientContractId`; `ContractID` is the catalog contract that was sold. One
  verified purchase read back as `Id` 16045 / `ContractID` 347 / contract 347 /
  `AutopayStatus: "Active"`. Match a read-back on `id`, not `ContractID`.
- **Time zone.** The site is `America/Los_Angeles`; the development host is
  `Asia/Hong_Kong`, 15 hours ahead. Every Mindbody date-time is site-local with
  no offset. The suite reads the zone from `getSites`, computes every "today"
  in it with `Intl.DateTimeFormat`, and compares date-times as strings, never
  through `new Date`.
- **Contracts exist at every location** (11 / 11 / 7 at locations 1 / 2 / 98 on
  2026-10-17). `getContracts` is tried at each location and asserted, and the ids
  at the first location that lists any are handed to `purchaseContract`.
- **`updateClient` needs `Client` nested and `CrossRegionalUpdate: false`.**
  Sent at the top level it answers `Client (Code: MissingRequiredFields)`; with
  `Client` nested but cross-regional updates left at the default, the sandbox
  answers "The current site does not belong to a region".
  `src/tools/clientManagement.ts` now sends both, and the client-cleanup rename
  test passes.

## Status

**Runs end to end against the authenticated `-99` sandbox.** A default run books, reschedules, arrives, guard-checks, checks out with a comp payment, then either cancels the appointment or re-notes it as a LEFTOVER, and buys a contract with account credit. Last default result on 2026-10-20:

```
 27 pass
 0 skip
 0 fail
Ran 27 tests across 1 file.
```

With `SKIP_LIVE_E2E=1` the same file reports `0 pass, 27 skip, 0 fail`.

- **No skips and no loud skips.** Every test ran, including the two writes the older tally treated as financial edges: the comp-paid checkout and `purchaseContract`. The `it.skip` that used to sit at this point is gone — its premise ("requires real payment details") was wrong, because `UseAccountCredit` is a flag, not an instrument.
- **The contract purchase passed.** It walked the 11 contracts at location 1, was refused `356` ("Contract 356 cannot be purchased at location 1"), accepted `347` (Corporate Monthly Membership) and returned `ClientContractId` 16045. `getClientContracts` read it back as `Id` 16045 with `AutopayStatus: "Active"`.
- **The comp-paid checkout passed.** It sold the appointment's pricing option (service `1395`, price 30) against the booked appointment with `Payments: [{ Type: 'Comp' }]`. Mindbody committed the sale, and the appointment read back as `Completed`. The response's reconciled-appointment arrays were empty, so the `LIVE NOTE (loud)` about the unverified link prints on every run.
- **Every appointment-lifecycle step ran:** client created, slot discovered from availability, appointment booked, the paying service found (`1395` for session type 23 at location 1), rescheduled, `execute: 'arrive'` read back as `Arrived`, both cancel guards refused, and the appointment sold through the comp-paid checkout. Cleanup then refused the `Completed` appointment and re-noted it as a LEFTOVER.
- `LEFTOVERS` on every default run: one client (no delete in v6), one `Completed` appointment, one comp-paid sale record, and one active auto-pay ClientContract. Each carries the run token (in the client's name, the appointment's notes and the payment's notes), so each is identifiable in the Mindbody UI. None can be deleted or reversed through this server.
- **The sandbox is shared and gets reset.** Between two runs on 2026-10-20 a concurrent reset removed every record an earlier run had left: the probe client returned HTTP 404 and `clientcontracts` came back empty. Nothing in this tier depends on state surviving one run — every id is re-discovered each time — but do not read a "missing leftover" as a bug in the suite.

Read every `LIVE …` block a run prints, not just the pass/fail tally: the
`LIVE E2E INCOMPLETE` summary names any test that returned early.
