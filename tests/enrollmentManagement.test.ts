import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { AxiosRequestConfig } from "axios";
import type { IMindbodyClient } from "../src/api/client.js";
import { SpecValidatingClient } from "./spec-validating-client.js";
import {
  DEFAULT_ENROLLMENT_WINDOW_DAYS,
  MAX_ENROLLMENT_CANCELLATIONS_PER_REQUEST,
  addClientToEnrollmentTool,
  cancelEnrollmentVisitsTool,
  getClientEnrollmentsTool,
  getEnrollmentsTool,
} from "../src/tools/enrollmentManagement.js";
import { SimpleCache } from "../src/cache/index.js";
import { LATE_CANCEL_WINDOW_ENV } from "../src/utils/lateCancel.js";
import {
  SITE_TIMEZONE_ENV,
  epochMsToSiteLocal,
  resetSiteTimeWarningForTests,
  siteDateString,
  siteDateStringPlusDays,
} from "../src/utils/siteTime.js";

const spec = JSON.parse(readFileSync(resolve(__dirname, "../docs/openapi.json"), "utf-8"));

const DAY_MS = 24 * 60 * 60 * 1000;
const CLIENT = "002542";
const OTHER_CLIENT = "009999";
const SITE_TZ = "America/Los_Angeles";
const SCHEDULE_ID = 2256;

function siteLocal(offsetMs: number): string {
  return epochMsToSiteLocal(Date.now() + offsetMs, SITE_TZ);
}

const ENROLLMENT_PROGRAM = { Id: 10, Name: "Boot Camp", ScheduleType: "Enrollment" };
const DROP_IN_PROGRAM = { Id: 3, Name: "Yoga", ScheduleType: "Class" };

/** A Class row as GET /class/classes returns it (shape from the sandbox). */
function classRow(id: number, startDateTime: string, program = ENROLLMENT_PROGRAM, scheduleId = SCHEDULE_ID) {
  return {
    Id: id,
    ClassScheduleId: scheduleId,
    ClassDescription: { Id: 307, Name: program.ScheduleType === "Enrollment" ? "Six Week Boot Camp" : "Vinyasa Flow", Program: program, SessionType: { Id: 208, Name: "Bootcamp" } },
    Staff: { Id: 42, Name: "Ada Lovelace" },
    Location: { Id: 1, Name: "Clubville" },
    StartDateTime: startDateTime,
    EndDateTime: startDateTime,
    TotalBooked: 3,
    SemesterId: null,
  };
}

/** A VisitWithWaitlistInfo row as GET /client/clientschedule returns it. */
function visitRow(id: number, classId: number, startDateTime: string, overrides: Record<string, unknown> = {}) {
  return {
    Id: id,
    ClassId: classId,
    ClientId: CLIENT,
    Name: "Six Week Boot Camp",
    StaffId: 42,
    LocationId: 1,
    StartDateTime: startDateTime,
    EndDateTime: startDateTime,
    SignedIn: false,
    LateCancelled: false,
    Missed: false,
    MakeUp: false,
    AppointmentId: 0,
    WaitlistInfo: { WaitlistId: null, WaitlistOrderNumber: null },
    ...overrides,
  };
}

/**
 * Records every call and validates GET params against docs/openapi.json.
 * Responses are chosen by URL: /site/sites gives a site in `siteZone`,
 * /client/clientschedule gives `visits`, /class/classes gives the subset of
 * `classes` whose Id is in `ClassIds`, /enrollment/enrollments gives
 * `enrollments`. POSTs are answered by `onPost`, which may throw.
 */
class RecordingClient implements IMindbodyClient {
  readonly gets: Array<{ url: string; params: Record<string, unknown> }> = [];
  readonly posts: Array<{ url: string; data: any }> = [];
  readonly cache = new SimpleCache(5);
  siteZone: string | null = SITE_TZ;
  visits: unknown[] = [];
  classes: any[] = [];
  enrollments: unknown[] = [];
  failGet: string | null = null;
  private readonly validator = new SpecValidatingClient(spec, {});

  constructor(
    private readonly onPost: (url: string, data: any, index: number) => unknown = (_url, data) => ({
      Class: { Id: data.ClassId, ClassScheduleId: SCHEDULE_ID, Visits: [], Clients: [] },
    })
  ) {}

  get callCount(): number {
    return this.gets.length + this.posts.length;
  }

  getsTo(url: string) {
    return this.gets.filter((get) => get.url === url);
  }

  async request<T>(): Promise<T> {
    throw new Error("request() is not used by these tools");
  }

  async get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    await this.validator.get(url, config);
    this.gets.push({ url, params: config?.params ?? {} });
    if (this.failGet === url) throw new Error(`simulated failure on ${url}`);
    const page = (key: string, rows: unknown[]) =>
      ({ [key]: rows, PaginationResponse: { RequestedLimit: 200, RequestedOffset: 0, PageSize: rows.length, TotalResults: rows.length } }) as T;
    if (url === "/site/sites") {
      return page("Sites", [{ Id: -99, Name: "Stub", ...(this.siteZone === null ? {} : { TimeZone: this.siteZone }) }]);
    }
    if (url === "/client/clientschedule") return page("Visits", this.visits);
    if (url === "/class/classes") {
      const wanted: number[] = config?.params?.ClassIds ?? [];
      return page("Classes", this.classes.filter((cls) => wanted.includes(cls.Id)));
    }
    if (url === "/enrollment/enrollments") return page("Enrollments", this.enrollments);
    throw new Error(`unexpected GET ${url}`);
  }

  async post<T>(url: string, data?: any): Promise<T> {
    await this.validator.post(url, data);
    this.posts.push({ url, data });
    return this.onPost(url, data, this.posts.length - 1) as T;
  }
}

/** A client holding one enrollment with sessions at the given day offsets. */
function clientWithEnrollment(client: RecordingClient) {
  const past = siteLocal(-7 * DAY_MS);
  const a = siteLocal(3 * DAY_MS);
  const b = siteLocal(10 * DAY_MS);
  const c = siteLocal(17 * DAY_MS);
  client.classes = [
    classRow(25201, past),
    classRow(25202, a),
    classRow(25203, b),
    classRow(25204, c),
    classRow(101, a, DROP_IN_PROGRAM, 77),
  ];
  client.visits = [
    visitRow(100001, 25201, past, { SignedIn: true }),
    visitRow(100002, 25202, a),
    visitRow(100003, 25203, b),
    visitRow(100004, 25204, c, { WaitlistInfo: { WaitlistId: 5601, WaitlistOrderNumber: 2 } }),
    visitRow(100005, 25203, b, { LateCancelled: true }),
    visitRow(100006, 101, a, { Name: "Vinyasa Flow" }),
    visitRow(100007, 0, a, { ClassId: 0, AppointmentId: 8001, Name: "Massage" }),
  ];
  return { past, a, b, c };
}

beforeEach(() => {
  resetSiteTimeWarningForTests();
  delete process.env[SITE_TIMEZONE_ENV];
  delete process.env[LATE_CANCEL_WINDOW_ENV];
});
afterEach(() => {
  delete process.env[SITE_TIMEZONE_ENV];
  delete process.env[LATE_CANCEL_WINDOW_ENV];
});

describe("getEnrollmentsTool", () => {
  it("pages GET /enrollment/enrollments with the spec's filters and a site-local default window", async () => {
    const client = new RecordingClient();
    client.enrollments = [
      {
        Id: SCHEDULE_ID,
        Classes: null,
        Clients: null,
        Course: { Id: 6, Name: "MBU NYC" },
        SemesterId: null,
        IsAvailable: true,
        ClassDescription: { Id: 307, Name: "Six Week Boot Camp", Description: "Burn fat", Program: ENROLLMENT_PROGRAM, SessionType: { Id: 208, Name: "Bootcamp" } },
        DayTuesday: true,
        DayThursday: true,
        AllowOpenEnrollment: false,
        AllowDateForwardEnrollment: true,
        StartTime: "1899-12-30T07:30:00",
        EndTime: "1899-12-30T09:00:00",
        StartDate: "2026-10-09T00:00:00",
        EndDate: "2026-11-13T00:00:00",
        Staff: { Id: 42, FirstName: "Ada", LastName: "Lovelace" },
        Location: { Id: 1, Name: "Clubville" },
      },
    ];
    const result = await getEnrollmentsTool([1], undefined, undefined, [10], undefined, undefined, undefined, client, client.cache);

    expect(result.totalEnrollments).toBe(1);
    expect(result.enrollments[0]).toEqual({
      id: SCHEDULE_ID,
      name: "Six Week Boot Camp",
      description: "Burn fat",
      courseId: 6,
      courseName: "MBU NYC",
      programId: 10,
      programName: "Boot Camp",
      sessionTypeId: 208,
      sessionTypeName: "Bootcamp",
      staffId: 42,
      staffName: "Ada Lovelace",
      locationId: 1,
      locationName: "Clubville",
      semesterId: undefined,
      startDate: "2026-10-09T00:00:00",
      endDate: "2026-11-13T00:00:00",
      startTime: "1899-12-30T07:30:00",
      endTime: "1899-12-30T09:00:00",
      days: ["Tuesday", "Thursday"],
      allowOpenEnrollment: false,
      allowDateForwardEnrollment: true,
      isAvailable: true,
    });

    const [get] = client.getsTo("/enrollment/enrollments");
    const now = new Date();
    expect(get.params).toMatchObject({
      LocationIds: [1],
      ProgramIds: [10],
      StartDate: siteDateString(now, SITE_TZ),
      EndDate: siteDateStringPlusDays(now, SITE_TZ, DEFAULT_ENROLLMENT_WINDOW_DAYS),
      Limit: 200,
      Offset: 0,
    });
    expect(get.params).not.toHaveProperty("SemesterIds");
    expect(get.params).not.toHaveProperty("CourseIds");
  });

  it("passes explicit dates through without resolving the site zone", async () => {
    const client = new RecordingClient();
    await getEnrollmentsTool(undefined, [SCHEDULE_ID], undefined, undefined, undefined, "2026-10-01", "2026-12-31", client, client.cache);
    expect(client.getsTo("/site/sites")).toHaveLength(0);
    expect(client.getsTo("/enrollment/enrollments")[0].params).toMatchObject({ ClassScheduleIds: [SCHEDULE_ID], StartDate: "2026-10-01", EndDate: "2026-12-31" });
  });
});

describe("addClientToEnrollmentTool", () => {
  it("sends the spec's body: singular ClassScheduleId, EnrollDateForward, EnrollOpen, Waitlist, SendEmail, Test", async () => {
    const client = new RecordingClient(() => ({
      Id: SCHEDULE_ID,
      ClassDescription: { Name: "Six Week Boot Camp" },
      Classes: [{ Id: 25202, StartDateTime: "2026-10-23T07:30:00", EndDateTime: "2026-10-23T09:00:00", TotalBooked: 1 }],
    }));
    const result = await addClientToEnrollmentTool(CLIENT, SCHEDULE_ID, "2026-10-23T00:00:00", undefined, false, true, true, undefined, client);

    expect(client.posts).toEqual([
      {
        url: "/enrollment/addclienttoenrollment",
        data: {
          ClientId: CLIENT,
          ClassScheduleId: SCHEDULE_ID,
          EnrollDateForward: "2026-10-23T00:00:00",
          EnrollOpen: undefined,
          Waitlist: false,
          WaitlistEntryId: undefined,
          SendEmail: true,
          Test: true,
        },
      },
    ]);
    expect(result).toEqual({
      success: true,
      classScheduleId: SCHEDULE_ID,
      name: "Six Week Boot Camp",
      sessions: [{ classId: 25202, startDateTime: "2026-10-23T07:30:00", endDateTime: "2026-10-23T09:00:00", totalBooked: 1 }],
      message: `[test] Client ${CLIENT} enrolled in enrollment ${SCHEDULE_ID} (1 session(s) on the schedule)`,
    });
  });

  it("sends EnrollOpen for selected sessions and reports a waitlist booking", async () => {
    const client = new RecordingClient(() => ({ Id: SCHEDULE_ID, Classes: [] }));
    const result = await addClientToEnrollmentTool(CLIENT, SCHEDULE_ID, undefined, ["2026-10-23T07:30:00"], true, false, false, 5601, client);
    expect(client.posts[0].data).toMatchObject({ EnrollOpen: ["2026-10-23T07:30:00"], Waitlist: true, WaitlistEntryId: 5601 });
    expect(result.success).toBe(true);
    expect(result.message).toContain("waitlisted for");
  });

  it("refuses a non-positive classScheduleId without calling the API", async () => {
    const client = new RecordingClient();
    const result = await addClientToEnrollmentTool(CLIENT, 0, undefined, undefined, false, false, false, undefined, client);
    expect(result.success).toBe(false);
    expect(client.callCount).toBe(0);
  });

  it("reports an upstream error as success: false", async () => {
    const client = new RecordingClient(() => {
      throw new Error("Mindbody API Error: Enrollment is full (Code: EnrollmentFull)");
    });
    const result = await addClientToEnrollmentTool(CLIENT, SCHEDULE_ID, undefined, undefined, false, false, false, undefined, client);
    expect(result).toMatchObject({ success: false, classScheduleId: SCHEDULE_ID, sessions: [] });
    expect(result.message).toContain("EnrollmentFull");
  });

  describe("duplicate-booking guard", () => {
    function enrolledClient() {
      const client = new RecordingClient();
      const { a, b, c } = clientWithEnrollment(client);
      client.enrollments = [{ Id: SCHEDULE_ID, StartDate: "2026-01-01T00:00:00", EndDate: "2027-12-31T00:00:00", ClassDescription: { Name: "Six Week Boot Camp", Program: ENROLLMENT_PROGRAM } }];
      return { client, a, b, c };
    }

    it("looks the enrollment up, then the client's sessions in its window, and refuses a whole-enrollment re-book", async () => {
      const { client } = enrolledClient();
      const result = await addClientToEnrollmentTool(CLIENT, SCHEDULE_ID, undefined, undefined, false, false, false, undefined, client, client.cache);
      expect(result.success).toBe(false);
      expect(result.message).toContain("already holds 3 of the requested session(s)");
      expect(result.message).toContain("100001, 100002, 100003");
      expect(client.posts).toHaveLength(0);
      expect(client.getsTo("/enrollment/enrollments")[0].params).toMatchObject({ ClassScheduleIds: [SCHEDULE_ID] });
      expect(client.getsTo("/client/clientschedule")[0].params).toMatchObject({ ClientId: CLIENT, StartDate: "2026-01-01", EndDate: "2027-12-31" });
    });

    it("counts only the sessions the request would book: date-forward and open dates", async () => {
      const { client, b, c } = enrolledClient();
      const forward = await addClientToEnrollmentTool(CLIENT, SCHEDULE_ID, b, undefined, false, false, false, undefined, client, client.cache);
      expect(forward.success).toBe(false);
      expect(forward.message).toContain("already holds 1 of the requested session(s)");
      expect(forward.message).toContain("100003");

      // Session c is held only as a waitlist entry (100004) and a late-cancelled visit (100005): neither is a seat.
      const open = await addClientToEnrollmentTool(CLIENT, SCHEDULE_ID, undefined, [c], false, false, false, undefined, client, client.cache);
      expect(open.success).toBe(true);
      expect(client.posts).toHaveLength(1);
    });

    it("skips the check for waitlist requests and books when the client holds nothing", async () => {
      const { client } = enrolledClient();
      const waitlisted = await addClientToEnrollmentTool(CLIENT, SCHEDULE_ID, undefined, undefined, true, false, false, undefined, client, client.cache);
      expect(waitlisted.success).toBe(true);
      expect(client.getsTo("/enrollment/enrollments")).toHaveLength(0);

      const fresh = new RecordingClient();
      fresh.enrollments = client.enrollments;
      const booked = await addClientToEnrollmentTool(CLIENT, SCHEDULE_ID, undefined, undefined, false, false, false, undefined, fresh, fresh.cache);
      expect(booked.success).toBe(true);
      expect(fresh.posts).toHaveLength(1);
    });

    it("books nothing when the check itself fails", async () => {
      const { client } = enrolledClient();
      client.failGet = "/client/clientschedule";
      const result = await addClientToEnrollmentTool(CLIENT, SCHEDULE_ID, undefined, undefined, false, false, false, undefined, client, client.cache);
      expect(result.success).toBe(false);
      expect(result.message).toContain("nothing was booked");
      expect(client.posts).toHaveLength(0);
    });
  });
});

describe("getClientEnrollmentsTool", () => {
  it("keeps only visits whose class belongs to an Enrollment program, grouped by schedule", async () => {
    const client = new RecordingClient();
    const { past, a, b, c } = clientWithEnrollment(client);
    const result = await getClientEnrollmentsTool(CLIENT, siteDateString(new Date(), SITE_TZ).replace(/\d{4}/, "2020"), undefined, client, client.cache);

    expect(result.totalEnrollments).toBe(1);
    expect(result.totalSessions).toBe(5);
    const [enrollment] = result.enrollments;
    expect(enrollment).toMatchObject({
      classScheduleId: SCHEDULE_ID,
      name: "Six Week Boot Camp",
      programId: 10,
      programName: "Boot Camp",
      staffId: 42,
      staffName: "Ada Lovelace",
      locationId: 1,
      locationName: "Clubville",
      totals: { sessions: 5, attended: 1, missed: 0, lateCancelled: 1, waitlisted: 1 },
    });
    expect(enrollment.sessions.map((s) => s.visitId)).toEqual([100001, 100002, 100003, 100005, 100004]);
    expect(enrollment.sessions[0]).toEqual({
      visitId: 100001, classId: 25201, startDateTime: past, endDateTime: past,
      signedIn: true, lateCancelled: false, missed: false, makeUp: false, isWaitlisted: false, waitlistEntryId: undefined,
    });
    expect(enrollment.sessions[4]).toMatchObject({ visitId: 100004, startDateTime: c, isWaitlisted: true, waitlistEntryId: 5601 });
    expect(enrollment.sessions.map((s) => s.startDateTime)).toEqual([past, a, b, b, c]);

    // The drop-in (ClassId 101) and the appointment (no ClassId) are gone.
    const ids = enrollment.sessions.map((s) => s.visitId);
    expect(ids).not.toContain(100006);
    expect(ids).not.toContain(100007);
  });

  it("asks for waitlist entries, pages the schedule, and resolves classes by ClassIds within the window", async () => {
    const client = new RecordingClient();
    clientWithEnrollment(client);
    await getClientEnrollmentsTool(CLIENT, "2026-10-01", "2027-03-31", client, client.cache);

    const [schedule] = client.getsTo("/client/clientschedule");
    expect(schedule.params).toEqual({ ClientId: CLIENT, StartDate: "2026-10-01", EndDate: "2027-03-31", IncludeWaitlistEntries: true, Limit: 200, Offset: 0 });
    const [classes] = client.getsTo("/class/classes");
    expect(classes.params).toEqual({
      ClassIds: [25201, 25202, 25203, 25204, 101],
      StartDateTime: "2026-10-01T00:00:00",
      EndDateTime: "2027-03-31T23:59:59",
      HideCanceledClasses: false,
      Limit: 200,
      Offset: 0,
    });
    expect(client.getsTo("/site/sites")).toHaveLength(0);
  });

  it("defaults to today through the window in the site's zone and makes no class lookup when there are no class visits", async () => {
    const client = new RecordingClient();
    client.visits = [visitRow(100007, 0, siteLocal(DAY_MS), { ClassId: 0, AppointmentId: 8001 })];
    const result = await getClientEnrollmentsTool(CLIENT, undefined, undefined, client, client.cache);
    expect(result).toEqual({ enrollments: [], totalEnrollments: 0, totalSessions: 0 });
    const now = new Date();
    expect(client.getsTo("/client/clientschedule")[0].params).toMatchObject({
      StartDate: siteDateString(now, SITE_TZ),
      EndDate: siteDateStringPlusDays(now, SITE_TZ, DEFAULT_ENROLLMENT_WINDOW_DAYS),
    });
    expect(client.getsTo("/class/classes")).toHaveLength(0);
  });
});

describe("cancelEnrollmentVisitsTool — request-shape guards make no calls at all", () => {
  it("exposes a limit of 3", () => {
    expect(MAX_ENROLLMENT_CANCELLATIONS_PER_REQUEST).toBe(3);
  });

  it("rejects more than the limit as a whole", async () => {
    const client = new RecordingClient();
    clientWithEnrollment(client);
    const result = await cancelEnrollmentVisitsTool(CLIENT, [100002, 100003, 100004, 100005], false, false, client, client.cache);
    expect(result.success).toBe(false);
    expect(result.cancelled).toEqual([]);
    expect(result.rejected[0].reason).toContain("at most 3");
    expect(client.callCount).toBe(0);
  });

  it("rejects duplicates, non-integers, an empty list and an empty clientId", async () => {
    const client = new RecordingClient();
    expect((await cancelEnrollmentVisitsTool(CLIENT, [100002, 100002], false, false, client, client.cache)).rejected).toEqual([
      { visitId: 100002, reason: "duplicate visit id in request" },
    ]);
    expect((await cancelEnrollmentVisitsTool(CLIENT, [1.5, -1, "x" as any], false, false, client, client.cache)).rejected).toHaveLength(3);
    expect((await cancelEnrollmentVisitsTool(CLIENT, [], false, false, client, client.cache)).rejected[0].reason).toContain("non-empty array");
    expect((await cancelEnrollmentVisitsTool("", [100002], false, false, client, client.cache)).rejected[0].reason).toContain("clientId");
    expect(client.callCount).toBe(0);
  });
});

describe("cancelEnrollmentVisitsTool — verification guards (all-or-nothing)", () => {
  it("fails closed when the site zone cannot be resolved", async () => {
    const client = new RecordingClient();
    client.siteZone = null;
    clientWithEnrollment(client);
    const result = await cancelEnrollmentVisitsTool(CLIENT, [100002], false, false, client, client.cache);
    expect(result.success).toBe(false);
    expect(result.rejected[0].reason).toContain("site timezone unavailable");
    expect(client.posts).toHaveLength(0);
    expect(client.getsTo("/client/clientschedule")).toHaveLength(0);
  });

  it("looks the visits up on the client's own schedule, today through two years out, and resolves their classes", async () => {
    const client = new RecordingClient();
    clientWithEnrollment(client);
    await cancelEnrollmentVisitsTool(CLIENT, [100002], false, false, client, client.cache);
    const now = new Date();
    const start = siteDateString(now, SITE_TZ);
    const end = siteDateStringPlusDays(now, SITE_TZ, 730);
    expect(client.getsTo("/client/clientschedule")[0].params).toEqual({
      ClientId: CLIENT, StartDate: start, EndDate: end, IncludeWaitlistEntries: true, Limit: 200, Offset: 0,
    });
    expect(client.getsTo("/class/classes")[0].params).toMatchObject({ ClassIds: [25202], StartDateTime: `${start}T00:00:00`, EndDateTime: `${end}T23:59:59` });
  });

  it("rejects each bad visit with its reason and writes nothing", async () => {
    const client = new RecordingClient();
    clientWithEnrollment(client);
    const result = await cancelEnrollmentVisitsTool(CLIENT, [100001, 100004, 100005], false, false, client, client.cache);
    expect(result.success).toBe(false);
    expect(result.cancelled).toEqual([]);
    expect(result.rejected).toEqual([
      { visitId: 100001, reason: "session has already started or is in the past" },
      { visitId: 100004, reason: "visit is a waitlist entry (5601), not a booked session; remove it from the waitlist instead" },
      { visitId: 100005, reason: "visit is already late-cancelled" },
    ]);
    expect(client.posts).toHaveLength(0);
  });

  it("rejects a drop-in class visit, an appointment visit and an unknown id", async () => {
    const client = new RecordingClient();
    clientWithEnrollment(client);
    const result = await cancelEnrollmentVisitsTool(CLIENT, [100006, 100007, 424242], false, false, client, client.cache);
    expect(result.rejected).toEqual([
      { visitId: 100006, reason: "visit is a drop-in class, not an enrollment session; use removeClientFromClass" },
      { visitId: 100007, reason: "visit is an appointment, not an enrollment session" },
      { visitId: 424242, reason: "not found for this client" },
    ]);
    expect(client.posts).toHaveLength(0);
  });

  it("treats a visit owned by another client exactly like a missing one", async () => {
    const client = new RecordingClient();
    clientWithEnrollment(client);
    client.visits = client.visits.map((v: any) => (v.Id === 100002 ? { ...v, ClientId: OTHER_CLIENT } : v));
    const result = await cancelEnrollmentVisitsTool(CLIENT, [100002, 100003], false, false, client, client.cache);
    expect(result.rejected).toEqual([{ visitId: 100002, reason: "not found for this client" }]);
    expect(result.cancelled).toEqual([]);
    expect(client.posts).toHaveLength(0);
  });

  it("rejects a signed-in visit but not a Missed one (Mindbody flags future unattended sessions as Missed)", async () => {
    const client = new RecordingClient();
    clientWithEnrollment(client);
    client.visits = client.visits.map((v: any) =>
      v.Id === 100002 ? { ...v, SignedIn: true } : v.Id === 100003 ? { ...v, Missed: true } : v
    );
    const result = await cancelEnrollmentVisitsTool(CLIENT, [100002, 100003], false, false, client, client.cache);
    expect(result.rejected).toEqual([{ visitId: 100002, reason: "visit is already signed in" }]);
    expect(client.posts).toHaveLength(0);

    const alone = await cancelEnrollmentVisitsTool(CLIENT, [100003], false, false, client, client.cache);
    expect(alone.success).toBe(true);
    expect(client.posts).toHaveLength(1);
  });

  it("writes nothing when the lookup itself fails", async () => {
    const client = new RecordingClient();
    clientWithEnrollment(client);
    client.failGet = "/class/classes";
    const result = await cancelEnrollmentVisitsTool(CLIENT, [100002], false, false, client, client.cache);
    expect(result.success).toBe(false);
    expect(result.rejected[0].reason).toContain("visit lookup failed");
    expect(client.posts).toHaveLength(0);
  });
});

describe("cancelEnrollmentVisitsTool — writes", () => {
  it("posts /class/removeclientfromclass per visit with ClientId, ClassId, VisitId, LateCancel, SendEmail", async () => {
    const client = new RecordingClient();
    const { a, b } = clientWithEnrollment(client);
    process.env[LATE_CANCEL_WINDOW_ENV] = "300"; // sessions start in 3 and 10 days (72h, 240h)
    const result = await cancelEnrollmentVisitsTool(CLIENT, [100002, 100003], true, true, client, client.cache);

    expect(result).toEqual({
      success: true,
      cancelled: [
        { visitId: 100002, classId: 25202, classScheduleId: SCHEDULE_ID, startDateTime: a },
        { visitId: 100003, classId: 25203, classScheduleId: SCHEDULE_ID, startDateTime: b },
      ],
      rejected: [],
      message: "Cancelled 2 enrollment session(s) as late cancellations.",
    });
    expect(client.posts).toEqual([
      { url: "/class/removeclientfromclass", data: { ClientId: CLIENT, ClassId: 25202, VisitId: 100002, LateCancel: true, SendEmail: true, Test: false } },
      { url: "/class/removeclientfromclass", data: { ClientId: CLIENT, ClassId: 25203, VisitId: 100003, LateCancel: true, SendEmail: true, Test: false } },
    ]);
  });

  it("refuses a late cancel outside the window, whole request, with no write", async () => {
    const client = new RecordingClient();
    clientWithEnrollment(client);
    process.env[LATE_CANCEL_WINDOW_ENV] = "100"; // 100002 is inside (72h), 100003 outside (240h)
    const result = await cancelEnrollmentVisitsTool(CLIENT, [100002, 100003], true, false, client, client.cache);
    expect(result.success).toBe(false);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].visitId).toBe(100003);
    expect(result.rejected[0].reason).toContain("outside the site's late-cancel window");
    expect(client.posts).toEqual([]);
  });

  it("refuses lateCancel with no call at all when the window is unset or invalid", async () => {
    for (const value of [undefined, "nope", "0"]) {
      if (value === undefined) delete process.env[LATE_CANCEL_WINDOW_ENV];
      else process.env[LATE_CANCEL_WINDOW_ENV] = value;
      const client = new RecordingClient();
      clientWithEnrollment(client);
      const result = await cancelEnrollmentVisitsTool(CLIENT, [100002], true, false, client, client.cache);
      expect(result.success).toBe(false);
      expect(result.rejected).toEqual([expect.objectContaining({ visitId: -1 })]);
      expect(result.rejected[0].reason).toContain(LATE_CANCEL_WINDOW_ENV);
      expect(client.callCount).toBe(0);
    }
  });

  it("defaults LateCancel and SendEmail to false", async () => {
    const client = new RecordingClient();
    clientWithEnrollment(client);
    await cancelEnrollmentVisitsTool(CLIENT, [100002], undefined, undefined, client, client.cache);
    expect(client.posts[0].data).toMatchObject({ LateCancel: false, SendEmail: false });
  });

  it("stops at the first failed write and reports what already stood", async () => {
    const client = new RecordingClient((_url, data, index) => {
      if (index === 1) throw new Error("Mindbody API Error: boom");
      return { Class: { Id: data.ClassId } };
    });
    clientWithEnrollment(client);
    const result = await cancelEnrollmentVisitsTool(CLIENT, [100002, 100003], false, false, client, client.cache);
    expect(result.success).toBe(false);
    expect(result.cancelled.map((c) => c.visitId)).toEqual([100002]);
    expect(result.rejected).toEqual([{ visitId: 100003, reason: "Mindbody API Error: boom" }]);
    expect(result.message).toContain("Cancelled 1 of 2 before visit 100003 failed");
    expect(client.posts).toHaveLength(2);
  });

  it("uses the MINDBODY_SITE_TIMEZONE override only when the site record has no zone", async () => {
    const client = new RecordingClient();
    client.siteZone = null;
    process.env[SITE_TIMEZONE_ENV] = SITE_TZ;
    clientWithEnrollment(client);
    const result = await cancelEnrollmentVisitsTool(CLIENT, [100002], false, false, client, client.cache);
    expect(result.success).toBe(true);
  });
});
