/**
 * Site-catalogue tools driven through docs/openapi.json.
 *
 * Every fixture here is SHAPED LIKE THE SPEC: each row carries only property
 * names the matching definition actually declares (`Site`, `Location`,
 * `SessionType`, `Staff`), with no field the API does not have — no `ESI`, no
 * `TotalLocations`, no `BusinessHours`, no `DefaultTimeLengthType`, no
 * `isMale`. A tool that reaches for one of those now reads `undefined` and the
 * field-by-field assertions below fail, which is the point: the phantom fields
 * used to be mapped as if they existed, so nothing here looked wrong.
 *
 * All requests go through `SpecValidatingClient`, which rejects any query
 * parameter docs/openapi.json does not define for that path. That is what proves
 * the request shapes below (plural `SessionTypeIds`/`LocationIds`, the singular
 * `SessionTypeId`/`LocationId`, and the fact that `getStaff` sends no
 * `IncludeInactive`) rather than the assertions on
 * the recorded params proving them twice over.
 *
 * One fixture carries every list key a tool here can read (`Sites`, `Locations`,
 * `SessionTypes`, `StaffMembers`, `Programs`, `Resources`) because several of
 * these tools make more than one call — `getSitesTool` reads `/site/sites` and
 * then `/site/locations` — and `fetchAllPages` picks one list key per path.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { AxiosRequestConfig } from "axios";
import type { IMindbodyClient } from "../src/api/client.js";
import { SimpleCache } from "../src/cache/index.js";
import { SpecValidatingClient, SpecValidationError } from "./spec-validating-client.js";
import {
  getLocationsTool,
  getResourcesTool,
  getSessionTypesTool,
  getSitesTool,
  getStaffTool,
} from "../src/tools/siteManagement.js";

const spec = JSON.parse(readFileSync(resolve(__dirname, "../docs/openapi.json"), "utf-8"));

function makeClient(fixture: unknown) {
  return new SpecValidatingClient(spec, fixture);
}

function emptyCache() {
  return new SimpleCache(5);
}

// ── Spec-shaped fixtures ──────────────────────────────────────────────────────

/** `Site`, exactly the properties `Mindbody.PublicApi.Dto.Models.V6.Site` declares. */
const SITE = {
  Id: -99,
  Name: "Sandbox Studio",
  Description: "Spec-shaped site record",
  LogoUrl: "https://example.invalid/logo.png",
  PageColor1: "#000000",
  PageColor2: "#111111",
  PageColor3: "#222222",
  PageColor4: "#333333",
  AcceptsVisa: true,
  AcceptsMasterCard: true,
  AcceptsDiscover: false,
  AcceptsAmericanExpress: true,
  AllowsDashboardAccess: true,
  ContactEmail: "studio@example.invalid",
  TaxInclusivePrices: false,
  CurrencyIsoCode: "USD",
  CountryCode: "US",
  TimeZone: "America/Los_Angeles",
  SmsPackageEnabled: false,
  PricingLevel: "Consumer",
  AcceptsDirectDebit: true,
  LeadChannels: [{ Id: 1, Name: "Web", SalespipelineId: 4, StudioId: -99 }],
  PerStaffPricing: false,
};

/** `Location`: `AdditionalImageURLs` is string[], `Amenities` is {Id, Name}. */
const LOCATION = {
  Id: 1,
  Name: "Main Studio",
  Description: "Ground floor",
  HasClasses: true,
  PhoneExtension: "101",
  Address: "1 Loopback Lane",
  Address2: "Suite 2",
  City: "Localhost",
  StateProvCode: "CA",
  PostalCode: "90000",
  Latitude: 34.1,
  Longitude: -118.2,
  Phone: "555-0100",
  AdditionalImageURLs: ["https://example.invalid/studio.png", "https://example.invalid/locker.png"],
  Amenities: [
    { Id: 1, Name: "Lockers" },
    { Id: 2, Name: "Showers" },
  ],
  AverageRating: 4.5,
  BusinessDescription: "Yoga and pilates",
  SiteID: -99,
  Tax1: 0.0925,
  TotalNumberOfDeals: 12,
  TotalNumberOfRatings: 3,
};

const SECOND_LOCATION = { ...LOCATION, Id: 2, Name: "Annex", AdditionalImageURLs: [], Amenities: [] };

/** `SessionType`: the fourteen documented properties, no `DefaultTimeLengthType`. */
const SESSION_TYPE = {
  Id: 9,
  Name: "Personal Training",
  AvailableForAddOn: false,
  Category: "Appointment",
  CategoryId: 11,
  DefaultTimeLength: 60,
  NumDeducted: 1,
  OnlineDescription: "One to one coaching",
  ProgramId: 3,
  ResourceRequired: true,
  StaffTimeLength: 75,
  Subcategory: "One to One",
  SubcategoryId: 12,
  Type: "Appointment",
};

/** `Staff`: `IsMale`, capitalised. */
const STAFF = {
  Id: 4,
  FirstName: "Ada",
  LastName: "Lovelace",
  DisplayName: "Ada L",
  Name: "Ada Lovelace",
  Email: "ada@example.invalid",
  MobilePhone: "555-0123",
  HomePhone: "555-0124",
  WorkPhone: "555-0125",
  Address: "2 Analytical Way",
  City: "London",
  State: "ENG",
  PostalCode: "NW1 1AA",
  Country: "GB",
  ImageUrl: "https://example.invalid/ada.png",
  Bio: "<p>Analytical engine enthusiast</p>",
  IsMale: false,
  AppointmentInstructor: true,
  AlwaysAllowDoubleBooking: false,
  IndependentContractor: true,
  EmploymentStart: "2019-04-01T00:00:00",
  EmploymentEnd: null,
  Active: true,
  SortOrder: 2,
  ProviderIDs: ["p-1"],
};

const PROGRAM = {
  Id: 3,
  Name: "Yoga",
  ScheduleType: "Class",
  CancelOffset: 12,
  ContentFormats: ["InPerson"],
  PricingRelationships: [],
};

const RESOURCE = { Id: 77, Name: "Studio A" };

/** Every list key a tool in this file reads, with a matching TotalResults. */
function fixture(overrides: Record<string, unknown[]> = {}) {
  const lists: Record<string, unknown[]> = {
    Sites: [SITE],
    Locations: [LOCATION],
    SessionTypes: [SESSION_TYPE],
    StaffMembers: [STAFF],
    Programs: [PROGRAM],
    Resources: [RESOURCE],
    ...overrides,
  };
  const totalResults = Math.max(...Object.values(lists).map((rows) => rows.length), 0);
  return {
    ...lists,
    PaginationResponse: { RequestedLimit: 200, RequestedOffset: 0, PageSize: totalResults, TotalResults: totalResults },
  };
}

/**
 * Records every request, still validating each one against the spec.
 *
 * `pageCap` makes this client behave like a server that silently serves fewer
 * rows than the requested `Limit` while still reporting the full `TotalResults`,
 * which is how a paged read proves it kept paging. Parameters left `undefined`
 * are dropped from the record, because that is what axios puts on the wire.
 */
class RecordingClient implements IMindbodyClient {
  readonly calls: Array<{ url: string; params: Record<string, unknown> | undefined }> = [];

  constructor(
    private readonly inner: SpecValidatingClient,
    private readonly failUrl?: string,
    private readonly pageCap = Number.POSITIVE_INFINITY
  ) {}

  async request<T>(config: AxiosRequestConfig, retries?: number): Promise<T> {
    this.record(config.url ?? "", config.params as Record<string, unknown> | undefined);
    return this.inner.request<T>(config, retries);
  }

  async get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    this.record(url, config?.params as Record<string, unknown> | undefined);
    if (url === this.failUrl) throw new Error(`stubbed failure: GET ${url}`);
    const page = await this.inner.get<any>(url, config);
    if (page === null || typeof page !== "object" || !Number.isFinite(this.pageCap)) return page as T;
    const capped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(page)) {
      capped[key] = Array.isArray(value) ? value.slice(0, this.pageCap) : value;
    }
    return capped as T;
  }

  async post<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    this.record(url, config?.params as Record<string, unknown> | undefined);
    return this.inner.post<T>(url, data, config);
  }

  private record(url: string, params: Record<string, unknown> | undefined): void {
    const onTheWire: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined) onTheWire[key] = value;
    }
    this.calls.push({ url, params: onTheWire });
  }

  /** Query parameters of the n-th request to `url` (default: the first). */
  paramsFor(url: string, index = 0): Record<string, unknown> | undefined {
    return this.calls.filter((call) => call.url === url)[index]?.params;
  }

  countFor(url: string): number {
    return this.calls.filter((call) => call.url === url).length;
  }
}

function recording(fixtureValue: unknown = fixture(), failUrl?: string, pageCap?: number): RecordingClient {
  return new RecordingClient(makeClient(fixtureValue), failUrl, pageCap);
}

/** A recording client that does NOT validate: proves the tool's request shape only. */
class ParamsOnlyClient implements IMindbodyClient {
  readonly calls: Array<{ url: string; params: Record<string, unknown> | undefined }> = [];

  constructor(private readonly body: unknown) {}

  async request<T>(config: AxiosRequestConfig): Promise<T> {
    this.calls.push({
      url: config.url ?? "",
      params: stripUndefined(config.params as Record<string, unknown>),
    });
    return this.body as T;
  }

  async get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    this.calls.push({ url, params: stripUndefined(config?.params as Record<string, unknown>) });
    return this.body as T;
  }

  async post<T>(): Promise<T> {
    return this.body as T;
  }

  paramsFor(url: string): Record<string, unknown> | undefined {
    return this.calls.filter((call) => call.url === url)[0]?.params;
  }
}

function stripUndefined(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params ?? {})) if (value !== undefined) out[key] = value;
  return out;
}

// ── C-26 · getSitesTool ───────────────────────────────────────────────────────

describe("getSitesTool — reads only fields the Site model has", () => {
  it("maps every documented Site property and derives totalLocations from the locations list", async () => {
    const client = recording(fixture({ Locations: [LOCATION, SECOND_LOCATION] }));

    const result = await getSitesTool("-99", client, emptyCache());

    expect(result.error).toBeUndefined();
    expect(result.site).toEqual({
      id: -99,
      name: "Sandbox Studio",
      description: "Spec-shaped site record",
      logoUrl: "https://example.invalid/logo.png",
      pageColor1: "#000000",
      pageColor2: "#111111",
      pageColor3: "#222222",
      pageColor4: "#333333",
      acceptsVisa: true,
      acceptsMasterCard: true,
      acceptsDiscover: false,
      acceptsAmex: true,
      contactEmail: "studio@example.invalid",
      taxInclusivePrices: false,
      currency: "USD", // Site.CurrencyIsoCode, not a `Currency` property
      countryCode: "US",
      timeZone: "America/Los_Angeles",
      totalLocations: 2, // counted from GET /site/locations, not read from Site
    });
  });

  it("drops esi: neither the spec's Site nor the sandbox has ESI", async () => {
    const client = recording();

    const site = (await getSitesTool("-99", client, emptyCache())).site;

    expect(site).toBeDefined();
    expect("esi" in (site as object)).toBe(false);
    // The drop is deliberate and documented in the tool's JSDoc.
    const source = readFileSync(resolve(__dirname, "../src/tools/siteManagement.ts"), "utf-8");
    expect(source).toContain("Site` has neither `ESI` nor `TotalLocations`");
  });

  it("reads the site record and the locations through the same injected client and cache", async () => {
    const client = recording();
    const cache = emptyCache();

    await getSitesTool("-99", client, cache);

    expect(client.countFor("/site/sites")).toBeGreaterThan(0);
    expect(client.countFor("/site/locations")).toBe(1);
    // One cache, one entry: the count the site record reports is the very same
    // 'locations' entry getLocationsTool reads, so calling it next costs no request.
    const locations = await getLocationsTool(client, cache);
    expect(client.countFor("/site/locations")).toBe(1);
    expect(locations.totalLocations).toBe(1);
  });

  it("leaves totalLocations undefined (never 0) when the locations read fails", async () => {
    const client = recording(fixture(), "/site/locations");

    const result = await getSitesTool("-99", client, emptyCache());

    expect(client.countFor("/site/locations")).toBe(1);
    // Fails open: the rest of the site record still comes back …
    expect(result.site?.currency).toBe("USD");
    expect(result.site?.timeZone).toBe("America/Los_Angeles");
    // … and a count we could not read is absent, because 0 would be a false claim.
    expect(result.site?.totalLocations).toBeUndefined();
    expect(result.site?.totalLocations).not.toBe(0);
  });

  it("still refuses an ambiguous multi-site key instead of guessing", async () => {
    const client = new RecordingClient(makeClient({
      Sites: [SITE, { ...SITE, Id: 12345, Name: "Second Studio" }],
      PaginationResponse: { RequestedLimit: 200, RequestedOffset: 0, PageSize: 2, TotalResults: 2 },
    }));

    const saved = process.env.MINDBODY_SITE_ID;
    delete process.env.MINDBODY_SITE_ID;
    try {
      const result = await getSitesTool(undefined, client, emptyCache());
      expect(result.site).toBeUndefined();
      expect(result.availableSites?.map((s) => s.id)).toEqual([-99, 12345]);
      // No site chosen, so no locations read was attempted either.
      expect(client.countFor("/site/locations")).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.MINDBODY_SITE_ID;
      else process.env.MINDBODY_SITE_ID = saved;
    }
  });
});

// ── C-27 · getLocationsTool ───────────────────────────────────────────────────

describe("getLocationsTool — image URLs are strings, and a location has no hours", () => {
  it("maps AdditionalImageURLs onto imageUrls and drops facilities and businessHours", async () => {
    const client = recording();

    const result = await getLocationsTool(client, emptyCache());

    expect(result.locations).toHaveLength(1);
    expect(result.locations[0]).toEqual({
      id: 1,
      name: "Main Studio",
      description: "Ground floor",
      hasClasses: true,
      phoneExtension: "101",
      address: "1 Loopback Lane",
      address2: "Suite 2",
      city: "Localhost",
      state: "CA", // Location.StateProvCode
      postalCode: "90000",
      latitude: 34.1,
      longitude: -118.2,
      phone: "555-0100",
      imageUrls: ["https://example.invalid/studio.png", "https://example.invalid/locker.png"],
      amenities: [
        { id: 1, name: "Lockers" },
        { id: 2, name: "Showers" },
      ],
    });
    const location = result.locations[0] as object;
    expect("facilities" in location).toBe(false);
    expect("businessHours" in location).toBe(false);
    expect(result.totalLocations).toBe(1);
  });

  it("reports an empty image list as an empty list, not as {id: undefined, name: undefined}", async () => {
    const client = recording(fixture({ Locations: [SECOND_LOCATION] }));

    const [location] = (await getLocationsTool(client, emptyCache())).locations;

    expect(location.imageUrls).toEqual([]);
    expect(location.amenities).toEqual([]);
  });

  it("pages the locations list rather than reading page one", async () => {
    // The server caps every page at one row while still reporting the full
    // TotalResults, so a caller that stops after the first page is caught.
    const client = recording(fixture({ Locations: [LOCATION, SECOND_LOCATION] }), undefined, 1);

    const result = await getLocationsTool(client, emptyCache());

    expect(result.locations.map((l) => l.id)).toEqual([1, 2]);
    expect(result.totalLocations).toBe(2);
    expect(client.paramsFor("/site/locations")).toMatchObject({ Limit: 200, Offset: 0 });
    expect(client.paramsFor("/site/locations", 1)).toMatchObject({ Limit: 200, Offset: 1 });
    expect(client.countFor("/site/locations")).toBeGreaterThan(1);
  });

  it("still honours a cached raw { Locations, PaginationResponse } response", async () => {
    const cache = emptyCache();
    cache.set(
      "locations",
      { Locations: [SECOND_LOCATION], PaginationResponse: { TotalResults: 2 } },
      60
    );
    const client = recording();

    const result = await getLocationsTool(client, cache);

    expect(client.countFor("/site/locations")).toBe(0);
    expect(result.locations.map((l) => l.id)).toEqual([2]);
    expect(result.totalLocations).toBe(2);
  });
});

// ── C-28 + D-2 · getResourcesTool ─────────────────────────────────────────────

describe("getResourcesTool — sends only the parameters the path defines", () => {
  it("maps the observed {Id, Name} rows and sends the documented filters", async () => {
    const client = recording();

    const result = await getResourcesTool([1], [3], [77], ["Class"], true, client);

    expect(result.resources).toEqual([{ id: 77, name: "Studio A" }]);
    expect(result.totalResources).toBe(1);
    expect(client.paramsFor("/site/resources")).toEqual({
      LocationIds: [1],
      ProgramIds: [3],
      ResourceIds: [77],
      ScheduleTypes: ["Class"],
      IncludeInactive: true,
      Limit: 200,
      Offset: 0,
    });
  });

  it("never sends the undocumented SessionTypeIds, LocationId, StartDateTime or EndDateTime", async () => {
    const client = recording();

    await getResourcesTool([1], undefined, undefined, undefined, undefined, client);

    const params = client.paramsFor("/site/resources") as Record<string, unknown>;
    // SessionTypeIds is the one that answers HTTP 500 in the sandbox (D-2).
    expect("SessionTypeIds" in params).toBe(false);
    expect("LocationId" in params).toBe(false);
    expect("StartDateTime" in params).toBe(false);
    expect("EndDateTime" in params).toBe(false);
    // A real filter, and an unset one the tool must leave off entirely.
    expect(params.LocationIds).toEqual([1]);
    expect("ProgramIds" in params).toBe(false);
    expect("ResourceIds" in params).toBe(false);
    expect("ScheduleTypes" in params).toBe(false);
    expect("IncludeInactive" in params).toBe(false);
  });

  it("rejects the undocumented SessionTypeIds through spec validation", async () => {
    const client = makeClient(fixture());

    await expect(
      client.get("/site/resources", { params: { SessionTypeIds: [999], Limit: 200, Offset: 0 } })
    ).rejects.toThrow(SpecValidationError);
  });

  it("records the untyped response as sandbox-observed, naming section D-2", () => {
    const source = readFileSync(resolve(__dirname, "../src/tools/siteManagement.ts"), "utf-8");
    expect(source).toContain(
      "// SANDBOX-OBSERVED (differs from spec): the 200 response is untyped in docs/openapi.json; the sandbox returns {PaginationResponse, Resources: [{Id, Name}]}, and undocumented SessionTypeIds on this path returns HTTP 500 rather than being ignored."
    );
    expect(source).toContain("docs/mindbody-spec-discrepancies.md section D-2");
  });
});

// ── C-29 · getSessionTypesTool ────────────────────────────────────────────────

describe("getSessionTypesTool — drops defaultDurationType, keeps the real fields", () => {
  it("maps the fourteen documented SessionType properties", async () => {
    const client = recording();

    const result = await getSessionTypesTool([3], false, client);

    expect(result.totalSessionTypes).toBe(1);
    expect(result.sessionTypes[0]).toEqual({
      id: 9,
      name: "Personal Training",
      defaultDuration: 60, // DefaultTimeLength
      staffTimeLength: 75, // StaffTimeLength
      resourceRequired: true, // ResourceRequired
      numDeducted: 1,
      programId: 3,
      category: "Appointment",
      categoryId: 11,
      subcategory: "One to One",
      subcategoryId: 12,
      type: "Appointment",
    });
    expect("defaultDurationType" in (result.sessionTypes[0] as object)).toBe(false);
    expect(client.paramsFor("/site/sessiontypes")).toEqual({
      ProgramIds: [3],
      OnlineOnly: false,
      Limit: 200,
      Offset: 0,
    });
  });

  it("passes programIds through as the documented request.programIDs parameter", async () => {
    const client = recording();

    await getSessionTypesTool([3, 4], true, client);

    // Case-insensitive on the wire: `ProgramIds` satisfies `request.programIDs`.
    expect(client.paramsFor("/site/sessiontypes")).toMatchObject({
      ProgramIds: [3, 4],
      OnlineOnly: true,
    });
  });
});

// ── C-30 · getStaffTool ───────────────────────────────────────────────────────

describe("getStaffTool — singular filters, and IsMale capitalised", () => {
  it("maps every documented Staff property the tool reads", async () => {
    const client = recording();

    const result = await getStaffTool(undefined, undefined, undefined, undefined, undefined, client);

    expect(result.totalStaff).toBe(1);
    expect(result.staff[0]).toEqual({
      id: 4,
      firstName: "Ada",
      lastName: "Lovelace",
      name: "Ada Lovelace",
      email: "ada@example.invalid",
      mobilePhone: "555-0123",
      homePhone: "555-0124",
      workPhone: "555-0125",
      address: "2 Analytical Way",
      city: "London",
      state: "ENG",
      postalCode: "NW1 1AA",
      country: "GB",
      imageUrl: "https://example.invalid/ada.png",
      bio: "<p>Analytical engine enthusiast</p>",
      isMale: false, // Staff.IsMale
      appointmentInstructor: true,
      alwaysAllowDoubleBooking: false,
      independentContractor: true,
      employmentStart: "2019-04-01T00:00:00",
      employmentEnd: null,
    });
  });

  it("sends singular SessionTypeId and LocationId, never the silently-ignored plurals", async () => {
    const client = recording();

    await getStaffTool([4], ["Active"], 9, 1, "2026-10-01T09:00:00", client);

    expect(client.paramsFor("/staff/staff")).toEqual({
      StaffIds: [4],
      Filters: ["Active"],
      SessionTypeId: 9, // singular: the API has no plural form and drops it
      LocationId: 1,
      StartDateTime: "2026-10-01T09:00:00",
      Limit: 200,
      Offset: 0,
    });
  });

  it("sends no IncludeInactive, because this tool does not expose it", async () => {
    const client = recording();

    await getStaffTool(undefined, undefined, undefined, undefined, undefined, client);

    // `/staff/staff` does document `request.includeInactive`, but exposing it is
    // outside this tool's remit; what is pinned here is that nothing undocumented
    // and nothing unintended reaches the wire.
    expect("IncludeInactive" in (client.paramsFor("/staff/staff") as Record<string, unknown>)).toBe(false);
  });

  it("omits every filter the caller did not ask for", async () => {
    const client = recording();

    await getStaffTool(undefined, undefined, undefined, undefined, undefined, client);

    const params = client.paramsFor("/staff/staff") as Record<string, unknown>;
    expect("SessionTypeId" in params).toBe(false);
    expect("LocationId" in params).toBe(false);
    expect("StartDateTime" in params).toBe(false);
    expect(params.Limit).toBe(200);
  });

  it("rejects the plural SessionTypeIds and LocationIds through spec validation", async () => {
    const client = makeClient(fixture());

    await expect(
      client.get("/staff/staff", { params: { SessionTypeIds: [999], Limit: 200, Offset: 0 } })
    ).rejects.toThrow(SpecValidationError);
    await expect(
      client.get("/staff/staff", { params: { LocationIds: [999], Limit: 200, Offset: 0 } })
    ).rejects.toThrow(SpecValidationError);
  });
});

// ── No phantom reads survive in the tool source ───────────────────────────────

describe("src/tools/siteManagement.ts — no reads of fields that do not exist", () => {
  /** Code only: comments name the dropped fields on purpose. */
  const code = readFileSync(resolve(__dirname, "../src/tools/siteManagement.ts"), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  for (const phantom of [
    "ESI",
    "TotalLocations",
    "DefaultTimeLengthType",
    "BusinessHours",
    "businessHours",
    "facilities",
    "SessionTypeIds",
  ]) {
    it(`never reads ${phantom}`, () => {
      expect(code).not.toContain(phantom);
    });
  }

  it("reads IsMale, not the lower-cased isMale the API never sends", () => {
    expect(code).toContain("member.IsMale");
    expect(code).not.toContain("member.isMale");
  });
});