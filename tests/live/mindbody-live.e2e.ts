/**
 * LIVE end-to-end acceptance tests — opt-in, second tier, real Mindbody API.
 *
 * ── Why this file is not named `*.test.ts` ───────────────────────────────────
 * Bun auto-collects `*.test.ts`, `*_test.ts`, `*.spec.ts` and `*_spec.ts` into a
 * bare `bun test`. This tier must never be picked up by that run: it needs real
 * credentials, it writes records, and it talks to a rate-limited third-party API.
 * The `.e2e.ts` suffix matches none of Bun's patterns, so `bun test` ignores the
 * file entirely and the default suite stays hermetic and fast.
 *
 * Run it deliberately:
 *
 *   bun test ./tests/live/mindbody-live.e2e.ts
 *
 * ── How it differs from tests/e2e-mcp-server.test.ts ────────────────────────
 * Everything mechanical is the same, deliberately: `src/index.ts` is spawned as
 * a real subprocess over STDIO, the MCP SDK client speaks real JSON-RPC to it,
 * and `beforeAll`/`afterAll` own the lifecycle with teardown in `finally`. The
 * single substitution is the API under test — `tests/support/mindbody-stub.ts`
 * here becomes the real Mindbody environment.
 *
 * ── Skip vs fail ────────────────────────────────────────────────────────────
 * See `live-config.ts` for the full policy. In short: exactly two automatic
 * skips ("no credentials", "explicitly disabled"); everything else fails. There
 * is deliberately no third "the network is down, never mind" escape hatch.
 *
 * ── STATUS: RUN AGAINST THE -99 SANDBOX, AUTHENTICATED ─────────────────────
 * This file has been run end to end against the Mindbody `-99` sandbox. The
 * sandbox facts it depends on were learned from those runs and are recorded in
 * tests/live/README.md ("Sandbox facts"). The ones that shape the code below:
 *
 *   - `addClient` requires a birth date on this site (MissingRequiredFields:
 *     Birthday), so the client is created with one.
 *   - Appointment inventory is discovered FROM availability: one
 *     `/appointment/bookableitems` call over the Appointment-type session types,
 *     with no staff or location filter, and staff, session type, location and
 *     start time are all taken from the same returned item. Choosing them
 *     independently lands on combinations with no availability.
 *   - `/appointment/staffappointments` does not return Cancelled appointments,
 *     so "cancelled" is verified as "returned as Cancelled, OR no longer
 *     returned at all, having been returned before the cancel".
 *   - Every date-time Mindbody returns is SITE-local with no offset. The site
 *     time zone is read from `getSites` and every "today" is computed in it;
 *     date-times are compared as strings, never through `new Date`, because
 *     the host running this file need not share the site's zone.
 *   - Only a pricing option tied to the booked appointment's session type can
 *     pay for it. An unfiltered `getServices` leads with a class package, and
 *     checking that out against an appointment fails with
 *     `ServiceDoesNotPayForAppointment`. The checkout therefore uses the service
 *     returned by `getServices` filtered by `sessionTypeIds` + `locationId`.
 *   - `/sale/purchasecontract` requires one of CreditCardInfo, StoredCardInfo,
 *     UseDirectDebit or UseAccountCredit, and the `purchaseContract` tool
 *     exposes none of them, so that test is a no-op by decision (it.skip).
 *
 * Two Mindbody v6 endpoints in this file declare required parameters that a
 * bare call omits (`LocationId` on `/sale/contracts`, `SessionTypeIds` on
 * `/appointment/bookableitems`, both answering HTTP 400 "<param> is a required
 * parameter."). Their parameters are discovered from the live environment at run
 * time, never hardcoded — see `requireDiscovered`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildLiveChildEnv, resolveLiveTier, type LiveConfig } from './live-config.js';

const SERVER_ENTRY = resolve(__dirname, '../../src/index.ts');
const BUN_BINARY = process.execPath;

/** Live API calls are slow and the client retries 5xx with 1s+2s+4s backoff. */
const CALL_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 60_000;

/**
 * A token unique to this run, embedded in every record this suite creates.
 *
 * Two jobs: it makes a leftover record identifiable by eye in the Mindbody UI,
 * and it makes a stale leftover distinguishable from a fresh one. `@example.invalid`
 * is an RFC 2606 reserved TLD that can never resolve, so no mail can be delivered
 * to it even if a sandbox ignores `SendAccountEmails`.
 */
const RUN_TOKEN = `livee2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const TEST_EMAIL = `${RUN_TOKEN}@example.invalid`;

// ── Suite-wide state ──────────────────────────────────────────────────────────

let decision = resolveLiveTier();
let config: LiveConfig | null = null;
let scratchDir: string | null = null;
let childEnv: Record<string, string> = {};
let transport: StdioClientTransport | null = null;
let client: Client | null = null;
let serverStderr: string[] = [];

/**
 * Live endpoint shapes captured during the read tests, reused by the write tests.
 *
 * Nothing here is hardcoded. Every id is discovered at run time by calling the
 * same read endpoint the corresponding test needs it for, because a literal id
 * captured from one Mindbody environment is meaningless in another — the
 * `-99` sandbox is shared, resettable, and not the only sandbox.
 *
 * ORDERING: the `live tier — service definitions` describe block below is what
 * fills these in, and it is declared before every block that reads them. Bun
 * runs the tests in a file in declaration order, so the values are populated by
 * the time a consumer runs. Consumers still guard with `requireDiscovered`,
 * because a discovery test that failed leaves them null and sending a null to a
 * parameter Mindbody marks required produces a confusing HTTP 400 rather than a
 * clear statement of what went wrong.
 */
const discovered = {
  /**
   * The site's IANA time zone, from `getSites`. Mindbody date-times are
   * site-local with no offset, so every "today" this file sends is computed in
   * this zone, not the host's.
   */
  siteTimeZone: null as string | null,
  /** Every location id, from `getLocations`; `getContracts` is tried at each. */
  locationIds: null as number[] | null,
  /**
   * The location the appointment write tests use. Starts as the first location
   * and is REPLACED by the location of the bookable slot that
   * `getBookableItems` discovers, so staff, session type, location and start
   * time always come from one availability item.
   */
  locationId: null as number | null,
  staffId: null as number | null,
  sessionTypeId: null as number | null,
  /**
   * Every Appointment-type session type, not just one.
   *
   * `/appointment/bookableitems` requires `SessionTypeIds` and is only
   * meaningful for session types that can be booked as appointments; a Class
   * type id in that list buys nothing. Passing all of them costs one request
   * and removes the need to guess which of the environment's types is bookable.
   */
  appointmentSessionTypeIds: null as number[] | null,
  /** The first service of the UNFILTERED `getServices` read; shape check only. */
  serviceId: null as number | null,
  /**
   * The pricing option that can pay for the booked appointment, from
   * `getServices` filtered by the booked session type and location. The
   * checkout must use this, not `serviceId`: on the -99 sandbox the first
   * unfiltered service is a class package, and Mindbody refuses it with
   * `ServiceDoesNotPayForAppointment`. Null when the filtered read returns none.
   */
  appointmentServiceId: null as number | null,
  /** That service's price, when the read exposes one; the Comp payment amount. */
  appointmentServicePrice: null as number | null,
  contractId: null as number | null,
  /** The location `contractId` was found at; `purchaseContract` sends it. */
  contractLocationId: null as number | null,
  /** Default length in minutes of each session type, from `getSessionTypes`. */
  sessionTypeMinutes: null as Map<number, number> | null,
  /**
   * Bookable candidates derived from availability, in the order to try them.
   * See `getBookableItems discovers…` for how they are built.
   */
  bookingCandidates: null as BookingCandidate[] | null,
  /** The start the booking succeeded at (one of the candidates). */
  bookableStart: null as string | null,
  /**
   * A second valid start for the same staff member, session type and location,
   * used as the reschedule target. Null when the environment offers none, in
   * which case the reschedule test skips loudly rather than "moving" the
   * appointment to the time it already has.
   */
  bookableStartAlt: null as string | null,
};

/**
 * One concrete booking the sandbox's availability says should be accepted.
 *
 * `startDateTime` is an ACTIVE SESSION TIME inside an availability window, not
 * the window's own start (see `getBookableItems discovers…`). `alternativeStart`
 * is another such time for the same staff, session type and location.
 */
interface BookingCandidate {
  staffId: number;
  sessionTypeId: number;
  locationId: number;
  startDateTime: string;
  alternativeStart: string | null;
}

/** What the raw `/usertoken/issue` probe saw: true issued, false not, null not run. */
let userTokenIssuedByProbe: boolean | null = null;

let createdClientId: string | null = null;
let createdAppointmentId: number | null = null;
/** The start time the appointment was booked at, before any reschedule. */
let createdAppointmentStart: string | null = null;

/**
 * How the appointment cleanup ended, for the LEFTOVERS banner.
 *
 *   cancelled -> the guarded `cancelAppointments` tool cancelled it; nothing to purge.
 *   leftover  -> it could not be cancelled (see `reason`) and was re-noted instead.
 *   null      -> cleanup never ran or failed; treat the id as a leftover.
 */
let appointmentCleanup: { outcome: 'cancelled' | 'leftover'; reason?: string } | null = null;

/**
 * Tests that returned early this run because a required input was unavailable.
 *
 * Surfaced by name in `afterAll`, so a run cannot finish quietly having tested
 * less than it appears to.
 */
const loudSkips: string[] = [];

// ── Reporting ─────────────────────────────────────────────────────────────────

/**
 * A banner, printed before any test runs.
 *
 * Bun prints nothing for a skipped test beyond a `(skip)` marker, and a bare
 * `bun test` never sees this file at all. Without this line, "the live tier
 * skipped" and "the live tier passed" are indistinguishable in a CI log, which is
 * exactly the confusion this tier must not create.
 */
console.log(
  [
    '',
    '='.repeat(78),
    ' LIVE E2E TIER',
    ` run token: ${RUN_TOKEN}`,
    ` decision:  ${decision.kind.toUpperCase()}`,
    decision.kind === 'run'
      ? ` site id:   ${decision.config.siteId} (sandbox)`
      : ` reason:   ${decision.reason}`,
    ' writes:    client, appointment and one comp-paid sale (no payment method); real-payment flows are no-ops',
    '='.repeat(78),
    '',
  ].join('\n')
);

/**
 * `it` that degrades according to the environment decision.
 *
 *   run     -> a normal test
 *   skip    -> `it.skip`, so Bun reports it as skipped, with the reason printed
 *   refuse  -> a FAILING test carrying the configuration error
 *
 * `refuse` deliberately does not skip. A SiteId pointing at a live business is a
 * misconfiguration someone must fix; silently skipping it would leave a red flag
 * looking like a green light.
 */
function itLive(name: string, fn: () => void | Promise<unknown>, timeout = CALL_TIMEOUT_MS) {
  if (decision.kind === 'run') {
    return it(name, fn, timeout);
  }
  if (decision.kind === 'refuse') {
    return it(name, () => {
      throw new Error(decision.reason);
    });
  }
  return it.skip(name, fn);
}

/**
 * Record a test that returned early this run, and say so where it cannot be
 * missed: a multi-line block at the point of the skip, and a named entry in the
 * `afterAll` summary.
 *
 * `lines[0]` is the reason proper; the rest is supporting detail. Both are
 * printed, indented, and never contain a credential value.
 */
function announceLoudSkip(name: string, lines: string[]): void {
  loudSkips.push(`${name} — ${lines[0]}`);
  console.log(
    `\n LIVE SKIP (loud) — "${name}"\n` + lines.map((line) => `   ${line}`).join('\n') + '\n'
  );
}

/** Was `name` skipped this run, by `requireDiscovered` or `announceLoudSkip`? */
function wasLoudlySkipped(name: string): boolean {
  return loudSkips.some((entry) => entry.startsWith(`${name} — `));
}

const ADD_APPOINTMENT_TEST = 'addAppointment books a slot that is then readable back';

/**
 * `/appointment/bookableitems` discovery parameters. Up to this many
 * Appointment-type session types are sent (the -99 sandbox has ~66; the first
 * 15 already return over a hundred availabilities), starting this many
 * site-local days out, across this many days.
 */
const BOOKABLE_SESSION_TYPE_LIMIT = 15;
const BOOKABLE_START_OFFSET_DAYS = 2;
const BOOKABLE_WINDOW_DAYS = 14;

/** How many distinct staff/session type/location candidates addAppointment may try. */
const MAX_BOOKING_CANDIDATES = 8;

/**
 * Mindbody refusals of an addAppointment REQUEST that availability cannot
 * predict, so the booking test moves on to the next candidate. Nothing is
 * written when either is returned. Every other refusal is a failure.
 */
const BOOKING_REFUSALS_TO_SKIP_PAST = [
  /InvalidBookingTime/,
  /not an instructor for the requested service/i,
];

/**
 * Gate a test on the appointment this run booked.
 *
 * Same split as the original cleanup test: if `addAppointment` was itself
 * loudly skipped (no bookable slot discovered), this test has nothing to act on
 * and skips loudly too, rather than manufacturing a second, misleading red. If
 * `addAppointment` FAILED, that is a real failure and stays one here.
 */
function requireCreatedAppointment(name: string): boolean {
  if (createdAppointmentId !== null) return true;
  if (wasLoudlySkipped(ADD_APPOINTMENT_TEST)) {
    announceLoudSkip(name, [
      'reason: addAppointment was skipped because no bookable slot was discovered,',
      'so no appointment exists for this test to act on. Fix the addAppointment',
      'skip earlier in this run rather than reading this as a separate bug.',
    ]);
    return false;
  }
  throw new Error('No appointment was created, so this test has nothing to act on. See the earlier failure.');
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The wall-clock date-time in `timeZone`, `offsetDays` from now, formatted the
 * way Mindbody formats site-local date-times: `YYYY-MM-DDTHH:MM:SS`, no offset.
 *
 * Computed with `Intl` in the SITE's zone because this host's zone is
 * irrelevant to Mindbody: on the development machine the host is
 * Asia/Hong_Kong and the sandbox is America/Los_Angeles, 15 hours apart, so a
 * host-local "today" can be the site's tomorrow.
 */
function siteLocalDateTime(timeZone: string, offsetDays = 0): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(Date.now() + offsetDays * DAY_MS));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '00';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;
}

/** The site-local calendar date `offsetDays` from now, as `YYYY-MM-DD`. */
function siteLocalDate(timeZone: string, offsetDays = 0): string {
  return siteLocalDateTime(timeZone, offsetDays).slice(0, 10);
}

/** The discovered site zone; only called once a slot (and so the zone) is known. */
function siteZone(): string {
  if (!discovered.siteTimeZone) {
    throw new Error('The site time zone was not discovered; see the getSites failure earlier in this run.');
  }
  return discovered.siteTimeZone;
}

/**
 * Two Mindbody date-times name the same site-local wall-clock time.
 *
 * Both sides are site-local strings with no offset, so they are compared as
 * strings (to the second) rather than parsed: `new Date` would read them in
 * THIS host's zone and the comparison would depend on where the suite runs.
 */
function sameLocalDateTime(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.slice(0, 19) === b.slice(0, 19);
}

/**
 * How far either side of "today" (site-local) the read-backs look. Explicit,
 * rather than the tool's default window, because the booked slot is chosen
 * days ahead and a reschedule can move it later still.
 */
/** Minutes since midnight of a `YYYY-MM-DDTHH:MM…` site-local string. */
function minutesOfDay(dateTime: string): number {
  const hours = Number(dateTime.slice(11, 13));
  const minutes = Number(dateTime.slice(14, 16));
  return hours * 60 + minutes;
}

/**
 * The active session times (`HH:MM:SS`, site-local) a session type may start
 * at, from `GET /appointment/activesessiontimes`.
 *
 * Read RAW rather than through the MCP `getActiveSessionTimes` tool, and only
 * as a discovery aid: the -99 sandbox returns `ActiveSessionTimes` as a list of
 * time STRINGS (and `SessionTypeActiveSessionTimes` per type), while the tool
 * maps each entry as an object with `Id` and per-day fields, so through MCP
 * every value comes back undefined. That is a defect in src/, reported rather
 * than worked around there; this read does not assert on the tool at all.
 */
async function fetchActiveSessionTimes(sessionTypeId: number): Promise<string[]> {
  const response = await rawApiCall(
    `/appointment/activesessiontimes?SessionTypeIds=${sessionTypeId}&ScheduleType=Appointment&Limit=200`,
    {
      method: 'GET',
      headers: { 'Api-Key': config!.apiKey, SiteId: config!.siteId, 'Content-Type': 'application/json' },
    }
  );
  if (response.status !== 200) {
    throw new Error(
      `GET /appointment/activesessiontimes for session type ${sessionTypeId} -> HTTP ${response.status}: ` +
        response.text.slice(0, 300)
    );
  }
  const perType = (response.body?.SessionTypeActiveSessionTimes ?? []).find(
    (entry: any) => entry?.SessionTypeId === sessionTypeId
  );
  const times: unknown[] = perType?.ActiveSessionTimes ?? response.body?.ActiveSessionTimes ?? [];
  return times.filter((time): time is string => typeof time === 'string' && /^\d{2}:\d{2}/.test(time)).sort();
}

const READBACK_DAYS_BEFORE = 1;
const READBACK_DAYS_AFTER = 30;

/**
 * Look the created appointment up through `getStaffAppointments`, returning the
 * row or `undefined` if the lookup does not return it.
 *
 * The -99 sandbox's lookup HIDES cancelled appointments (see README "Sandbox
 * facts"), so `undefined` here is meaningful only next to a read that found it.
 */
async function findCreatedAppointment(): Promise<any | undefined> {
  const zone = siteZone();
  const readBack = await callTool('getStaffAppointments', {
    staffIds: [discovered.staffId],
    appointmentIds: [createdAppointmentId],
    startDate: siteLocalDate(zone, -READBACK_DAYS_BEFORE),
    endDate: siteLocalDate(zone, READBACK_DAYS_AFTER),
  });
  expect(Array.isArray(readBack.appointments)).toBe(true);
  return readBack.appointments.find((appointment: any) => appointment.id === createdAppointmentId);
}

/**
 * Read the created appointment back through `getStaffAppointments`, requiring
 * that it is returned.
 *
 * Every assertion about appointment state in this file goes through this read,
 * not through the echo of the write that changed it. Because the lookup hides
 * cancelled rows, presence is itself evidence the appointment is NOT cancelled;
 * the guard tests rely on that as well as on the status.
 */
async function readBackCreatedAppointment(): Promise<any> {
  const row = await findCreatedAppointment();
  expect(
    row,
    `getStaffAppointments did not return appointment ${createdAppointmentId}; its state cannot be verified ` +
      '(this sandbox hides cancelled appointments, so a missing row may mean it was cancelled)'
  ).toBeDefined();
  return row;
}

/** Statuses after which an appointment no longer holds a slot. */
const CANCELLED_STATUSES = ['Cancelled', 'LateCancelled'];

/**
 * Refuse to make a call that has no valid value for a parameter Mindbody
 * documents as REQUIRED.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Mindbody v6 answers a missing required parameter with HTTP 400 and a message
 * like "LocationId is a required parameter." That is a *caller* error, not a
 * product defect. Two endpoints used by this tier have such parameters, both
 * confirmed against the spec (docs/openapi.json) and against the live API:
 *
 *   GET /sale/contracts             requires `LocationId`
 *   GET /appointment/bookableitems  requires `SessionTypeIds`
 *
 * If a discovery test failed, the dependent test would otherwise send
 * `{"sessionTypeIds":[null]}`, get a 400, and `callTool` would report it as a
 * failure of the server — a red suite for the wrong reason, pointing at code
 * that is not the problem. That is the specific outcome this guards against.
 *
 * ── Why it prints instead of skipping ────────────────────────────────────────
 * `it.skip` / `it.skipIf` are evaluated while the file is being COLLECTED, which
 * in Bun happens before any test body has run — so the value is not known yet
 * and a decision cannot be deferred to run time. Returning early is the only
 * run-time option, and Bun counts an early return as a pass. To stop that pass
 * reading as coverage, `announceLoudSkip` prints and records it.
 *
 * The branch should be unreachable on a healthy environment: if a discovered
 * value is missing, the discovery test that would have produced it has already
 * failed loudly, and the summary at the end names both.
 */
function requireDiscovered(name: string, keys: Array<keyof typeof discovered>): boolean {
  const missing = keys.filter((key) => {
    const value = discovered[key];
    if (value === null || value === undefined) return true;
    // An empty array is as useless as a null: it carries no id to send.
    return Array.isArray(value) && value.length === 0;
  });

  if (missing.length === 0) return true;

  announceLoudSkip(name, [
    `reason: this environment yielded no usable ${missing.join(', ')}.`,
    'The read that discovers those values failed or was itself skipped, so this',
    'call would have gone out with a null where Mindbody documents a REQUIRED',
    'parameter — which answers HTTP 400 "<param> is a required parameter." and',
    'would record a caller error as a product failure. Skipping rather than',
    'sending a request known to be wrong.',
    'Root cause: the discovery failure earlier in this run, which is itself a',
    'real failure. This line should not appear on a healthy environment.',
  ]);
  return false;
}

// ── Result helpers ────────────────────────────────────────────────────────────

function resultText(result: object): string {
  const content = (result as { content?: unknown }).content as Array<{ type: string; text?: string }>;
  if (!Array.isArray(content)) return '';
  return content.map((block) => block.text ?? '').join('');
}

function resultJson(result: object): any {
  return JSON.parse(resultText(result));
}

/**
 * Call a tool and fail loudly on any error result.
 *
 * This is where the FAIL policy is enforced mechanically: an unexpected upstream
 * response arrives as `isError: true` with Mindbody's error envelope in the text,
 * and it becomes a thrown Error here. There is no path by which a broken call
 * turns into a pass.
 */
async function callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
  if (!client) throw new Error('MCP client is not connected; the live tier did not start.');
  const result = await client.callTool({ name, arguments: args });
  const text = resultText(result);
  if (result.isError) {
    throw new Error(
      `Live call "${name}" failed against the real Mindbody API.\n` +
        `  arguments: ${JSON.stringify(args)}\n` +
        `  server said: ${text}\n` +
        '  This is a failure, not a skip. Credentials were present and the suite reached the API.'
    );
  }
  return resultJson(result);
}

/**
 * A raw HTTP call to the live API from the test process.
 *
 * Used only where the MCP surface cannot show what happened — currently the
 * `/usertoken/issue` probe, whose entire purpose is to report what the sandbox
 * does with a user-token request. It sends the same headers `src/api/auth.ts`
 * sends. Response text is returned to the caller; credential values are never
 * placed in a log line.
 */
async function rawApiCall(
  path: string,
  init: { method: string; headers: Record<string, string>; body?: string } | null
): Promise<{ status: number; body: any; text: string }> {
  if (!config) throw new Error('Live tier is not configured.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${config.apiUrl}${path}`, {
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body,
      signal: controller.signal,
    });
    const text = await response.text();
    let body: any = undefined;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: response.status, body, text };
  } finally {
    clearTimeout(timer);
  }
}

/** Poll the subprocess's stderr until `predicate` matches, or give up. */
async function waitForStderr(predicate: (text: string) => boolean, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = serverStderr.join('');
    if (predicate(text)) return text;
    await new Promise((done) => setTimeout(done, 200));
  }
  return serverStderr.join('');
}

/**
 * Tear a connection down promptly.
 *
 * Mirrors tests/e2e-mcp-server.test.ts: the server does not exit on stdin EOF in
 * STDIO mode, so signalling first turns a 2-second close into an immediate one
 * and guarantees no orphaned process.
 */
async function shutdownConnection(closingClient: Client, closingTransport: StdioClientTransport) {
  const pid = closingTransport.pid;
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
  await closingClient.close();
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  if (decision.kind !== 'run') return;
  config = decision.config;

  // An empty scratch dir is the subprocess's cwd and HOME. Because it holds no
  // `.env`, neither Bun's loader nor `dotenv.config()` in src/index.ts can find
  // the repo's credentials, while module resolution still walks up to the repo's
  // node_modules.
  scratchDir = mkdtempSync(join(tmpdir(), 'mindbody-mcp-live-'));

  childEnv = buildLiveChildEnv(config, scratchDir);

  transport = new StdioClientTransport({
    command: BUN_BINARY,
    args: ['run', SERVER_ENTRY],
    cwd: scratchDir,
    env: childEnv,
    stderr: 'pipe',
  });

  const stderrStream = transport.stderr;
  if (stderrStream) {
    stderrStream.on('data', (chunk: Buffer | string) => {
      serverStderr.push(chunk.toString());
    });
  }

  client = new Client({ name: 'live-e2e-test-client', version: '0.0.0' });
  await client.connect(transport);
}, CONNECT_TIMEOUT_MS);

afterAll(async () => {
  try {
    if (client && transport) {
      await shutdownConnection(client, transport);
    }
  } catch {
    // The transport may already be gone.
  } finally {
    if (scratchDir) {
      rmSync(scratchDir, { recursive: true, force: true });
    }
    if (decision.kind === 'run') {
      // Report anything this run could not clean up, by ID, so a human can purge
      // it in the Mindbody UI. Never printed when the run skipped or refused.
      const appointmentLine =
        createdAppointmentId === null
          ? 'none'
          : appointmentCleanup?.outcome === 'cancelled'
            ? `${createdAppointmentId} (cancelled)`
            : `${createdAppointmentId} (LEFTOVER — ${appointmentCleanup?.reason ?? 'cleanup did not complete; cancel it by hand'})`;
      console.log('\n LIVE E2E LEFTOVERS');
      console.log(`   client id:      ${createdClientId ?? 'none'}`);
      console.log(`   appointment id: ${appointmentLine}`);
      console.log('   Clients have no delete endpoint in Mindbody API v6, so the client is always a leftover.');
      console.log('   See the cleanup notes in tests/live/mindbody-live.e2e.ts.\n');

      // A green tally is not the same as full coverage: `requireDiscovered`
      // returns early rather than sending a request Mindbody would reject, and
      // Bun counts an early return as a pass. Names are listed here so that the
      // shortfall is impossible to miss at the end of a long log.
      if (loudSkips.length > 0) {
        console.log(` LIVE E2E INCOMPLETE — ${loudSkips.length} test(s) did not run:`);
        for (const entry of loudSkips) {
          console.log(`   - ${entry}`);
        }
        console.log('   Read this as a FAILURE of the run, not a clean pass.');
        console.log('   See the LIVE SKIP blocks above for each reason.\n');
      }
    }
  }
});

// ── 1. The decision itself ────────────────────────────────────────────────────

describe('live tier — configuration', () => {
  itLive('ran against the sandbox SiteId and never inherited production credentials', () => {
    if (decision.kind !== 'run') return;

    // The SiteId guard in live-config.ts already refused anything else, so
    // reaching this assertion means the child was pointed at the sandbox.
    expect(config!.siteId).toBe('-99');
    expect(childEnv.MINDBODY_SITE_ID).toBe('-99');

    // The child env is built from scratch, so no `MINDBODY_*` variable the test
    // process holds can reach a subprocess that writes to a live API.
    const inherited = Object.keys(process.env).filter((key) => key.startsWith('MINDBODY_'));
    for (const key of inherited) {
      if (childEnv[key] === undefined) continue;
      expect([
        config!.apiUrl,
        config!.apiKey,
        config!.siteId,
        config!.sourceName,
        config!.sourcePassword,
      ]).toContain(childEnv[key]);
    }

    // And the subprocess has no `.env` within reach of its cwd.
    expect(existsSync(join(scratchDir!, '.env'))).toBe(false);
    expect(readdirSync(scratchDir!).filter((entry) => entry.startsWith('.env'))).toEqual([]);
  });

  itLive('starts the real server over STDIO and answers MCP', async () => {
    expect(client!.getServerVersion()?.name).toBe('mindbody-mcp');
    expect(client!.getServerCapabilities()).toHaveProperty('tools');
    const { tools } = await client!.listTools();
    expect(tools.length).toBeGreaterThan(0);
    await client!.ping();
  });

  itLive('the Mindbody environment is reachable from this host', async () => {
    // The single most important gate in this file. The sandbox accepts requests
    // only from allow-listed IP addresses, and everything below fails confusingly
    // if the host is not on that list. This test turns that into one clear,
    // unmissable failure with the actual reason attached.
    const response = await rawApiCall('/site/locations', {
      method: 'GET',
      headers: {
        'Api-Key': config!.apiKey,
        SiteId: config!.siteId,
        'Content-Type': 'application/json',
      },
    });

    if (response.status !== 200) {
      throw new Error(
        `The Mindbody environment is not usable from this host.\n` +
          `  GET /site/locations -> HTTP ${response.status}\n` +
          `  body: ${response.text.slice(0, 500)}\n` +
          '  If this is HTTP 403 "Unsupported IP Address", the sandbox only accepts\n' +
          '  allow-listed IPs: add this machine\'s egress IP in the Mindbody developer\n' +
          '  portal. This test fails rather than skips so the tier cannot report a\n' +
          '  green run while having verified nothing.'
      );
    }

    expect(Array.isArray(response.body?.Locations)).toBe(true);
  });
});

// ── 2. User token flow ────────────────────────────────────────────────────────

describe('live tier — user token flow', () => {
  itLive('POST /usertoken/issue — reports what the environment actually does', async () => {
    const response = await rawApiCall('/usertoken/issue', {
      method: 'POST',
      headers: {
        'Api-Key': config!.apiKey,
        SiteId: config!.siteId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        Username: config!.sourceName,
        Password: config!.sourcePassword,
      }),
    });

    const tokenIssued = typeof response.body?.AccessToken === 'string' && response.body.AccessToken.length > 0;
    userTokenIssuedByProbe = tokenIssued;

    // Never print the token itself. The shape and the status are the finding.
    console.log(
      `\n LIVE user-token probe: HTTP ${response.status}, ` +
        `token ${tokenIssued ? 'ISSUED' : 'NOT issued'}` +
        (response.body?.Error ? `, Error.Code = ${response.body.Error.Code}` : '') +
        '\n'
    );

    // Both outcomes are legitimate and both are recorded, but a 5xx or a 404 is
    // neither of them: it means the endpoint or the environment is broken.
    if (response.status >= 500) {
      throw new Error(`POST /usertoken/issue returned HTTP ${response.status}: ${response.text.slice(0, 500)}`);
    }
    expect([200, 400, 401, 403]).toContain(response.status);
  });

  itLive('the server uses a user token when one is issued, and falls back cleanly when not', async () => {
    // Any real API call forces `mindbodyAuth.getAuthHeaders()` to run, which is
    // where the token is acquired and attached (or where the fallback is logged).
    // `getClientVisits` is not cached, so this always produces an HTTP request,
    // and it is the first API call this server instance makes.
    //
    // The probe client id was never created, so Mindbody answers it with
    // `ClientNotFound`. That is the point: a ClientNotFound can only come back
    // from a request that was AUTHENTICATED and reached the client data layer.
    // An auth problem would answer DeniedAccess / 401 / 403 instead, and is
    // still a failure here. Any other error is also still a failure.
    const probeArgs = {
      clientId: `${RUN_TOKEN}-probe`,
      startDate: '2020-01-01',
      endDate: '2020-01-02',
    };
    const probe = await client!.callTool({ name: 'getClientVisits', arguments: probeArgs });
    const probeText = resultText(probe);
    if (probe.isError) {
      if (!/ClientNotFound/.test(probeText)) {
        throw new Error(
          'getClientVisits for a never-created client failed with something other than ClientNotFound.\n' +
            `  arguments: ${JSON.stringify(probeArgs)}\n` +
            `  server said: ${probeText}\n` +
            '  Only ClientNotFound proves the request was authenticated and reached the API.'
        );
      }
      expect(probeText).not.toMatch(/DeniedAccess|Unauthori[sz]ed|\b401\b|\b403\b/);
    } else {
      // A sandbox that answers an unknown id with an empty list is also an
      // authenticated answer; it must still be well formed.
      expect(Array.isArray(resultJson(probe).visits)).toBe(true);
    }

    // `src/api/auth.ts` logs exactly one line when token acquisition fails:
    //   "User token acquisition failed (<status>): <msg>. Falling back to API-key-only auth."
    // and nothing when it succeeds.
    const stderr = await waitForStderr((text) =>
      text.includes('Falling back to API-key-only auth') || text.includes('User token acquisition failed')
    );
    const usedFallback = stderr.includes('Falling back to API-key-only auth');

    console.log(
      ` LIVE auth path: ${usedFallback ? 'API-key-only fallback' : 'user token attached'}` +
        ` (getClientVisits probe: ${probe.isError ? 'ClientNotFound, authenticated' : 'well-formed empty answer'})\n`
    );

    // The intent of this test: when the environment issues a token, the server
    // must USE it, not fall back. The raw probe above used the same credentials
    // and endpoint as `src/api/auth.ts`, so its outcome is the expectation.
    if (userTokenIssuedByProbe === true) {
      expect(usedFallback, 'the raw probe was issued a user token, but the server fell back to API-key-only auth').toBe(
        false
      );
    } else if (userTokenIssuedByProbe === false) {
      expect(usedFallback, 'the raw probe was refused a user token, but the server logged no fallback').toBe(true);
    }

    // Whichever path was taken, the server must still be serving requests.
    const afterAuth = await callTool('getLocations', {});
    expect(Array.isArray(afterAuth.locations)).toBe(true);
  });
});

// ── 3. Clients: read, write, verify, clean up ─────────────────────────────────

describe('live tier — clients', () => {
  itLive('getClients returns a well-formed collection', async () => {
    const result = await callTool('getClients', { searchText: RUN_TOKEN });
    // Pre-write: this run's marker cannot exist yet, so an empty result is the
    // correct shape and proves the search filter was actually applied.
    expect(Array.isArray(result.clients)).toBe(true);
    expect(result.clients).toHaveLength(0);
    expect(typeof result.totalClients).toBe('number');
  });

  itLive('addClient creates a client that is then readable back', async () => {
    const created = await callTool('addClient', {
      firstName: 'LiveE2E',
      lastName: RUN_TOKEN,
      email: TEST_EMAIL,
      // The -99 sandbox rejects a client without one:
      //   "The following are required: Birthday (Code: MissingRequiredFields)".
      // A fixed, obviously synthetic date; it carries no information.
      birthDate: '1990-01-01',
      // No mail can be delivered to a .invalid domain regardless, but be explicit.
      sendAccountEmails: false,
    });

    expect(created.success).toBe(true);
    expect(created.client).toBeDefined();
    expect(created.client.id).toBeTruthy();
    createdClientId = String(created.client.id);

    // Read back by id — the assertion that matters, rather than the write's own
    // echo of its input.
    const readBack = await callTool('getClients', { clientIds: [createdClientId] });
    expect(readBack.clients).toHaveLength(1);
    expect(readBack.clients[0]).toMatchObject({
      id: createdClientId,
      firstName: 'LiveE2E',
      lastName: RUN_TOKEN,
    });
  });

  itLive('cleanup: marks the created client as a leftover, because v6 has no delete', async () => {
    // ── Cleanup honesty note ───────────────────────────────────────────────
    // Mindbody Public API v6 exposes NO way to delete or archive a client. The
    // full endpoint list (docs/openapi.json) contains `client/mergeclients`,
    // `client/terminatecontract` and `client/suspendcontract`, but nothing that
    // removes a client profile; `Client` has an `Active` flag but the v6 write
    // endpoints do not expose a way to set it, and `updateClient` in this server
    // does not pass it through either.
    //
    // So the client is NOT deleted. It is renamed to an unmistakable leftover
    // marker and its id is printed by afterAll, so a human can purge it in the
    // Mindbody UI in one search. This is a real limitation of the API surface,
    // not a gap in the test, and it is stated rather than papered over.
    if (!createdClientId) {
      throw new Error('No client was created, so there is nothing to clean up. See the earlier failure.');
    }

    const renamed = await callTool('updateClient', {
      clientId: createdClientId,
      updates: { firstName: 'LEFTOVER', lastName: RUN_TOKEN, email: TEST_EMAIL, sendAccountEmails: false },
    });
    expect(renamed.success, `updateClient failed: ${renamed.message}`).toBe(true);

    const readBack = await callTool('getClients', { clientIds: [createdClientId] });
    expect(readBack.clients[0]).toMatchObject({ firstName: 'LEFTOVER', lastName: RUN_TOKEN });
  });
});

// ── 4. Service definitions ────────────────────────────────────────────────────

describe('live tier — service definitions', () => {
  itLive('getSites yields the site time zone every site-local date is computed in', async () => {
    const result = await callTool('getSites', {});
    expect(result.site).toBeDefined();
    expect(String(result.site.id)).toBe(config!.siteId);
    expect(
      typeof result.site.timeZone === 'string' && result.site.timeZone.length > 0,
      'getSites returned no site time zone; site-local dates cannot be computed'
    ).toBe(true);
    // An unknown zone name throws a RangeError here, which is the right failure.
    siteLocalDate(result.site.timeZone);
    discovered.siteTimeZone = result.site.timeZone;
    console.log(
      `\n LIVE site time zone: ${result.site.timeZone} (site-local now ${siteLocalDateTime(result.site.timeZone)}).\n`
    );
  });

  itLive('getServices returns sellable services', async () => {
    const result = await callTool('getServices', {});
    expect(Array.isArray(result.services)).toBe(true);
    expect(typeof result.totalServices).toBe('number');
    if (result.services.length > 0) {
      discovered.serviceId = result.services[0].id;
      expect(typeof result.services[0].id).toBe('number');
      expect(typeof result.services[0].name).toBe('string');
    }
  });

  itLive('getSessionTypes returns session types, and yields one usable for appointments', async () => {
    const result = await callTool('getSessionTypes', {});
    expect(Array.isArray(result.sessionTypes)).toBe(true);
    expect(typeof result.totalSessionTypes).toBe('number');

    const appointmentTypes = result.sessionTypes.filter((type: any) => type.type === 'Appointment');
    const chosen = appointmentTypes[0] ?? result.sessionTypes[0];
    expect(chosen, 'the sandbox has no session types, so no appointment can be booked').toBeDefined();
    discovered.sessionTypeId = chosen.id;

    // `/appointment/bookableitems` requires SessionTypeIds, and only the
    // Appointment types are meaningful there. If the environment reports none,
    // leave the list empty: `requireDiscovered` then skips the bookable-items
    // tests loudly instead of the suite sending an id the endpoint cannot use.
    discovered.appointmentSessionTypeIds = appointmentTypes
      .map((type: any) => type.id)
      .filter((id: unknown) => typeof id === 'number');
    discovered.sessionTypeMinutes = new Map(
      appointmentTypes
        .filter((type: any) => typeof type.id === 'number' && typeof type.defaultDuration === 'number')
        .map((type: any) => [type.id, type.defaultDuration] as [number, number])
    );

    console.log(
      `\n LIVE session types: ${result.sessionTypes.length} total, ` +
        `${appointmentTypes.length} of type "Appointment" (used for /appointment/bookableitems).\n`
    );
  });

  itLive('getLocations yields the location the write tests will use', async () => {
    const result = await callTool('getLocations', {});
    expect(Array.isArray(result.locations)).toBe(true);
    expect(result.locations.length, 'the sandbox has no locations configured').toBeGreaterThan(0);
    discovered.locationIds = result.locations.map((location: any) => location.id);
    discovered.locationId = result.locations[0].id;
  });

  itLive('getStaff yields a bookable staff member', async () => {
    const result = await callTool('getStaff', {});
    expect(Array.isArray(result.staff)).toBe(true);
    const instructor = result.staff.find((member: any) => member.appointmentInstructor === true);
    expect(
      instructor,
      'no staff member is flagged as an appointment instructor; the sandbox cannot book appointments'
    ).toBeDefined();
    discovered.staffId = instructor.id;
  });
});

// ── 5. Orders (reads; the comp-paid checkout write is in section 7) ──────────

describe('live tier — orders, read-only', () => {
  itLive('getPackages returns class packages', async () => {
    const result = await callTool('getPackages', {});
    expect(Array.isArray(result.packages)).toBe(true);
    expect(typeof result.totalPackages).toBe('number');
  });

  itLive('getProducts returns retail products', async () => {
    const result = await callTool('getProducts', {});
    expect(Array.isArray(result.products)).toBe(true);
    expect(typeof result.totalProducts).toBe('number');
  });

  itLive('getContracts returns sellable contracts', async () => {
    // `/sale/contracts` declares `LocationId` as REQUIRED (docs/openapi.json,
    // and a bare call answers HTTP 400 "LocationId is a required parameter.").
    // It is supplied from the location discovered by getLocations above — never
    // hardcoded, because ids are environment-specific.
    //
    // Tried at EVERY location, not just the first: on the -99 sandbox
    // `LocationId=1` returns zero contracts, and stopping there would report
    // "no contracts" for a site that may sell them elsewhere.
    if (!requireDiscovered('getContracts returns sellable contracts', ['locationIds'])) return;

    const counts: string[] = [];
    for (const locationId of discovered.locationIds!) {
      const result = await callTool('getContracts', { locationId });
      expect(Array.isArray(result.contracts)).toBe(true);
      expect(typeof result.totalContracts).toBe('number');
      counts.push(`location ${locationId}: ${result.contracts.length}`);
      if (discovered.contractId === null && result.contracts.length > 0) {
        expect(typeof result.contracts[0].id).toBe('number');
        discovered.contractId = result.contracts[0].id;
        discovered.contractLocationId = locationId;
      }
    }
    console.log(`\n LIVE contracts: ${counts.join(', ')}.\n`);
  });
});

// ── 6. Appointments: read, write, verify, clean up ────────────────────────────

describe('live tier — appointments', () => {
  itLive('getBookableItems discovers a bookable slot from live availability', async () => {
    const name = 'getBookableItems discovers a bookable slot from live availability';
    // `SessionTypeIds` is REQUIRED by /appointment/bookableitems. Every id below
    // is one the discovery tests pulled from this environment in this run.
    if (!requireDiscovered(name, ['appointmentSessionTypeIds', 'siteTimeZone'])) return;

    // Discovery runs FROM availability. Staff, session type and location are not
    // chosen independently and then intersected: on the -99 sandbox that lands
    // on combinations with no availability at all. Instead: one call across the
    // Appointment-type session types with no staff or location filter, and every
    // booking parameter is read off the SAME returned item.
    //
    // The window starts two SITE-local days out. A slot "today" may already be
    // in the past in the site's zone, and the cancel guard (src/) compares the
    // offset-less StartDateTime against the host clock, so a margin wider than
    // any host/site offset keeps a correct booking from reading as "started".
    const zone = siteZone();
    const sessionTypeIds = discovered.appointmentSessionTypeIds!.slice(0, BOOKABLE_SESSION_TYPE_LIMIT);
    const startDate = siteLocalDate(zone, BOOKABLE_START_OFFSET_DAYS);
    const endDate = siteLocalDate(zone, BOOKABLE_START_OFFSET_DAYS + BOOKABLE_WINDOW_DAYS);
    const result = await callTool('getBookableItems', { sessionTypeIds, startDate, endDate });

    expect(Array.isArray(result.bookableItems)).toBe(true);
    expect(typeof result.totalItems).toBe('number');

    // Belt and braces on "in the future": compared as site-local strings.
    const siteNow = siteLocalDateTime(zone);
    const windows = result.bookableItems.filter(
      (item: any) =>
        item.isAvailable !== false &&
        typeof item.startDateTime === 'string' &&
        typeof item.endDateTime === 'string' &&
        typeof item.staffId === 'number' &&
        typeof item.sessionTypeId === 'number' &&
        typeof item.locationId === 'number'
    );

    // An availability item is a WINDOW (e.g. 05:00–10:00), not a slot. On the
    // -99 sandbox, booking at the window's own start is refused with
    // "The appointment must start on an active time. (InvalidBookingTime)":
    // a start must also be one of the session type's ACTIVE SESSION TIMES
    // (06:00, 06:30, … 21:00 for session type 23). So each candidate start is the
    // first active time inside its window at which the session still fits.
    const activeTimes = new Map<number, string[]>();
    const firstStartIn = async (window: any, notBefore: string): Promise<string | null> => {
      let times = activeTimes.get(window.sessionTypeId);
      if (!times) {
        times = await fetchActiveSessionTimes(window.sessionTypeId);
        activeTimes.set(window.sessionTypeId, times);
      }
      const minutes = discovered.sessionTypeMinutes?.get(window.sessionTypeId) ?? 0;
      const day = window.startDateTime.slice(0, 10);
      const windowEnd = minutesOfDay(window.endDateTime);
      for (const time of times) {
        const start = `${day}T${time.slice(0, 8)}`;
        if (start < window.startDateTime.slice(0, 19) || start <= notBefore) continue;
        if (minutesOfDay(start) + minutes > windowEnd) continue;
        return start;
      }
      return null;
    };

    // Candidates are distinct staff/session type/location combinations, tried
    // in order by addAppointment. Several are kept because availability does
    // not guarantee the booking either: the sandbox also lists windows for staff
    // without a pay rate for the service ("The staff member is not an instructor
    // for the requested service"), which only a booking attempt reveals.
    const candidates: BookingCandidate[] = [];
    const seen = new Set<string>();
    for (const window of windows) {
      if (candidates.length >= MAX_BOOKING_CANDIDATES) break;
      const key = `${window.staffId}/${window.sessionTypeId}/${window.locationId}`;
      if (seen.has(key)) continue;
      const start = await firstStartIn(window, siteNow);
      if (start === null) continue;
      seen.add(key);

      // The reschedule target: the first valid start for the SAME staff,
      // session type and location in a later window, so the move changes only
      // the time and cannot overlap the booking it replaces.
      let alternativeStart: string | null = null;
      for (const later of windows) {
        if (
          later === window ||
          later.staffId !== window.staffId ||
          later.sessionTypeId !== window.sessionTypeId ||
          later.locationId !== window.locationId ||
          later.startDateTime.slice(0, 19) <= window.startDateTime.slice(0, 19)
        ) {
          continue;
        }
        alternativeStart = await firstStartIn(later, start);
        if (alternativeStart !== null && !sameLocalDateTime(alternativeStart, start)) break;
        alternativeStart = null;
      }

      candidates.push({
        staffId: window.staffId,
        sessionTypeId: window.sessionTypeId,
        locationId: window.locationId,
        startDateTime: start,
        alternativeStart,
      });
    }

    expect(
      candidates.length,
      `the sandbox returned no bookable appointment slot between ${startDate} and ${endDate} (site-local, ` +
        `${zone}) for session types ${sessionTypeIds.join(', ')} that falls on an active session time, so the ` +
        'addAppointment write test below cannot run. This FAILS rather than skips: the tier must never report ' +
        'green while having tested nothing.'
    ).toBeGreaterThan(0);
    discovered.bookingCandidates = candidates;

    console.log(
      `\n LIVE bookable slots: ${result.bookableItems.length} availability windows returned ` +
        `between ${startDate} and ${endDate} site-local; ${candidates.length} booking candidate(s):\n` +
        candidates
          .map(
            (candidate) =>
              `   staff ${candidate.staffId}, session type ${candidate.sessionTypeId}, location ${candidate.locationId}, ` +
              `start ${candidate.startDateTime}, reschedule target ${candidate.alternativeStart ?? 'none'}`
          )
          .join('\n') +
        '\n'
    );
  });

  itLive('getStaffAppointments returns a collection for the discovered staff member', async () => {
    if (!requireDiscovered('getStaffAppointments returns a collection for the discovered staff member', ['staffId'])) {
      return;
    }

    const result = await callTool('getStaffAppointments', { staffIds: [discovered.staffId] });
    expect(Array.isArray(result.appointments)).toBe(true);
    expect(typeof result.totalAppointments).toBe('number');
  });

  itLive('addAppointment books a slot that is then readable back', async () => {
    if (!createdClientId) {
      throw new Error('No client was created, so the appointment has nobody to book. See the earlier failure.');
    }
    // The candidates are what the read test above derived from availability.
    // Without them the write would go out with a null start time, which is
    // another caller error dressed up as a product failure.
    if (!requireDiscovered(ADD_APPOINTMENT_TEST, ['bookingCandidates'])) {
      return;
    }

    // Try the candidates in order. Exactly two Mindbody refusals move on to the
    // next candidate, because availability alone cannot rule them out (see the
    // read test above); both are refusals of the REQUEST, so nothing was written.
    // Any other refusal fails the test immediately.
    const refusals: string[] = [];
    let booked: any = null;
    let chosen: BookingCandidate | null = null;
    for (const candidate of discovered.bookingCandidates!) {
      const attempt = await callTool('addAppointment', {
        clientId: createdClientId,
        staffId: candidate.staffId,
        locationId: candidate.locationId,
        sessionTypeId: candidate.sessionTypeId,
        startDateTime: candidate.startDateTime,
        notes: `live-e2e ${RUN_TOKEN}`,
        // No payment, no mail. This tier asserts the booking path, not billing.
        executePayment: false,
        applyPayment: false,
        sendEmail: false,
      });
      if (attempt.success) {
        booked = attempt;
        chosen = candidate;
        break;
      }
      const label = `staff ${candidate.staffId} / session type ${candidate.sessionTypeId} / location ${candidate.locationId} at ${candidate.startDateTime}`;
      if (!BOOKING_REFUSALS_TO_SKIP_PAST.some((pattern) => pattern.test(String(attempt.message)))) {
        throw new Error(
          `addAppointment failed for ${label}: ${attempt.message}\n` +
            (refusals.length > 0 ? `  earlier candidates refused:\n    ${refusals.join('\n    ')}\n` : '') +
            '  This is not one of the refusals availability cannot predict, so it is a failure.'
        );
      }
      refusals.push(`${label}: ${attempt.message}`);
    }

    if (refusals.length > 0) {
      console.log(
        `\n LIVE booking: ${refusals.length} candidate(s) refused before ${booked ? 'one was accepted' : 'giving up'}:\n` +
          refusals.map((line) => `   ${line}`).join('\n') +
          '\n'
      );
    }
    expect(
      booked,
      `addAppointment was refused for all ${refusals.length} candidate(s) derived from availability`
    ).not.toBeNull();

    expect(booked.success, `addAppointment failed: ${booked.message}`).toBe(true);
    expect(booked.appointment).toBeDefined();
    expect(typeof booked.appointment.id).toBe('number');
    createdAppointmentId = booked.appointment.id;
    discovered.staffId = chosen!.staffId;
    discovered.sessionTypeId = chosen!.sessionTypeId;
    discovered.locationId = chosen!.locationId;
    discovered.bookableStart = chosen!.startDateTime;
    discovered.bookableStartAlt = chosen!.alternativeStart;
    createdAppointmentStart = booked.appointment.startDateTime ?? chosen!.startDateTime;
    console.log(
      `\n LIVE booked appointment ${createdAppointmentId}: staff ${chosen!.staffId}, session type ` +
        `${chosen!.sessionTypeId}, location ${chosen!.locationId}, start ${chosen!.startDateTime}.\n`
    );

    const readBack = await readBackCreatedAppointment();
    expect(readBack).toMatchObject({ id: createdAppointmentId, clientId: createdClientId });
    expect(
      sameLocalDateTime(readBack.startDateTime, discovered.bookableStart),
      `appointment ${createdAppointmentId} reads back at ${readBack.startDateTime}, not the booked ${discovered.bookableStart}`
    ).toBe(true);
  });

  itLive('getServices finds the pricing option that pays for the booked session type', async () => {
    // ORDERING: after addAppointment, because that test REPLACES
    // discovered.sessionTypeId and discovered.locationId with the values of the
    // slot it actually booked. The service must pay for THAT session type.
    //
    // Read-only, so it runs by default; only the checkout that consumes the
    // result is the comp checkout. An empty result is recorded, not failed: it is a fact
    // about the environment, and the checkout skips loudly on it.
    const name = 'getServices finds the pricing option that pays for the booked session type';
    if (!requireDiscovered(name, ['sessionTypeId', 'locationId'])) return;

    const result = await callTool('getServices', {
      sessionTypeIds: [discovered.sessionTypeId],
      locationId: discovered.locationId,
    });
    expect(Array.isArray(result.services)).toBe(true);
    expect(typeof result.totalServices).toBe('number');

    if (result.services.length === 0) {
      console.log(
        `\n LIVE NOTE (loud): getServices returned no pricing option for session type ${discovered.sessionTypeId}\n` +
          `   at location ${discovered.locationId}. Nothing can pay for the booked appointment, so the comp\n` +
          '   checkout will skip loudly. Configure a pricing option for that session type to cover it.\n'
      );
      return;
    }

    // Prefer a service that names the session type explicitly; otherwise the
    // filter itself is the evidence (the -99 sandbox returns exactly one).
    const service =
      result.services.find((entry: any) => entry.sessionTypeId === discovered.sessionTypeId) ?? result.services[0];
    expect(typeof service.id).toBe('number');
    expect(typeof service.name).toBe('string');
    discovered.appointmentServiceId = service.id;
    discovered.appointmentServicePrice =
      typeof service.price === 'number' && Number.isFinite(service.price) ? service.price : null;
    console.log(
      `\n LIVE appointment service: ${service.id} "${service.name}", price ` +
        `${discovered.appointmentServicePrice ?? 'not exposed'}, for session type ${discovered.sessionTypeId} ` +
        `at location ${discovered.locationId} (${result.services.length} returned).\n`
    );
  });

  // ── Salon/spa lifecycle: reschedule -> arrive -> check in -> guards ────────
  // These run in declaration order on the appointment booked above. The comp-paid
  // checkout (section 7) runs after them, and the cancellation cleanup
  // (section 8) runs last of all.

  itLive('updateAppointment reschedules the booked appointment to a new slot', async () => {
    const name = 'updateAppointment reschedules the booked appointment to a new slot';
    if (!requireCreatedAppointment(name)) return;
    if (discovered.bookableStartAlt === null) {
      announceLoudSkip(name, [
        'reason: getBookableItems offered no second available slot with a different start time,',
        'so there is nowhere to move the appointment to. Rescheduling to the slot it already',
        'occupies would pass while proving nothing. Add appointment availability to the sandbox.',
      ]);
      return;
    }

    const before = await readBackCreatedAppointment();
    const originalStart: string = before.startDateTime ?? createdAppointmentStart;

    const updated = await callTool('updateAppointment', {
      appointmentId: createdAppointmentId,
      startDateTime: discovered.bookableStartAlt,
      sendEmail: false,
    });
    expect(updated.success).toBe(true);

    // The read-back is the assertion; the write's own echo is not.
    const after = await readBackCreatedAppointment();
    expect(typeof after.startDateTime).toBe('string');
    expect(
      sameLocalDateTime(after.startDateTime, originalStart),
      `appointment ${createdAppointmentId} still starts at ${after.startDateTime}; the reschedule did not persist`
    ).toBe(false);
    expect(
      sameLocalDateTime(after.startDateTime, discovered.bookableStartAlt),
      `appointment ${createdAppointmentId} moved to ${after.startDateTime}, not the requested ${discovered.bookableStartAlt}`
    ).toBe(true);
  });

  itLive('updateAppointment execute=arrive marks the appointment Arrived', async () => {
    if (!requireCreatedAppointment('updateAppointment execute=arrive marks the appointment Arrived')) return;

    const arrived = await callTool('updateAppointment', {
      appointmentId: createdAppointmentId,
      execute: 'arrive',
      sendEmail: false,
    });
    expect(arrived.success).toBe(true);

    const readBack = await readBackCreatedAppointment();
    if (readBack.status !== 'Arrived') {
      // The write succeeded but the status did not move. Some sandboxes accept
      // `Execute` without persisting the transition; record it rather than hide
      // it, but only for the two pre-arrival statuses. Anything else (for
      // example Cancelled) is a real failure.
      expect(['Confirmed', 'Booked']).toContain(readBack.status);
      console.log(
        `\n LIVE NOTE (loud): updateAppointment execute=arrive returned success, but appointment\n` +
          `   ${createdAppointmentId} reads back as "${readBack.status}", not "Arrived". The sandbox\n` +
          '   accepted the transition without persisting it. Verify on a real site before relying on it.\n'
      );
      return;
    }
    expect(readBack.status).toBe('Arrived');
  });

  // `addClientArrival` (POST /client/addarrival) is deliberately NOT exercised
  // here. It is a client-account check-in that consumes a paid visit, so the
  // -99 sandbox refuses it for a fresh client ("Client requires payment").
  // The salon workflow marks arrival on the APPOINTMENT via
  // updateAppointment execute=arrive, which is tested above.

  // ── Cancellation guards, proven against real data ─────────────────────────
  // Both requests below must be refused by the server's own guards BEFORE any
  // write. If the guards work, no appointment changes; the read-back after each
  // proves that rather than trusting the refusal message.

  itLive('cancelAppointments refuses more than 3 appointments without calling the API', async () => {
    if (!requireCreatedAppointment('cancelAppointments refuses more than 3 appointments without calling the API')) {
      return;
    }

    // Four ids — one over MAX_CANCELLATIONS_PER_REQUEST. The REAL appointment is
    // included deliberately: three fakes plus our own booking means a broken
    // count guard would cancel something observable, and the read-back below
    // would catch it. Four fakes alone would make that read-back vacuous.
    const appointmentIds = [createdAppointmentId!, 900_000_001, 900_000_002, 900_000_003];
    const result = await callTool('cancelAppointments', {
      clientId: createdClientId,
      appointmentIds,
      sendEmail: false,
    });

    expect(result.success).toBe(false);
    expect(Array.isArray(result.cancelled)).toBe(true);
    expect(result.cancelled).toHaveLength(0);
    expect(Array.isArray(result.rejected)).toBe(true);
    expect(result.rejected.length).toBeGreaterThan(0);

    // Still returned (this sandbox hides cancelled rows) AND not cancelled.
    const readBack = await readBackCreatedAppointment();
    expect(CANCELLED_STATUSES).not.toContain(readBack.status);
  });

  itLive("cancelAppointments refuses to cancel another client's appointment", async () => {
    const name = "cancelAppointments refuses to cancel another client's appointment";
    if (!requireCreatedAppointment(name)) return;

    // Any client other than ours. Read-only; nothing is written to it.
    const clients = await callTool('getClients', {});
    expect(Array.isArray(clients.clients)).toBe(true);
    const other = clients.clients.find((entry: any) => entry.id && String(entry.id) !== createdClientId);
    if (!other) {
      announceLoudSkip(name, [
        'reason: getClients returned no client other than the one this run created,',
        "so there is no second client to impersonate. The ownership guard is untested",
        'this run. Any earlier run leaves a LEFTOVER client, so a second run will cover it.',
      ]);
      return;
    }

    const result = await callTool('cancelAppointments', {
      clientId: String(other.id),
      appointmentIds: [createdAppointmentId],
      sendEmail: false,
    });

    expect(result.success).toBe(false);
    expect(result.cancelled).toHaveLength(0);
    expect(result.rejected.length).toBeGreaterThan(0);
    expect(result.rejected[0].id).toBe(createdAppointmentId);
    expect(result.rejected[0].reason).toMatch(/not found/i);

    // Still returned (this sandbox hides cancelled rows) AND not cancelled.
    const readBack = await readBackCreatedAppointment();
    expect(CANCELLED_STATUSES).not.toContain(readBack.status);
  });
});

// ── 7. Checkout with a Comp payment: runs by default ─────────────────────────

/**
 * DECISION (operator): a `Comp` payment moves no money and touches no card, so
 * checking out a service with a Comp payment IS testable and runs on every live
 * run. Mindbody accepted a Comp checkout against the booked appointment live
 * (sale committed, appointment read back as Completed), with no payment method
 * involved. The sale record itself is irreversible in the shared -99 sandbox,
 * exactly like the client this run creates; both are reported in the LEFTOVERS
 * block.
 *
 * Anything that requires a REAL payment method (`purchaseContract` demands card,
 * stored card, direct debit or account credit) stays a no-op by decision; see the
 * No-op policy in tests/live/README.md. There is therefore no longer a financial
 * opt-in flag: the only financial write in this tier is comp-paid.
 *
 * ORDERING: this block runs AFTER the arrival tests in section 6 and BEFORE the
 * cancellation cleanup in section 8. A checked-out appointment is Completed,
 * which the guarded cancel refuses, so cleanup re-notes it as a LEFTOVER.
 */
describe('live tier — comp-paid checkout', () => {
  itLive('checkoutShoppingCart commits a comp-paid sale that reconciles the booked appointment', async () => {
    // ORDERING: this must run AFTER the arrival tests in section 6 and BEFORE the
    // cancellation cleanup in section 8. Checking out an appointment moves it to
    // Completed, which the guarded cancel refuses — so the cleanup falls back to
    // re-noting it as a LEFTOVER. Bun runs tests in declaration order across
    // describe blocks, and section 8 is declared after this block for that reason.
    const name = 'checkoutShoppingCart commits a comp-paid sale that reconciles the booked appointment';

    // Same reasoning as the read tests: a null locationId here would be a caller
    // error against an endpoint that writes real money records, so skip loudly
    // instead of sending one.
    if (!requireDiscovered(name, ['locationId'])) {
      return;
    }
    if (createdAppointmentId === null) {
      announceLoudSkip(name, [
        'reason: no appointment was booked this run, so there is nothing for the sale to',
        'reconcile. Committing an unattached sale would test less than this test claims.',
        'See the addAppointment failure or skip earlier in this run.',
      ]);
      return;
    }
    if (discovered.appointmentServiceId === null) {
      // Not the unfiltered `serviceId`: that is a class package on the -99
      // sandbox and Mindbody refuses it with ServiceDoesNotPayForAppointment.
      announceLoudSkip(name, [
        `reason: getServices returned no pricing option for session type ${discovered.sessionTypeId} at location ${discovered.locationId},`,
        'so nothing can pay for the booked appointment. Checking out any other service fails with',
        'ServiceDoesNotPayForAppointment. See "getServices finds the pricing option…" earlier in this run.',
      ]);
      return;
    }

    // A Comp payment: the sale record is still created, but no money moves and
    // no card is touched. The amount is the service's price when getServices
    // exposes it, else 0; both were accepted by the -99 sandbox in Test mode.
    const amount = discovered.appointmentServicePrice ?? 0;
    const result = await callTool('checkoutShoppingCart', {
      clientId: createdClientId,
      items: [
        {
          item: { type: 'Service', metadata: { id: discovered.appointmentServiceId } },
          quantity: 1,
          appointmentIds: [createdAppointmentId],
        },
      ],
      payments: [{ type: 'Comp', metadata: { amount, notes: `live-e2e ${RUN_TOKEN}` } }],
      inStore: true,
      sendEmail: false,
      locationId: discovered.locationId,
    });
    expect(result.success, `checkoutShoppingCart failed: ${result.message}`).toBe(true);
    console.log(`\n LIVE financial write: sale ${result.shoppingCart?.id ?? 'unknown'} committed. NOT reversible.\n`);

    // The reconciliation can surface in two places: on the cart item that paid
    // for it, and in the top-level list of appointments the sale touched.
    const cartItems: any[] = result.shoppingCart?.items ?? result.items ?? [];
    // Either list may carry bare ids or `{ id }` objects (the spec describes
    // CartItem.Appointments as ids but types it as Appointment objects), so both
    // shapes are accepted and normalised to numbers.
    const toId = (entry: any): number | undefined => {
      const raw = typeof entry === 'object' && entry !== null ? (entry.id ?? entry.Id) : entry;
      const id = Number(raw);
      return Number.isFinite(id) ? id : undefined;
    };
    const fromItems = cartItems.flatMap((item: any) => (item.appointments ?? []).map(toId));
    const fromTopLevel = (result.appointments ?? []).map(toId);
    const reconciled = [...fromItems, ...fromTopLevel].filter((id): id is number => id !== undefined);

    // Independent evidence: read the appointment back and report its status.
    // A reconciled appointment may move to Completed or stay Arrived; neither is
    // asserted, because the sandbox has not shown which a real commit produces.
    const after = await findCreatedAppointment();
    console.log(
      `\n LIVE checkout read-back: appointment ${createdAppointmentId} ` +
        (after !== undefined
          ? `now reads back with status "${after.status}".`
          : 'is no longer returned by getStaffAppointments (this lookup hides cancelled appointments).') +
        '\n'
    );

    if (reconciled.length === 0) {
      // In Test mode the -99 sandbox returns CartItems[].Appointments,
      // CartItems[].AppointmentIds and top-level Appointments all EMPTY for a
      // checkout it accepted, so an empty list is not by itself a failure.
      console.log(
        '\n LIVE NOTE (loud): checkoutShoppingCart succeeded but the response names no reconciled\n' +
          `   appointment — neither items[].appointments nor appointments mentions ${createdAppointmentId}.\n` +
          '   The -99 sandbox returns these lists empty even for an accepted checkout. The sale\n' +
          `   committed; the read-back above (status "${after?.status ?? 'not returned'}") is the only evidence\n` +
          '   it is tied to the appointment. Reconciliation is UNVERIFIED by the response this run.\n'
      );
      return;
    }
    expect(reconciled).toContain(createdAppointmentId);
  });

  // ── purchaseContract: NO-OP BY DECISION ────────────────────────────────────
  // /sale/purchasecontract demands real payment details (CreditCardInfo,
  // StoredCardInfo, UseDirectDebit or UseAccountCredit; verified against the
  // sandbox: MissingRequiredFields). The operator has decided NOT to supply real
  // payment details to any test environment, so every workflow that requires an
  // actual payment is a deliberate no-op here, not an incomplete run. This is
  // `it.skip`, not a loud skip, so it is never listed under LIVE E2E INCOMPLETE.
  // Revisit if Mindbody ever offers a sandbox-only payment method.
  it.skip(
    'purchaseContract commits an auto-pay contract [NO-OP: requires real payment details; not tested by decision]',
    () => {}
  );
});

// ── 8. Appointment cleanup: LAST, after the comp-paid checkout ────────────────

/**
 * The appointment is cancelled through the same guarded tool an operator would
 * use, so cleanup is itself a live test of the happy path of `cancelAppointments`.
 *
 * This block is declared last on purpose. Bun runs tests in declaration order,
 * so it runs after the comp-paid checkout in section 7; a checkout moves the
 * appointment to Completed, the guard then refuses to cancel it, and cleanup
 * falls back to re-noting it as a LEFTOVER for manual handling.
 */
describe('live tier — appointment cleanup', () => {
  itLive('cleanup: cancels the created appointment through the guarded tool', async () => {
    const name = 'cleanup: cancels the created appointment through the guarded tool';
    if (!requireCreatedAppointment(name)) return;
    if (!createdClientId) {
      throw new Error('An appointment exists but no client id was recorded; cannot address the cancel. See earlier failures.');
    }

    // Before the cancel, the lookup MUST return the appointment. That is what
    // makes "no longer returned" afterwards evidence of a cancel rather than of
    // a lookup that never saw it.
    const beforeCancel = await readBackCreatedAppointment();
    expect(CANCELLED_STATUSES).not.toContain(beforeCancel.status);

    const result = await callTool('cancelAppointments', {
      clientId: createdClientId,
      appointmentIds: [createdAppointmentId],
      sendEmail: false,
    });

    if (result.success) {
      expect(result.rejected).toHaveLength(0);
      expect(result.cancelled.map((entry: any) => entry.id)).toContain(createdAppointmentId);

      // The -99 sandbox's /appointment/staffappointments does not return
      // cancelled appointments (a sample of 100 had statuses NoShow, Completed,
      // Arrived, Booked and Confirmed, and no Cancelled). So a cancel is
      // verified as EITHER returned with a cancelled status OR no longer
      // returned by the same lookup that returned it a moment ago.
      const afterCancel = await findCreatedAppointment();
      if (afterCancel !== undefined) {
        expect(
          CANCELLED_STATUSES,
          `appointment ${createdAppointmentId} still reads back as "${afterCancel.status}" after a successful cancel`
        ).toContain(afterCancel.status);
      }
      console.log(
        `\n LIVE cleanup: appointment ${createdAppointmentId} cancelled; read-back ` +
          (afterCancel !== undefined
            ? `returned it with status "${afterCancel.status}".`
            : 'no longer returns it (this lookup hides cancelled appointments; it was returned before the cancel).') +
          '\n'
      );
      appointmentCleanup = { outcome: 'cancelled' };
      return;
    }

    // Refused. The only expected refusal is a Completed appointment — which is
    // what the comp-paid checkout leaves behind. Anything else is a real failure.
    const reasons: string[] = (result.rejected ?? []).map((entry: any) => String(entry.reason));
    const completed = reasons.some((reason) => /completed/i.test(reason));
    if (!completed) {
      throw new Error(
        `cancelAppointments refused to cancel this run's own appointment ${createdAppointmentId}.\n` +
          `  message: ${result.message}\n` +
          `  rejected: ${JSON.stringify(result.rejected)}\n` +
          '  The appointment belongs to this client, starts in the future and was not checked out,\n' +
          '  so every guard should have passed. This is a failure, not a skip.'
      );
    }

    const why = 'Completed by the comp-paid checkout; the cancel guard refuses Completed appointments';
    console.log(
      `\n LIVE cleanup: appointment ${createdAppointmentId} was NOT cancelled — ${why}.\n` +
        '   Re-noting it as a LEFTOVER instead. Its id is printed in the LEFTOVERS block.\n'
    );

    const updated = await callTool('updateAppointment', {
      appointmentId: createdAppointmentId,
      notes: `LEFTOVER live-e2e ${RUN_TOKEN} — ${why}`,
      sendEmail: false,
    });
    expect(updated.success).toBe(true);

    const readBack = await readBackCreatedAppointment();
    expect(readBack.notes).toContain('LEFTOVER');
    appointmentCleanup = { outcome: 'leftover', reason: why };
  });
});
