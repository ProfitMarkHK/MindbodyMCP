/**
 * Enrollment support in the Next.js app (nextjs-app/src/lib/mindbody/service.ts,
 * "ENROLLMENT MANAGEMENT"), held to docs/openapi.json:
 *
 *   GET  /enrollment/enrollments        rows are ClassSchedule: name/program
 *                                       under ClassDescription, seven Day*
 *                                       booleans, no capacity; filters are the
 *                                       spec's only (no SemesterIds/CourseIds)
 *   POST /enrollment/addclienttoenrollment  ClassScheduleId singular,
 *                                       EnrollDateForward one date-time,
 *                                       EnrollOpen an ARRAY of date-times
 *   GET  /client/clientschedule + GET /class/classes   a visit is an enrollment
 *                                       visit only when its class's program has
 *                                       ScheduleType `Enrollment`
 *
 * The fixtures are the same ones the MCP server's stub serves
 * (tests/support/mindbody-stub.ts, ENROLLMENT_FIXTURES), so both code bases
 * are tested against one picture of the API.
 *
 * Runs under the root `bun test` (Gate 1); nextjs-app has no runner of its own.
 */
import { describe, expect, it } from "bun:test";
import {
  DEFAULT_ENROLLMENT_WINDOW_DAYS,
  ENROLLMENT_SCHEDULE_TYPE,
  MindbodyService,
} from "../nextjs-app/src/lib/mindbody/service";
import { siteDateString, siteDateStringPlusDays } from "../nextjs-app/src/lib/mindbody/siteTime";
import { ENROLLMENT_FIXTURES, STUB_FIXTURES } from "./support/mindbody-stub";

interface Call {
  method: "GET" | "POST";
  url: string;
  params: Record<string, any>; // Record<string, any>: fixture — value read untyped
}

/**
 * A fake Mindbody API that serves the enrollment fixtures, paged, with the
 * same routes the service reads. `/class/classes` answers by `ClassIds`, like
 * the real endpoint, and `/enrollment/addclienttoenrollment` echoes the stub's
 * behaviour (ClassScheduleId required; EnrollOpen/EnrollDateForward select the
 * sessions that come back).
 */
class FakeApi {
  readonly calls: Call[] = [];
  constructor(private readonly pageCap = 2) {}

  private page<T>(rows: T[], params: Record<string, unknown>, key: string) {
    const offset = Number(params.Offset ?? 0);
    const served = Math.min(Number(params.Limit ?? 100), this.pageCap);
    return {
      PaginationResponse: { RequestedLimit: served, RequestedOffset: offset, PageSize: 0, TotalResults: rows.length },
      [key]: rows.slice(offset, offset + served),
    };
  }

  async get<T>(url: string, options?: { params?: Record<string, any> }): Promise<T> { // Record<string, any>: fixture — value read untyped
    const params = options?.params ?? {};
    this.calls.push({ method: "GET", url, params });
    // Resolving the site's timezone is a /site/sites read that the service now
    // makes whenever it has to fill in a default date range, so the fake serves
    // it. Tests index calls by URL rather than by position, because this lookup
    // shifts the positions of everything after it.
    if (url === "/site/sites") {
      return this.page([{ Id: -99, Name: "Sandbox", TimeZone: ENROLLMENT_TIME_ZONE }], params, "Sites") as T;
    }
    if (url === "/enrollment/enrollments") {
      return this.page([ENROLLMENT_FIXTURES.schedule], params, "Enrollments") as T;
    }
    if (url === "/client/clientschedule") {
      const rows = params.ClientId === ENROLLMENT_FIXTURES.clientId ? [...ENROLLMENT_FIXTURES.visits] : [];
      return this.page(rows, params, "Visits") as T;
    }
    if (url === "/class/classes") {
      const wanted = new Set((params.ClassIds ?? []).map(Number));
      // The drop-in class (ClassId 101) belongs to a plain Class program.
      const dropIn = {
        Id: 101,
        ClassScheduleId: 11,
        ClassDescription: { Id: 1, Name: "Vinyasa Flow", Program: { Id: 1, Name: "Yoga", ScheduleType: "Class" } },
        Staff: { Id: 7, FirstName: "Grace", LastName: "Hopper" },
        Location: { Id: 1, Name: "E2E Main Studio" },
      };
      const rows = [...ENROLLMENT_FIXTURES.sessions, dropIn].filter((cls) => wanted.has(Number(cls.Id)));
      return this.page(rows, params, "Classes") as T;
    }
    throw new Error(`FakeApi: unexpected GET ${url}`);
  }

  async post<T>(url: string, body?: any): Promise<T> {
    this.calls.push({ method: "POST", url, params: body ?? {} });
    if (url !== "/enrollment/addclienttoenrollment") throw new Error(`FakeApi: unexpected POST ${url}`);
    if (!body?.ClientId || body.ClassScheduleId === undefined) {
      throw new Error("MissingRequiredFields: ClassScheduleId is a required parameter.");
    }
    if (Number(body.ClassScheduleId) !== ENROLLMENT_FIXTURES.classScheduleId) {
      throw new Error("NotFound: Enrollment not found");
    }
    const open: string[] | undefined = Array.isArray(body.EnrollOpen) ? body.EnrollOpen : undefined;
    const forward: string | undefined = body.EnrollDateForward;
    const classes = ENROLLMENT_FIXTURES.sessions.filter((session) => {
      if (forward !== undefined) return session.StartDateTime >= forward;
      if (open !== undefined) return open.includes(session.StartDateTime);
      return true;
    });
    return { ...ENROLLMENT_FIXTURES.schedule, Classes: classes.map((s) => ({ ...s, TotalBooked: s.TotalBooked + 1 })), Clients: [] } as T;
  }

  urls(method?: Call["method"]): string[] {
    return this.calls.filter((c) => !method || c.method === method).map((c) => c.url);
  }

  /** The first recorded GET to `url`. Index by URL: a default date range can
   *  prepend a /site/sites lookup for the site timezone. */
  getTo(url: string): Record<string, unknown> {
    const call = this.calls.find((c) => c.method === "GET" && c.url === url);
    if (!call) throw new Error(`FakeApi: no GET ${url} recorded; got ${this.urls("GET").join(", ")}`);
    return call.params;
  }
}

const service = (api: FakeApi) => new MindbodyService(api as any);
const isoDate = (d: Date) => d.toISOString().split("T")[0];
/** The zone the fake site reports, so expected dates are the site's, not the host's. */
const ENROLLMENT_TIME_ZONE = "America/Los_Angeles";

describe("nextjs-app getEnrollments — GET /enrollment/enrollments rows are ClassSchedule", () => {
  it("maps name, program and session type from ClassDescription, days from the Day* flags, and the enrollment options", async () => {
    const api = new FakeApi();
    const { items, total } = await service(api).getEnrollments({ locationIds: [1], startDate: "2026-10-01", endDate: "2026-12-31" });

    expect(total).toBe(1);
    const [row] = items;
    expect(row).toEqual({
      id: ENROLLMENT_FIXTURES.classScheduleId,
      name: "Six Week Boot Camp",
      description: "Six weeks of training",
      courseId: undefined,
      courseName: undefined,
      programId: 10,
      programName: "Boot Camp",
      sessionTypeId: 208,
      sessionTypeName: "Bootcamp",
      staffId: 42,
      staffName: "Ada Lovelace",
      locationId: 1,
      locationName: "E2E Main Studio",
      semesterId: undefined,
      startDate: ENROLLMENT_FIXTURES.schedule.StartDate,
      endDate: ENROLLMENT_FIXTURES.schedule.EndDate,
      startTime: "1899-12-30T18:00:00",
      endTime: "1899-12-30T19:30:00",
      days: ["Tuesday"],
      allowOpenEnrollment: true,
      allowDateForwardEnrollment: true,
      isAvailable: true,
    });
    // Nothing on an Enrollment pretends to be a field the spec does not give a ClassSchedule.
    expect(row).not.toHaveProperty("dayOfWeek");
    expect(row).not.toHaveProperty("maxCapacity");
    expect(row).not.toHaveProperty("webCapacity");
    expect(row).not.toHaveProperty("scheduleType");
  });

  it("sends only the spec's filters (no SemesterIds or CourseIds) and the given dates", async () => {
    const api = new FakeApi();
    await service(api).getEnrollments({
      locationIds: [1],
      classScheduleIds: [2256],
      staffIds: [42],
      programIds: [10],
      sessionTypeIds: [208],
      startDate: "2026-10-01",
      endDate: "2026-12-31",
      ...({ semesterIds: [3], courseIds: [4] } as object),
    });
    const { params } = api.calls[0];
    expect(params).toEqual({
      LocationIds: [1],
      ClassScheduleIds: [2256],
      StaffIds: [42],
      ProgramIds: [10],
      SessionTypeIds: [208],
      StartDate: "2026-10-01",
      EndDate: "2026-12-31",
      Limit: 200,
      Offset: 0,
    });
    expect(params).not.toHaveProperty("SemesterIds");
    expect(params).not.toHaveProperty("CourseIds");
  });

  it("without dates asks for the SITE's today through DEFAULT_ENROLLMENT_WINDOW_DAYS, not the API's today-only default", async () => {
    const api = new FakeApi();
    await service(api).getEnrollments();
    const params = api.getTo("/enrollment/enrollments");
    // Site-local, from the fake site's TimeZone — not the host's UTC calendar.
    expect(params.StartDate).toBe(siteDateString(new Date(), ENROLLMENT_TIME_ZONE));
    expect(params.EndDate).toBe(siteDateStringPlusDays(new Date(), ENROLLMENT_TIME_ZONE, DEFAULT_ENROLLMENT_WINDOW_DAYS));
    expect(DEFAULT_ENROLLMENT_WINDOW_DAYS).toBe(365);
  });

  it("IsAvailable absent is false, Day* flags absent give no days, and a missing ClassDescription gives an empty name", async () => {
    const api = new FakeApi();
    (api as any).get = async (url: string, options?: { params?: Record<string, unknown> }) => {
      const params = options?.params ?? {};
      api.calls.push({ method: "GET", url, params });
      // Route-aware: a blanket answer would be read as an empty site record by
      // the timezone lookup, which this test is not about.
      if (url === "/site/sites") {
        return { PaginationResponse: { TotalResults: 1 }, Sites: [{ Id: -99, Name: "Sandbox", TimeZone: ENROLLMENT_TIME_ZONE }] };
      }
      const rows = [{ Id: 9, Staff: { FirstName: "Only", LastName: "Names" }, Location: null }];
      return { PaginationResponse: { TotalResults: rows.length }, Enrollments: rows.slice(Number(params.Offset ?? 0)) };
    };
    const { items } = await service(api).getEnrollments();
    expect(items[0]).toMatchObject({ id: 9, name: "", staffName: "Only Names", locationName: "", days: [], isAvailable: false });
  });
});

describe("nextjs-app addClientToEnrollment — POST /enrollment/addclienttoenrollment body follows the spec", () => {
  it("sends ClassScheduleId (singular), EnrollOpen as an array of session date-times, and returns the booked sessions", async () => {
    const api = new FakeApi();
    const wanted = [ENROLLMENT_FIXTURES.sessions[1].StartDateTime, ENROLLMENT_FIXTURES.sessions[2].StartDateTime];
    const result = await service(api).addClientToEnrollment({
      clientId: ENROLLMENT_FIXTURES.clientId,
      classScheduleId: ENROLLMENT_FIXTURES.classScheduleId,
      enrollOpenDates: wanted,
    });

    expect(api.urls("POST")).toEqual(["/enrollment/addclienttoenrollment"]);
    expect(api.calls[0].params).toEqual({
      ClientId: ENROLLMENT_FIXTURES.clientId,
      ClassScheduleId: ENROLLMENT_FIXTURES.classScheduleId,
      EnrollDateForward: undefined,
      EnrollOpen: wanted,
      Waitlist: false,
      WaitlistEntryId: undefined,
      SendEmail: false,
      Test: false,
    });
    expect(api.calls[0].params).not.toHaveProperty("ClassScheduleIds");
    expect(result.success).toBe(true);
    expect(result.data?.classScheduleId).toBe(ENROLLMENT_FIXTURES.classScheduleId);
    expect(result.data?.name).toBe("Six Week Boot Camp");
    expect(result.data?.sessions.map((s) => s.startDateTime)).toEqual(wanted);
    expect(result.data?.sessions[0]).toEqual({ classId: 25202, startDateTime: wanted[0], endDateTime: ENROLLMENT_FIXTURES.sessions[1].EndDateTime, totalBooked: 5 });
    expect(result.message).toContain("enrolled in enrollment 2256 (2 session(s)");
  });

  it("EnrollDateForward is one date-time and books every session from it on; Waitlist/WaitlistEntryId/SendEmail/Test pass through", async () => {
    const api = new FakeApi();
    const from = ENROLLMENT_FIXTURES.sessions[3].StartDateTime;
    const result = await service(api).addClientToEnrollment({
      clientId: ENROLLMENT_FIXTURES.clientId,
      classScheduleId: ENROLLMENT_FIXTURES.classScheduleId,
      enrollDateForward: from,
      waitlist: true,
      waitlistEntryId: 5601,
      sendEmail: true,
      test: true,
    });
    expect(api.calls[0].params).toMatchObject({ EnrollDateForward: from, EnrollOpen: undefined, Waitlist: true, WaitlistEntryId: 5601, SendEmail: true, Test: true });
    expect(result.success).toBe(true);
    expect(result.data?.sessions.map((s) => s.classId)).toEqual([25204, 25205]);
    expect(result.message).toStartWith("[test] ");
    expect(result.message).toContain("waitlisted for");
  });

  it("refuses a non-positive classScheduleId before any request, and reports an API error as success: false", async () => {
    const api = new FakeApi();
    const bad = await service(api).addClientToEnrollment({ clientId: "C1", classScheduleId: 0 });
    expect(bad.success).toBe(false);
    expect(bad.message).toContain("classScheduleId must be a positive integer");
    expect(api.calls).toHaveLength(0);

    const missing = await service(api).addClientToEnrollment({ clientId: "C1", classScheduleId: 999 });
    expect(missing.success).toBe(false);
    expect(missing.message).toContain("NotFound");
  });
});

describe("nextjs-app getClientEnrollments — schedule visits resolved through /class/classes", () => {
  it("keeps only visits whose class is in an Enrollment program; drop-in classes and appointments are left out", async () => {
    const api = new FakeApi();
    const { items, total } = await service(api).getClientEnrollments(ENROLLMENT_FIXTURES.clientId, "2026-01-01", "2027-12-31");

    expect(ENROLLMENT_SCHEDULE_TYPE).toBe("Enrollment");
    // Six enrollment visits in the fixtures; the seventh is the drop-in (ClassId 101).
    expect(total).toBe(6);
    expect(items.map((v) => v.id).sort()).toEqual(["100001", "100002", "100003", "100004", "100005", "100006"]);
    expect(items.find((v) => v.id === String(ENROLLMENT_FIXTURES.dropInVisit))).toBeUndefined();
    expect(items.every((v) => v.classScheduleId === ENROLLMENT_FIXTURES.classScheduleId)).toBe(true);
    expect(items.every((v) => v.programName === "Boot Camp" && v.name === "Six Week Boot Camp")).toBe(true);
    // Sorted by start, so the past (signed-in) session comes first.
    expect(items[0]).toMatchObject({ id: String(ENROLLMENT_FIXTURES.pastVisit), signedIn: true, staffName: "Ada Lovelace", locationName: "E2E Main Studio" });
    expect(items.find((v) => v.id === String(ENROLLMENT_FIXTURES.waitlistedVisit))).toMatchObject({ isWaitlisted: true, waitlistEntryId: 5601 });
    expect(items.find((v) => v.id === String(ENROLLMENT_FIXTURES.lateCancelledVisit))).toMatchObject({ lateCancelled: true, isWaitlisted: false, waitlistEntryId: undefined });
    expect(items.find((v) => v.id === String(ENROLLMENT_FIXTURES.futureVisitA))).toEqual({
      id: "100002",
      classId: 25202,
      classScheduleId: 2256,
      name: "Six Week Boot Camp",
      programId: 10,
      programName: "Boot Camp",
      staffId: 42,
      staffName: "Ada Lovelace",
      locationId: 1,
      locationName: "E2E Main Studio",
      startDateTime: ENROLLMENT_FIXTURES.sessions[1].StartDateTime,
      endDateTime: ENROLLMENT_FIXTURES.sessions[1].EndDateTime,
      isWaitlisted: false,
      waitlistEntryId: undefined,
      signedIn: false,
      lateCancelled: false,
      missed: false,
      makeUp: false,
    });
  });

  it("pages the schedule with IncludeWaitlistEntries, then looks the classes up by ClassIds through the pager with the same window", async () => {
    const api = new FakeApi();
    await service(api).getClientEnrollments(ENROLLMENT_FIXTURES.clientId, "2026-01-01", "2027-12-31");

    const schedule = api.calls.filter((c) => c.url === "/client/clientschedule");
    expect(schedule.map((c) => c.params.Offset)).toEqual([0, 2, 4, 6]);
    expect(schedule[0].params).toMatchObject({ ClientId: ENROLLMENT_FIXTURES.clientId, StartDate: "2026-01-01", EndDate: "2027-12-31", IncludeWaitlistEntries: true, Limit: 200 });

    const classes = api.calls.filter((c) => c.url === "/class/classes");
    expect(classes.length).toBeGreaterThan(0);
    // Every schedule call comes before the first class lookup.
    expect(api.urls("GET").indexOf("/class/classes")).toBe(schedule.length);
    expect(classes[0].params).toMatchObject({
      StartDateTime: "2026-01-01T00:00:00",
      EndDateTime: "2027-12-31T23:59:59",
      HideCanceledClasses: false,
      Limit: 200,
      Offset: 0,
    });
    // Unique class IDs, one chunk: the five sessions plus the drop-in class.
    expect([...classes[0].params.ClassIds].sort()).toEqual([101, 25201, 25202, 25203, 25204, 25205]);
    expect(classes.map((c) => c.params.Offset)).toEqual([0, 2, 4]);
  });

  it("looks classes up in chunks of 50 and never calls /class/classes when the schedule has no class visits", async () => {
    const api = new FakeApi(500);
    (api as any).get = async (url: string, options?: { params?: Record<string, unknown> }) => {
      const params = options?.params ?? {};
      api.calls.push({ method: "GET", url, params });
      if (url === "/client/clientschedule") {
        const rows = Array.from({ length: 120 }, (_, i) => ({ Id: i + 1, ClassId: 1000 + i, StartDateTime: "2026-10-18T08:00:00", EndDateTime: "2026-10-18T09:00:00" }));
        return { PaginationResponse: { TotalResults: rows.length }, Visits: rows };
      }
      return { PaginationResponse: { TotalResults: 0 }, Classes: [] };
    };
    const { items } = await service(api).getClientEnrollments("C1", "2026-10-01", "2026-10-31");
    const classCalls = api.calls.filter((c) => c.url === "/class/classes");
    expect(classCalls.map((c) => c.params.ClassIds.length)).toEqual([50, 50, 20]);
    expect(items).toEqual([]);

    const empty = new FakeApi();
    const result = await service(empty).getClientEnrollments("someone-else", "2026-10-01", "2026-10-31");
    expect(result).toEqual({ items: [], total: 0 });
    // Explicit dates need no site-zone lookup, so the schedule is the only read.
    expect(empty.urls("GET")).toEqual(["/client/clientschedule"]);
  });

  it("without dates asks for the SITE's today through DEFAULT_ENROLLMENT_WINDOW_DAYS", async () => {
    const api = new FakeApi();
    await service(api).getClientEnrollments("someone-else");
    const params = api.getTo("/client/clientschedule");
    expect(params.StartDate).toBe(siteDateString(new Date(), ENROLLMENT_TIME_ZONE));
    expect(params.EndDate).toBe(siteDateStringPlusDays(new Date(), ENROLLMENT_TIME_ZONE, DEFAULT_ENROLLMENT_WINDOW_DAYS));
  });
});

describe("nextjs-app enrollment fixtures are the MCP stub's", () => {
  it("uses the same client and schedule IDs as tests/support/mindbody-stub.ts", () => {
    expect(ENROLLMENT_FIXTURES.clientId).toBe(STUB_FIXTURES.clientId);
    expect(ENROLLMENT_FIXTURES.schedule.Id).toBe(ENROLLMENT_FIXTURES.classScheduleId);
  });
});
