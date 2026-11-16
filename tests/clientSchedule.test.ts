import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { AxiosRequestConfig } from "axios";
import type { IMindbodyClient } from "../src/api/client.js";
import { SimpleCache } from "../src/cache/index.js";
import { DEFAULT_CLIENT_SCHEDULE_WINDOW_DAYS, getClientScheduleTool } from "../src/tools/clientSchedule.js";
import { siteDateString, siteDateStringPlusDays } from "../src/utils/siteTime.js";
import { SpecValidatingClient } from "./spec-validating-client.js";

const spec = JSON.parse(readFileSync(resolve(__dirname, "../docs/openapi.json"), "utf-8"));

const CLIENT = "100000042";
const SITE_TZ = "Asia/Hong_Kong";

const ENROLLMENT_PROGRAM = { Id: 10, Name: "Boot Camp", ScheduleType: "Enrollment" };
const DROP_IN_PROGRAM = { Id: 3, Name: "Yoga", ScheduleType: "Class" };

function classRow(id: number, program: typeof ENROLLMENT_PROGRAM) {
  return { Id: id, ClassScheduleId: 900 + id, ClassDescription: { Id: 7, Name: "x", Program: program } };
}

/** A VisitWithWaitlistInfo row as GET /client/clientschedule returns it. */
function visitRow(id: number, overrides: Record<string, unknown> = {}) {
  return {
    Id: id,
    ClassId: 0,
    AppointmentId: 0,
    ClientId: CLIENT,
    Name: "Session",
    StaffId: 42,
    LocationId: 1,
    ServiceId: 77,
    ServiceName: "10 Class Pack",
    StartDateTime: "2026-12-01T09:00:00",
    EndDateTime: "2026-12-01T10:00:00",
    SignedIn: false,
    LateCancelled: false,
    Missed: false,
    WaitlistInfo: { WaitlistId: null, WaitlistOrderNumber: null },
    ...overrides,
  };
}

/**
 * Records every call and validates it against docs/openapi.json. Serves
 * /client/clientschedule a page at a time (Limit/Offset honoured, TotalResults
 * the full count), /class/classes filtered by ClassIds, and the catalogues.
 */
class RecordingClient implements IMindbodyClient {
  readonly gets: Array<{ url: string; params: Record<string, any> }> = [];
  readonly posts: string[] = [];
  readonly cache = new SimpleCache(5);
  visits: unknown[] = [];
  classes: any[] = [];
  locations = [{ Id: 1, Name: "Central" }];
  staff = [{ Id: 42, FirstName: "Ada", LastName: "Lovelace" }];
  private readonly validator = new SpecValidatingClient(spec, {});

  getsTo(url: string) {
    return this.gets.filter((get) => get.url === url);
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
      return {
        [key]: rows,
        PaginationResponse: { RequestedLimit: params.Limit, RequestedOffset: offset, PageSize: rows.length, TotalResults: all.length },
      } as T;
    };
    if (url === "/site/sites") return page("Sites", [{ Id: -99, Name: "Stub", TimeZone: SITE_TZ }]);
    if (url === "/client/clientschedule") return page("Visits", this.visits);
    if (url === "/class/classes") {
      const wanted: number[] = params.ClassIds ?? [];
      return page("Classes", this.classes.filter((cls) => wanted.includes(cls.Id)));
    }
    if (url === "/site/locations") return page("Locations", this.locations);
    if (url === "/staff/staff") return page("StaffMembers", this.staff);
    throw new Error(`unexpected GET ${url}`);
  }

  async post<T>(url: string): Promise<T> {
    this.posts.push(url);
    throw new Error(`unexpected POST ${url}`);
  }
}

/** One drop-in class, one enrollment session, one appointment and one waitlist entry. */
function fourKinds(client: RecordingClient) {
  client.visits = [
    visitRow(5001, { ClassId: 201, Name: "Vinyasa", StartDateTime: "2026-12-01T09:00:00" }),
    visitRow(5002, { ClassId: 202, Name: "Boot Camp wk 1", StartDateTime: "2026-12-02T09:00:00" }),
    visitRow(5003, { AppointmentId: 8001, AppointmentStatus: "Booked", Name: "Massage", StartDateTime: "2026-12-03T09:00:00" }),
    visitRow(5004, { ClassId: 203, Name: "Vinyasa", StartDateTime: "2026-12-04T09:00:00", WaitlistInfo: { WaitlistId: 6101, WaitlistOrderNumber: 1 } }),
  ];
  client.classes = [classRow(201, DROP_IN_PROGRAM), classRow(202, ENROLLMENT_PROGRAM), classRow(203, DROP_IN_PROGRAM)];
}

describe("getClientScheduleTool", () => {
  it("returns one row per booking with kind class, enrollment, appointment and waitlist", async () => {
    const client = new RecordingClient();
    fourKinds(client);
    const result = await getClientScheduleTool(CLIENT, "2026-12-01", "2026-12-31", client, client.cache);

    expect(result.totalBookings).toBe(4);
    expect(result.bookings.map((b) => [b.kind, b.visitId, b.classId, b.appointmentId])).toEqual([
      ["class", 5001, 201, undefined],
      ["enrollment", 5002, 202, undefined],
      ["appointment", 5003, undefined, 8001],
      ["waitlist", 5004, 203, undefined],
    ]);
    expect(result.bookings[1]).toEqual({
      kind: "enrollment",
      visitId: 5002,
      classId: 202,
      appointmentId: undefined,
      appointmentStatus: undefined,
      startDateTime: "2026-12-02T09:00:00",
      endDateTime: "2026-12-01T10:00:00",
      name: "Boot Camp wk 1",
      staffId: 42,
      staffName: "Ada Lovelace",
      locationId: 1,
      locationName: "Central",
      serviceId: 77,
      serviceName: "10 Class Pack",
      programId: 10,
      programName: "Boot Camp",
      signedIn: false,
      lateCancelled: false,
      missed: false,
      isWaitlisted: false,
      waitlistEntryId: undefined,
    });
    expect(result.bookings[2]).toMatchObject({ appointmentStatus: "Booked", programId: undefined });
    expect(result.bookings[3]).toMatchObject({ isWaitlisted: true, waitlistEntryId: 6101, programName: "Yoga" });
  });

  it("ranks waitlist over appointment over enrollment", async () => {
    const client = new RecordingClient();
    client.visits = [
      visitRow(1, { ClassId: 202, AppointmentId: 9, WaitlistInfo: { WaitlistId: 7, WaitlistOrderNumber: 1 } }),
      visitRow(2, { ClassId: 202, AppointmentId: 9 }),
    ];
    client.classes = [classRow(202, ENROLLMENT_PROGRAM)];
    const { bookings } = await getClientScheduleTool(CLIENT, "2026-12-01", "2026-12-31", client, client.cache);
    expect(bookings.map((b) => b.kind)).toEqual(["waitlist", "appointment"]);
  });

  it("sends ClientId, the given dates unchanged and IncludeWaitlistEntries, and pages until TotalResults is reached", async () => {
    const client = new RecordingClient();
    client.visits = Array.from({ length: 450 }, (_, i) => visitRow(10000 + i, { AppointmentId: 20000 + i }));
    const result = await getClientScheduleTool(CLIENT, "2026-12-01", "2027-01-15", client, client.cache);

    const calls = client.getsTo("/client/clientschedule");
    expect(calls.map((c) => c.params)).toEqual([0, 200, 400].map((Offset) => ({
      ClientId: CLIENT, StartDate: "2026-12-01", EndDate: "2027-01-15", IncludeWaitlistEntries: true, Limit: 200, Offset,
    })));
    expect(result.totalBookings).toBe(450);
    expect(new Set(result.bookings.map((b) => b.visitId)).size).toBe(450);
    expect(client.getsTo("/site/sites")).toHaveLength(0);
    expect(client.getsTo("/class/classes")).toHaveLength(0);
  });

  it("defaults to today through 30 days ahead in the site's zone", async () => {
    const client = new RecordingClient();
    await getClientScheduleTool(CLIENT, undefined, undefined, client, client.cache);
    const now = new Date();
    expect(client.getsTo("/client/clientschedule")[0].params).toMatchObject({
      StartDate: siteDateString(now, SITE_TZ),
      EndDate: siteDateStringPlusDays(now, SITE_TZ, DEFAULT_CLIENT_SCHEDULE_WINDOW_DAYS),
    });
    expect(DEFAULT_CLIENT_SCHEDULE_WINDOW_DAYS).toBe(30);
  });

  it("keeps the raw id and leaves the name undefined when a catalogue does not hold it", async () => {
    const client = new RecordingClient();
    client.visits = [visitRow(1, { AppointmentId: 9, StaffId: 999, LocationId: 888 })];
    const { bookings } = await getClientScheduleTool(CLIENT, "2026-12-01", "2026-12-31", client, client.cache);
    expect(bookings[0]).toMatchObject({ staffId: 999, staffName: undefined, locationId: 888, locationName: undefined });
  });

  it("leaves a class the lookup does not return as kind class with no program", async () => {
    const client = new RecordingClient();
    client.visits = [visitRow(1, { ClassId: 404 })];
    const { bookings } = await getClientScheduleTool(CLIENT, "2026-12-01", "2026-12-31", client, client.cache);
    expect(bookings[0]).toMatchObject({ kind: "class", classId: 404, programId: undefined, programName: undefined });
  });

  it("returns an empty result after one schedule call and no class lookup", async () => {
    const client = new RecordingClient();
    const result = await getClientScheduleTool(CLIENT, "2026-12-01", "2026-12-31", client, client.cache);
    expect(result).toEqual({ bookings: [], totalBookings: 0 });
    expect(client.getsTo("/client/clientschedule")).toHaveLength(1);
    expect(client.getsTo("/class/classes")).toHaveLength(0);
    expect(client.gets).toHaveLength(1);
  });

  it("never POSTs", async () => {
    const client = new RecordingClient();
    fourKinds(client);
    await getClientScheduleTool(CLIENT, undefined, undefined, client, client.cache);
    expect(client.posts).toEqual([]);
  });
});
