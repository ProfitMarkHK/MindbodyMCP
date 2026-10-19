import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { AxiosRequestConfig } from "axios";
import type { IMindbodyClient } from "../src/api/client.js";
import { SimpleCache } from "../src/cache/index.js";
import {
  SITE_INFO_CACHE_KEY,
  SITE_TIMEZONE_ENV,
  assertTimeZone,
  defaultDateRange,
  epochMsToSiteLocal,
  fetchSiteInfo,
  getSiteTimeZone,
  resetSiteTimeWarningForTests,
  resolveReadTimeZone,
  siteDateString,
  siteDateStringPlusDays,
  siteLocalToEpochMs,
  withDefaultDates,
} from "../src/utils/siteTime.js";

const LA = "America/Los_Angeles";
const HK = "Asia/Hong_Kong";
const iso = (ms: number) => new Date(ms).toISOString();

describe("siteLocalToEpochMs — fixed offsets", () => {
  it("reads a Los Angeles summer time as PDT (UTC-7)", () => {
    expect(iso(siteLocalToEpochMs("2026-10-18T08:00:00", LA))).toBe("2026-10-18T15:00:00.000Z");
  });

  it("reads a Los Angeles winter time as PST (UTC-8)", () => {
    expect(iso(siteLocalToEpochMs("2026-01-15T08:00:00", LA))).toBe("2026-01-15T16:00:00.000Z");
  });

  it("reads a positive-offset zone (Hong Kong, UTC+8) on the previous UTC day", () => {
    expect(iso(siteLocalToEpochMs("2026-10-18T06:30:00", HK))).toBe("2026-10-17T22:30:00.000Z");
  });

  it("keeps fractional seconds", () => {
    expect(iso(siteLocalToEpochMs("2026-10-18T08:00:00.123", LA))).toBe("2026-10-18T15:00:00.123Z");
    expect(iso(siteLocalToEpochMs("2026-10-18T08:00:00.5", LA))).toBe("2026-10-18T15:00:00.500Z");
  });

  it("accepts a missing seconds field", () => {
    expect(iso(siteLocalToEpochMs("2026-10-18T08:00", LA))).toBe("2026-10-18T15:00:00.000Z");
  });

  it("respects an explicit Z or numeric offset instead of the site zone", () => {
    expect(iso(siteLocalToEpochMs("2026-10-18T08:00:00Z", LA))).toBe("2026-10-18T08:00:00.000Z");
    expect(iso(siteLocalToEpochMs("2026-10-18T08:00:00+08:00", LA))).toBe("2026-10-18T00:00:00.000Z");
    expect(iso(siteLocalToEpochMs("2026-10-18T08:00:00-0530", LA))).toBe("2026-10-18T13:30:00.000Z");
  });
});

describe("siteLocalToEpochMs — DST in America/Los_Angeles", () => {
  it("spring-forward gap: nonexistent 02:30 is read with the pre-transition offset (PST), i.e. 03:30 PDT", () => {
    const ms = siteLocalToEpochMs("2026-03-08T02:30:00", LA);
    expect(iso(ms)).toBe("2026-03-08T10:30:00.000Z");
    // Documented behaviour: it does not round-trip; the wall clock reads 03:30.
    expect(epochMsToSiteLocal(ms, LA)).toBe("2026-03-08T03:30:00");
  });

  it("either side of the gap is unaffected", () => {
    expect(iso(siteLocalToEpochMs("2026-03-08T01:59:59", LA))).toBe("2026-03-08T09:59:59.000Z");
    expect(iso(siteLocalToEpochMs("2026-03-08T03:00:00", LA))).toBe("2026-03-08T10:00:00.000Z");
  });

  it("fall-back overlap: ambiguous 01:30 resolves to the EARLIER instant (01:30 PDT)", () => {
    const ms = siteLocalToEpochMs("2026-11-01T01:30:00", LA);
    expect(iso(ms)).toBe("2026-11-01T08:30:00.000Z");
    expect(epochMsToSiteLocal(ms, LA)).toBe("2026-11-01T01:30:00");
    // The later 01:30 (PST) is one hour on and reads the same wall time.
    expect(epochMsToSiteLocal(ms + 60 * 60 * 1000, LA)).toBe("2026-11-01T01:30:00");
  });

  it("either side of the overlap is unaffected", () => {
    expect(iso(siteLocalToEpochMs("2026-11-01T00:59:59", LA))).toBe("2026-11-01T07:59:59.000Z");
    expect(iso(siteLocalToEpochMs("2026-11-01T02:00:00", LA))).toBe("2026-11-01T10:00:00.000Z");
  });
});

describe("siteLocalToEpochMs — unparseable input is NaN", () => {
  for (const bad of ["not a date", "", "2026-10-18", "2026-13-01T00:00:00", "2026-02-29T00:00:00", "2026-10-18T24:00:00", "2026-10-18T08:60:00", "2026-10-18T08:00:00+25:00", "2026/10/18 08:00:00"]) {
    it(`returns NaN for ${JSON.stringify(bad)}`, () => {
      expect(Number.isNaN(siteLocalToEpochMs(bad, LA))).toBe(true);
    });
  }

  it("returns NaN for a non-string", () => {
    expect(Number.isNaN(siteLocalToEpochMs(undefined as unknown as string, LA))).toBe(true);
    expect(Number.isNaN(siteLocalToEpochMs(1234 as unknown as string, LA))).toBe(true);
  });

  it("accepts 29 February in a leap year", () => {
    expect(iso(siteLocalToEpochMs("2024-02-29T00:00:00", LA))).toBe("2024-02-29T08:00:00.000Z");
  });
});

describe("epochMsToSiteLocal and round-trips", () => {
  it("formats an instant as site wall time with no offset", () => {
    expect(epochMsToSiteLocal(Date.UTC(2026, 9, 18, 15, 0, 0), LA)).toBe("2026-10-18T08:00:00");
    expect(epochMsToSiteLocal(Date.UTC(2026, 9, 17, 22, 30, 0), HK)).toBe("2026-10-18T06:30:00");
    expect(epochMsToSiteLocal(Date.UTC(2026, 9, 18, 0, 0, 0), HK)).toBe("2026-10-18T08:00:00");
    expect(epochMsToSiteLocal(Date.UTC(2026, 9, 18, 7, 0, 0), LA)).toBe("2026-10-18T00:00:00");
  });

  it("round-trips every hour across both 2026 LA transitions, and in Hong Kong", () => {
    for (const zone of [LA, HK, "UTC", "Australia/Lord_Howe"]) {
      for (const start of [Date.UTC(2026, 2, 7), Date.UTC(2026, 9, 31), Date.UTC(2026, 3, 4)]) {
        for (let h = 0; h < 72; h += 1) {
          const ms = start + h * 60 * 60 * 1000 + 17_000;
          const local = epochMsToSiteLocal(ms, zone);
          const back = siteLocalToEpochMs(local, zone);
          // Exact, except the second pass of an ambiguous hour maps to the first.
          const ambiguousSecondPass = back !== ms && epochMsToSiteLocal(back, zone) === local;
          expect(back === ms || ambiguousSecondPass).toBe(true);
        }
      }
    }
  });

  it("throws on non-finite input", () => {
    expect(() => epochMsToSiteLocal(Number.NaN, LA)).toThrow("Invalid epoch milliseconds");
  });
});

describe("site calendar dates", () => {
  // 2026-10-17T20:00Z is 13:00 on the 17th in LA, but 04:00 on the 18th in HK.
  const lateUtc = new Date("2026-10-17T20:00:00Z");
  // 2026-10-18T05:00Z is 22:00 on the 17th in LA, but 13:00 on the 18th in HK.
  const earlyUtc = new Date("2026-10-18T05:00:00Z");

  it("uses the site's date when it differs from the UTC date", () => {
    expect(siteDateString(lateUtc, HK)).toBe("2026-10-18");
    expect(siteDateString(lateUtc, LA)).toBe("2026-10-17");
    expect(siteDateString(earlyUtc, LA)).toBe("2026-10-17");
    expect(siteDateString(earlyUtc, "UTC")).toBe("2026-10-18");
  });

  it("is exact either side of site midnight", () => {
    expect(siteDateString(new Date("2026-10-18T06:59:59Z"), LA)).toBe("2026-10-17");
    expect(siteDateString(new Date("2026-10-18T07:00:00Z"), LA)).toBe("2026-10-18");
    expect(siteDateString(new Date("2026-10-17T15:59:59Z"), HK)).toBe("2026-10-17");
    expect(siteDateString(new Date("2026-10-17T16:00:00Z"), HK)).toBe("2026-10-18");
  });

  it("adds calendar days from the site date, across month/year ends and DST", () => {
    expect(siteDateStringPlusDays(earlyUtc, LA, 7)).toBe("2026-10-24");
    expect(siteDateStringPlusDays(earlyUtc, HK, 7)).toBe("2026-10-25");
    expect(siteDateStringPlusDays(earlyUtc, LA, -30)).toBe("2026-09-17");
    expect(siteDateStringPlusDays(new Date("2026-10-28T19:00:00Z"), LA, 7)).toBe("2026-11-04");
    expect(siteDateStringPlusDays(new Date("2026-12-31T12:00:00Z"), "UTC", 1)).toBe("2027-01-01");
    expect(siteDateStringPlusDays(earlyUtc, LA, 0)).toBe("2026-10-17");
    expect(siteDateStringPlusDays(new Date("2026-03-06T20:00:00Z"), LA, 730)).toBe("2028-03-05");
  });

  it("rejects a non-integer day count", () => {
    expect(() => siteDateStringPlusDays(earlyUtc, LA, 1.5)).toThrow("days must be an integer");
  });
});

describe("timezone validation", () => {
  for (const bad of ["Nope/Zone", "", "   ", "Pacific Standard Time"]) {
    it(`throws for ${JSON.stringify(bad)}`, () => {
      expect(() => assertTimeZone(bad)).toThrow(RangeError);
      expect(() => siteDateString(new Date(), bad)).toThrow("Invalid IANA time zone");
      expect(() => siteLocalToEpochMs("2026-10-18T08:00:00", bad)).toThrow("Invalid IANA time zone");
      expect(() => epochMsToSiteLocal(0, bad)).toThrow("Invalid IANA time zone");
    });
  }

  it("throws for a non-string zone", () => {
    expect(() => assertTimeZone(undefined)).toThrow(RangeError);
    expect(() => assertTimeZone(42)).toThrow(RangeError);
  });
});

/** Serves GET /site/sites with `site`, or throws `error`. Counts every call. */
class SiteClient implements IMindbodyClient {
  calls: Array<{ url: string; params: unknown }> = [];
  constructor(private readonly site: unknown, private readonly error?: Error) {}
  async request<T>(): Promise<T> {
    throw new Error("unused");
  }
  async get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    this.calls.push({ url, params: config?.params });
    if (this.error) throw this.error;
    const sites = this.site === undefined ? [] : [this.site];
    return {
      Sites: sites,
      PaginationResponse: { RequestedLimit: 200, RequestedOffset: 0, PageSize: sites.length, TotalResults: sites.length },
    } as T;
  }
  async post<T>(): Promise<T> {
    throw new Error("unused");
  }
}

describe("getSiteTimeZone", () => {
  let savedEnv: string | undefined;
  let savedSiteId: string | undefined;
  beforeEach(() => {
    savedEnv = process.env[SITE_TIMEZONE_ENV];
    savedSiteId = process.env[SITE_ID_ENV];
    delete process.env[SITE_TIMEZONE_ENV];
    delete process.env[SITE_ID_ENV];
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env[SITE_TIMEZONE_ENV];
    else process.env[SITE_TIMEZONE_ENV] = savedEnv;
    if (savedSiteId === undefined) delete process.env[SITE_ID_ENV];
    else process.env[SITE_ID_ENV] = savedSiteId;
  });

  it("reads Sites[0].TimeZone and caches the site record under 'site-info'", async () => {
    const client = new SiteClient({ Id: -99, TimeZone: LA });
    const cache = new SimpleCache(5);
    expect(await getSiteTimeZone(client, cache)).toBe(LA);
    expect(await getSiteTimeZone(client, cache)).toBe(LA);
    // /site/sites is paginated in the spec, so it is read through fetchAllPages.
    expect(client.calls).toEqual([{ url: "/site/sites", params: { Limit: 200, Offset: 0 } }]);
    expect(cache.get<any>(SITE_INFO_CACHE_KEY).Sites[0].TimeZone).toBe(LA);
    // getSitesTool reads the very same cached record.
    expect(await fetchSiteInfo(client, cache)).toBe(cache.get(SITE_INFO_CACHE_KEY));
    expect(client.calls).toHaveLength(1);
  });

  it("returns the API zone when the env override agrees with it", async () => {
    process.env[SITE_TIMEZONE_ENV] = LA;
    expect(await getSiteTimeZone(new SiteClient({ TimeZone: LA }), new SimpleCache(5))).toBe(LA);
  });

  it("falls back to MINDBODY_SITE_TIMEZONE when the API has no usable zone", async () => {
    process.env[SITE_TIMEZONE_ENV] = HK;
    expect(await getSiteTimeZone(new SiteClient({ Id: 1 }), new SimpleCache(5))).toBe(HK);
    expect(await getSiteTimeZone(new SiteClient({ TimeZone: "Pacific Standard Time" }), new SimpleCache(5))).toBe(HK);
  });

  it("never consults the override when the site lookup fails", async () => {
    process.env[SITE_TIMEZONE_ENV] = HK;
    await expect(getSiteTimeZone(new SiteClient(undefined, new Error("down")), new SimpleCache(5))).rejects.toThrow(
      /^Cannot determine the site timezone: site lookup failed: down$/
    );
  });

  it("returns the multi-site refusal instead of the override", async () => {
    process.env[SITE_TIMEZONE_ENV] = HK;
    await expect(getSiteTimeZone(new MultiSiteClient(TWO_SITES), new SimpleCache(5))).rejects.toThrow(
      /site lookup failed: this API key reaches 2 sites/
    );
    // reads refuse too (UTC fallback), they do not adopt the override
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await resolveReadTimeZone(new MultiSiteClient(TWO_SITES), new SimpleCache(5))).toBe("UTC");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("write path refuses an override that disagrees with the record; a case-only difference is fine", async () => {
    process.env[SITE_TIMEZONE_ENV] = HK;
    await expect(getSiteTimeZone(new SiteClient({ TimeZone: LA }), new SimpleCache(5))).rejects.toThrow(
      /disagrees with the site record's TimeZone "America\/Los_Angeles"/
    );
    process.env[SITE_TIMEZONE_ENV] = "america/los_angeles";
    expect(await getSiteTimeZone(new SiteClient({ TimeZone: LA }), new SimpleCache(5))).toBe(LA);
  });

  it("read path keeps the record's zone and ignores a disagreeing override", async () => {
    process.env[SITE_TIMEZONE_ENV] = HK;
    expect(await resolveReadTimeZone(new SiteClient({ TimeZone: LA }), new SimpleCache(5))).toBe(LA);
  });

  it("throws a clear error when neither source is usable", async () => {
    await expect(getSiteTimeZone(new SiteClient({ TimeZone: "" }), new SimpleCache(5))).rejects.toThrow(
      'Cannot determine the site timezone: site record has no usable TimeZone (got ""), and MINDBODY_SITE_TIMEZONE is not set'
    );
    await expect(getSiteTimeZone(new SiteClient(undefined, new Error("boom")), new SimpleCache(5))).rejects.toThrow(
      "site lookup failed: boom"
    );
  });

  it("throws when the env override is itself invalid", async () => {
    process.env[SITE_TIMEZONE_ENV] = "Not/AZone";
    await expect(getSiteTimeZone(new SiteClient({}), new SimpleCache(5))).rejects.toThrow(
      'MINDBODY_SITE_TIMEZONE="Not/AZone" is not a valid IANA zone'
    );
  });

  it("does not cache a failed lookup", async () => {
    const cache = new SimpleCache(5);
    await expect(getSiteTimeZone(new SiteClient(undefined, new Error("down")), cache)).rejects.toThrow();
    expect(cache.get(SITE_INFO_CACHE_KEY)).toBeNull();
  });
});

describe("read defaults", () => {
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env[SITE_TIMEZONE_ENV];
    delete process.env[SITE_TIMEZONE_ENV];
    resetSiteTimeWarningForTests();
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env[SITE_TIMEZONE_ENV];
    else process.env[SITE_TIMEZONE_ENV] = savedEnv;
  });

  // 05:00Z on the 18th is still the 17th in Los Angeles.
  const now = new Date("2026-10-18T05:00:00Z");

  it("defaultDateRange uses the site calendar, forwards and backwards", async () => {
    const client = new SiteClient({ TimeZone: LA });
    const cache = new SimpleCache(5);
    expect(await defaultDateRange(7, client, cache, now)).toEqual({ start: "2026-10-17", end: "2026-10-24" });
    expect(await defaultDateRange(-30, client, cache, now)).toEqual({ start: "2026-09-17", end: "2026-10-17" });
  });

  it("withDefaultDates passes explicit dates through and makes no request", async () => {
    const client = new SiteClient({ TimeZone: LA });
    expect(await withDefaultDates("2030-01-01", "2030-01-02", 7, client, new SimpleCache(5))).toEqual({
      start: "2030-01-01",
      end: "2030-01-02",
    });
    expect(client.calls).toHaveLength(0);
  });

  it("withDefaultDates fills only the missing side", async () => {
    const client = new SiteClient({ TimeZone: LA });
    const cache = new SimpleCache(5);
    const today = siteDateString(new Date(), LA);
    expect(await withDefaultDates("2030-01-01", undefined, 7, client, cache)).toEqual({
      start: "2030-01-01",
      end: siteDateStringPlusDays(new Date(), LA, 7),
    });
    expect((await withDefaultDates(undefined, "2030-01-02", 7, client, cache)).start).toBe(today);
  });

  it("falls back to UTC with exactly one warning when the zone cannot be resolved", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const client = new SiteClient(undefined, new Error("down"));
      expect(await resolveReadTimeZone(client, new SimpleCache(5))).toBe("UTC");
      expect(await defaultDateRange(7, client, new SimpleCache(5), now)).toEqual({ start: "2026-10-18", end: "2026-10-25" });
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0][0])).toContain("using UTC for default date ranges");
      expect(String(errorSpy.mock.calls[0][0])).toContain("site lookup failed: down");
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// ── Multi-site selection ─────────────────────────────────────────────────────

import { SITE_ID_ENV, SiteSelectionError, getSelectedSite, selectSite } from "../src/utils/siteTime.js";
import { getSitesTool } from "../src/tools/siteManagement.js";

/** A client whose /site/sites returns several sites, honouring SiteIds[] like Mindbody. */
class MultiSiteClient implements IMindbodyClient {
  calls: Array<{ url: string; params: any }> = [];
  constructor(private readonly sites: Array<{ Id: number; Name: string; TimeZone?: string }>, private readonly ignoreFilter = false) {}
  async request<T>(): Promise<T> {
    throw new Error("unused");
  }
  async get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    this.calls.push({ url, params: config?.params });
    const wanted: string[] | undefined = config?.params?.SiteIds?.map(String);
    const sites = this.ignoreFilter || !wanted ? this.sites : this.sites.filter((s) => wanted.includes(String(s.Id)));
    return {
      Sites: sites,
      PaginationResponse: { RequestedLimit: 200, RequestedOffset: 0, PageSize: sites.length, TotalResults: sites.length },
    } as T;
  }
  async post<T>(): Promise<T> {
    throw new Error("unused");
  }
}

const TWO_SITES = [
  { Id: -99, Name: "Sandbox", TimeZone: LA },
  { Id: 12345, Name: "Second Studio", TimeZone: HK },
];

describe("selectSite — policy for multi-site API keys", () => {
  let savedSiteId: string | undefined;
  beforeEach(() => {
    savedSiteId = process.env[SITE_ID_ENV];
    delete process.env[SITE_ID_ENV];
  });
  afterEach(() => {
    if (savedSiteId === undefined) delete process.env[SITE_ID_ENV];
    else process.env[SITE_ID_ENV] = savedSiteId;
  });

  it("returns the only site when exactly one is reachable and nothing is configured", () => {
    expect(selectSite([TWO_SITES[0]]).Id).toBe(-99);
  });

  it("refuses when several sites are reachable and no default or explicit site is given", () => {
    expect(() => selectSite(TWO_SITES)).toThrow(SiteSelectionError);
    try {
      selectSite(TWO_SITES);
    } catch (error: any) {
      expect(error.availableSites).toEqual([
        { id: -99, name: "Sandbox" },
        { id: 12345, name: "Second Studio" },
      ]);
      expect(error.message).toContain(SITE_ID_ENV);
    }
  });

  it("uses the configured default MINDBODY_SITE_ID to pick among several", () => {
    process.env[SITE_ID_ENV] = "12345";
    expect(selectSite(TWO_SITES).Name).toBe("Second Studio");
  });

  it("an explicit siteId overrides the configured default", () => {
    process.env[SITE_ID_ENV] = "-99";
    expect(selectSite(TWO_SITES, 12345).Name).toBe("Second Studio");
    expect(selectSite(TWO_SITES, "12345").Name).toBe("Second Studio");
  });

  it("refuses when the chosen site is not among those reachable, naming the reachable ones", () => {
    process.env[SITE_ID_ENV] = "777";
    expect(() => selectSite(TWO_SITES)).toThrow(/777 is not among the 2 site\(s\).*-99, 12345/);
  });

  it("refuses an empty result and a duplicated site id", () => {
    expect(() => selectSite([])).toThrow(/returned no site/);
    process.env[SITE_ID_ENV] = "-99";
    expect(() => selectSite([TWO_SITES[0], TWO_SITES[0]])).toThrow(/2 times/);
  });

  it("never falls back to Sites[0] when a configured site is missing", () => {
    process.env[SITE_ID_ENV] = "1";
    expect(() => selectSite(TWO_SITES)).toThrow(SiteSelectionError);
  });
});

describe("fetchSiteInfo / getSelectedSite — pins the lookup with SiteIds", () => {
  let savedSiteId: string | undefined;
  beforeEach(() => {
    savedSiteId = process.env[SITE_ID_ENV];
    process.env[SITE_ID_ENV] = "-99";
  });
  afterEach(() => {
    if (savedSiteId === undefined) delete process.env[SITE_ID_ENV];
    else process.env[SITE_ID_ENV] = savedSiteId;
  });

  it("sends SiteIds=[configured] to /site/sites and resolves that site", async () => {
    const client = new MultiSiteClient(TWO_SITES);
    const site = await getSelectedSite(client, new SimpleCache(5));
    expect(site.Id).toBe(-99);
    expect(client.calls[0].url).toBe("/site/sites");
    expect(client.calls[0].params.SiteIds).toEqual(["-99"]);
  });

  it("still refuses if the server ignores the SiteIds filter and the configured site is absent", async () => {
    process.env[SITE_ID_ENV] = "555";
    const client = new MultiSiteClient(TWO_SITES, true);
    await expect(getSelectedSite(client, new SimpleCache(5))).rejects.toThrow(SiteSelectionError);
  });

  it("caches per requested site id, so two sites never share one record", async () => {
    const client = new MultiSiteClient(TWO_SITES);
    const cache = new SimpleCache(5);
    expect((await getSelectedSite(client, cache)).Id).toBe(-99);
    expect((await getSelectedSite(client, cache, 12345)).Id).toBe(12345);
    expect((await getSelectedSite(client, cache)).Id).toBe(-99);
    expect(client.calls.length).toBe(2);
  });

  it("the site timezone follows the SELECTED site, not Sites[0]", async () => {
    process.env[SITE_ID_ENV] = "12345";
    expect(await getSiteTimeZone(new MultiSiteClient(TWO_SITES, true), new SimpleCache(5))).toBe(HK);
  });
});

describe("getSitesTool — returns no data for an ambiguous multi-site key", () => {
  let savedSiteId: string | undefined;
  beforeEach(() => {
    savedSiteId = process.env[SITE_ID_ENV];
    delete process.env[SITE_ID_ENV];
  });
  afterEach(() => {
    if (savedSiteId === undefined) delete process.env[SITE_ID_ENV];
    else process.env[SITE_ID_ENV] = savedSiteId;
  });

  it("no default, no siteId, two sites → error + availableSites, no site", async () => {
    const result = await getSitesTool(undefined, new MultiSiteClient(TWO_SITES), new SimpleCache(5));
    expect(result.site).toBeUndefined();
    expect(result.error).toContain("2 sites");
    expect(result.availableSites?.map((s) => s.id)).toEqual([-99, 12345]);
  });

  it("explicit siteId → that site's record", async () => {
    const result = await getSitesTool("12345", new MultiSiteClient(TWO_SITES), new SimpleCache(5));
    expect(result.error).toBeUndefined();
    expect(result.site?.id).toBe(12345);
    expect(result.site?.timeZone).toBe(HK);
  });

  it("configured default → that site's record", async () => {
    process.env[SITE_ID_ENV] = "-99";
    const result = await getSitesTool(undefined, new MultiSiteClient(TWO_SITES), new SimpleCache(5));
    expect(result.site?.id).toBe(-99);
  });
});
