import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { AxiosRequestConfig } from "axios";
import type { IMindbodyClient } from "../src/api/client.js";
import { SimpleCache } from "../src/cache/index.js";
import { cancelClientBookingTool, type CancelClientBookingRequest } from "../src/tools/cancelBooking.js";
import { LATE_CANCEL_WINDOW_ENV } from "../src/utils/lateCancel.js";
import { epochMsToSiteLocal } from "../src/utils/siteTime.js";
import { SpecValidatingClient } from "./spec-validating-client.js";

const spec = JSON.parse(readFileSync(resolve(__dirname, "../docs/openapi.json"), "utf-8"));

const CLIENT = "100000042";
const SITE_TZ = "Asia/Hong_Kong";
const ENROLLMENT_PROGRAM = { Id: 10, Name: "Boot Camp", ScheduleType: "Enrollment" };
const DROP_IN_PROGRAM = { Id: 3, Name: "Yoga", ScheduleType: "Class" };

/** Site-local wall time `hours` from now. */
const inHours = (hours: number) => epochMsToSiteLocal(Date.now() + hours * 3_600_000, SITE_TZ);

function visitRow(id: number, startDateTime: string, overrides: Record<string, unknown> = {}) {
  return {
    Id: id,
    ClassId: 0,
    AppointmentId: 0,
    ClientId: CLIENT,
    Name: "Session",
    StartDateTime: startDateTime,
    EndDateTime: startDateTime,
    SignedIn: false,
    LateCancelled: false,
    Missed: false,
    WaitlistInfo: { WaitlistId: null, WaitlistOrderNumber: null },
    ...overrides,
  };
}

/**
 * A stub Mindbody, validated against docs/openapi.json. Serves the schedule,
 * classes, appointments and catalogues; records every POST body. `postFailure`
 * makes the next POST reject; `onPost` lets a test change state as the write lands.
 */
class StubClient implements IMindbodyClient {
  readonly cache = new SimpleCache(5);
  readonly gets: Array<{ url: string; params: Record<string, any> }> = [];
  readonly posts: Array<{ url: string; body: any }> = [];
  visits: any[] = [];
  classes: any[] = [];
  appointments: any[] = [];
  scheduleFailsAfter = Infinity;
  postFailure?: Error;
  onPost?: (body: any) => void;
  private readonly validator = new SpecValidatingClient(spec, {});

  schedulePageOneReads() {
    return this.gets.filter((g) => g.url === "/client/clientschedule" && Number(g.params.Offset ?? 0) === 0).length;
  }

  async request<T>(): Promise<T> {
    throw new Error("request() is not used");
  }

  async get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    await this.validator.get(url, config);
    const params = config?.params ?? {};
    this.gets.push({ url, params });
    const page = (key: string, all: unknown[]) => {
      const offset = Number(params.Offset ?? 0);
      const rows = all.slice(offset, offset + Number(params.Limit ?? all.length));
      return { [key]: rows, PaginationResponse: { PageSize: rows.length, TotalResults: all.length } } as T;
    };
    if (url === "/site/sites") return page("Sites", [{ Id: -99, Name: "Stub", TimeZone: SITE_TZ }]);
    if (url === "/client/clientschedule") {
      if (this.schedulePageOneReads() > this.scheduleFailsAfter) throw new Error("schedule read timed out");
      return page("Visits", this.visits);
    }
    if (url === "/class/classes") {
      const wanted: number[] = (params.ClassIds ?? []).map(Number);
      return page("Classes", this.classes.filter((c) => wanted.includes(c.Id)));
    }
    if (url === "/appointment/staffappointments") {
      const wanted: number[] = (params.AppointmentIds ?? []).map(Number);
      return page("Appointments", this.appointments.filter((a) => wanted.includes(a.Id)));
    }
    if (url === "/site/locations") return page("Locations", []);
    if (url === "/staff/staff") return page("StaffMembers", []);
    throw new Error(`unexpected GET ${url}`);
  }

  async post<T>(url: string, data?: unknown): Promise<T> {
    await this.validator.post(url, data);
    this.posts.push({ url, body: structuredClone(data) });
    this.onPost?.(data);
    if (this.postFailure) throw this.postFailure;
    return { ok: true } as T;
  }
}

function dropIn(client: StubClient, hoursOut: number, visitId = 5001, classId = 201) {
  const start = inHours(hoursOut);
  client.visits.push(visitRow(visitId, start, { ClassId: classId, Name: "Vinyasa" }));
  client.classes.push({ Id: classId, ClassScheduleId: 900, StartDateTime: start, ClassDescription: { Id: 7, Name: "Vinyasa", Program: DROP_IN_PROGRAM } });
  return start;
}

function enrollment(client: StubClient, hoursOut: number, visitId = 6001, classId = 301) {
  const start = inHours(hoursOut);
  client.visits.push(visitRow(visitId, start, { ClassId: classId, Name: "Boot Camp wk 1" }));
  client.classes.push({ Id: classId, ClassScheduleId: 950, StartDateTime: start, ClassDescription: { Id: 8, Name: "Boot Camp", Program: ENROLLMENT_PROGRAM } });
  return start;
}

function appointment(client: StubClient, hoursOut: number, appointmentId = 8001, visitId = 7001) {
  const start = inHours(hoursOut);
  client.visits.push(visitRow(visitId, start, { AppointmentId: appointmentId, AppointmentStatus: "Booked", Name: "Massage" }));
  client.appointments.push({ Id: appointmentId, ClientId: CLIENT, StartDateTime: start, Status: "Booked" });
  return start;
}

const run = (client: StubClient, req: Omit<CancelClientBookingRequest, "clientId">) =>
  cancelClientBookingTool({ clientId: CLIENT, ...req }, client, client.cache);

let savedWindow: string | undefined;
beforeEach(() => {
  savedWindow = process.env[LATE_CANCEL_WINDOW_ENV];
  process.env[LATE_CANCEL_WINDOW_ENV] = "24";
});
afterEach(() => {
  if (savedWindow === undefined) delete process.env[LATE_CANCEL_WINDOW_ENV];
  else process.env[LATE_CANCEL_WINDOW_ENV] = savedWindow;
});

describe("cancelClientBookingTool: decision and routing", () => {
  it("late-cancels a drop-in class 3 hours out when lateCancel is omitted", async () => {
    const client = new StubClient();
    dropIn(client, 3);
    const result = await run(client, { classId: 201 });

    expect(client.posts).toEqual([{ url: "/class/removeclientfromclass", body: { ClientId: CLIENT, ClassId: 201, LateCancel: true } }]);
    expect(result).toMatchObject({ success: true, outcome: "cancelled", mode: "late" });
    expect(result.decision).toMatchObject({ mode: "late", requested: undefined, windowHours: 24 });
    expect(result.receipt).toMatchObject({ tool: "removeClientFromClass", endpoint: "/class/removeclientfromclass", response: { ok: true } });
    expect(result.receipt!.request).toEqual(client.posts[0].body);
  });

  it("normal-cancels a drop-in class 3 days out when lateCancel is omitted", async () => {
    const client = new StubClient();
    dropIn(client, 72);
    const result = await run(client, { classId: 201 });

    expect(client.posts).toHaveLength(1);
    expect(client.posts[0].body).toMatchObject({ ClassId: 201, LateCancel: false });
    expect(result).toMatchObject({ success: true, outcome: "cancelled", mode: "normal" });
  });

  it("sends Execute latecancel for an appointment 2 hours out, receipt equal to the body", async () => {
    const client = new StubClient();
    appointment(client, 2);
    const result = await run(client, { appointmentId: 8001 });

    expect(client.posts).toEqual([
      { url: "/appointment/updateappointment", body: { AppointmentId: 8001, Execute: "latecancel", SendEmail: false } },
    ]);
    expect(result).toMatchObject({ success: true, outcome: "cancelled", mode: "late" });
    expect(result.receipt).toMatchObject({ tool: "cancelAppointments", request: client.posts[0].body });
  });

  it("sends the visit's VisitId with LateCancel true for an enrollment session 2 hours out", async () => {
    const client = new StubClient();
    enrollment(client, 2);
    const result = await run(client, { visitId: 6001, sendEmail: true });

    expect(client.posts).toHaveLength(1);
    expect(client.posts[0]).toEqual({
      url: "/class/removeclientfromclass",
      body: { ClientId: CLIENT, ClassId: 301, VisitId: 6001, LateCancel: true, SendEmail: true, Test: false },
    });
    expect(result).toMatchObject({ success: true, mode: "late", receipt: { tool: "cancelEnrollmentVisits", request: client.posts[0].body } });
  });

  it("normal-cancels inside the window when lateCancel is false", async () => {
    const client = new StubClient();
    dropIn(client, 3);
    const result = await run(client, { classId: 201, lateCancel: false });
    expect(client.posts[0].body.LateCancel).toBe(false);
    expect(result).toMatchObject({ success: true, mode: "normal", decision: { requested: false } });
  });

  it("refuses lateCancel true outside the window with the existing refusal text and no POST", async () => {
    const client = new StubClient();
    dropIn(client, 72);
    const result = await run(client, { classId: 201, lateCancel: true });
    expect(client.posts).toEqual([]);
    expect(result).toMatchObject({ success: false, outcome: "refused", mode: "late" });
    expect(result.message).toContain("outside the site's late-cancel window");
  });

  it("refuses lateCancel true with the window unset, naming the variable, before any read", async () => {
    delete process.env[LATE_CANCEL_WINDOW_ENV];
    const client = new StubClient();
    dropIn(client, 3);
    const result = await run(client, { classId: 201, lateCancel: true });
    expect(client.posts).toEqual([]);
    expect(client.gets).toEqual([]);
    expect(result).toMatchObject({ success: false, outcome: "refused" });
    expect(result.message).toContain(LATE_CANCEL_WINDOW_ENV);
  });

  it("cancels normally when the window is unset and lateCancel is omitted", async () => {
    delete process.env[LATE_CANCEL_WINDOW_ENV];
    const client = new StubClient();
    dropIn(client, 3);
    const result = await run(client, { classId: 201 });
    expect(client.posts[0].body.LateCancel).toBe(false);
    expect(result).toMatchObject({ success: true, mode: "normal", decision: { windowHours: undefined } });
    expect(result.decision!.reason).toContain(LATE_CANCEL_WINDOW_ENV);
  });
});

describe("cancelClientBookingTool: resolution refusals", () => {
  it("refuses a waitlisted row with no POST and says it is a waitlist entry", async () => {
    const client = new StubClient();
    dropIn(client, 3);
    client.visits[0].WaitlistInfo = { WaitlistId: 61, WaitlistOrderNumber: 1 };
    const result = await run(client, { classId: 201 });
    expect(client.posts).toEqual([]);
    expect(result).toMatchObject({ success: false, outcome: "refused" });
    expect(result.message).toContain("waitlist entry");
    expect(result.candidates).toHaveLength(1);
  });

  it("refuses a signed-in row with no POST and says the client is signed in", async () => {
    const client = new StubClient();
    dropIn(client, 3);
    client.visits[0].SignedIn = true;
    const result = await run(client, { visitId: 5001 });
    expect(client.posts).toEqual([]);
    expect(result.message).toContain("signed in");
  });

  it("refuses two bookings sharing a startDateTime and returns both candidates", async () => {
    const client = new StubClient();
    const start = dropIn(client, 5, 5001, 201);
    appointment(client, 5, 8001, 7001);
    client.visits[1].StartDateTime = start;
    const result = await run(client, { startDateTime: start });
    expect(client.posts).toEqual([]);
    expect(result).toMatchObject({ success: false, outcome: "refused" });
    expect(result.candidates!.map((c) => c.visitId).sort()).toEqual([5001, 7001]);
  });

  it("reads only the locator's day for startDateTime and narrows by classScheduleId", async () => {
    const client = new StubClient();
    const start = `${dropIn(client, 5, 5001, 201).slice(0, 16)}:00`;
    dropIn(client, 5, 5002, 202);
    client.classes[1].ClassScheduleId = 901;
    for (const row of [...client.visits, ...client.classes]) row.StartDateTime = start;
    const result = await run(client, { startDateTime: start.slice(0, 16), classScheduleId: 901 });
    const day = start.slice(0, 10);
    expect(client.gets.find((g) => g.url === "/client/clientschedule")!.params).toMatchObject({ StartDate: day, EndDate: day });
    expect(result).toMatchObject({ success: true, booking: { visitId: 5002, classId: 202 } });
    expect(client.posts[0].body.ClassId).toBe(202);
  });

  it("refuses a locator that matches nothing", async () => {
    const client = new StubClient();
    dropIn(client, 3);
    const result = await run(client, { classId: 999 });
    expect(client.posts).toEqual([]);
    expect(result.message).toContain("No booking");
  });

  it("refuses a booking that has already started", async () => {
    const client = new StubClient();
    dropIn(client, -1);
    const result = await run(client, { classId: 201 });
    expect(client.posts).toEqual([]);
    expect(result.message).toContain("already started");
  });

  it("rejects zero or two locators before any read", async () => {
    const client = new StubClient();
    expect((await run(client, {})).message).toContain("exactly one of");
    expect((await run(client, { classId: 1, visitId: 2 })).message).toContain("exactly one of");
    expect((await run(client, { classId: 1, classScheduleId: 2 })).message).toContain("needs startDateTime");
    expect(client.gets).toEqual([]);
  });

  it("refuses sendEmail on a drop-in class, which removeClientFromClass cannot send", async () => {
    const client = new StubClient();
    dropIn(client, 72);
    const result = await run(client, { classId: 201, sendEmail: true });
    expect(client.posts).toEqual([]);
    expect(result.message).toContain("sendEmail");
  });

  it("reports a delegate guard refusal with an empty receipt request", async () => {
    const client = new StubClient();
    appointment(client, 2);
    client.appointments[0].ClientId = "someone-else";
    const result = await run(client, { appointmentId: 8001 });
    expect(client.posts).toEqual([]);
    expect(result).toMatchObject({ success: false, outcome: "refused", receipt: { tool: "cancelAppointments", request: undefined } });
    expect(result.message).toContain("not found for this client");
  });
});

describe("cancelClientBookingTool: failed POST", () => {
  const timeout = () => Object.assign(new Error("timeout of 30000ms exceeded"), { code: "ECONNABORTED" });

  it("does not retry and reports still-booked when the re-read shows the row", async () => {
    const client = new StubClient();
    dropIn(client, 3);
    client.postFailure = timeout();
    const result = await run(client, { classId: 201 });
    expect(client.posts).toHaveLength(1);
    expect(client.schedulePageOneReads()).toBe(2);
    expect(result).toMatchObject({ success: false, outcome: "still-booked", mode: "late" });
    expect(result.reconcile!.booking).toMatchObject({ visitId: 5001 });
    expect(result.receipt).toMatchObject({ request: client.posts[0].body, error: expect.stringContaining("timeout") });
  });

  it("does not retry and reports cancelled when the re-read no longer has the row", async () => {
    const client = new StubClient();
    dropIn(client, 3);
    client.postFailure = timeout();
    client.onPost = () => { client.visits = []; };
    const result = await run(client, { classId: 201 });
    expect(client.posts).toHaveLength(1);
    expect(result).toMatchObject({ success: true, outcome: "cancelled", reconcile: { booking: null } });
  });

  it("reports cancelled when the re-read shows the appointment as LateCancelled", async () => {
    const client = new StubClient();
    appointment(client, 2);
    client.postFailure = timeout();
    client.onPost = () => { client.visits[0].AppointmentStatus = "LateCancelled"; };
    const result = await run(client, { appointmentId: 8001 });
    expect(client.posts).toHaveLength(1);
    expect(result).toMatchObject({ outcome: "cancelled", reconcile: { booking: { appointmentStatus: "LateCancelled" } } });
  });

  it("reports unknown when the re-read itself fails", async () => {
    const client = new StubClient();
    dropIn(client, 3);
    client.postFailure = timeout();
    client.scheduleFailsAfter = 1;
    const result = await run(client, { classId: 201 });
    expect(client.posts).toHaveLength(1);
    expect(result).toMatchObject({ success: false, outcome: "unknown", reconcile: { booking: null, error: expect.stringContaining("timed out") } });
  });
});
