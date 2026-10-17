/**
 * A local stub of the Mindbody public API v6, for end-to-end tests.
 *
 * The E2E suite spawns the real MCP server as a subprocess and points it at this
 * stub through `MINDBODY_API_URL`. Nothing here talks to the network: it is a
 * plain `node:http` server bound to 127.0.0.1 on an ephemeral port.
 *
 * It serves the OAuth user-token endpoint as well as the API endpoints, using the
 * exact URLs the server builds in `src/api/auth.ts` and `src/api/client.ts`.
 *
 * Scope: five business domains, read and write, plus the site record.
 *
 *   Clients              GET  /client/clients              clientManagement.getClientsTool
 *                        POST /client/addclient             clientManagement.addClientTool
 *                        POST /client/updateclient          clientManagement.updateClientTool
 *                        GET  /client/clientvisits         clientManagement.getClientVisitsTool
 *                        GET  /client/clientaccountbalances clientManagement.getClientAccountBalancesTool
 *                        GET  /client/activeclientmemberships clientManagement.getClientMembershipsTool
 *                        GET  /client/clientschedule        enrollmentManagement.getClientEnrollmentsTool,
 *                                                             enrollmentManagement.cancelEnrollmentVisitsTool (lookup)
 *   Enrollments          GET  /enrollment/enrollments       enrollmentManagement.getEnrollmentsTool
 *                        POST /enrollment/addclienttoenrollment enrollmentManagement.addClientToEnrollmentTool
 *                        POST /class/removeclientfromclass  enrollmentManagement.cancelEnrollmentVisitsTool (write)
 *                        GET  /class/classes (ClassIds[])   enrollmentManagement (visit -> class resolution)
 *                        POST /client/addarrival            clientManagement.addClientArrivalTool
 *   Classes and staff    GET  /class/classes  (page cap 3)  classManagement.getClassesTool,
 *                                                             teacherSchedule.getTeacherScheduleTool
 *                        GET  /class/classdescriptions      classManagement.getClassDescriptionsTool
 *                        GET  /class/waitlistentries        classManagement.getWaitlistEntriesTool
 *                        GET  /class/classschedules         classManagement.getClassSchedulesTool
 *                        GET  /staff/staff    (page cap 1)  teacherSchedule.getTeacherScheduleTool
 *   Orders               GET  /sale/packages                salesManagement.getPackagesTool
 *                        GET  /sale/products                salesManagement.getProductsTool
 *                        GET  /sale/contracts               salesManagement.getContractsTool
 *                        POST /sale/checkoutshoppingcart    salesManagement.checkoutShoppingCartTool
 *                        POST /sale/purchasecontract        salesManagement.purchaseContractTool
 *   Appointments         GET  /appointment/staffappointments  appointmentManagement.getStaffAppointmentsTool
 *                                                             appointmentManagement.cancelAppointmentsTool (lookup)
 *                        GET  /appointment/bookableitems      appointmentManagement.getBookableItemsTool
 *                        GET  /appointment/activesessiontimes appointmentManagement.getActiveSessionTimesTool
 *                        POST /appointment/addappointment    appointmentManagement.addAppointmentTool
 *                        POST /appointment/updateappointment appointmentManagement.updateAppointmentTool
 *                                                             appointmentManagement.cancelAppointmentsTool (Execute)
 *   Service definitions  GET  /sale/services                salesManagement.getServicesTool
 *                        GET  /site/sessiontypes            siteManagement.getSessionTypesTool
 *   Site                 GET  /site/sites                   siteManagement.getSitesTool
 *                                                             siteTime.getSiteTimeZone (TimeZone, before
 *                                                             cancelAppointments and date-range defaults)
 *                        GET  /site/locations               siteManagement.getLocationsTool
 *                        GET  /site/programs                siteManagement.getProgramsTool
 *   OAuth                POST /usertoken/issue              auth.ts (token fetch)
 *
 * Every fixture below uses Mindbody's own PascalCase field names, because the
 * tools read those exact properties and re-emit them lowerCamelCased. A fixture
 * that misspelled `TotalResults` would not fail the tools — it would make them
 * emit `undefined` — so each tool's transform is asserted against the values the
 * transform actually consumes.
 *
 * Pagination. Every GET list route honours `Limit` and `Offset` through the
 * shared `paginate()` helper and answers with a spec-shaped
 * `PaginationResponse { RequestedLimit, RequestedOffset, PageSize, TotalResults }`
 * (docs/openapi.json; there is no `PageNumber`). A missing `Limit` means
 * Mindbody's default of 100. Routes marked "page cap N" above additionally serve
 * at most N rows per page whatever `Limit` asks for, while echoing the asked
 * `Limit` as `RequestedLimit` — the case where a client that stops on "page
 * shorter than Limit" would silently truncate. Those caps are what let the E2E
 * suite prove the server walks every page with an advancing `Offset`.
 *
 * Any other request is a hard 404 with a Mindbody-shaped `Error` envelope, so an
 * unexpected endpoint call fails loudly instead of silently returning empty data.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { siteDateStringPlusDays } from '../../src/utils/siteTime.js';

/** Path prefix the server appends to whatever MINDBODY_API_URL points at. */
export const API_PREFIX = '/public/v6';

export interface StubRequest {
  method: string;
  path: string;
  /** Last value per key. Use `queryAll` for repeated keys such as `Ids[]`. */
  query: Record<string, string>;
  /** Every value per key, in order, for array parameters. */
  queryAll: Record<string, string[]>;
  headers: Record<string, string>;
  body: unknown;
  /** Raw `Host` header, so tests can prove every request stayed on loopback. */
  host: string | undefined;
}

export interface StubResponse {
  status?: number;
  body: unknown;
}

type RouteHandler = (request: StubRequest) => StubResponse;

/** Mindbody's documented default `Limit` when a request sends none. */
export const STUB_DEFAULT_LIMIT = 100;

/** Spec-shaped `PaginationResponse` (docs/openapi.json). */
export interface StubPaginationResponse {
  RequestedLimit: number;
  RequestedOffset: number;
  PageSize: number;
  TotalResults: number;
}

/**
 * Slice `items` by the request's `Limit`/`Offset`, the way Mindbody does.
 *
 * `maxPageSize` simulates a server-side cap: at most that many rows are served
 * per page whatever `Limit` asks for, while `RequestedLimit` still echoes the
 * asked value.
 */
export function paginate<T>(
  items: readonly T[],
  query: Record<string, string>,
  maxPageSize: number = Infinity
): { page: T[]; PaginationResponse: StubPaginationResponse } {
  const limit = query.Limit === undefined ? STUB_DEFAULT_LIMIT : Number(query.Limit);
  const offset = query.Offset === undefined ? 0 : Number(query.Offset);
  const page = items.slice(offset, offset + Math.min(limit, maxPageSize));
  return {
    page,
    PaginationResponse: {
      RequestedLimit: limit,
      RequestedOffset: offset,
      PageSize: page.length,
      TotalResults: items.length,
    },
  };
}

/** `{ [key]: page, PaginationResponse }` for a 200 list response. */
function listResponse<T>(
  key: string,
  items: readonly T[],
  query: Record<string, string>,
  maxPageSize?: number
): StubResponse {
  const { page, PaginationResponse } = paginate(items, query, maxPageSize);
  return { status: 200, body: { [key]: page, PaginationResponse } };
}

/** Page caps for the routes that prove multi-page walks end to end. */
export const STUB_PAGE_CAPS = {
  classes: 3,
  staff: 1,
} as const;

/**
 * Decides what `/usertoken/issue` returns. `attempt` is 1-based, so a responder
 * can hand out a different token on each call — which is how the expiry-skew test
 * proves the cached token really was discarded rather than reused.
 */
export type TokenResponder = (attempt: number) => StubResponse;

interface Route {
  method: string;
  path: string;
  handler: RouteHandler;
}

/** Deterministic fixture values. Tests assert against these exact values. */
export const STUB_FIXTURES = {
  apiKey: 'e2e-fake-api-key',
  siteId: '-99',
  sourceName: 'e2e-fake-source-name',
  sourcePassword: 'e2e-fake-source-password',
  accessToken: 'e2e-stub-access-token',
  /** Well past the 60s skew `auth.ts` subtracts, so a cached token stays valid. */
  accessTokenExpiry: '2099-01-01T00:00:00.000Z',

  // ── Site ───────────────────────────────────────────────────────────────────
  /**
   * The site's IANA zone. Deliberately the sandbox's real zone, and deliberately
   * not tied to the host's TZ, so the guard fixtures below prove the server
   * converts with the SITE's zone wherever the test runs.
   */
  siteTimeZone: 'America/Los_Angeles',
  site: {
    Id: -99,
    Name: 'E2E Stub Studio',
    Description: 'Stub site for end-to-end tests',
    LogoUrl: 'https://example.invalid/logo.png',
    PageColor1: '#000000',
    PageColor2: '#111111',
    PageColor3: '#222222',
    PageColor4: '#333333',
    AcceptsVisa: true,
    AcceptsMasterCard: true,
    AcceptsDiscover: false,
    AcceptsAmericanExpress: true,
    ContactEmail: 'studio@example.invalid',
    ESI: 'stub-esi',
    TaxInclusivePrices: false,
    Currency: 'USD',
    CountryCode: 'US',
    TimeZone: 'America/Los_Angeles',
    TotalLocations: 1,
  },

  // ── Clients ────────────────────────────────────────────────────────────────
  clientId: 'c-1001',
  client: {
    Id: 'c-1001',
    FirstName: 'Grace',
    LastName: 'Hopper',
    Email: 'grace@example.invalid',
    MobilePhone: '555-0111',
    HomePhone: '555-0112',
    BirthDate: '1985-12-09',
    AddressLine1: '42 Compiler Way',
    City: 'Arlington',
    State: 'VA',
    PostalCode: '22201',
    Country: 'US',
    IsProspect: false,
    SendAccountEmails: true,
    LiabilityRelease: { IsReleased: true, AgreementDate: '2024-01-15' },
    EmergencyContactInfoName: 'Alan Turing',
    EmergencyContactInfoPhone: '555-0199',
    EmergencyContactInfoRelationship: 'Spouse',
    CreationDate: '2024-01-15T10:00:00',
    Status: 'Active',
    MembershipIcon: 4,
  },
  prospectId: 'c-1002',
  prospect: {
    Id: 'c-1002',
    FirstName: 'Alan',
    LastName: 'Turing',
    Email: 'alan@example.invalid',
    MobilePhone: '555-0121',
    HomePhone: '555-0121',
    BirthDate: '1912-06-23',
    AddressLine1: '1 Wilmslow Road',
    City: 'Manchester',
    State: 'ENG',
    PostalCode: 'M13 9PL',
    Country: 'GB',
    IsProspect: true,
    SendAccountEmails: false,
    CreationDate: '2026-02-28T08:30:00',
    Status: 'Lead',
    MembershipIcon: 0,
  },

  // Visits: one attended, one late-cancelled. `getClientVisitsTool` derives three
  // different counts from `SignedIn`/`LateCancelled`, so a fixture that set only
  // one flag could not tell those branches apart.
  visitAttended: {
    Id: 7001,
    ClassId: 101,
    Name: 'Vinyasa Flow',
    StartDateTime: '2026-03-02T09:00:00',
    EndDateTime: '2026-03-02T10:00:00',
    Location: { Name: 'E2E Main Studio' },
    Staff: { Name: 'Ada Lovelace' },
    SignedIn: true,
    WebSignup: false,
    LateCancelled: false,
    ServiceId: 5,
    ServiceName: 'Drop-in',
  },
  visitLateCancelled: {
    Id: 7002,
    ClassId: 102,
    Name: 'Power Reformer',
    StartDateTime: '2026-03-03T18:00:00',
    EndDateTime: '2026-03-03T19:00:00',
    Location: { Name: 'E2E Annex' },
    Staff: { Name: 'Ada Lovelace' },
    SignedIn: false,
    WebSignup: true,
    LateCancelled: true,
    ServiceId: 6,
    ServiceName: 'Reformer',
  },

  accountBalances: {
    Clients: [
      {
        Id: 'c-1001',
        AccountBalance: -42.5,
        ClientCreditCards: [
          { Balance: -30, CardType: 'Visa', LastFour: '4242' },
          { Balance: -12.5, CardType: 'Mastercard', LastFour: '4444' },
        ],
      },
    ],
  },

  // ── Service definitions (the catalogue the writes depend on) ───────────────
  sessionType: {
    Id: 9,
    Name: 'Personal Training',
    // The tool maps these to `defaultDuration`/`defaultDurationType`, not to
    // `defaultDuration`-shaped names: a fixture using the wrong name here would
    // silently produce `undefined`.
    DefaultTimeLength: 60,
    DefaultTimeLengthType: 'Minutes',
    NumDeducted: 1,
    ProgramId: 3,
    Category: 'Appointment',
    CategoryId: 11,
    Subcategory: 'One to One',
    SubcategoryId: 12,
    Type: 'Appointment',
  },

  service: {
    Id: 501,
    Name: '10 Class Pack',
    Price: 220,
    OnlinePrice: 199,
    TaxIncluded: true,
    TaxRate: 0.07,
    ProgramId: 3,
    SessionTypeId: 9,
    Count: 10,
    ExpirationUnit: 'Months',
    ExpirationLength: 6,
    MembershipId: 77,
    Priority: 1,
    Prerequisite: 'None',
  },

  // ── Orders ─────────────────────────────────────────────────────────────────
  package: {
    Id: 601,
    Name: 'Unlimited Month',
    // `Count` is surfaced as `classCount`, so it must not be confused with `Id`.
    Count: 0,
    Price: 149,
    OnlinePrice: 149,
    TaxIncluded: true,
    Active: true,
    ProductId: 701,
    SellOnline: true,
    Services: [{ Id: 501, Name: '10 Class Pack', Count: 10 }],
  },

  product: {
    Id: 701,
    Name: 'Cork Yoga Mat',
    Price: 60,
    OnlinePrice: 55,
    Description: 'Natural cork, three-ply',
    Category: 'Equipment',
    // Note the capital S: the tool reads `product.Subcategory`, not `subCategory`.
    Subcategory: 'Mats',
    Color: { Name: 'Natural' },
    Size: { Name: 'Standard' },
    TaxIncluded: false,
    TaxRate: 0.07,
    SellOnline: true,
  },

  contract: {
    Id: 801,
    Name: 'Gold Unlimited',
    Description: 'Gold tier membership',
    AssignsMembershipId: 77,
    AssignsMembershipName: 'Gold Membership',
    SoldOnline: true,
    ContractType: 'Recurring',
    AgreementTerms: 'Cancel with 30 days notice',
    AutopaySchedule: {
      FrequencyType: 'Monthly',
      FrequencyValue: 1,
      PaymentAmount: 149,
    },
    IntroOffer: { Id: 'io-1', Name: 'Intro 99', Price: 99 },
    LocationId: 1,
  },

  shoppingCart: {
    ShoppingCart: {
      Id: 'cart-1',
      SubTotal: 280,
      TaxTotal: 0,
      DiscountTotal: 20,
      GrandTotal: 260,
      CartItems: [
        // `UnitPrice` is what the tool maps to `price`; `Price` would be ignored.
        {
          Id: 501,
          Name: '10 Class Pack',
          UnitPrice: 220,
          Quantity: 1,
          DiscountAmount: 20,
          TaxAmount: 0,
          Total: 200,
        },
        {
          Id: 701,
          Name: 'Cork Yoga Mat',
          UnitPrice: 60,
          Quantity: 1,
          DiscountAmount: 0,
          TaxAmount: 0,
          Total: 60,
        },
      ],
    },
    Appointments: [
      {
        Id: 8002,
        Status: 'Booked',
        StartDateTime: '2026-03-05T10:00:00',
        EndDateTime: '2026-03-05T11:00:00',
        Notes: 'Booked via cart',
      },
    ],
  },

  clientContract: {
    ClientContract: {
      Id: 902,
      ClientId: 'c-1001',
      ContractName: 'Gold Unlimited',
      StartDate: '2026-04-01',
      EndDate: '2027-03-31',
      PaymentAmount: 149,
      Frequency: 1,
      RemainingPayments: 12,
    },
  },

  // ── Appointments ───────────────────────────────────────────────────────────
  staffAppointment: {
    Id: 8001,
    Status: 'Booked',
    StaffId: 42,
    Staff: { Id: 42, Name: 'Ada Lovelace' },
    SessionTypeId: 9,
    SessionType: { Id: 9, Name: 'Personal Training' },
    LocationId: 1,
    Location: { Id: 1, Name: 'E2E Main Studio' },
    StartDateTime: '2026-03-05T10:00:00',
    EndDateTime: '2026-03-05T11:00:00',
    ClientId: 'c-1001',
    Client: {
      Id: 'c-1001',
      FirstName: 'Grace',
      LastName: 'Hopper',
      Email: 'grace@example.invalid',
      MobilePhone: '555-0111',
    },
    Notes: 'Bring a mat',
    StaffRequested: true,
    ProviderId: 'prov-1',
    Duration: 60,
    Confirmed: true,
    FirstAppointment: false,
  },

  addedAppointment: {
    Appointment: {
      Id: 8003,
      Status: 'Booked',
      StartDateTime: '2026-03-06T09:00:00',
      EndDateTime: '2026-03-06T10:00:00',
      Duration: 60,
      Staff: { Id: 42, Name: 'Ada Lovelace' },
      SessionType: { Name: 'Personal Training' },
      Location: { Name: 'E2E Annex' },
    },
    // A distinct Message proves the tool surfaced the response's message rather
    // than its own `|| 'Appointment booked successfully'` default.
    Message: 'Appointment created for Grace',
  },

  updatedAppointment: {
    Appointment: {
      Id: 8003,
      Status: 'Changed',
      StartDateTime: '2026-03-07T14:00:00',
      EndDateTime: '2026-03-07T15:00:00',
      Staff: { Id: 42, Name: 'Ada Lovelace' },
    },
  },

  activeSessionTimes: {
    ActiveSessionTimes: ['06:00:00', '06:30:00', '07:00:00', '07:30:00'],
    SessionTypeActiveSessionTimes: [
      { SessionTypeId: 23, ActiveSessionTimes: ['06:00:00', '06:30:00', '07:00:00'] },
      { SessionTypeId: 9, ActiveSessionTimes: ['07:00:00', '07:30:00'] },
    ],
  },
  bookableItem: {
    ScheduledItemId: 3001,
    StaffId: 42,
    Staff: { Id: 42, Name: 'Ada Lovelace' },
    SessionTypeId: 9,
    SessionType: { Name: 'Personal Training' },
    LocationId: 1,
    Location: { Name: 'E2E Main Studio' },
    StartDateTime: '2026-03-08T09:00:00',
    EndDateTime: '2026-03-08T10:00:00',
    IsAvailable: true,
    IsSingleSessionBookable: true,
  },

  // ── Classes and staff ──────────────────────────────────────────────────────
  /**
   * Two staff members. /staff/staff is capped at one row per page, and Ada is the
   * SECOND row, so getTeacherSchedule can only find her by reading page two.
   */
  staff: [
    { Id: 43, Name: 'Charles Babbage', FirstName: 'Charles', LastName: 'Babbage', Email: 'charles@example.invalid' },
    { Id: 42, Name: 'Ada Lovelace', FirstName: 'Ada', LastName: 'Lovelace', Email: 'ada@example.invalid' },
  ],
  classDescriptions: [
    { Id: 10, Name: 'Vinyasa Flow', Description: 'A dynamic class', ImageUrl: 'https://example.invalid/v.png', Prereq: 'None', Level: { Name: 'All Levels' } },
    { Id: 11, Name: 'Power Reformer', Description: 'Reformer strength', Prereq: 'Intro to Reformer', Level: { Name: 'Intermediate' } },
  ],
  waitlistEntry: {
    Id: 5501,
    ClassId: 101,
    ClassDate: '2026-03-09T00:00:00',
    RequestDateTime: '2026-03-01T08:00:00',
    Web: true,
    Client: { Id: 'c-1001', FirstName: 'Grace', LastName: 'Hopper' },
  },
  classSchedule: {
    Id: 301,
    ClassDescription: { Id: 10, Name: 'Vinyasa Flow' },
    Staff: { Id: 42, Name: 'Ada Lovelace', FirstName: 'Ada', LastName: 'Lovelace' },
    Location: { Id: 1, Name: 'E2E Main Studio' },
    DayMonday: true,
    StartTime: '09:00:00',
    EndTime: '10:00:00',
    StartDate: '2026-01-05',
    EndDate: '2026-12-28',
  },

  // ── Client memberships and schedule ────────────────────────────────────────
  clientMembership: {
    Id: 6601,
    MembershipId: 77,
    Name: 'Gold Membership',
    Remaining: 8,
    Count: 10,
    Current: true,
    ActiveDate: '2026-03-01T00:00:00',
    ExpirationDate: '2026-09-01T00:00:00',
    PaymentDate: '2026-03-01T00:00:00',
    SiteId: -99,
    Action: 'None',
  },
  /**
   * GET /client/clientschedule rows (VisitWithWaitlistInfo): an attended class
   * session, a waitlisted one, and an appointment visit (no ClassId) that
   * getClientEnrollments must leave out.
   */
  clientSchedule: [
    { Id: 7101, ClassId: 201, Name: 'Teacher Training Module 1', StaffId: 42, LocationId: 1, StartDateTime: '2026-03-10T18:00:00', EndDateTime: '2026-03-10T20:00:00', SignedIn: true, LateCancelled: false, Missed: false },
    { Id: 7102, AppointmentId: 8001, Name: 'Personal Training', StaffId: 42, LocationId: 1, StartDateTime: '2026-03-11T10:00:00', EndDateTime: '2026-03-11T11:00:00', SignedIn: false, LateCancelled: false, Missed: false },
    { Id: 7103, ClassId: 202, Name: 'Teacher Training Module 2', StaffId: 42, LocationId: 2, StartDateTime: '2026-03-17T18:00:00', EndDateTime: '2026-03-17T20:00:00', SignedIn: false, LateCancelled: false, Missed: false, WaitlistInfo: { WaitlistId: 5502, WaitlistOrderNumber: 1 } },
  ],

  // ── Site catalogue ─────────────────────────────────────────────────────────
  location: {
    Id: 1,
    Name: 'E2E Main Studio',
    Description: 'The main room',
    HasClasses: true,
    Address: '1 Loopback Lane',
    City: 'Localhost',
    StateProvCode: 'CA',
    PostalCode: '90000',
    Phone: '555-0100',
  },
  program: { Id: 3, Name: 'Yoga', ScheduleType: 'Class', CancelOffset: 12, ContentFormats: ['InPerson'] },
} as const;

/**
 * Seven classes 2026-03-09 .. 2026-03-15, one per day at 09:00 site-local. Ada
 * (42) teaches six; Charles (43) teaches the one on 2026-03-12. With the
 * /class/classes page cap of 3, getClasses needs three GETs (Offset 0, 3, 6)
 * and getTeacherSchedule for Ada needs two (6 rows: Offset 0, 3).
 */
export const STUB_CLASSES: ReadonlyArray<Record<string, any>> = Array.from({ length: 7 }, (_, i) => {
  const day = `2026-03-${String(9 + i).padStart(2, '0')}`;
  const staff = i === 3 ? STUB_FIXTURES.staff[0] : STUB_FIXTURES.staff[1];
  return {
    Id: 101 + i,
    ClassDescription: { Id: 10, Name: 'Vinyasa Flow', Description: 'A dynamic class' },
    Staff: { Id: staff.Id, Name: staff.Name, FirstName: staff.FirstName, LastName: staff.LastName },
    Location: { Id: 1, Name: 'E2E Main Studio' },
    StartDateTime: `${day}T09:00:00`,
    EndDateTime: `${day}T10:00:00`,
    MaxCapacity: 20,
    TotalBooked: 5 + i,
    IsWaitlistAvailable: true,
    IsCanceled: false,
    IsSubstitute: false,
  };
});

/**
 * An appointment `days` site-calendar days from today (negative = past), 10:00
 * to 11:00 site-local wall time, with no offset — the shape Mindbody returns.
 * The date comes from the same siteTime.ts conversion the server uses, in the
 * stub site's zone, so it is independent of the host's TZ.
 */
function appointmentAt(
  id: number,
  clientId: string,
  status: string,
  days: number
): Record<string, unknown> {
  const day = siteDateStringPlusDays(new Date(), STUB_FIXTURES.siteTimeZone, days);
  return {
    Id: id,
    Status: status,
    StaffId: 42,
    Staff: { Id: 42, Name: 'Ada Lovelace' },
    SessionTypeId: 9,
    SessionType: { Id: 9, Name: 'Personal Training' },
    LocationId: 1,
    Location: { Id: 1, Name: 'E2E Main Studio' },
    StartDateTime: `${day}T10:00:00`,
    EndDateTime: `${day}T11:00:00`,
    ClientId: clientId,
    Duration: 60,
    StaffRequested: false,
    FirstAppointment: false,
  };
}

/**
 * Appointments that make cancelAppointments' guards testable end to end.
 *
 * Dates are computed relative to `Date.now()` when the module loads, as site-local
 * dates in `STUB_FIXTURES.siteTimeZone`, so the "future" fixtures never rot into
 * the past and stay correct whatever TZ the host runs in. The past one sits three
 * site days back, outside the tool's site-today-onwards lookup window, so it reads
 * as not found.
 */
export const CANCELLATION_FIXTURES = {
  clientId: 'C-100',
  otherClientId: 'C-200',
  futureBookedA: 9001,
  futureBookedB: 9002,
  futureConfirmed: 9003,
  futureBookedC: 9004,
  past: 9005,
  futureCancelled: 9006,
  otherClientFutureBooked: 9101,
  appointments: [
    appointmentAt(9001, 'C-100', 'Booked', 3),
    appointmentAt(9002, 'C-100', 'Booked', 4),
    appointmentAt(9003, 'C-100', 'Confirmed', 5),
    appointmentAt(9004, 'C-100', 'Booked', 6),
    appointmentAt(9005, 'C-100', 'Booked', -3),
    appointmentAt(9006, 'C-100', 'Cancelled', 7),
    appointmentAt(9101, 'C-200', 'Booked', 3),
  ] as ReadonlyArray<Record<string, unknown>>,
} as const;

/** UpdateAppointmentRequest.Execute -> resulting Appointment.Status. */
const EXECUTE_TO_STATUS: Record<string, string> = {
  cancel: 'Cancelled',
  latecancel: 'LateCancelled',
  arrive: 'Arrived',
  unarrive: 'Booked',
  confirm: 'Confirmed',
  unconfirm: 'Booked',
  complete: 'Completed',
};

/** Every appointment the stub knows about, for lookups by id. */
function allStubAppointments(): ReadonlyArray<Record<string, unknown>> {
  return [STUB_FIXTURES.staffAppointment, ...CANCELLATION_FIXTURES.appointments];
}

// ── Enrollments ──────────────────────────────────────────────────────────────

/** Program of the enrollment fixtures, as `ClassDescription.Program` carries it. */
const ENROLLMENT_PROGRAM = { Id: 10, Name: 'Boot Camp', ScheduleType: 'Enrollment', CancelOffset: 0, ContentFormats: ['InPerson'] };

/** Site-local 18:00 to 19:30 `days` site-calendar days from today (negative = past). */
function enrollmentSessionAt(classId: number, classScheduleId: number, days: number): Record<string, any> {
  const day = siteDateStringPlusDays(new Date(), STUB_FIXTURES.siteTimeZone, days);
  return {
    Id: classId,
    ClassScheduleId: classScheduleId,
    ClassDescription: { Id: 307, Name: 'Six Week Boot Camp', Description: 'Six weeks of training', Program: ENROLLMENT_PROGRAM, SessionType: { Id: 208, Name: 'Bootcamp', Type: 'All' } },
    Staff: { Id: 42, Name: 'Ada Lovelace', FirstName: 'Ada', LastName: 'Lovelace' },
    Location: { Id: 1, Name: 'E2E Main Studio' },
    StartDateTime: `${day}T18:00:00`,
    EndDateTime: `${day}T19:30:00`,
    MaxCapacity: 13,
    WebCapacity: 13,
    TotalBooked: 4,
    SemesterId: null,
    IsCanceled: false,
    IsAvailable: true,
    IsWaitlistAvailable: true,
    IsEnrolled: null,
  };
}

/** A VisitWithWaitlistInfo row on the client's schedule for one session. */
function enrollmentVisit(
  visitId: number,
  session: Record<string, any>,
  clientId: string,
  overrides: Record<string, unknown> = {}
): Record<string, any> {
  return {
    Id: visitId,
    ClassId: session.Id,
    ClientId: clientId,
    Name: session.ClassDescription.Name,
    StaffId: session.Staff.Id,
    LocationId: session.Location.Id,
    StartDateTime: session.StartDateTime,
    EndDateTime: session.EndDateTime,
    SignedIn: false,
    LateCancelled: false,
    Missed: false,
    MakeUp: false,
    WebSignup: false,
    AppointmentId: 0,
    VisitType: 208,
    TypeGroup: 10,
    TypeTaken: 'Unpaid Boot Camp',
    Action: 'None',
    WaitlistInfo: { WaitlistId: null, WaitlistOrderNumber: null },
    ...overrides,
  };
}

const ENROLLMENT_SESSIONS = [
  enrollmentSessionAt(25201, 2256, -7),
  enrollmentSessionAt(25202, 2256, 3),
  enrollmentSessionAt(25203, 2256, 10),
  enrollmentSessionAt(25204, 2256, 17),
  enrollmentSessionAt(25205, 2256, 24),
] as const;

/**
 * One enrollment (class schedule 2256, "Six Week Boot Camp") with five weekly
 * sessions, one of them already past, plus the client's visits in it. Dates are
 * relative to today in the stub site's zone, like CANCELLATION_FIXTURES, so the
 * "future" visits never rot. The drop-in visit points at STUB_CLASSES[0]
 * (ClassId 101, no enrollment program), which getClientEnrollments and
 * cancelEnrollmentVisits must both leave out.
 */
export const ENROLLMENT_FIXTURES = {
  clientId: STUB_FIXTURES.clientId,
  classScheduleId: 2256,
  pastVisit: 100001,
  futureVisitA: 100002,
  futureVisitB: 100003,
  futureVisitC: 100004,
  waitlistedVisit: 100005,
  lateCancelledVisit: 100006,
  dropInVisit: 100007,
  sessions: ENROLLMENT_SESSIONS as ReadonlyArray<Record<string, any>>,
  /** ClassSchedule as GET /enrollment/enrollments returns it (`Classes`/`Clients` null, like the sandbox). */
  schedule: {
    Id: 2256,
    Classes: null,
    Clients: null,
    Course: null,
    SemesterId: null,
    IsAvailable: true,
    ClassDescription: ENROLLMENT_SESSIONS[1].ClassDescription,
    DaySunday: false, DayMonday: false, DayTuesday: true, DayWednesday: false, DayThursday: false, DayFriday: false, DaySaturday: false,
    AllowOpenEnrollment: true,
    AllowDateForwardEnrollment: true,
    StartTime: '1899-12-30T18:00:00',
    EndTime: '1899-12-30T19:30:00',
    StartDate: `${ENROLLMENT_SESSIONS[0].StartDateTime.slice(0, 10)}T00:00:00`,
    EndDate: `${ENROLLMENT_SESSIONS[4].StartDateTime.slice(0, 10)}T00:00:00`,
    Staff: ENROLLMENT_SESSIONS[1].Staff,
    Location: ENROLLMENT_SESSIONS[1].Location,
    FrequencyType: null,
    FrequencyInterval: null,
  } as Record<string, any>,
  visits: [
    enrollmentVisit(100001, ENROLLMENT_SESSIONS[0], STUB_FIXTURES.clientId, { SignedIn: true }),
    enrollmentVisit(100002, ENROLLMENT_SESSIONS[1], STUB_FIXTURES.clientId),
    enrollmentVisit(100003, ENROLLMENT_SESSIONS[2], STUB_FIXTURES.clientId),
    enrollmentVisit(100004, ENROLLMENT_SESSIONS[3], STUB_FIXTURES.clientId),
    enrollmentVisit(100005, ENROLLMENT_SESSIONS[4], STUB_FIXTURES.clientId, { WaitlistInfo: { WaitlistId: 5601, WaitlistOrderNumber: 2 } }),
    enrollmentVisit(100006, ENROLLMENT_SESSIONS[3], STUB_FIXTURES.clientId, { LateCancelled: true }),
    { ...enrollmentVisit(100007, ENROLLMENT_SESSIONS[2], STUB_FIXTURES.clientId), ClassId: 101, Name: 'Vinyasa Flow' },
  ] as ReadonlyArray<Record<string, any>>,
} as const;

export class MindbodyStub {
  readonly origin: string;
  /** The exact value to hand the subprocess as MINDBODY_API_URL. */
  readonly apiUrl: string;
  readonly port: number;

  private readonly server: Server;
  private readonly routes: Route[] = [];
  private readonly log: StubRequest[] = [];
  /**
   * Every `/usertoken/issue` request, kept across `resetLog()` so tests can
   * assert on token-acquisition behaviour independently of test order.
   */
  private readonly tokenLog: StubRequest[] = [];
  /** Every request in the session, kept across `resetLog()` (for ordering checks). */
  private readonly sessionLog: StubRequest[] = [];
  /** Per-route fault override, keyed the same way as `routes`. */
  private readonly faults = new Map<string, StubResponse>();
  private tokenResponder: TokenResponder;
  private listening = false;
  /**
   * Sites this "API key" can reach. Defaults to the one fixture site; a test may
   * assign several to simulate a multi-site key. `/site/sites` filters them by
   * the `SiteIds[]` query the server sends.
   */
  sites: Array<Record<string, unknown>> = [STUB_FIXTURES.site];

  private constructor() {
    this.server = createServer();
    this.tokenResponder = MindbodyStub.defaultTokenResponder;
    this.registerDefaults();
    // Placeholder; `origin`/`port` are filled in by `start()`.
    this.port = 0;
    this.origin = '';
    this.apiUrl = '';
  }

  /** Start the stub on an ephemeral loopback port and resolve once listening. */
  static async start(): Promise<MindbodyStub> {
    const stub = new MindbodyStub();
    stub.server.on('request', (req, res) => {
      void stub.handle(req, res);
    });

    // Port 0 => the OS picks a free loopback port, so concurrent runs never clash.
    await new Promise<void>((resolve, reject) => {
      stub.server.once('error', reject);
      stub.server.listen(0, '127.0.0.1', () => resolve());
    });

    stub.listening = true;
    const address = stub.server.address() as AddressInfo;
    stub.port = address.port;
    stub.origin = `http://127.0.0.1:${address.port}`;
    stub.apiUrl = `${stub.origin}${API_PREFIX}`;
    return stub;
  }

  /** Every request the stub has seen, oldest first. */
  get requests(): readonly StubRequest[] {
    return this.log;
  }

  /** Requests whose path ends with `suffix`, in arrival order. */
  requestsTo(suffix: string, method?: string): StubRequest[] {
    return this.log.filter(
      (request) =>
        request.path.endsWith(suffix) && (method === undefined || request.method === method)
    );
  }

  countTo(suffix: string, method?: string): number {
    return this.requestsTo(suffix, method).length;
  }

  /** Every request across the whole session, unaffected by `resetLog()`. */
  get sessionRequests(): readonly StubRequest[] {
    return this.sessionLog;
  }

  /** Token requests across the whole session, unaffected by `resetLog()`. */
  get tokenRequests(): readonly StubRequest[] {
    return this.tokenLog;
  }

  /**
   * Every path this stub implements, including the token endpoint.
   *
   * The hermeticity test compares the request log against this list, so
   * "the server called something the stub does not serve" cannot pass unnoticed:
   * such a call would have been answered 404 and the tool would have errored.
   */
  get implementedPaths(): readonly string[] {
    return this.routes.map((route) => `${API_PREFIX}${route.path}`);
  }

  resetLog(): void {
    this.log.length = 0;
  }

  /**
   * Override what `/usertoken/issue` returns. Pass `null` to restore the default
   * (a single, far-future token that `auth.ts` will keep reusing).
   */
  setTokenResponder(responder: TokenResponder | null): void {
    this.tokenResponder = responder ?? MindbodyStub.defaultTokenResponder;
  }

  /**
   * Make the next request(s) to `method path` return `response` instead of the
   * fixture. Used by the fault-injection tests, and to demonstrate that the suite
   * really does fail when the upstream payload changes shape.
   */
  setFault(method: string, path: string, response: StubResponse | null): void {
    const key = `${method} ${path}`;
    if (response === null) {
      this.faults.delete(key);
    } else {
      this.faults.set(key, response);
    }
  }

  clearFaults(): void {
    this.faults.clear();
  }

  async close(): Promise<void> {
    if (!this.listening) return;
    this.listening = false;
    await new Promise<void>((resolve) => {
      this.server.closeAllConnections?.();
      this.server.close(() => resolve());
    });
  }

  /** A valid token with an expiry far beyond `auth.ts`'s 60-second skew. */
  private static defaultTokenResponder(): StubResponse {
    return {
      status: 200,
      body: {
        TokenType: 'Bearer',
        AccessToken: STUB_FIXTURES.accessToken,
        Expires: STUB_FIXTURES.accessTokenExpiry,
      },
    };
  }

  private key(method: string, path: string): string {
    return `${method} ${path}`;
  }

  private registerDefaults(): void {
    this.route('POST', '/usertoken/issue', () =>
      // `tokenLog` was already appended to in handle(), so `attempt` is 1-based.
      this.tokenResponder(this.tokenLog.length)
    );

    // ── Clients ──────────────────────────────────────────────────────────────
    this.route('GET', '/client/clients', (request) => {
      const search = request.query.SearchText?.toLowerCase() ?? '';
      const prospectsOnly = request.query.IsProspect === 'true';
      // Both filters are honoured, as Mindbody honours them, so the returned set
      // and the total can genuinely disagree with an unfiltered list.
      const matches = [STUB_FIXTURES.client, STUB_FIXTURES.prospect].filter((client) => {
        if (prospectsOnly && !client.IsProspect) return false;
        return (
          search === '' ||
          client.FirstName.toLowerCase().includes(search) ||
          client.LastName.toLowerCase().includes(search)
        );
      });
      // `PaginationResponse.TotalResults` is what `getClientsTool` reads for
      // `totalClients` — it does not fall back to the array length. Asserting a
      // specific number therefore fails if this envelope is missing, renamed,
      // or left out, which a `totalClients === clients.length` check could not.
      return listResponse('Clients', matches, request.query);
    });

    this.route('POST', '/client/addclient', (request) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      return {
        status: 200,
        // Mindbody assigns the id; the rest is echoed so the test can prove the
        // tool's field mapping (`response.Client.FirstName` -> `client.firstName`)
        // actually ran.
        body: {
          Client: {
            Id: 'c-2001',
            FirstName: body.FirstName,
            LastName: body.LastName,
            Email: body.Email,
          },
        },
      };
    });

    this.route('POST', '/client/updateclient', (request) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      // UpdateClientRequest requires the fields nested under `Client`. The -99
      // sandbox refuses a flat body with exactly this envelope, which the client
      // surfaces as `Client (Code: MissingRequiredFields)`.
      const updated = body.Client;
      if (updated === null || typeof updated !== 'object' || Array.isArray(updated)) {
        return {
          status: 400,
          body: { Error: { Code: 'MissingRequiredFields', Message: 'Client' } },
        };
      }
      // CrossRegionalUpdate defaults to true, and the sandbox (a site outside any
      // region) refuses that with this message. The error Code is a stub choice;
      // only the message was observed against the sandbox.
      if (body.CrossRegionalUpdate !== false) {
        return {
          status: 400,
          body: { Error: { Code: 'InvalidParameter', Message: 'The current site does not belong to a region' } },
        };
      }
      const fields = updated as Record<string, unknown>;
      return {
        status: 200,
        body: {
          Client: {
            Id: fields.Id,
            FirstName: fields.FirstName ?? STUB_FIXTURES.client.FirstName,
            LastName: fields.LastName ?? STUB_FIXTURES.client.LastName,
            Email: fields.Email ?? STUB_FIXTURES.client.Email,
          },
        },
      };
    });

    this.route('GET', '/client/clientvisits', (request) => {
      // No ClientId => the same 400 Mindbody returns for a missing required
      // parameter. This is what the "missing required argument" test drives.
      if (!request.query.ClientId) {
        return {
          status: 400,
          body: { Error: { Code: 'InvalidParameter', Message: 'ClientId is required' } },
        };
      }
      return listResponse('Visits', [STUB_FIXTURES.visitAttended, STUB_FIXTURES.visitLateCancelled], request.query);
    });

    this.route('GET', '/client/activeclientmemberships', (request) => {
      if (!request.query.ClientId) {
        return {
          status: 400,
          body: { Error: { Code: 'InvalidParameter', Message: 'ClientId is required' } },
        };
      }
      const memberships = request.query.ClientId === STUB_FIXTURES.clientId ? [STUB_FIXTURES.clientMembership] : [];
      return listResponse('ClientMemberships', memberships, request.query);
    });

    this.route('GET', '/client/clientschedule', (request) => {
      // Waitlist rows only appear when asked for, as Mindbody documents. The
      // StartDate .. EndDate window is honoured on the visit's site-local date.
      const from = request.query.StartDate;
      const to = request.query.EndDate;
      const rows = [...STUB_FIXTURES.clientSchedule, ...ENROLLMENT_FIXTURES.visits].filter((visit: any) => {
        const waitlisted = visit.WaitlistInfo?.WaitlistId != null;
        if (waitlisted && request.query.IncludeWaitlistEntries !== 'true') return false;
        const day = String(visit.StartDateTime).slice(0, 10);
        if (from !== undefined && day < from.slice(0, 10)) return false;
        if (to !== undefined && day > to.slice(0, 10)) return false;
        return true;
      });
      return listResponse('Visits', request.query.ClientId === STUB_FIXTURES.clientId ? rows : [], request.query);
    });

    this.route('POST', '/client/addarrival', (request) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (!body.ClientId || body.LocationId === undefined) {
        return {
          status: 400,
          body: { Error: { Code: 'InvalidParameter', Message: 'ClientId and LocationId are required' } },
        };
      }
      return {
        status: 200,
        body: { ArrivalAdded: true, ClientService: { Id: 1, Name: 'Stub Service', Remaining: 4 } },
      };
    });

    this.route('GET', '/client/clientaccountbalances', (request) => {
      const wanted = request.query['ClientIds[]'];
      const clients = STUB_FIXTURES.accountBalances.Clients.filter(
        (entry) => wanted === undefined || entry.Id === wanted
      );
      if (clients.length === 0) {
        return { status: 404, body: { Error: { Code: 'NotFound', Message: 'No such client' } } };
      }
      return listResponse('Clients', clients, request.query);
    });

    // ── Classes and staff ────────────────────────────────────────────────────
    this.route('GET', '/class/classes', (request) => {
      // A ClassIds[] lookup (getClientEnrollments, cancelEnrollmentVisits)
      // answers by id from every class the stub knows, drop-in and enrollment,
      // ignoring the date window so an old drop-in class still resolves.
      const classIds = (request.queryAll['ClassIds[]'] ?? []).map(Number);
      if (classIds.length > 0) {
        const byId = [...STUB_CLASSES, ...ENROLLMENT_FIXTURES.sessions].filter((cls) => classIds.includes(cls.Id));
        return listResponse('Classes', byId, request.query, STUB_PAGE_CAPS.classes);
      }
      // Honour the filters the tools send: StaffIds[] and the StartDateTime ..
      // EndDateTime window (site-local strings compare chronologically).
      const staffIds = (request.queryAll['StaffIds[]'] ?? []).map(Number);
      const from = request.query.StartDateTime;
      const to = request.query.EndDateTime;
      const matches = STUB_CLASSES.filter((cls) => {
        if (staffIds.length > 0 && !staffIds.includes(cls.Staff.Id)) return false;
        if (from !== undefined && cls.StartDateTime < from) return false;
        if (to !== undefined && cls.StartDateTime > to) return false;
        return true;
      });
      return listResponse('Classes', matches, request.query, STUB_PAGE_CAPS.classes);
    });

    this.route('GET', '/class/classdescriptions', (request) =>
      listResponse('ClassDescriptions', STUB_FIXTURES.classDescriptions, request.query)
    );

    // ── Enrollments ──────────────────────────────────────────────────────────
    this.route('GET', '/enrollment/enrollments', (request) => {
      const scheduleIds = (request.queryAll['ClassScheduleIds[]'] ?? []).map(Number);
      const programIds = (request.queryAll['ProgramIds[]'] ?? []).map(Number);
      const schedule = ENROLLMENT_FIXTURES.schedule;
      const matches =
        (scheduleIds.length === 0 || scheduleIds.includes(schedule.Id)) &&
        (programIds.length === 0 || programIds.includes(schedule.ClassDescription.Program.Id))
          ? [schedule]
          : [];
      return listResponse('Enrollments', matches, request.query);
    });

    this.route('POST', '/enrollment/addclienttoenrollment', (request) => {
      const body = (request.body ?? {}) as Record<string, any>;
      // The sandbox refuses the plural `ClassScheduleIds` with exactly this error.
      if (!body.ClientId || body.ClassScheduleId === undefined) {
        return {
          status: 400,
          body: { Error: { Code: 'MissingRequiredFields', Message: 'ClassScheduleId is a required parameter.' } },
        };
      }
      if (Number(body.ClassScheduleId) !== ENROLLMENT_FIXTURES.classScheduleId) {
        return { status: 404, body: { Error: { Code: 'NotFound', Message: 'Enrollment not found' } } };
      }
      // The response is the ClassSchedule with its sessions. With EnrollOpen only
      // the listed sessions come back; with EnrollDateForward only those from
      // that date on; otherwise all of them.
      const open: string[] | undefined = Array.isArray(body.EnrollOpen) ? body.EnrollOpen : undefined;
      const forward: string | undefined = body.EnrollDateForward;
      const classes = ENROLLMENT_FIXTURES.sessions.filter((session) => {
        if (forward !== undefined) return session.StartDateTime >= forward;
        if (open !== undefined) return open.includes(session.StartDateTime);
        return true;
      });
      return {
        status: 200,
        body: { ...ENROLLMENT_FIXTURES.schedule, Classes: classes.map((session) => ({ ...session, TotalBooked: session.TotalBooked + 1 })), Clients: [] },
      };
    });

    this.route('POST', '/class/removeclientfromclass', (request) => {
      const body = (request.body ?? {}) as Record<string, any>;
      if (body.ClassId === undefined) {
        return { status: 400, body: { Error: { Code: 'MissingRequiredFields', Message: 'ClassId is a required parameter.' } } };
      }
      const known = [...STUB_CLASSES, ...ENROLLMENT_FIXTURES.sessions].find((cls) => cls.Id === Number(body.ClassId));
      if (!known) {
        return { status: 404, body: { Error: { Code: 'NotFound', Message: `Class ${body.ClassId} not found` } } };
      }
      return { status: 200, body: { Class: { ...known, Visits: [], Clients: [] } } };
    });

    this.route('GET', '/class/waitlistentries', (request) =>
      listResponse('WaitlistEntries', [STUB_FIXTURES.waitlistEntry], request.query)
    );

    this.route('GET', '/class/classschedules', (request) =>
      listResponse('ClassSchedules', [STUB_FIXTURES.classSchedule], request.query)
    );

    this.route('GET', '/staff/staff', (request) =>
      listResponse('StaffMembers', STUB_FIXTURES.staff, request.query, STUB_PAGE_CAPS.staff)
    );

    // ── Service definitions ──────────────────────────────────────────────────
    this.route('GET', '/sale/services', (request) =>
      listResponse('Services', [STUB_FIXTURES.service], request.query)
    );

    // ── Site ─────────────────────────────────────────────────────────────────
    this.route('GET', '/site/sites', (request) => {
      // Mirrors `request.siteIds`: a multi-site key sees only the sites asked for.
      const wanted = request.queryAll['SiteIds[]'] ?? [];
      const sites = this.sites.filter((site) => wanted.length === 0 || wanted.includes(String(site.Id)));
      return listResponse('Sites', sites, request.query);
    });

    this.route('GET', '/site/sessiontypes', (request) =>
      listResponse('SessionTypes', [STUB_FIXTURES.sessionType], request.query)
    );

    this.route('GET', '/site/locations', (request) =>
      listResponse('Locations', [STUB_FIXTURES.location], request.query)
    );

    this.route('GET', '/site/programs', (request) =>
      listResponse('Programs', [STUB_FIXTURES.program], request.query)
    );

    // ── Orders ───────────────────────────────────────────────────────────────
    this.route('GET', '/sale/packages', (request) =>
      listResponse('Packages', [STUB_FIXTURES.package], request.query)
    );

    this.route('GET', '/sale/products', (request) => {
      const search = request.query.SearchText?.toLowerCase() ?? '';
      const products = [STUB_FIXTURES.product].filter(
        (product) => search === '' || product.Name.toLowerCase().includes(search)
      );
      return listResponse('Products', products, request.query);
    });

    this.route('GET', '/sale/contracts', (request) =>
      listResponse('Contracts', [STUB_FIXTURES.contract], request.query)
    );

    this.route('POST', '/sale/checkoutshoppingcart', (request) => {
      const body = (request.body ?? {}) as { Items?: Array<Record<string, any>> };
      const items = Array.isArray(body.Items) ? body.Items : [];
      const reconciling = items.some((item) => Array.isArray(item.AppointmentIds));
      // Without AppointmentIds the cart is the fixed fixture, unchanged.
      if (!reconciling) {
        return { status: 200, body: STUB_FIXTURES.shoppingCart };
      }

      // With AppointmentIds, echo them: each cart item lists the appointments it
      // reconciled, and the top-level Appointments carries the full records.
      const known = allStubAppointments();
      const reconciled: Array<Record<string, unknown>> = [];
      const cartItems: Array<Record<string, unknown>> = [];
      for (const item of items) {
        const id = item.Item?.Metadata?.Id;
        const base =
          STUB_FIXTURES.shoppingCart.ShoppingCart.CartItems.find((entry) => entry.Id === id) ??
          STUB_FIXTURES.shoppingCart.ShoppingCart.CartItems[0];
        const cartItem: Record<string, unknown> = { ...base, Quantity: item.Quantity ?? base.Quantity };
        if (Array.isArray(item.AppointmentIds)) {
          const appointments: Array<Record<string, unknown>> = [];
          for (const appointmentId of item.AppointmentIds) {
            const match = known.find((appointment) => appointment.Id === appointmentId);
            if (!match) {
              return {
                status: 400,
                body: { Error: { Code: 'InvalidParameter', Message: `Appointment ${appointmentId} not found` } },
              };
            }
            appointments.push(match);
          }
          cartItem.AppointmentIds = item.AppointmentIds;
          // Typed in docs/openapi.json as Appointment objects (described as IDs).
          cartItem.Appointments = appointments;
          reconciled.push(...appointments);
        }
        cartItems.push(cartItem);
      }
      return {
        status: 200,
        body: {
          ShoppingCart: { ...STUB_FIXTURES.shoppingCart.ShoppingCart, CartItems: cartItems },
          Appointments: reconciled,
        },
      };
    });

    this.route('POST', '/sale/purchasecontract', (request) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      return {
        status: 200,
        body: {
          ClientContract: {
            ...STUB_FIXTURES.clientContract.ClientContract,
            // Echo the ids the caller sent, so a dropped field cannot pass.
            ClientId: body.ClientId,
          },
        },
      };
    });

    // ── Appointments ─────────────────────────────────────────────────────────
    this.route('GET', '/appointment/staffappointments', (request) => {
      // Honour the filters Mindbody honours: appointment ids, the single
      // ClientId, and the StartDate..EndDate window (compared on the date part).
      const wantedIds = (request.queryAll['AppointmentIds[]'] ?? []).map(Number);
      const clientId = request.query.ClientId;
      const startDate = request.query.StartDate;
      const endDate = request.query.EndDate ?? startDate;
      const matches = allStubAppointments().filter((appointment) => {
        const day = String(appointment.StartDateTime).slice(0, 10);
        if (wantedIds.length > 0 && !wantedIds.includes(Number(appointment.Id))) return false;
        if (clientId !== undefined && String(appointment.ClientId) !== clientId) return false;
        if (startDate !== undefined && day < startDate) return false;
        if (endDate !== undefined && day > endDate) return false;
        return true;
      });
      return listResponse('Appointments', matches, request.query);
    });

    // GetBookableItemsResponse documents exactly one list key: `Availabilities`.
    this.route('GET', '/appointment/bookableitems', (request) =>
      listResponse('Availabilities', [STUB_FIXTURES.bookableItem], request.query)
    );

    // The real -99 sandbox shape: plain "HH:MM:SS" strings, not objects, paged
    // over `ActiveSessionTimes`, with the per-session-type breakdown alongside.
    this.route('GET', '/appointment/activesessiontimes', (request) => {
      const { page, PaginationResponse } = paginate(STUB_FIXTURES.activeSessionTimes.ActiveSessionTimes, request.query);
      return {
        status: 200,
        body: {
          PaginationResponse,
          ActiveSessionTimes: page,
          SessionTypeActiveSessionTimes: STUB_FIXTURES.activeSessionTimes.SessionTypeActiveSessionTimes,
        },
      };
    });

    this.route('POST', '/appointment/addappointment', (request) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      return {
        status: 200,
        body: {
          ...STUB_FIXTURES.addedAppointment,
          Appointment: {
            ...STUB_FIXTURES.addedAppointment.Appointment,
            StartDateTime: body.StartDateTime ?? STUB_FIXTURES.addedAppointment.Appointment.StartDateTime,
          },
        },
      };
    });

    this.route('POST', '/appointment/updateappointment', (request) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      let status: string | undefined;
      if (body.Execute !== undefined) {
        status = EXECUTE_TO_STATUS[String(body.Execute)];
        if (status === undefined) {
          return {
            status: 400,
            body: {
              Error: { Code: 'InvalidParameter', Message: `Invalid Execute value: ${String(body.Execute)}` },
            },
          };
        }
      }
      // Known cancellation fixtures are echoed as themselves; anything else falls
      // back to the generic updated-appointment fixture. Stateless on purpose:
      // nothing persists between requests, so tests cannot depend on order.
      const known = CANCELLATION_FIXTURES.appointments.find(
        (appointment) => appointment.Id === body.AppointmentId
      );
      const base = known ?? STUB_FIXTURES.updatedAppointment.Appointment;
      return {
        status: 200,
        body: {
          Appointment: {
            ...base,
            Status: status ?? base.Status,
            StartDateTime: body.StartDateTime ?? base.StartDateTime,
          },
        },
      };
    });
  }

  private route(method: string, path: string, handler: RouteHandler): void {
    this.routes.push({ method, path, handler });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.origin);
    const query: Record<string, string> = {};
    const queryAll: Record<string, string[]> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
      (queryAll[key] ??= []).push(value);
    });

    const body = await this.readBody(req);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
    }

    const record: StubRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query,
      queryAll,
      headers,
      body,
      host: req.headers.host,
    };
    this.log.push(record);
    this.sessionLog.push(record);
    if (record.path === `${API_PREFIX}/usertoken/issue`) {
      this.tokenLog.push(record);
    }

    const match = this.routes.find(
      (candidate) =>
        candidate.method === record.method &&
        `${API_PREFIX}${candidate.path}` === record.path
    );

    let response: StubResponse;
    if (!match) {
      response = {
        status: 404,
        body: {
          Error: {
            Code: 'NotFound',
            Message: `Stub has no route for ${record.method} ${record.path}`,
          },
        },
      };
    } else {
      const fault = this.faults.get(this.key(record.method, record.path));
      response = fault ?? match.handler(record);
    }

    const payload = JSON.stringify(response.body);
    res.writeHead(response.status ?? 200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload).toString(),
    });
    res.end(payload);
  }

  private readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8').trim();
        if (!raw) {
          resolve(undefined);
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(raw);
        }
      });
      req.on('error', () => resolve(undefined));
    });
  }
}

/** Build the minimal, fake-only environment the subprocess is allowed to see. */
export interface StubEnvOptions {
  apiUrl: string;
  scratchDir: string;
  /** Name of a required env var to leave out, to test startup rejection. */
  omitRequired?: string;
  /**
   * Arbitrary env vars to delete. Used by the no-source-credentials case, where
   * `auth.ts` must short-circuit but `src/index.ts`'s startup gate still applies.
   */
  omit?: string[];
}

/**
 * A clean-room environment for the server subprocess.
 *
 * Built from scratch rather than spread from `process.env`: the test process runs
 * under `bunfig.toml`'s `dotenv = true` and therefore holds the developer's real
 * credentials in its own environment. Inheriting would leak them into the child.
 *
 * The proxy variables are an egress trap. axios honours `HTTPS_PROXY` unless
 * `NO_PROXY` matches, so with `NO_PROXY` pinned to loopback, any attempt to leave
 * the machine is routed to a closed port on loopback and fails loudly instead of
 * quietly reaching api.mindbodyonline.com.
 */
export function buildStubEnv(options: StubEnvOptions): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: options.scratchDir,
    TMPDIR: options.scratchDir,
    NODE_ENV: 'test',
    // Egress trap: loopback bypasses the proxy, everything else hits a dead port.
    HTTP_PROXY: 'http://127.0.0.1:1',
    HTTPS_PROXY: 'http://127.0.0.1:1',
    NO_PROXY: '127.0.0.1,localhost',
    MINDBODY_API_URL: options.apiUrl,
    MINDBODY_API_KEY: STUB_FIXTURES.apiKey,
    MINDBODY_SITE_ID: STUB_FIXTURES.siteId,
    MINDBODY_SOURCE_NAME: STUB_FIXTURES.sourceName,
    MINDBODY_SOURCE_PASSWORD: STUB_FIXTURES.sourcePassword,
  };

  if (options.omitRequired) {
    delete env[options.omitRequired];
  }

  for (const key of options.omit ?? []) {
    delete env[key];
  }

  return env;
}