import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { AxiosRequestConfig } from "axios";
import type { IMindbodyClient } from "../src/api/client.js";
import { SpecValidatingClient, SpecValidationError } from "./spec-validating-client.js";
import {
  MAX_CANCELLATIONS_PER_REQUEST,
  addAppointmentTool,
  cancelAppointmentsTool,
  getActiveSessionTimesTool,
  getScheduleItemsTool,
  getStaffAppointmentsTool,
  updateAppointmentTool,
} from "../src/tools/appointmentManagement.js";
import { checkoutShoppingCartTool } from "../src/tools/salesManagement.js";
import { SimpleCache } from "../src/cache/index.js";
import {
  SITE_TIMEZONE_ENV,
  epochMsToSiteLocal,
  resetSiteTimeWarningForTests,
  siteDateString,
  siteDateStringPlusDays,
} from "../src/utils/siteTime.js";

const spec = JSON.parse(readFileSync(resolve(__dirname, "../docs/openapi.json"), "utf-8"));

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const CLIENT = "C-100";
/** The site's zone as GET /site/sites reports it (the sandbox's real zone). */
const SITE_TZ = "America/Los_Angeles";

/** Site-local wall-clock time with no offset, as Mindbody returns it. */
function siteLocal(offsetMs: number, timeZone: string = SITE_TZ): string {
  return epochMsToSiteLocal(Date.now() + offsetMs, timeZone);
}

function row(id: number, overrides: Record<string, unknown> = {}) {
  return { Id: id, ClientId: CLIENT, Status: "Booked", StartDateTime: siteLocal(2 * DAY_MS), ...overrides };
}

/**
 * Records every call. GETs are first validated against docs/openapi.json (so an
 * undocumented query parameter such as `ClientIds` throws). GET /site/sites is
 * answered with a site whose TimeZone is `siteZone` (`null` = no zone); every
 * other GET is answered with `rows`. POSTs are answered by `onPost`, which may
 * throw to simulate a failure. Each client carries its own fresh `cache`, so the
 * cached site record never leaks between tests.
 */
class RecordingClient implements IMindbodyClient {
  readonly gets: Array<{ url: string; params: Record<string, unknown> }> = [];
  readonly posts: Array<{ url: string; data: any }> = [];
  readonly cache = new SimpleCache(5);
  siteZone: string | null = SITE_TZ;
  private readonly validator = new SpecValidatingClient(spec, {});

  constructor(
    private readonly rows: unknown[] = [],
    private readonly onPost: (url: string, data: any, index: number) => unknown = (_url, data) => ({
      Appointment: { Id: data.AppointmentId, Status: data.Execute === "latecancel" ? "LateCancelled" : "Cancelled", StartDateTime: "echoed" },
    })
  ) {}

  get callCount(): number {
    return this.gets.length + this.posts.length;
  }

  /** GET /site/sites calls. */
  get siteGets() {
    return this.gets.filter((get) => get.url === "/site/sites");
  }

  /** Every GET except the site lookup. */
  get dataGets() {
    return this.gets.filter((get) => get.url !== "/site/sites");
  }

  async request<T>(): Promise<T> {
    throw new Error("request() is not used by these tools");
  }

  async get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    await this.validator.get(url, config);
    this.gets.push({ url, params: config?.params ?? {} });
    if (url === "/site/sites") {
      return {
        Sites: [{ Id: -99, Name: "Stub", ...(this.siteZone === null ? {} : { TimeZone: this.siteZone }) }],
        PaginationResponse: { RequestedLimit: 200, RequestedOffset: 0, PageSize: 1, TotalResults: 1 },
      } as T;
    }
    return { Appointments: this.rows, PaginationResponse: { TotalResults: this.rows.length } } as T;
  }

  async post<T>(url: string, data?: any): Promise<T> {
    await this.validator.post(url, data);
    this.posts.push({ url, data });
    return this.onPost(url, data, this.posts.length - 1) as T;
  }
}

describe("cancelAppointmentsTool — request-shape guards make no calls at all", () => {
  it("exposes a limit of 3", () => {
    expect(MAX_CANCELLATIONS_PER_REQUEST).toBe(3);
  });

  it("rejects more than the limit as a whole, without truncating", async () => {
    const client = new RecordingClient([row(1), row(2), row(3), row(4)]);
    const result = await cancelAppointmentsTool(CLIENT, [1, 2, 3, 4], false, false, client, client.cache);
    expect(result.success).toBe(false);
    expect(result.cancelled).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].id).toBe(-1);
    expect(result.rejected[0].reason).toContain("at most 3");
    expect(client.callCount).toBe(0);
  });

  it("rejects duplicate ids", async () => {
    const client = new RecordingClient([row(1)]);
    const result = await cancelAppointmentsTool(CLIENT, [1, 1], false, false, client, client.cache);
    expect(result.success).toBe(false);
    expect(result.rejected).toEqual([{ id: 1, reason: "duplicate appointment id in request" }]);
    expect(client.callCount).toBe(0);
  });

  it("rejects an empty id list, non-integer ids and an empty clientId", async () => {
    const client = new RecordingClient([row(1)]);
    expect((await cancelAppointmentsTool(CLIENT, [], false, false, client, client.cache)).rejected[0].id).toBe(-1);
    const bad = await cancelAppointmentsTool(CLIENT, [1, 2.5, -3], false, false, client, client.cache);
    expect(bad.rejected.map((entry) => entry.id)).toEqual([2.5, -3]);
    const noClient = await cancelAppointmentsTool("  ", [1], false, false, client, client.cache);
    expect(noClient.rejected).toEqual([{ id: -1, reason: "clientId must be a non-empty string" }]);
    expect(client.callCount).toBe(0);
  });
});

describe("cancelAppointmentsTool — verification guards make no writes", () => {
  it("resolves the site zone first, then looks up with spec-valid params: the ids, the single ClientId, site-today onward", async () => {
    const client = new RecordingClient([row(1)]);
    await cancelAppointmentsTool(CLIENT, [1], false, false, client, client.cache);
    expect(client.gets.map((get) => get.url)).toEqual(["/site/sites", "/appointment/staffappointments"]);
    const { params } = client.gets[1];
    expect(params.AppointmentIds).toEqual([1]);
    expect(params.ClientId).toBe(CLIENT);
    expect(params.StartDate).toBe(siteDateString(new Date(), SITE_TZ));
    expect(params.EndDate).toBe(siteDateStringPlusDays(new Date(), SITE_TZ, 730));
    expect(params.StaffIds).toBeUndefined();
  });

  it("uses the cached site record on a second call", async () => {
    const client = new RecordingClient([row(1)]);
    await cancelAppointmentsTool(CLIENT, [1], false, false, client, client.cache);
    await cancelAppointmentsTool(CLIENT, [1], false, false, client, client.cache);
    expect(client.siteGets).toHaveLength(1);
  });

  it("treats another client's appointment as not found, without naming the owner", async () => {
    const client = new RecordingClient([row(1), row(2, { ClientId: "C-200" })]);
    const result = await cancelAppointmentsTool(CLIENT, [1, 2], false, false, client, client.cache);
    expect(result.success).toBe(false);
    expect(result.rejected).toEqual([{ id: 2, reason: "not found for this client" }]);
    expect(JSON.stringify(result)).not.toContain("C-200");
    expect(client.posts).toHaveLength(0);
  });

  it("compares ClientId as strings, strictly", async () => {
    const client = new RecordingClient([row(1, { ClientId: 100 })]);
    const numeric = await cancelAppointmentsTool("100", [1], false, false, client, client.cache);
    expect(numeric.success).toBe(true);
    const prefixClient = new RecordingClient([row(1, { ClientId: 100 })]);
    const prefix = await cancelAppointmentsTool("10", [1], false, false, prefixClient, prefixClient.cache);
    expect(prefix.rejected).toEqual([{ id: 1, reason: "not found for this client" }]);
  });

  it("rejects an id the lookup did not return", async () => {
    const client = new RecordingClient([row(1)]);
    const result = await cancelAppointmentsTool(CLIENT, [1, 7], false, false, client, client.cache);
    expect(result.rejected).toEqual([{ id: 7, reason: "not found for this client" }]);
    expect(client.posts).toHaveLength(0);
  });

  it("rejects an id the lookup returned twice", async () => {
    const client = new RecordingClient([row(1), row(1)]);
    const result = await cancelAppointmentsTool(CLIENT, [1], false, false, client, client.cache);
    expect(result.rejected[0].id).toBe(1);
    expect(result.rejected[0].reason).toContain("more than once");
    expect(client.posts).toHaveLength(0);
  });

  it("rejects an appointment that has already started", async () => {
    const client = new RecordingClient([row(1, { StartDateTime: siteLocal(-60 * 60 * 1000) })]);
    const result = await cancelAppointmentsTool(CLIENT, [1], false, false, client, client.cache);
    expect(result.rejected).toEqual([{ id: 1, reason: "appointment has already started or is in the past" }]);
    expect(client.posts).toHaveLength(0);
  });

  it("rejects an unparseable start time", async () => {
    const client = new RecordingClient([row(1, { StartDateTime: "not a date" })]);
    const result = await cancelAppointmentsTool(CLIENT, [1], false, false, client, client.cache);
    expect(result.rejected).toEqual([{ id: 1, reason: "appointment start time could not be parsed" }]);
    expect(client.posts).toHaveLength(0);
  });

  for (const status of ["Cancelled", "LateCancelled", "Completed", "NoShow"]) {
    it(`rejects an appointment whose status is ${status}`, async () => {
      const client = new RecordingClient([row(1, { Status: status })]);
      const result = await cancelAppointmentsTool(CLIENT, [1], false, false, client, client.cache);
      expect(result.rejected).toEqual([{ id: 1, reason: `appointment status is ${status}, which cannot be cancelled` }]);
      expect(client.posts).toHaveLength(0);
    });
  }

  it("is all-or-nothing: one good and one bad id cancels neither", async () => {
    const client = new RecordingClient([row(1), row(2, { Status: "Cancelled" })]);
    const result = await cancelAppointmentsTool(CLIENT, [1, 2], false, false, client, client.cache);
    expect(result.success).toBe(false);
    expect(result.cancelled).toEqual([]);
    expect(result.rejected.map((entry) => entry.id)).toEqual([2]);
    expect(client.posts).toHaveLength(0);
  });

  it("reports a failed lookup and makes no writes", async () => {
    const client = new RecordingClient([row(1)]);
    const realGet = client.get.bind(client);
    client.get = async <T,>(url: string, config?: AxiosRequestConfig): Promise<T> => {
      if (url === "/site/sites") return realGet<T>(url, config);
      throw new Error("Mindbody API Error: down (Code: 500)");
    };
    const result = await cancelAppointmentsTool(CLIENT, [1], false, false, client, client.cache);
    expect(result.success).toBe(false);
    expect(result.rejected[0]).toEqual({ id: -1, reason: "appointment lookup failed: Mindbody API Error: down (Code: 500)" });
    expect(client.posts).toHaveLength(0);
  });
});

/** Run `fn` with the process timezone set to `tz`, restoring it afterwards. */
async function withProcessTz<T>(tz: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.TZ;
  process.env.TZ = tz;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
}

/** Minutes the host's local time is behind UTC on 15 January (Date#getTimezoneOffset). */
const JANUARY_OFFSET_MINUTES: Record<string, number> = {
  "Asia/Hong_Kong": -480,
  "America/Los_Angeles": 480,
};

describe("cancelAppointmentsTool — the start-time guard uses the SITE's zone, not the process's", () => {
  // Every combination where the process zone differs from (or equals) the site
  // zone. With the old process-local parse, a Los Angeles site seen from a Hong
  // Kong process put "+2h" 15 hours in the past (wrongly rejected), and a Hong
  // Kong site seen from a Los Angeles process put "-2h" 13 hours in the future
  // (wrongly accepted).
  for (const processTz of ["Asia/Hong_Kong", "America/Los_Angeles"]) {
    for (const siteTz of ["America/Los_Angeles", "Asia/Hong_Kong"]) {
      it(`process TZ=${processTz}, site ${siteTz}: +2h is accepted, -2h is rejected`, async () => {
        await withProcessTz(processTz, async () => {
          // Prove the process zone really switched, so the case is meaningful.
          expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(JANUARY_OFFSET_MINUTES[processTz]);

          const future = new RecordingClient([row(1, { StartDateTime: siteLocal(2 * HOUR_MS, siteTz) })]);
          future.siteZone = siteTz;
          const accepted = await cancelAppointmentsTool(CLIENT, [1], false, false, future, future.cache);
          expect(accepted.rejected).toEqual([]);
          expect(accepted.success).toBe(true);
          expect(future.posts).toHaveLength(1);

          const past = new RecordingClient([row(2, { StartDateTime: siteLocal(-2 * HOUR_MS, siteTz) })]);
          past.siteZone = siteTz;
          const rejected = await cancelAppointmentsTool(CLIENT, [2], false, false, past, past.cache);
          expect(rejected.success).toBe(false);
          expect(rejected.rejected).toEqual([{ id: 2, reason: "appointment has already started or is in the past" }]);
          expect(past.posts).toHaveLength(0);

          // The lookup window starts on the site's calendar date.
          expect(past.dataGets[0].params.StartDate).toBe(siteDateString(new Date(), siteTz));
        });
      });
    }
  }
});

describe("cancelAppointmentsTool — fails closed without a site timezone", () => {
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env[SITE_TIMEZONE_ENV];
    delete process.env[SITE_TIMEZONE_ENV];
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env[SITE_TIMEZONE_ENV];
    else process.env[SITE_TIMEZONE_ENV] = savedEnv;
  });

  it("refuses, with no lookup and no write, when the site record has no TimeZone", async () => {
    const client = new RecordingClient([row(1)]);
    client.siteZone = null;
    const result = await cancelAppointmentsTool(CLIENT, [1], false, false, client, client.cache);
    expect(result.success).toBe(false);
    expect(result.cancelled).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].id).toBe(-1);
    expect(result.rejected[0].reason).toStartWith("site timezone unavailable: Cannot determine the site timezone");
    expect(result.message).toContain("no appointments were cancelled");
    expect(client.siteGets).toHaveLength(1);
    expect(client.dataGets).toHaveLength(0);
    expect(client.posts).toHaveLength(0);
  });

  it("refuses, with no write, when the site lookup itself fails", async () => {
    const client = new RecordingClient([row(1)]);
    client.get = async () => {
      throw new Error("Mindbody API Error: down (Code: 500)");
    };
    const result = await cancelAppointmentsTool(CLIENT, [1], false, false, client, client.cache);
    expect(result.success).toBe(false);
    expect(result.rejected[0].id).toBe(-1);
    expect(result.rejected[0].reason).toContain("site lookup failed: Mindbody API Error: down (Code: 500)");
    expect(client.posts).toHaveLength(0);
  });

  it("refuses when the site's zone is not a valid IANA name", async () => {
    const client = new RecordingClient([row(1)]);
    client.siteZone = "Pacific Standard Time";
    const result = await cancelAppointmentsTool(CLIENT, [1], false, false, client, client.cache);
    expect(result.success).toBe(false);
    expect(result.rejected[0].reason).toContain('no usable TimeZone (got "Pacific Standard Time")');
    expect(client.posts).toHaveLength(0);
  });

  it("honours MINDBODY_SITE_TIMEZONE when the API has no zone", async () => {
    process.env[SITE_TIMEZONE_ENV] = "Asia/Hong_Kong";
    const client = new RecordingClient([row(1, { StartDateTime: siteLocal(2 * HOUR_MS, "Asia/Hong_Kong") })]);
    client.siteZone = null;
    const result = await cancelAppointmentsTool(CLIENT, [1], false, false, client, client.cache);
    expect(result.success).toBe(true);
    expect(client.posts).toHaveLength(1);
  });
});

describe("cancelAppointmentsTool — execution", () => {
  it("cancels each verified id with exactly one POST, Execute cancel, SendEmail false", async () => {
    const client = new RecordingClient([row(1), row(2), { Id: 99, ClientId: CLIENT }]);
    const result = await cancelAppointmentsTool(CLIENT, [1, 2], undefined, undefined, client, client.cache);
    expect(result.success).toBe(true);
    expect(result.rejected).toEqual([]);
    expect(result.cancelled).toEqual([
      { id: 1, status: "Cancelled", startDateTime: "echoed" },
      { id: 2, status: "Cancelled", startDateTime: "echoed" },
    ]);
    expect(client.posts).toEqual([
      { url: "/appointment/updateappointment", data: { AppointmentId: 1, Execute: "cancel", SendEmail: false } },
      { url: "/appointment/updateappointment", data: { AppointmentId: 2, Execute: "cancel", SendEmail: false } },
    ]);
  });

  it("sends Execute latecancel and honours sendEmail", async () => {
    const client = new RecordingClient([row(1)]);
    const result = await cancelAppointmentsTool(CLIENT, [1], true, true, client, client.cache);
    expect(result.cancelled).toEqual([{ id: 1, status: "LateCancelled", startDateTime: "echoed" }]);
    expect(client.posts.map((post) => post.data)).toEqual([{ AppointmentId: 1, Execute: "latecancel", SendEmail: true }]);
  });

  it("falls back to the looked-up start time when the response omits it", async () => {
    const start = siteLocal(3 * DAY_MS);
    const client = new RecordingClient([row(1, { StartDateTime: start })], () => ({}));
    const result = await cancelAppointmentsTool(CLIENT, [1], false, false, client, client.cache);
    expect(result.cancelled).toEqual([{ id: 1, status: "Cancelled", startDateTime: start }]);
  });

  it("stops at the first failure and reports what was and was not done", async () => {
    const client = new RecordingClient([row(1), row(2), row(3)], (_url, data, index) => {
      if (index === 1) throw new Error("Mindbody API Error: nope (Code: 400)");
      return { Appointment: { Id: data.AppointmentId, Status: "Cancelled", StartDateTime: "echoed" } };
    });
    const result = await cancelAppointmentsTool(CLIENT, [1, 2, 3], false, false, client, client.cache);
    expect(result.success).toBe(false);
    expect(result.cancelled).toEqual([{ id: 1, status: "Cancelled", startDateTime: "echoed" }]);
    expect(result.rejected).toEqual([{ id: 2, reason: "Mindbody API Error: nope (Code: 400)" }]);
    expect(result.message).toContain("Not attempted: 3");
    // Appointment 3 was never attempted.
    expect(client.posts.map((post) => post.data.AppointmentId)).toEqual([1, 2]);
  });

  it("with two ids, a failure on the second leaves one cancelled and one rejected", async () => {
    const client = new RecordingClient([row(1), row(2)], (_url, data, index) => {
      if (index === 1) throw new Error("boom");
      return { Appointment: { Id: data.AppointmentId, Status: "Cancelled", StartDateTime: "echoed" } };
    });
    const result = await cancelAppointmentsTool(CLIENT, [1, 2], false, false, client, client.cache);
    expect(result.success).toBe(false);
    expect(result.cancelled).toHaveLength(1);
    expect(result.rejected).toEqual([{ id: 2, reason: "boom" }]);
  });
});

describe("updateAppointmentTool — request-shape guards make no calls at all", () => {
  it("requires a non-empty clientId and a positive integer appointmentId", async () => {
    const client = new RecordingClient([row(1)]);
    expect((await updateAppointmentTool("  ", 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, client, client.cache)).rejected)
      .toEqual([{ id: -1, reason: "clientId must be a non-empty string" }]);
    for (const bad of [0, -3, 2.5, "5", null, undefined]) {
      const result = await updateAppointmentTool(CLIENT, bad as any, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, client, client.cache);
      expect(result.success).toBe(false);
      expect(result.rejected[0].id).toBe(-1);
      expect(result.rejected[0].reason).toContain("not a positive integer");
    }
    expect(client.callCount).toBe(0);
  });

  for (const value of ["cancel", "latecancel", "CANCEL", "explode"]) {
    it(`refuses execute ${value} and makes no call`, async () => {
      const client = new RecordingClient([row(1)]);
      const result = await updateAppointmentTool(CLIENT, 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, value as any, client, client.cache);
      expect(result.success).toBe(false);
      expect(result.rejected[0].id).toBe(-1);
      expect(result.message).toContain("cancelAppointments");
      expect(client.callCount).toBe(0);
    });
  }

  it("refuses applyPayment combined with a reschedule, with no call", async () => {
    const client = new RecordingClient([row(1)]);
    const result = await updateAppointmentTool(CLIENT, 1, undefined, "2030-01-01T10:00:00", undefined, undefined, undefined, undefined, undefined, true, undefined, client, client.cache);
    expect(result.success).toBe(false);
    expect(result.rejected[0].reason).toContain("cannot be combined with a reschedule");
    expect(client.callCount).toBe(0);
  });
});

describe("updateAppointmentTool — ownership is verified before any write", () => {
  it("looks the appointment up by id and the single ClientId, over a window that reaches both ways", async () => {
    const client = new RecordingClient([row(1)]);
    const result = await updateAppointmentTool(CLIENT, 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, client, client.cache);
    expect(result.success).toBe(true);
    expect(client.gets.map((get) => get.url)).toEqual(["/site/sites", "/appointment/staffappointments"]);
    const { params } = client.gets[1];
    expect(params.AppointmentIds).toEqual([1]);
    expect(params.ClientId).toBe(CLIENT);
    expect("ClientIds" in params).toBe(false);
    // A completed appointment may be annotated, so the window must reach into the past.
    expect(params.StartDate).toBe(siteDateStringPlusDays(new Date(), SITE_TZ, -365));
    expect(params.EndDate).toBe(siteDateStringPlusDays(new Date(), SITE_TZ, 730));
    expect(client.posts).toHaveLength(1);
  });

  it("reports another client's appointment as not found, without naming the owner", async () => {
    const client = new RecordingClient([row(1, { ClientId: "C-200" })]);
    const result = await updateAppointmentTool(CLIENT, 1, undefined, undefined, undefined, undefined, "overwrite their notes", undefined, undefined, undefined, "complete", client, client.cache);
    expect(result.success).toBe(false);
    expect(result.rejected).toEqual([{ id: 1, reason: "not found for this client" }]);
    expect(JSON.stringify(result)).not.toContain("C-200");
    expect(client.posts).toHaveLength(0);
  });

  it("compares ClientId as strings, strictly", async () => {
    const numeric = new RecordingClient([row(1, { ClientId: 100 })]);
    expect((await updateAppointmentTool("100", 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, numeric, numeric.cache)).success).toBe(true);
    const prefixClient = new RecordingClient([row(1, { ClientId: 100 })]);
    const prefix = await updateAppointmentTool("10", 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, prefixClient, prefixClient.cache);
    expect(prefix.rejected).toEqual([{ id: 1, reason: "not found for this client" }]);
    expect(prefixClient.posts).toHaveLength(0);
  });

  it("reads ownership off Client.Id when ClientId is absent", async () => {
    const client = new RecordingClient([{ Id: 1, Status: "Booked", StartDateTime: siteLocal(2 * DAY_MS), Client: { Id: CLIENT } }]);
    expect((await updateAppointmentTool(CLIENT, 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, client, client.cache)).success).toBe(true);
  });

  it("refuses an id the lookup did not return, and one it returned twice", async () => {
    const missing = new RecordingClient([row(1)]);
    expect((await updateAppointmentTool(CLIENT, 9, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, missing, missing.cache)).rejected)
      .toEqual([{ id: 9, reason: "not found for this client" }]);
    expect(missing.posts).toHaveLength(0);

    const twice = new RecordingClient([row(1), row(1)]);
    const result = await updateAppointmentTool(CLIENT, 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, twice, twice.cache);
    expect(result.rejected[0].reason).toContain("more than once");
    expect(twice.posts).toHaveLength(0);
  });

  it("makes no write when the lookup fails", async () => {
    const client = new RecordingClient([row(1)]);
    const realGet = client.get.bind(client);
    client.get = async <T,>(url: string, config?: AxiosRequestConfig): Promise<T> => {
      if (url === "/site/sites") return realGet<T>(url, config);
      throw new Error("Mindbody API Error: down (Code: 500)");
    };
    const result = await updateAppointmentTool(CLIENT, 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, client, client.cache);
    expect(result.success).toBe(false);
    expect(result.rejected[0].reason).toContain("appointment lookup failed");
    expect(client.posts).toHaveLength(0);
  });

  it("fails closed without a site timezone, with no lookup and no write", async () => {
    const client = new RecordingClient([row(1)]);
    client.siteZone = null;
    const result = await updateAppointmentTool(CLIENT, 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, client, client.cache);
    expect(result.success).toBe(false);
    expect(result.rejected[0].reason).toStartWith("site timezone unavailable:");
    expect(client.dataGets).toHaveLength(0);
    expect(client.posts).toHaveLength(0);
  });
});

describe("updateAppointmentTool — status guards make no writes", () => {
  for (const status of ["Cancelled", "LateCancelled"]) {
    it(`refuses every update to a ${status} appointment`, async () => {
      const client = new RecordingClient([row(1, { Status: status })]);
      const result = await updateAppointmentTool(CLIENT, 1, undefined, undefined, undefined, undefined, "a note", undefined, undefined, undefined, undefined, client, client.cache);
      expect(result.success).toBe(false);
      expect(result.rejected[0].reason).toContain(`appointment status is ${status}, which is final`);
      expect(client.posts).toHaveLength(0);
    });
  }

  for (const status of ["Completed", "NoShow"]) {
    it(`refuses execute on a ${status} appointment but still allows a note`, async () => {
      for (const verb of ["arrive", "unarrive", "complete"]) {
        const client = new RecordingClient([row(1, { Status: status })]);
        const result = await updateAppointmentTool(CLIENT, 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, verb as any, client, client.cache);
        expect(result.success).toBe(false);
        expect(result.rejected[0].reason).toContain(`appointment status is ${status}, which has settled`);
        expect(client.posts).toHaveLength(0);
      }

      const noted = new RecordingClient([row(1, { Status: status })]);
      const ok = await updateAppointmentTool(CLIENT, 1, undefined, undefined, undefined, undefined, "late note", undefined, undefined, undefined, undefined, noted, noted.cache);
      expect(ok.success).toBe(true);
      expect(noted.posts).toHaveLength(1);
    });

    it(`refuses applyPayment and a reschedule on a ${status} appointment`, async () => {
      const paid = new RecordingClient([row(1, { Status: status })]);
      const paidResult = await updateAppointmentTool(CLIENT, 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, true, undefined, paid, paid.cache);
      expect(paidResult.success).toBe(false);
      expect(paidResult.rejected[0].reason).toContain("a payment cannot be applied");
      expect(paid.posts).toHaveLength(0);

      const moved = new RecordingClient([row(1, { Status: status })]);
      const movedResult = await updateAppointmentTool(CLIENT, 1, undefined, siteLocal(3 * DAY_MS), undefined, undefined, undefined, undefined, undefined, undefined, undefined, moved, moved.cache);
      expect(movedResult.success).toBe(false);
      expect(movedResult.rejected[0].reason).toContain("cannot be rescheduled");
      expect(moved.posts).toHaveLength(0);
    });
  }
});

describe("updateAppointmentTool — the complete guard uses the SITE's zone", () => {
  it("refuses to complete an appointment that has not started, and allows one that has", async () => {
    const future = new RecordingClient([row(1, { StartDateTime: siteLocal(2 * DAY_MS) })]);
    const refused = await updateAppointmentTool(CLIENT, 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "complete", future, future.cache);
    expect(refused.success).toBe(false);
    expect(refused.rejected[0].reason).toContain("needs the appointment to have started");
    expect(future.posts).toHaveLength(0);

    const started = new RecordingClient([row(2, { StartDateTime: siteLocal(-2 * HOUR_MS) })]);
    const allowed = await updateAppointmentTool(CLIENT, 2, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "complete", started, started.cache);
    expect(allowed.success).toBe(true);
    expect(started.posts[0].data.Execute).toBe("complete");
  });

  for (const processTz of ["Asia/Hong_Kong", "America/Los_Angeles"]) {
    for (const siteTz of ["America/Los_Angeles", "Asia/Hong_Kong"]) {
      it(`process TZ=${processTz}, site ${siteTz}: the same instant decides it either way`, async () => {
        await withProcessTz(processTz, async () => {
          const notYet = new RecordingClient([row(1, { StartDateTime: siteLocal(2 * HOUR_MS, siteTz) })]);
          notYet.siteZone = siteTz;
          expect((await updateAppointmentTool(CLIENT, 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "complete", notYet, notYet.cache)).success).toBe(false);
          expect(notYet.posts).toHaveLength(0);

          const underway = new RecordingClient([row(2, { StartDateTime: siteLocal(-2 * HOUR_MS, siteTz) })]);
          underway.siteZone = siteTz;
          expect((await updateAppointmentTool(CLIENT, 2, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "complete", underway, underway.cache)).success).toBe(true);
          expect(underway.posts).toHaveLength(1);
        });
      });
    }
  }

  it("refuses an unparseable start time rather than comparing it", async () => {
    const client = new RecordingClient([row(1, { StartDateTime: "not a date" })]);
    const result = await updateAppointmentTool(CLIENT, 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "complete", client, client.cache);
    expect(result.rejected[0].reason).toBe("appointment start time could not be parsed");
    expect(client.posts).toHaveLength(0);
  });

  it("does not time-gate arrive: a future booking can still be checked in", async () => {
    const client = new RecordingClient([row(1, { StartDateTime: siteLocal(6 * DAY_MS) })]);
    const result = await updateAppointmentTool(CLIENT, 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "arrive", client, client.cache);
    expect(result.success).toBe(true);
    expect(client.posts[0].data.Execute).toBe("arrive");
  });

  it("does not time-gate a reschedule or a confirm of a future booking", async () => {
    const client = new RecordingClient([row(1)]);
    const result = await updateAppointmentTool(CLIENT, 1, undefined, siteLocal(4 * DAY_MS), undefined, undefined, undefined, undefined, false, undefined, "confirm", client, client.cache);
    expect(result.success).toBe(true);
    expect(client.posts[0].data.StartDateTime).toBe(siteLocal(4 * DAY_MS));
  });
});

describe("updateAppointmentTool — the write", () => {
  const updated = () => ({ Appointment: { Id: 5, Status: "Arrived", StartDateTime: "s", EndDateTime: "e", Staff: { Name: "Ada" } } });

  it("sends exactly the given fields and never ExecutePayment", async () => {
    const client = new RecordingClient([row(5)], updated);
    const result = await updateAppointmentTool(CLIENT, 5, 42, undefined, undefined, undefined, "n", true, true, true, "arrive", client, client.cache);
    expect(result.success).toBe(true);
    expect(result.rejected).toEqual([]);
    expect(result.appointment?.status).toBe("Arrived");
    expect(client.posts).toHaveLength(1);
    expect(client.posts[0].data).toEqual({
      AppointmentId: 5,
      StaffId: 42,
      Notes: "n",
      Execute: "arrive",
      SendEmail: true,
      ApplyPayment: true,
    });
    expect("ExecutePayment" in client.posts[0].data).toBe(false);
  });

  it("omits Execute when not given", async () => {
    const client = new RecordingClient([row(5)], updated);
    await updateAppointmentTool(CLIENT, 5, 42, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, client, client.cache);
    expect(client.posts[0].data.Execute).toBeUndefined();
  });

  it("reports an upstream failure", async () => {
    const client = new RecordingClient([row(5)], () => { throw new Error("Mindbody API Error: nope (Code: 400)"); });
    const result = await updateAppointmentTool(CLIENT, 5, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, client, client.cache);
    expect(result.success).toBe(false);
    expect(result.message).toContain("nope");
  });
});

describe("addAppointmentTool", () => {
  it("never sends ExecutePayment, even when the caller passes it", async () => {
    const client = new RecordingClient([], () => ({ Appointment: { Id: 1, Status: "Booked" } }));
    const result = await addAppointmentTool(CLIENT, 42, 1, 9, "2030-01-01T10:00:00", undefined, undefined, undefined, true, false, undefined, client);
    expect(result.success).toBe(true);
    expect("ExecutePayment" in client.posts[0].data).toBe(false);
  });
});

describe("getStaffAppointmentsTool", () => {
  it("sends the single, spec-defined ClientId", async () => {
    const client = new RecordingClient([row(1)]);
    const result = await getStaffAppointmentsTool([42], undefined, "2030-01-01", "2030-01-02", undefined, CLIENT, client, client.cache);
    expect(result.appointments).toHaveLength(1);
    expect(client.gets[0].params.ClientId).toBe(CLIENT);
    expect("ClientIds" in client.gets[0].params).toBe(false);
  });

  it("passes explicit dates through unchanged without looking up the site", async () => {
    const client = new RecordingClient([]);
    await getStaffAppointmentsTool([42], undefined, "2030-01-01", "2030-01-02", undefined, undefined, client, client.cache);
    expect(client.siteGets).toHaveLength(0);
    expect(client.dataGets[0].params.StartDate).toBe("2030-01-01");
    expect(client.dataGets[0].params.EndDate).toBe("2030-01-02");
  });

  for (const processTz of ["Asia/Hong_Kong", "America/Los_Angeles", "UTC"]) {
    it(`defaults to the site's today .. today+7 under process TZ=${processTz}`, async () => {
      await withProcessTz(processTz, async () => {
        const client = new RecordingClient([]);
        await getStaffAppointmentsTool([42], undefined, undefined, undefined, undefined, undefined, client, client.cache);
        expect(client.siteGets).toHaveLength(1);
        expect(client.dataGets[0].params.StartDate).toBe(siteDateString(new Date(), SITE_TZ));
        expect(client.dataGets[0].params.EndDate).toBe(siteDateStringPlusDays(new Date(), SITE_TZ, 7));
      });
    });
  }

  it("falls back to UTC dates (with one warning) when the site zone is unavailable, and still reads", async () => {
    const savedEnv = process.env[SITE_TIMEZONE_ENV];
    delete process.env[SITE_TIMEZONE_ENV];
    resetSiteTimeWarningForTests();
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const client = new RecordingClient([row(1)]);
      client.siteZone = null;
      const result = await getStaffAppointmentsTool([42], undefined, undefined, undefined, undefined, undefined, client, client.cache);
      expect(result.appointments).toHaveLength(1);
      expect(client.dataGets[0].params.StartDate).toBe(siteDateString(new Date(), "UTC"));
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
      if (savedEnv === undefined) delete process.env[SITE_TIMEZONE_ENV];
      else process.env[SITE_TIMEZONE_ENV] = savedEnv;
    }
  });

  it("is rejected by the spec validator if the plural ClientIds is sent", async () => {
    const client = new RecordingClient([]);
    await expect(client.get("/appointment/staffappointments", { params: { ClientIds: [CLIENT] } })).rejects.toThrow(
      'Unrecognised query parameter "ClientIds"'
    );
  });
});

describe("checkoutShoppingCartTool — appointment reconciliation", () => {
  const cart = (appointments: unknown) => ({
    ShoppingCart: { Id: "c", CartItems: [{ Id: 501, Name: "Pack", UnitPrice: 1, Quantity: 1, Appointments: appointments }] },
    Appointments: [{ Id: 9001, Status: "Booked", StartDateTime: "s", EndDateTime: "e" }],
  });

  it("sends AppointmentIds on the item wrapper and maps reconciled appointments", async () => {
    const client = new RecordingClient([], () => cart([{ Id: 9001, Status: "Booked" }]));
    const result = await checkoutShoppingCartTool(
      CLIENT,
      [{ item: { type: "Service", metadata: { id: 501 } }, quantity: 1, appointmentIds: [9001] }],
      [{ type: "Cash", metadata: { amount: 1 } }],
      false, undefined, false, undefined, client
    );
    expect(result.success).toBe(true);
    expect(client.posts[0].data.Items[0].AppointmentIds).toEqual([9001]);
    expect(result.shoppingCart?.items[0].appointments).toEqual([9001]);
    expect(result.appointments?.[0]).toMatchObject({ id: 9001, status: "Booked", startDateTime: "s" });
  });

  it("accepts reconciled appointments returned as bare ids", async () => {
    const client = new RecordingClient([], () => cart([9001, 9002]));
    const result = await checkoutShoppingCartTool(CLIENT, [{ item: { type: "Service", metadata: { id: 501 } }, quantity: 1, appointmentIds: [9001, 9002] }], [], false, undefined, false, undefined, client);
    expect(result.shoppingCart?.items[0].appointments).toEqual([9001, 9002]);
  });

  it("omits AppointmentIds and item appointments when none are involved", async () => {
    const client = new RecordingClient([], () => cart(undefined));
    const result = await checkoutShoppingCartTool(CLIENT, [{ item: { type: "Service", metadata: { id: 501 } }, quantity: 1 }], [], false, undefined, false, undefined, client);
    expect("AppointmentIds" in client.posts[0].data.Items[0]).toBe(false);
    expect("appointments" in (result.shoppingCart?.items[0] ?? {})).toBe(false);
  });
});

/** Answers every GET with `response` and records the params; no spec validation. */
class FixedResponseClient implements IMindbodyClient {
  readonly gets: Array<{ url: string; params: Record<string, unknown> }> = [];
  constructor(private readonly response: unknown) {}
  async request<T>(): Promise<T> {
    throw new Error("request() is not used by this tool");
  }
  async get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    this.gets.push({ url, params: config?.params ?? {} });
    return this.response as T;
  }
  async post<T>(): Promise<T> {
    throw new Error("post() is not used by this tool");
  }
}

describe("getActiveSessionTimesTool", () => {
  // The shape GET /appointment/activesessiontimes returns on the -99 sandbox.
  const realShape = {
    PaginationResponse: { RequestedLimit: 100, RequestedOffset: 0, PageSize: 3, TotalResults: 3 },
    ActiveSessionTimes: ["06:00:00", "06:30:00", "07:00:00"],
    SessionTypeActiveSessionTimes: [
      { SessionTypeId: 23, ActiveSessionTimes: ["06:00:00", "06:30:00"] },
      { SessionTypeId: 24, ActiveSessionTimes: ["07:00:00"] },
    ],
  };

  it("maps the plain time strings overall and per session type", async () => {
    const client = new FixedResponseClient(realShape);
    const result = await getActiveSessionTimesTool("Appointment", [23, 24], undefined, undefined, client);
    expect(result).toEqual({
      activeTimes: ["06:00:00", "06:30:00", "07:00:00"],
      bySessionType: [
        { sessionTypeId: 23, activeTimes: ["06:00:00", "06:30:00"] },
        { sessionTypeId: 24, activeTimes: ["07:00:00"] },
      ],
      totalActiveTimes: 3,
    });
    expect(client.gets).toHaveLength(1);
    expect(client.gets[0].url).toBe("/appointment/activesessiontimes");
  });

  it("sends only the documented query params and never a Days filter, defaulting ScheduleType to All", async () => {
    const client = new FixedResponseClient(realShape);
    await getActiveSessionTimesTool(undefined, [23], "06:00:00", "09:00:00", client);
    expect(client.gets[0].params).toEqual({
      ScheduleType: "All",
      SessionTypeIds: [23],
      StartTime: "06:00:00",
      EndTime: "09:00:00",
      Limit: 200,
      Offset: 0,
    });
    expect("Days" in client.gets[0].params).toBe(false);
  });

  it("passes spec validation, and the validator rejects the Days filter it used to send", async () => {
    // The request the tool itself builds must satisfy docs/openapi.json ...
    const validator = new SpecValidatingClient(spec, realShape);
    const result = await getActiveSessionTimesTool("Class", [23], "06:00:00", "09:00:00", validator);
    expect(result.totalActiveTimes).toBe(3);
    // ... and `Days`, which the sandbox silently ignored, is not a parameter.
    await expect(
      new SpecValidatingClient(spec, realShape).get("/appointment/activesessiontimes", { params: { Days: ["Monday"] } })
    ).rejects.toThrow(SpecValidationError);
    await expect(
      new SpecValidatingClient(spec, realShape).get("/appointment/activesessiontimes", { params: { Days: ["Monday"] } })
    ).rejects.toThrow('Unrecognised query parameter "Days"');
  });

  it("returns empty lists when the response omits both arrays", async () => {
    const client = new FixedResponseClient({ PaginationResponse: { TotalResults: 0 } });
    const result = await getActiveSessionTimesTool(undefined, undefined, undefined, undefined, client);
    expect(result).toEqual({ activeTimes: [], bySessionType: [], totalActiveTimes: 0 });
  });

  it("drops non-string entries rather than emitting them", async () => {
    const client = new FixedResponseClient({
      PaginationResponse: { RequestedLimit: 200, RequestedOffset: 0, PageSize: 3, TotalResults: 3 },
      ActiveSessionTimes: ["06:00:00", { Id: 1 }, null],
      SessionTypeActiveSessionTimes: [{ SessionTypeId: 23, ActiveSessionTimes: ["06:00:00", 7] }, { SessionTypeId: 24 }],
    });
    const result = await getActiveSessionTimesTool(undefined, undefined, undefined, undefined, client);
    expect(result).toEqual({
      activeTimes: ["06:00:00"],
      bySessionType: [
        { sessionTypeId: 23, activeTimes: ["06:00:00"] },
        { sessionTypeId: 24, activeTimes: [] },
      ],
      totalActiveTimes: 1,
    });
  });

  it("pages over ActiveSessionTimes and merges SessionTypeActiveSessionTimes by SessionTypeId across pages", async () => {
    // Two pages of two times each. Session type 23 appears on both pages with an
    // overlapping time, so a page-one-only read would lose 07:00:00 and a naive
    // concatenation would emit 23 twice and 06:30:00 twice.
    const pages = [
      {
        PaginationResponse: { RequestedLimit: 2, RequestedOffset: 0, PageSize: 2, TotalResults: 4 },
        ActiveSessionTimes: ["06:00:00", "06:30:00"],
        SessionTypeActiveSessionTimes: [{ SessionTypeId: 23, ActiveSessionTimes: ["06:00:00", "06:30:00"] }],
      },
      {
        PaginationResponse: { RequestedLimit: 2, RequestedOffset: 2, PageSize: 2, TotalResults: 4 },
        ActiveSessionTimes: ["07:00:00", "07:30:00"],
        SessionTypeActiveSessionTimes: [
          { SessionTypeId: 23, ActiveSessionTimes: ["06:30:00", "07:00:00"] },
          { SessionTypeId: 24, ActiveSessionTimes: ["07:30:00"] },
        ],
      },
    ];
    const offsets: unknown[] = [];
    const client: IMindbodyClient = {
      request: async () => { throw new Error("unused"); },
      get: async <T,>(_url: string, config?: AxiosRequestConfig): Promise<T> => {
        offsets.push(config?.params?.Offset);
        return (pages[Number(config?.params?.Offset) / 2] ?? { ActiveSessionTimes: [] }) as T;
      },
      post: async () => { throw new Error("unused"); },
    };
    const result = await getActiveSessionTimesTool("Appointment", [23, 24], undefined, undefined, client);
    expect(offsets).toEqual([0, 2]);
    expect(result).toEqual({
      activeTimes: ["06:00:00", "06:30:00", "07:00:00", "07:30:00"],
      bySessionType: [
        { sessionTypeId: 23, activeTimes: ["06:00:00", "06:30:00", "07:00:00"] },
        { sessionTypeId: 24, activeTimes: ["07:30:00"] },
      ],
      totalActiveTimes: 4,
    });
  });

  it("propagates an API failure", async () => {
    const client: IMindbodyClient = {
      request: async () => { throw new Error("unused"); },
      get: async () => { throw new Error("Mindbody API Error: boom (Code: InternalError)"); },
      post: async () => { throw new Error("unused"); },
    };
    await expect(getActiveSessionTimesTool(undefined, undefined, undefined, undefined, client)).rejects.toThrow("boom");
  });
});

// ── C-1, C-2, C-4, C-5: the spec's own models, read field by field ─────────────

/**
 * `SpecValidatingClient` that also records what it validated, so one client
 * proves both halves of a request: it satisfies docs/openapi.json (the
 * validator throws otherwise) and it sent the parameters the test asserts on.
 */
class RecordingValidatingClient implements IMindbodyClient {
  readonly gets: Array<{ url: string; params: Record<string, unknown> }> = [];
  readonly posts: Array<{ url: string; data: any }> = [];
  readonly cache = new SimpleCache(5);
  private readonly validator: SpecValidatingClient;

  constructor(fixture: unknown) {
    this.validator = new SpecValidatingClient(spec, fixture);
  }

  async request<T>(): Promise<T> {
    throw new Error("request() is not used by these tools");
  }

  async get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    // Validate first: a rejected request is never recorded as sent.
    const response = await this.validator.get<T>(url, config);
    this.gets.push({ url, params: config?.params ?? {} });
    return response;
  }

  async post<T>(url: string, data?: any): Promise<T> {
    const response = await this.validator.post<T>(url, data);
    this.posts.push({ url, data });
    return response;
  }

  /** Every GET except the site lookup, which these tests never need. */
  get dataGets() {
    return this.gets.filter((get) => get.url !== "/site/sites");
  }
}

/**
 * One row from each catalogue the tools resolve names through, with ids that
 * match the appointment rows below. `sessionTypeNames()` reads `SessionTypes`,
 * `locationNames()` reads `Locations` and `staffNames()` reads `StaffMembers`.
 */
const CATALOGUES = {
  SessionTypes: [{ Id: 9, Name: "Personal Training", DefaultTimeLength: 60, NumDeducted: 1 }],
  Locations: [{ Id: 1, Name: "Main Studio" }],
  StaffMembers: [{ Id: 42, Name: "Ada Lovelace", FirstName: "Ada", LastName: "Lovelace", DisplayName: "Ada Lovelace" }],
};

/**
 * An `Appointment` with exactly the keys `Appointment` documents in
 * docs/openapi.json — which is also exactly what the sandbox returned in the
 * audit. No `Client`, `SessionType`, `Location` or `Confirmed` key, because the
 * model has none.
 */
const APPOINTMENT_ROW = {
  GenderPreference: "None",
  Duration: 60,
  ProviderId: "prov-1",
  Id: 8001,
  Status: "Confirmed",
  StartDateTime: "2026-03-05T10:00:00",
  EndDateTime: "2026-03-05T11:00:00",
  Notes: "Bring a mat",
  StaffRequested: true,
  ProgramId: 12,
  SessionTypeId: 9,
  LocationId: 1,
  StaffId: 42,
  Staff: { Id: 42, FirstName: "Ada", LastName: "Lovelace", DisplayName: "Ada Lovelace" },
  ClientId: "c-1001",
  FirstAppointment: false,
  IsWaitlist: false,
  WaitlistEntryId: 0,
  ClientServiceId: 100234199,
  Resources: [{ Id: 7, Name: "Mat" }],
  AddOns: [],
  OnlineDescription: null,
};

/** Explicit dates keep these calls off `/site/sites`. */
const WINDOW = { startDate: "2026-03-05", endDate: "2026-03-06" } as const;

describe("getStaffAppointmentsTool — maps the spec's Appointment model (C-1)", () => {
  function appointmentsFixture(rows: unknown[]) {
    return {
      ...CATALOGUES,
      Appointments: rows,
      PaginationResponse: { RequestedLimit: 200, RequestedOffset: 0, PageSize: rows.length, TotalResults: rows.length },
    };
  }

  it("resolves session type and location names from the catalogues and reports the client by id alone", async () => {
    const client = new RecordingValidatingClient(appointmentsFixture([APPOINTMENT_ROW]));
    const result = await getStaffAppointmentsTool(
      [42], [1], WINDOW.startDate, WINDOW.endDate, undefined, undefined, client, client.cache
    );

    expect(result).toEqual({
      appointments: [
        {
          id: 8001,
          status: "Confirmed",
          staffId: 42,
          staffName: "Ada Lovelace",
          sessionTypeId: 9,
          sessionTypeName: "Personal Training",
          locationId: 1,
          locationName: "Main Studio",
          startDateTime: "2026-03-05T10:00:00",
          endDateTime: "2026-03-05T11:00:00",
          clientId: "c-1001",
          notes: "Bring a mat",
          staffRequested: true,
          providerId: "prov-1",
          duration: 60,
          confirmed: true,
          firstAppointment: false,
          resources: [{ id: 7, name: "Mat" }],
        },
      ],
      totalAppointments: 1,
    });

    // `Appointment` carries ClientId and nothing else about the client, so the
    // three fields that read a client object are gone rather than empty.
    const [appointment] = result.appointments;
    expect(appointment.clientId).toBe("c-1001");
    for (const dropped of ["clientName", "clientEmail", "clientPhone"]) {
      expect(dropped in appointment).toBe(false);
    }
  });

  it("reads both catalogues through the documented, paged endpoints", async () => {
    const client = new RecordingValidatingClient(appointmentsFixture([APPOINTMENT_ROW]));
    await getStaffAppointmentsTool([42], [1], WINDOW.startDate, WINDOW.endDate, undefined, undefined, client, client.cache);

    expect(client.gets.map((get) => get.url).sort()).toEqual([
      "/appointment/staffappointments",
      "/site/locations",
      "/site/sessiontypes",
    ]);
    expect(client.gets.find((get) => get.url === "/site/sessiontypes")?.params).toEqual({ Limit: 200, Offset: 0 });
    expect(client.gets.find((get) => get.url === "/site/locations")?.params).toEqual({ Limit: 200, Offset: 0 });
    // Only spec-defined query parameters: the validator throws on anything else.
    expect(client.dataGets[0].params).toEqual({
      StaffIds: [42],
      LocationIds: [1],
      StartDate: WINDOW.startDate,
      EndDate: WINDOW.endDate,
      Limit: 200,
      Offset: 0,
    });
  });

  it("derives `confirmed` from Status; there is no Confirmed flag to read", async () => {
    const statuses = ["Booked", "Confirmed", "Arrived", "Completed", "NoShow", "Cancelled"];
    const client = new RecordingValidatingClient(
      appointmentsFixture(statuses.map((status, index) => ({ ...APPOINTMENT_ROW, Id: 9000 + index, Status: status })))
    );
    const result = await getStaffAppointmentsTool([42], undefined, WINDOW.startDate, WINDOW.endDate, undefined, undefined, client, client.cache);
    expect(result.appointments.map((appointment) => appointment.confirmed)).toEqual([
      false,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it("prefers DisplayName, falls back to first + last, and reports undefined — never '' — when neither is there", async () => {
    const { StaffId: _droppedStaffId, Staff: _droppedStaff, ...withoutStaff } = APPOINTMENT_ROW;
    const client = new RecordingValidatingClient(
      appointmentsFixture([
        { ...APPOINTMENT_ROW, Id: 1, Staff: { Id: 42, FirstName: "Ada", LastName: "Lovelace" } },
        { ...APPOINTMENT_ROW, Id: 2, Staff: { Id: 42, FirstName: "Ada" } },
        { ...APPOINTMENT_ROW, Id: 3, Staff: { Id: 42, DisplayName: "  Ada L.  " } },
        { ...APPOINTMENT_ROW, Id: 4, Staff: { Id: 42 } },
        { ...withoutStaff, Id: 5 },
      ])
    );
    const result = await getStaffAppointmentsTool([42], undefined, WINDOW.startDate, WINDOW.endDate, undefined, undefined, client, client.cache);
    expect(result.appointments.map((appointment) => appointment.staffName)).toEqual([
      "Ada Lovelace",
      "Ada",
      "Ada L.",
      undefined,
      undefined,
    ]);
    // StaffId still falls back to the embedded Staff.Id when the row omits it.
    expect(result.appointments.map((appointment) => appointment.staffId)).toEqual([42, 42, 42, 42, undefined]);
  });

  it("leaves the names undefined when a catalogue does not contain the id, and still reports the id", async () => {
    const client = new RecordingValidatingClient(
      appointmentsFixture([{ ...APPOINTMENT_ROW, SessionTypeId: 777, LocationId: 888 }])
    );
    const result = await getStaffAppointmentsTool([42], undefined, WINDOW.startDate, WINDOW.endDate, undefined, undefined, client, client.cache);
    const [appointment] = result.appointments;
    expect(appointment.sessionTypeId).toBe(777);
    expect(appointment.locationId).toBe(888);
    expect(appointment.sessionTypeName).toBeUndefined();
    expect(appointment.locationName).toBeUndefined();
  });

  it("still returns the appointments when a catalogue read fails", async () => {
    const client = new RecordingValidatingClient(appointmentsFixture([APPOINTMENT_ROW]));
    const validated = client.get.bind(client);
    client.get = async <T,>(url: string, config?: AxiosRequestConfig): Promise<T> => {
      if (url === "/site/locations") throw new Error("Mindbody API Error: locations down (Code: 500)");
      return validated<T>(url, config);
    };
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await getStaffAppointmentsTool([42], undefined, WINDOW.startDate, WINDOW.endDate, undefined, undefined, client, client.cache);
      expect(result.appointments).toHaveLength(1);
      expect(result.appointments[0].sessionTypeName).toBe("Personal Training");
      expect(result.appointments[0].locationName).toBeUndefined();
      expect(result.appointments[0].locationId).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("addAppointmentTool — maps the spec's Appointment model (C-2)", () => {
  /** A booked appointment as AddAppointmentResponse returns it: ids, no name objects. */
  const booked = {
    Appointment: {
      Id: 8003,
      Status: "Booked",
      StartDateTime: "2026-03-06T09:00:00",
      EndDateTime: "2026-03-06T10:00:00",
      Duration: 60,
      StaffId: 42,
      Staff: { Id: 42, FirstName: "Ada", LastName: "Lovelace", DisplayName: "Ada Lovelace" },
      SessionTypeId: 9,
      LocationId: 1,
      ClientId: "c-1001",
    },
    Message: "Appointment created for Grace",
  };

  it("returns sessionTypeId and locationId, because the response carries no names", async () => {
    // `SpecValidatingClient` checks the path and method of a POST but not its
    // body, which is all C-2 needs: the defect was in the response mapping.
    const client = new RecordingValidatingClient(booked);
    const result = await addAppointmentTool(
      "c-1001", 42, 1, 9, "2026-03-06T09:00:00", undefined, undefined, undefined, undefined, false, undefined, client
    );

    expect(result).toEqual({
      success: true,
      appointment: {
        id: 8003,
        status: "Booked",
        startDateTime: "2026-03-06T09:00:00",
        endDateTime: "2026-03-06T10:00:00",
        duration: 60,
        staffName: "Ada Lovelace",
        sessionTypeId: 9,
        locationId: 1,
      },
      message: "Appointment created for Grace",
    });
    for (const dropped of ["sessionTypeName", "locationName"]) {
      expect(dropped in (result.appointment ?? {})).toBe(false);
    }
    // No catalogue read: the tool echoes the ids the caller sent.
    expect(client.gets).toHaveLength(0);
  });

  it("reads the staff name off the embedded Staff and leaves it undefined when the row has none", async () => {
    const rows = [
      { ...booked.Appointment, Id: 1, Staff: { Id: 42, FirstName: "Ada", LastName: "Lovelace" } },
      { ...booked.Appointment, Id: 2, Staff: undefined },
    ];
    for (const [index, appointment] of rows.entries()) {
      const client = new RecordingValidatingClient({ ...booked, Appointment: appointment });
      const result = await addAppointmentTool(
        "c-1001", 42, 1, 9, "2026-03-06T09:00:00", undefined, undefined, undefined, undefined, false, undefined, client
      );
      expect(result.appointment?.staffName).toBe(index === 0 ? "Ada Lovelace" : undefined);
      expect(result.appointment?.sessionTypeId).toBe(9);
      expect(result.appointment?.locationId).toBe(1);
    }
  });
});

describe("getScheduleItemsTool — emits the spec's three lists (C-4, C-5)", () => {
  /**
   * `StaffMembers[]` is `Staff`, so its `Appointments`, `Availabilities` and
   * `Unavailabilities` are `Appointment`, `Availability` and `Unavailability`.
   * The staff name comes from the member's own `Name`, so no staff catalogue is
   * read here; the session type and location catalogues are.
   */
  function scheduleItemsFixture(staffMembers: unknown[]) {
    return {
      ...CATALOGUES,
      StaffMembers: staffMembers,
      PaginationResponse: { RequestedLimit: 200, RequestedOffset: 0, PageSize: staffMembers.length, TotalResults: staffMembers.length },
    };
  }

  const member = {
    Id: 42,
    Name: "Ada Lovelace",
    FirstName: "Ada",
    LastName: "Lovelace",
    DisplayName: "Ada Lovelace",
    Appointments: [
      {
        Id: 8001,
        Status: "NoShow",
        StartDateTime: "2026-03-05T10:00:00",
        EndDateTime: "2026-03-05T11:00:00",
        SessionTypeId: 9,
        LocationId: 1,
        StaffId: 42,
        ClientId: "c-1001",
      },
    ],
    Availabilities: [
      {
        Id: 5001,
        StartDateTime: "2026-03-05T09:00:00",
        EndDateTime: "2026-03-05T17:00:00",
        BookableEndDateTime: "2026-03-05T16:00:00",
        PrepTime: 15,
        FinishTime: 5,
        IsMasked: false,
        ShowPublic: true,
      },
    ],
    Unavailabilities: [
      { Id: 6001, StartDateTime: "2026-03-05T12:00:00", EndDateTime: "2026-03-05T13:00:00", Description: "Lunch" },
    ],
  };

  it("emits appointments, availabilities and unavailabilities from the three spec lists", async () => {
    const client = new RecordingValidatingClient(scheduleItemsFixture([member]));
    const result = await getScheduleItemsTool([1], [42], WINDOW.startDate, WINDOW.endDate, false, client, client.cache);

    expect(result).toEqual({
      appointments: [
        {
          id: 8001,
          status: "NoShow",
          staffId: 42,
          staffName: "Ada Lovelace",
          sessionTypeId: 9,
          sessionTypeName: "Personal Training",
          locationId: 1,
          locationName: "Main Studio",
          startDateTime: "2026-03-05T10:00:00",
          endDateTime: "2026-03-05T11:00:00",
        },
      ],
      availabilities: [
        {
          id: 5001,
          staffId: 42,
          staffName: "Ada Lovelace",
          startDateTime: "2026-03-05T09:00:00",
          endDateTime: "2026-03-05T17:00:00",
          bookableEndDateTime: "2026-03-05T16:00:00",
          prepTime: 15,
          finishTime: 5,
          isMasked: false,
          showPublic: true,
        },
      ],
      unavailabilities: [
        {
          id: 6001,
          staffId: 42,
          staffName: "Ada Lovelace",
          startDateTime: "2026-03-05T12:00:00",
          endDateTime: "2026-03-05T13:00:00",
          description: "Lunch",
        },
      ],
      // The paged total is the number of staff members the endpoint returned.
      totalItems: 1,
    });
    // The one flattened row type is gone, and with it the fields `Appointment`
    // does not have.
    expect("scheduleItems" in result).toBe(false);
    const [appointment] = result.appointments;
    for (const dropped of ["isAvailable", "isUnavailable"]) {
      expect(dropped in appointment).toBe(false);
    }
  });

  it("sends IgnorePrepFinishTimes, the parameter the spec names, and the request passes validation", async () => {
    const client = new RecordingValidatingClient(scheduleItemsFixture([member]));
    await getScheduleItemsTool([1], [42], WINDOW.startDate, WINDOW.endDate, true, client, client.cache);
    const request = client.dataGets[0];
    expect(request.url).toBe("/appointment/scheduleitems");
    expect(request.params).toEqual({
      LocationIds: [1],
      StaffIds: [42],
      StartDate: WINDOW.startDate,
      EndDate: WINDOW.endDate,
      IgnorePrepFinishTimes: true,
      Limit: 200,
      Offset: 0,
    });
    expect("IgnorePrepFinishBuffer" in request.params).toBe(false);
  });

  it("the old IgnorePrepFinishBuffer key is rejected by the spec validator", async () => {
    await expect(
      new SpecValidatingClient(spec, {}).get("/appointment/scheduleitems", { params: { IgnorePrepFinishBuffer: true } })
    ).rejects.toThrow(SpecValidationError);
    await expect(
      new SpecValidatingClient(spec, {}).get("/appointment/scheduleitems", { params: { IgnorePrepFinishBuffer: true } })
    ).rejects.toThrow('Unrecognised query parameter "IgnorePrepFinishBuffer"');
    await expect(
      new SpecValidatingClient(spec, {}).get("/appointment/scheduleitems", { params: { IgnorePrepFinishTimes: true } })
    ).resolves.toBeDefined();
  });

  it("emits an empty list for a staff member with none of that kind of item", async () => {
    const client = new RecordingValidatingClient(
      scheduleItemsFixture([member, { Id: 43, Name: "Grace Hopper", FirstName: "Grace", LastName: "Hopper" }])
    );
    const result = await getScheduleItemsTool(undefined, [42, 43], WINDOW.startDate, WINDOW.endDate, false, client, client.cache);
    expect(result.appointments).toHaveLength(1);
    expect(result.availabilities).toHaveLength(1);
    expect(result.unavailabilities).toHaveLength(1);
    expect(result.totalItems).toBe(2);
  });

  it("leaves the names undefined when the catalogues do not contain the ids, and still reports the ids", async () => {
    const client = new RecordingValidatingClient(
      scheduleItemsFixture([{ ...member, Appointments: [{ ...member.Appointments[0], SessionTypeId: 777, LocationId: 888 }] }])
    );
    const result = await getScheduleItemsTool(undefined, [42], WINDOW.startDate, WINDOW.endDate, false, client, client.cache);
    const [appointment] = result.appointments;
    expect(appointment.sessionTypeId).toBe(777);
    expect(appointment.locationId).toBe(888);
    expect(appointment.sessionTypeName).toBeUndefined();
    expect(appointment.locationName).toBeUndefined();
  });
});
