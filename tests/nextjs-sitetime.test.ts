/**
 * Site-local time in the Next.js app (nextjs-app/src/lib/mindbody/siteTime.ts),
 * a port of the MCP server's src/utils/siteTime.ts, and the date defaults in
 * service.ts that depend on it.
 *
 * The bug this covers: every default date range in service.ts used to come from
 * the HOST's UTC clock (`new Date().toISOString().split('T')[0]`). Mindbody reads
 * and returns StartDate/EndDate as SITE-local dates, so a studio in Los Angeles
 * driven from Hong Kong was asked about the wrong day, and for a site west of
 * the host about the wrong window.
 *
 * Same fixtures/style as tests/nextjs-paging.test.ts and
 * tests/nextjs-enrollment.test.ts: a fake Mindbody API with a `.get`, here
 * serving GET /site/sites paginated. Runs under the root `bun test` (Gate 1);
 * nextjs-app has no runner of its own.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  SITE_ID_ENV,
  SITE_INFO_CACHE_KEY,
  SITE_TIMEZONE_ENV,
  SiteSelectionError,
  SimpleTtlCache,
  defaultDateRange,
  epochMsToSiteLocal,
  fetchSiteInfo,
  getSelectedSite,
  getSiteTimeZone,
  isValidTimeZone,
  resetSiteTimeCacheForTests,
  resetSiteTimeWarningForTests,
  resolveReadTimeZone,
  selectSite,
  siteDateString,
  siteDateStringPlusDays,
  siteLocalToEpochMs,
  withDefaultDates,
} from "../nextjs-app/src/lib/mindbody/siteTime";
import { MindbodyService } from "../nextjs-app/src/lib/mindbody/service";

const LA = "America/Los_Angeles";
const HK = "Asia/Hong_Kong";
const iso = (ms: number) => new Date(ms).toISOString();

interface SiteRow {
  Id: number;
  Name: string;
  TimeZone?: string;
}

/**
 * A fake Mindbody API that serves GET /site/sites, honouring `SiteIds` like the
 * real endpoint (so a multi-site key cannot leak a neighbour's record), and
 * throws for any other route unless a test overrides `get`.
 */
class FakeApi {
  readonly calls: Array<{ url: string; params: Record<string, any> }> = [];

  constructor(private readonly sites: SiteRow[] = [], private readonly failure?: Error) {}

  async get<T>(url: string, options?: { params?: Record<string, any> }): Promise<T> {
    const params = options?.params ?? {};
    this.calls.push({ url, params });
    if (this.failure) throw this.failure;
    if (url !== "/site/sites") throw new Error(`FakeApi: unexpected GET ${url}`);
    const wanted: string[] | undefined = params.SiteIds?.map(String);
    const rows = wanted ? this.sites.filter((s) => wanted.includes(String(s.Id))) : this.sites;
    return {
      PaginationResponse: {
        RequestedLimit: Number(params.Limit ?? 200),
        RequestedOffset: Number(params.Offset ?? 0),
        PageSize: rows.length,
        TotalResults: rows.length,
      },
      Sites: rows,
    } as T;
  }

  /** The recorded GETs for one endpoint. */
  to(url: string): Array<Record<string, any>> {
    return this.calls.filter((c) => c.url === url).map((c) => c.params);
  }
}

const cache = () => new SimpleTtlCache();
const sandbox = (zone = LA): FakeApi => new FakeApi([{ Id: -99, Name: "Sandbox", TimeZone: zone }]);

/** Save and restore the two env vars this module reads, per suite. */
function useCleanEnv() {
  let savedZone: string | undefined;
  let savedSiteId: string | undefined;
  beforeEach(() => {
    savedZone = process.env[SITE_TIMEZONE_ENV];
    savedSiteId = process.env[SITE_ID_ENV];
    delete process.env[SITE_TIMEZONE_ENV];
    delete process.env[SITE_ID_ENV];
  });
  afterEach(() => {
    if (savedZone === undefined) delete process.env[SITE_TIMEZONE_ENV];
    else process.env[SITE_TIMEZONE_ENV] = savedZone;
    if (savedSiteId === undefined) delete process.env[SITE_ID_ENV];
    else process.env[SITE_ID_ENV] = savedSiteId;
  });
}

// ── Pure conversions ──────────────────────────────────────────────────────────

describe("site calendar dates follow the SITE, not the host", () => {
  // 02:00Z on the 18th is 19:00 on the 17th in Los Angeles: the host-UTC date
  // (what service.ts used to default to) is a day ahead of the studio's.
  const nextDayInUtc = new Date("2026-10-18T02:00:00Z");

  it("siteDateString names the site's date, not the UTC date", () => {
    expect(siteDateString(nextDayInUtc, LA)).toBe("2026-10-17");
    expect(siteDateString(nextDayInUtc, HK)).toBe("2026-10-18");
    // The expression every default range used to be built from:
    expect(nextDayInUtc.toISOString().split("T")[0]).toBe("2026-10-18");
    expect(siteDateString(nextDayInUtc, LA)).not.toBe(nextDayInUtc.toISOString().split("T")[0]);
  });

  it("flips exactly at site midnight, in both directions", () => {
    expect(siteDateString(new Date("2026-10-18T06:59:59Z"), LA)).toBe("2026-10-17");
    expect(siteDateString(new Date("2026-10-18T07:00:00Z"), LA)).toBe("2026-10-18");
    expect(siteDateString(new Date("2026-10-17T15:59:59Z"), HK)).toBe("2026-10-17");
    expect(siteDateString(new Date("2026-10-17T16:00:00Z"), HK)).toBe("2026-10-18");
  });

  it("adds calendar days from the SITE's date, over month ends and DST", () => {
    expect(siteDateStringPlusDays(nextDayInUtc, LA, 7)).toBe("2026-10-24");
    expect(siteDateStringPlusDays(nextDayInUtc, LA, -1)).toBe("2026-10-16");
    expect(siteDateStringPlusDays(new Date("2026-10-31T20:00:00Z"), LA, 1)).toBe("2026-11-01");
    expect(siteDateStringPlusDays(new Date("2026-03-07T20:00:00Z"), LA, 1)).toBe("2026-03-08");
    expect(siteDateStringPlusDays(new Date("2026-12-31T12:00:00Z"), "UTC", 1)).toBe("2027-01-01");
    expect(siteDateStringPlusDays(nextDayInUtc, LA, 0)).toBe("2026-10-17");
    expect(() => siteDateStringPlusDays(nextDayInUtc, LA, 1.5)).toThrow("days must be an integer");
  });

  it("epochMsToSiteLocal writes the site's wall clock, with no offset", () => {
    expect(epochMsToSiteLocal(nextDayInUtc.getTime(), LA)).toBe("2026-10-17T19:00:00");
    expect(epochMsToSiteLocal(nextDayInUtc.getTime(), HK)).toBe("2026-10-18T10:00:00");
    expect(() => epochMsToSiteLocal(Number.NaN, LA)).toThrow("Invalid epoch milliseconds");
  });

  it("validates the zone name", () => {
    expect(isValidTimeZone(LA)).toBe(true);
    for (const bad of ["Nope/Zone", "", "   ", "Pacific Standard Time", 42, undefined]) {
      expect(isValidTimeZone(bad)).toBe(false);
      expect(() => siteDateString(nextDayInUtc, bad as string)).toThrow("Invalid IANA time zone");
    }
  });
});

describe("DST disambiguation — Temporal/java.time 'compatible' mode", () => {
  it("ambiguous fall-back wall time resolves to the EARLIER instant", () => {
    const ms = siteLocalToEpochMs("2026-11-01T01:30:00", LA);
    expect(iso(ms)).toBe("2026-11-01T08:30:00.000Z"); // 01:30 PDT
    expect(epochMsToSiteLocal(ms, LA)).toBe("2026-11-01T01:30:00");
    // The second 01:30 (PST) is an hour later and reads the same wall time.
    expect(epochMsToSiteLocal(ms + 3_600_000, LA)).toBe("2026-11-01T01:30:00");
  });

  it("nonexistent spring-forward wall time moves forward by the gap", () => {
    const ms = siteLocalToEpochMs("2026-03-08T02:30:00", LA);
    expect(iso(ms)).toBe("2026-03-08T10:30:00.000Z"); // 02:30 PST
    expect(epochMsToSiteLocal(ms, LA)).toBe("2026-03-08T03:30:00"); // does not round-trip
    expect(epochMsToSiteLocal(siteLocalToEpochMs("2026-03-08T01:59:59", LA), LA)).toBe("2026-03-08T01:59:59");
    expect(epochMsToSiteLocal(siteLocalToEpochMs("2026-03-08T03:00:00", LA), LA)).toBe("2026-03-08T03:00:00");
  });

  it("reads a fixed-offset site-local string, and respects an explicit offset", () => {
    expect(iso(siteLocalToEpochMs("2026-10-18T08:00:00", LA))).toBe("2026-10-18T15:00:00.000Z");
    expect(iso(siteLocalToEpochMs("2026-10-18T06:30:00", HK))).toBe("2026-10-17T22:30:00.000Z");
    expect(iso(siteLocalToEpochMs("2026-10-18T08:00:00+08:00", LA))).toBe("2026-10-18T00:00:00.000Z");
    expect(Number.isNaN(siteLocalToEpochMs("not a date", LA))).toBe(true);
  });
});

// ── Default date ranges ───────────────────────────────────────────────────────

describe("defaultDateRange / withDefaultDates", () => {
  useCleanEnv();

  // 05:00Z on the 18th is still the 17th in Los Angeles.
  const now = new Date("2026-10-18T05:00:00Z");

  it("days >= 0 gives [site today, site today + days]; days < 0 gives [site today + days, site today]", async () => {
    const api = sandbox();
    expect(await defaultDateRange(7, api, cache(), now)).toEqual({ start: "2026-10-17", end: "2026-10-24" });
    expect(await defaultDateRange(0, api, cache(), now)).toEqual({ start: "2026-10-17", end: "2026-10-17" });
    expect(await defaultDateRange(365, api, cache(), now)).toEqual({ start: "2026-10-17", end: "2027-10-17" });
    expect(await defaultDateRange(-30, api, cache(), now)).toEqual({ start: "2026-09-17", end: "2026-10-17" });
  });

  it("the site zone, not UTC, decides the window", async () => {
    // Same instant, two studios: 05:00Z is the 17th in LA and the 18th in HK.
    expect(await defaultDateRange(7, sandbox(LA), cache(), now)).toEqual({ start: "2026-10-17", end: "2026-10-24" });
    expect(await defaultDateRange(7, sandbox(HK), cache(), now)).toEqual({ start: "2026-10-18", end: "2026-10-25" });
  });

  it("passes caller-supplied dates through unchanged and makes NO request", async () => {
    const api = sandbox();
    expect(await withDefaultDates("2030-01-01", "2030-01-02", 7, api, cache())).toEqual({
      start: "2030-01-01",
      end: "2030-01-02",
    });
    expect(api.calls).toHaveLength(0);
  });

  it("fills only the missing side, leaving the given one alone", async () => {
    const api = sandbox();
    const today = siteDateString(new Date(), LA);
    expect(await withDefaultDates("2030-01-01", undefined, 7, api, cache())).toEqual({
      start: "2030-01-01",
      end: siteDateStringPlusDays(new Date(), LA, 7),
    });
    expect((await withDefaultDates(undefined, "2030-01-02", 7, api, cache())).start).toBe(today);
  });

  it("falls back to UTC with exactly one warning when the zone cannot be resolved", async () => {
    resetSiteTimeWarningForTests();
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const api = new FakeApi([], new Error("down"));
      expect(await resolveReadTimeZone(api, cache())).toBe("UTC");
      expect(await defaultDateRange(7, api, cache(), now)).toEqual({ start: "2026-10-18", end: "2026-10-25" });
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0][0])).toContain("site lookup failed: down");
      expect(String(errorSpy.mock.calls[0][0])).toContain("using UTC for default date ranges");
      // A second failure in the same process stays silent.
      expect(await resolveReadTimeZone(new FakeApi([], new Error("down")), cache())).toBe("UTC");
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("re-arms the one-time warning for the next test process state", async () => {
    resetSiteTimeWarningForTests();
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await resolveReadTimeZone(new FakeApi([], new Error("down")), cache());
      await resolveReadTimeZone(new FakeApi([], new Error("down")), cache());
      expect(errorSpy).toHaveBeenCalledTimes(1);
      resetSiteTimeWarningForTests();
      await resolveReadTimeZone(new FakeApi([], new Error("down")), cache());
      expect(errorSpy).toHaveBeenCalledTimes(2);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// ── Zone resolution ───────────────────────────────────────────────────────────

describe("getSiteTimeZone", () => {
  useCleanEnv();

  it("reads the site record's TimeZone, paged, cached under 'site-info'", async () => {
    const api = sandbox();
    const c = cache();
    expect(await getSiteTimeZone(api, c)).toBe(LA);
    expect(await getSiteTimeZone(api, c)).toBe(LA);
    // /site/sites is paginated in docs/openapi.json, so it is read through
    // fetchAllPages: one GET here because there is one page.
    expect(api.to("/site/sites")).toEqual([{ Limit: 200, Offset: 0 }]);
    expect(c.get<any>(SITE_INFO_CACHE_KEY).Sites[0].TimeZone).toBe(LA);
    // The very same cached record, no second request.
    expect(await fetchSiteInfo(api, c)).toBe(c.get(SITE_INFO_CACHE_KEY));
    expect(api.calls).toHaveLength(1);
  });

  it("pins the lookup with SiteIds=[MINDBODY_SITE_ID] so a multi-site key cannot read a neighbour", async () => {
    process.env[SITE_ID_ENV] = "12345";
    const api = new FakeApi([
      { Id: -99, Name: "Sandbox", TimeZone: LA },
      { Id: 12345, Name: "Second Studio", TimeZone: HK },
    ]);
    expect(await getSiteTimeZone(api, cache())).toBe(HK);
    expect(api.to("/site/sites")[0]).toEqual({ SiteIds: ["12345"], Limit: 200, Offset: 0 });
  });

  it("prefers the API zone over MINDBODY_SITE_TIMEZONE", async () => {
    process.env[SITE_TIMEZONE_ENV] = HK;
    expect(await getSiteTimeZone(sandbox(LA), cache())).toBe(LA);
  });

  it("falls back to MINDBODY_SITE_TIMEZONE when the API has no usable zone", async () => {
    process.env[SITE_TIMEZONE_ENV] = HK;
    expect(await getSiteTimeZone(new FakeApi([{ Id: 1, Name: "No zone" }]), cache())).toBe(HK);
    expect(await getSiteTimeZone(sandbox("Pacific Standard Time"), cache())).toBe(HK);
    expect(await getSiteTimeZone(new FakeApi([], new Error("down")), cache())).toBe(HK);
  });

  it("throws when neither source yields a usable zone", async () => {
    await expect(getSiteTimeZone(new FakeApi([{ Id: 1, Name: "No zone" }]), cache())).rejects.toThrow(
      'Cannot determine the site timezone: site record has no usable TimeZone (got undefined), and MINDBODY_SITE_TIMEZONE is not set'
    );
    await expect(getSiteTimeZone(new FakeApi([], new Error("boom")), cache())).rejects.toThrow("site lookup failed: boom");
    process.env[SITE_TIMEZONE_ENV] = "Not/AZone";
    await expect(getSiteTimeZone(new FakeApi([], new Error("down")), cache())).rejects.toThrow(
      'MINDBODY_SITE_TIMEZONE="Not/AZone" is not a valid IANA zone'
    );
  });

  it("does not cache a failed lookup", async () => {
    const c = cache();
    await expect(getSiteTimeZone(new FakeApi([], new Error("down")), c)).rejects.toThrow();
    expect(c.get(SITE_INFO_CACHE_KEY)).toBeNull();
  });
});

// ── Multi-site selection ──────────────────────────────────────────────────────

describe("selectSite — refuses ambiguity for a multi-site key", () => {
  useCleanEnv();

  const TWO: SiteRow[] = [
    { Id: -99, Name: "Sandbox", TimeZone: LA },
    { Id: 12345, Name: "Second Studio", TimeZone: HK },
  ];

  it("returns the only reachable site when nothing is configured", () => {
    expect(selectSite([TWO[0]]).Id).toBe(-99);
  });

  it("refuses when several sites are reachable and no site was chosen", () => {
    expect(() => selectSite(TWO)).toThrow(SiteSelectionError);
    try {
      selectSite(TWO);
      throw new Error("expected SiteSelectionError");
    } catch (error: any) {
      expect(error.availableSites).toEqual([
        { id: -99, name: "Sandbox" },
        { id: 12345, name: "Second Studio" },
      ]);
      expect(error.message).toContain(SITE_ID_ENV);
      expect(error.message).toContain("2 sites");
    }
  });

  it("uses MINDBODY_SITE_ID, or an explicit siteId over it, and never Sites[0]", () => {
    process.env[SITE_ID_ENV] = "12345";
    expect(selectSite(TWO).Name).toBe("Second Studio");
    process.env[SITE_ID_ENV] = "-99";
    expect(selectSite(TWO, 12345).Name).toBe("Second Studio");
    process.env[SITE_ID_ENV] = "777";
    expect(() => selectSite(TWO)).toThrow(/777 is not among the 2 site\(s\).*-99, 12345/);
  });

  it("refuses an empty result and a duplicated site id", () => {
    expect(() => selectSite([])).toThrow(/returned no site/);
    process.env[SITE_ID_ENV] = "-99";
    expect(() => selectSite([TWO[0], TWO[0]])).toThrow(/2 times/);
  });

  it("getSelectedSite still refuses when the server ignores SiteIds", async () => {
    process.env[SITE_ID_ENV] = "555";
    // The filter is honoured here, so the result is empty and refused.
    await expect(getSelectedSite(new FakeApi(TWO), cache())).rejects.toThrow(SiteSelectionError);
  });
});

// ── service.ts date defaults ──────────────────────────────────────────────────

describe("nextjs-app service date defaults are site-local", () => {
  useCleanEnv();

  /**
   * The window service.ts would have sent from the HOST's UTC clock, for
   * comparison. It is the bug: for a site whose date differs from the host's,
   * the two disagree.
   */
  const hostUtcDate = () => new Date().toISOString().split("T")[0];

  /**
   * A fake studio: /site/sites with the given record, plus one canned response
   * per route the method under test reads. Any other route throws, so an
   * unexpected request shows up rather than returning empty data.
   */
  function studio(site: SiteRow, routes: Record<string, (params: Record<string, any>) => any>): FakeApi {
    const api = new FakeApi([site]);
    api.get = async (url: string, options?: { params?: Record<string, any> }) => {
      const params = options?.params ?? {};
      api.calls.push({ url, params });
      if (url === "/site/sites") {
        const wanted: string[] | undefined = params.SiteIds?.map(String);
        const rows = wanted ? [site].filter((s) => wanted.includes(String(s.Id))) : [site];
        return {
          PaginationResponse: { RequestedLimit: Number(params.Limit ?? 200), RequestedOffset: 0, PageSize: rows.length, TotalResults: rows.length },
          Sites: rows,
        };
      }
      const route = routes[url];
      if (!route) throw new Error(`studio: unexpected GET ${url}`);
      return route(params);
    };
    return api;
  }

  /** A route that answers with an empty, correctly-paginated list under `key`. */
  const emptyList = (key: string) => () => ({ PaginationResponse: { TotalResults: 0 }, [key]: [] });

  it("getAppointments defaults to the SITE's today..+7, not the host's", async () => {
    process.env[SITE_ID_ENV] = "-99";
    const api = studio({ Id: -99, Name: "West Coast", TimeZone: LA }, {
      "/appointment/staffappointments": emptyList("Appointments"),
    });
    await new MindbodyService(api as any).getAppointments({ staffIds: [7] });

    const [call] = api.to("/appointment/staffappointments");
    expect(call.StartDate).toBe(siteDateString(new Date(), LA));
    expect(call.EndDate).toBe(siteDateStringPlusDays(new Date(), LA, 7));
    // The zone came from the site record, not from the host clock.
    expect(api.to("/site/sites")[0]).toMatchObject({ SiteIds: ["-99"] });
  });

  it("getBookableItems follows the SITE zone the stub reports", async () => {
    process.env[SITE_ID_ENV] = "12345";
    const api = studio({ Id: 12345, Name: "Hong Kong", TimeZone: HK }, {
      "/appointment/bookableitems": emptyList("Availabilities"),
    });

    await new MindbodyService(api as any).getBookableItems({ staffIds: [7] });
    const [call] = api.to("/appointment/bookableitems");
    expect(call.StartDate).toBe(siteDateString(new Date(), HK));
    expect(call.EndDate).toBe(siteDateStringPlusDays(new Date(), HK, 7));
    // If the host's clock is not itself Hong Kong time, this is where the two
    // implementations part company.
    expect(hostUtcDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("getEnrollments defaults to the SITE's today..+365", async () => {
    process.env[SITE_ID_ENV] = "777";
    const api = studio({ Id: 777, Name: "West Coast", TimeZone: LA }, {
      "/enrollment/enrollments": emptyList("Enrollments"),
    });

    await new MindbodyService(api as any).getEnrollments();
    const [call] = api.to("/enrollment/enrollments");
    expect(call.StartDate).toBe(siteDateString(new Date(), LA));
    expect(call.EndDate).toBe(siteDateStringPlusDays(new Date(), LA, 365));
  });

  it("caller-supplied dates pass through unchanged and cost no extra request", async () => {
    process.env[SITE_ID_ENV] = "4242";
    const api = studio({ Id: 4242, Name: "Explicit", TimeZone: LA }, {
      "/enrollment/enrollments": emptyList("Enrollments"),
    });

    await new MindbodyService(api as any).getEnrollments({ startDate: "2026-01-01", endDate: "2027-12-31" });
    expect(api.to("/site/sites")).toHaveLength(0);
    expect(api.to("/enrollment/enrollments")[0]).toMatchObject({ StartDate: "2026-01-01", EndDate: "2027-12-31" });
  });

  it("getTeacherSchedule buckets classes under the studio's own weekday", async () => {
    process.env[SITE_ID_ENV] = "31337";
    const api = studio({ Id: 31337, Name: "Studio", TimeZone: LA }, {
      "/staff/staff": () => ({
        PaginationResponse: { TotalResults: 1 },
        StaffMembers: [{ Id: 42, FirstName: "Ada", LastName: "Lovelace" }],
      }),
      "/class/classes": () => ({
        PaginationResponse: { TotalResults: 1 },
        Classes: [
          {
            Id: 1, ClassScheduleId: 9, StartDateTime: "2026-10-18T01:30:00", EndDateTime: "2026-10-18T02:30:00",
            Canceled: false, WaitListEnabled: false, DefaultCapacity: 10, TotalBooked: 4,
            ClassDescription: { Id: 1, Name: "Vinyasa", Description: "Flow", SessionType: { Id: 5, Name: "Flow" }, Program: { Id: 2, Name: "Yoga" } },
            Staff: { Id: 42, FirstName: "Ada", LastName: "Lovelace" },
            Location: { Id: 1, Name: "Main Studio" },
          },
        ],
      }),
    });

    const schedule = await new MindbodyService(api as any).getTeacherSchedule(42, "2026-10-18", "2026-10-18");
    // 2026-10-18 is a Sunday; 01:30 is early enough that a host east of the
    // site would still call it the 17th if the string were zoned at the host.
    expect(schedule.summary.byDay).toEqual({ Sunday: 1 });
    expect(schedule.classes[0].duration).toBe(60);
    expect(schedule.dateRange).toEqual({ start: "2026-10-18", end: "2026-10-18" });
  });

  it("getClientVisits reaches backwards in the SITE's calendar (today-30d..today)", async () => {
    process.env[SITE_ID_ENV] = "8888";
    const api = studio({ Id: 8888, Name: "West Coast", TimeZone: LA }, {
      "/client/clientvisits": emptyList("Visits"),
    });

    await new MindbodyService(api as any).getClientVisits({ clientId: "C1" });
    const [call] = api.to("/client/clientvisits");
    expect(call.StartDate).toBe(siteDateStringPlusDays(new Date(), LA, -30));
    expect(call.EndDate).toBe(siteDateString(new Date(), LA));
  });

  it("defaultDateTimeRange is a site-local day boundary, with no offset appended", async () => {
    process.env[SITE_ID_ENV] = "5555";
    const api = studio({ Id: 5555, Name: "West Coast", TimeZone: LA }, {});
    const service = new MindbodyService(api as any);

    const window = await service.defaultDateTimeRange(undefined, undefined, 30);
    expect(window).toEqual({
      start: `${siteDateString(new Date(), LA)}T00:00:00`,
      end: `${siteDateStringPlusDays(new Date(), LA, 30)}T23:59:59`,
    });
    // A `Z` or a numeric offset would assert a zone the API does not expect.
    expect(window.start).not.toMatch(/[Z+]/);
    expect(window.end).not.toMatch(/[Z+]/);

    // Explicit dates win, with no site lookup at all.
    expect(await service.defaultDateTimeRange("2026-01-01", "2026-01-31")).toEqual({
      start: "2026-01-01T00:00:00",
      end: "2026-01-31T23:59:59",
    });
    expect(api.to("/site/sites")).toHaveLength(1);
  });
});

describe("nextjs-app reads survive an unresolvable site zone", () => {
  useCleanEnv();

  it("a failed site lookup degrades to UTC rather than failing the read", async () => {
    // The site cache is process-wide and shared across suites, so it must be
    // dropped or an earlier suite's cached record hides the failure under test.
    resetSiteTimeCacheForTests();
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const api = new FakeApi([{ Id: 1, Name: "Unreachable", TimeZone: LA }]);
      (api as any).get = async (url: string, options?: { params?: Record<string, any> }) => {
        api.calls.push({ url, params: options?.params ?? {} });
        if (url !== "/enrollment/enrollments") throw new Error("down");
        return { PaginationResponse: { TotalResults: 0 }, Enrollments: [] };
      };
      await new MindbodyService(api as any).getEnrollments();
      expect(api.calls.filter((c) => c.url === "/enrollment/enrollments")[0].params.StartDate).toBe(
        new Date().toISOString().split("T")[0]
      );
      expect(String(errorSpy.mock.calls[0][0])).toContain("using UTC for default date ranges");
    } finally {
      errorSpy.mockRestore();
    }
  });
});
