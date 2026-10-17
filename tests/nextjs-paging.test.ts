/**
 * The Next.js app's `fetchAllPages` (nextjs-app/src/lib/mindbody/paging.ts) is
 * a port of the MCP server's (src/api/client.ts). Gate 13 lets both code bases
 * satisfy one rule because the two pagers share a name AND a contract; this
 * suite holds the port to that contract, mirroring tests/fetchAllPages.test.ts,
 * and then proves the Next.js service really goes through it.
 *
 * Runs under the root `bun test` (Gate 1). nextjs-app has no test runner of
 * its own; see docs/quality-gates.md.
 */
import { describe, expect, it } from "bun:test";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGES,
  fetchAllPages,
  type PagedGetClient,
} from "../nextjs-app/src/lib/mindbody/paging";
import { MindbodyService } from "../nextjs-app/src/lib/mindbody/service";
import { MindbodyApiClient, getMindbodyClient, resetMindbodyClient } from "../nextjs-app/src/lib/mindbody/client";

type PaginationMode = "full" | "no-total" | "none";

interface MockOptions {
  total: number;
  serverCap?: number;
  pagination?: PaginationMode;
  ignoreOffset?: boolean;
  key?: string;
  /** Build a row from its 1-based index; default `{ Id }`. */
  row?: (id: number) => Record<string, unknown>;
}

/** A paging Mindbody list endpoint over `total` rows. */
class PagingServer implements PagedGetClient {
  readonly calls: Array<{ url: string; params: Record<string, unknown> }> = [];
  private readonly rows: Array<Record<string, unknown>>;

  constructor(private readonly options: MockOptions) {
    const row = options.row ?? ((id: number) => ({ Id: id }));
    this.rows = Array.from({ length: options.total }, (_, i) => row(i + 1));
  }

  async get<T>(url: string, options?: { params?: Record<string, any> }): Promise<T> {
    const params = options?.params ?? {};
    this.calls.push({ url, params });
    const asked = Number(params.Limit ?? 100);
    const served = Math.min(asked, this.options.serverCap ?? Infinity);
    const offset = this.options.ignoreOffset ? 0 : Number(params.Offset ?? 0);
    const page = this.rows.slice(offset, offset + served);
    const mode = this.options.pagination ?? "full";
    const body: Record<string, unknown> = { [this.options.key ?? "Things"]: page };
    if (mode !== "none") {
      body.PaginationResponse = {
        RequestedLimit: served,
        RequestedOffset: offset,
        PageSize: page.length,
        ...(mode === "full" ? { TotalResults: this.rows.length } : {}),
      };
    }
    return body as T;
  }

  get offsets(): unknown[] {
    return this.calls.map((call) => call.params.Offset);
  }

  get limits(): unknown[] {
    return this.calls.map((call) => call.params.Limit);
  }
}

const ids = (items: Array<{ Id: number }>) => items.map((item) => item.Id);
const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe("nextjs-app fetchAllPages — contract shared with src/api/client.ts", () => {
  it("defaults to a page size of 200 and caps a walk at 100 pages", () => {
    expect(DEFAULT_PAGE_SIZE).toBe(200);
    expect(MAX_PAGES).toBe(100);
  });

  it("walks every page, sends Limit=pageSize, advances Offset by rows received, keeps caller params", async () => {
    const server = new PagingServer({ total: 450 });
    const { items, totalResults } = await fetchAllPages<{ Id: number }>(
      server,
      "/class/classes",
      { StaffIds: [7] },
      "Things"
    );
    expect(ids(items)).toEqual(range(450));
    expect(totalResults).toBe(450);
    expect(server.limits).toEqual([200, 200, 200]);
    expect(server.offsets).toEqual([0, 200, 400]);
    expect(server.calls.every((call) => call.url === "/class/classes")).toBe(true);
    expect(server.calls.every((call) => (call.params.StaffIds as number[])[0] === 7)).toBe(true);
  });

  it("still fetches everything when the server silently caps Limit below what was asked", async () => {
    const server = new PagingServer({ total: 250, serverCap: 100 });
    const { items } = await fetchAllPages<{ Id: number }>(server, "/staff/staff", {}, "Things");
    expect(ids(items)).toEqual(range(250));
    expect(server.offsets).toEqual([0, 100, 200]);
  });

  it("without TotalResults, walks until a short page", async () => {
    const server = new PagingServer({ total: 450, pagination: "no-total" });
    const { items, totalResults } = await fetchAllPages<{ Id: number }>(server, "/sale/products", {}, "Things");
    expect(ids(items)).toEqual(range(450));
    expect(totalResults).toBe(450);
    expect(server.offsets).toEqual([0, 200, 400]);
  });

  it("without any PaginationResponse, walks until an empty page on a boundary", async () => {
    const server = new PagingServer({ total: 400, pagination: "none" });
    const { items } = await fetchAllPages<{ Id: number }>(server, "/site/programs", {}, "Things");
    expect(ids(items)).toEqual(range(400));
    expect(server.offsets).toEqual([0, 200, 400]);
  });

  it("collects rows from every listed key and hands every raw page to onPage", async () => {
    const seen: unknown[] = [];
    const server = new PagingServer({ total: 3, key: "A" });
    const { items } = await fetchAllPages<{ Id: number }>(server, "/x", {}, ["A", "B"], 200, {
      onPage: (page) => seen.push(page),
    });
    expect(ids(items)).toEqual([1, 2, 3]);
    expect(seen).toHaveLength(1);
  });

  it("returns no items from an empty first page", async () => {
    const server = new PagingServer({ total: 0 });
    expect(await fetchAllPages(server, "/x", {}, "Things")).toEqual({ items: [], totalResults: 0 });
  });

  it("throws, naming the path and the count, rather than return a truncated list after MAX_PAGES", async () => {
    const server = new PagingServer({ total: MAX_PAGES + 1, pagination: "no-total" });
    await expect(fetchAllPages(server, "/sale/sales", {}, "Things", 1)).rejects.toThrow(
      /GET \/sale\/sales exceeded MAX_PAGES=100 \(100 items fetched/
    );
  });

  it("throws when the server ignores Offset and repeats page one", async () => {
    const server = new PagingServer({ total: 500, ignoreOffset: true });
    await expect(fetchAllPages(server, "/client/clients", {}, "Things")).rejects.toThrow(/appears to ignore Offset/);
    expect(server.calls).toHaveLength(2);
  });

  it("rejects a non-positive or fractional page size before any request", async () => {
    const server = new PagingServer({ total: 1 });
    await expect(fetchAllPages(server, "/x", {}, "Things", 0)).rejects.toThrow(RangeError);
    await expect(fetchAllPages(server, "/x", {}, "Things", 1.5)).rejects.toThrow(RangeError);
    expect(server.calls).toHaveLength(0);
  });

  it("propagates a request failure", async () => {
    const failing: PagedGetClient = {
      get: async () => {
        throw new Error("HTTP 503");
      },
    };
    await expect(fetchAllPages(failing, "/x", {}, "Things")).rejects.toThrow("HTTP 503");
  });
});

describe("nextjs-app MindbodyApiClient satisfies the pager's client contract", () => {
  // Constructor-only: no request is made. The explicit config means nothing is
  // read from the developer's environment (bunfig.toml loads the repo .env).
  const config = { apiKey: "test-key", siteId: "-99", sourceName: "src", sourcePassword: "pw", apiUrl: "http://127.0.0.1:1" };

  it("exposes get(endpoint, { params }) and is accepted by fetchAllPages and MindbodyService", () => {
    const client = new MindbodyApiClient(config);
    const asPaged: PagedGetClient = client;
    expect(typeof asPaged.get).toBe("function");
    expect(new MindbodyService(client)).toBeInstanceOf(MindbodyService);
  });

  it("getMindbodyClient returns one shared instance until reset", () => {
    resetMindbodyClient();
    const a = getMindbodyClient(config);
    expect(getMindbodyClient()).toBe(a);
    resetMindbodyClient();
    expect(getMindbodyClient(config)).not.toBe(a);
    resetMindbodyClient();
  });
});

describe("nextjs-app MindbodyService — every list read walks all pages of its spec endpoint", () => {
  // One kitchen-sink row satisfies every mapper in the service, so a single
  // table can drive all list methods. `Appointments` is for getScheduleItems,
  // whose rows are staff members carrying their appointments.
  const row = (id: number) => ({
    Id: id,
    Name: `N${id}`,
    FirstName: "A",
    LastName: "B",
    ContractName: `C${id}`,
    Client: { Id: "c1", FirstName: "A", LastName: "B" },
    Location: { Id: 1, Name: "L" },
    Staff: { Id: 1, Name: "S", FirstName: "A", LastName: "B" },
    SessionType: { Id: 1, Name: "T" },
    ClassDescription: { Id: 1, Name: "D" },
    Appointments: [{ Id: id }],
  });

  type ListCase = {
    method: string;
    path: string;
    key: string;
    call: (s: MindbodyService) => Promise<{ items: Array<{ id?: unknown; scheduledItemId?: unknown }>; total: number }>;
  };
  const cases: ListCase[] = [
    { method: "getSites", path: "/site/sites", key: "Sites", call: (s) => s.getSites() },
    { method: "getLocations", path: "/site/locations", key: "Locations", call: (s) => s.getLocations() },
    { method: "getResources", path: "/site/resources", key: "Resources", call: (s) => s.getResources() },
    { method: "getPrograms", path: "/site/programs", key: "Programs", call: (s) => s.getPrograms({ scheduleType: "Class" }) },
    { method: "getSessionTypes", path: "/site/sessiontypes", key: "SessionTypes", call: (s) => s.getSessionTypes() },
    { method: "getStaff", path: "/staff/staff", key: "StaffMembers", call: (s) => s.getStaff({ locationIds: [1] }) },
    { method: "getClients", path: "/client/clients", key: "Clients", call: (s) => s.getClients({ searchText: "a" }) },
    { method: "getClientMemberships", path: "/client/activeclientmemberships", key: "ClientMemberships", call: (s) => s.getClientMemberships("c1") },
    { method: "getClientContracts", path: "/client/clientcontracts", key: "Contracts", call: (s) => s.getClientContracts("c1") },
    { method: "getClassDescriptions", path: "/class/classdescriptions", key: "ClassDescriptions", call: (s) => s.getClassDescriptions() },
    { method: "getClassSchedules", path: "/class/classschedules", key: "ClassSchedules", call: (s) => s.getClassSchedules({ staffIds: [1] }) },
    { method: "getWaitlistEntries", path: "/class/waitlistentries", key: "WaitlistEntries", call: (s) => s.getWaitlistEntries([1]) },
    { method: "getAppointments", path: "/appointment/staffappointments", key: "Appointments", call: (s) => s.getAppointments({ staffIds: [1] }) },
    { method: "getBookableItems", path: "/appointment/bookableitems", key: "Availabilities", call: (s) => s.getBookableItems({ sessionTypeIds: [1] }) },
    { method: "getScheduleItems", path: "/appointment/scheduleitems", key: "StaffMembers", call: (s) => s.getScheduleItems() },
    { method: "getActiveSessionTimes", path: "/appointment/activesessiontimes", key: "ActiveSessionTimes", call: (s) => s.getActiveSessionTimes() },
    { method: "getEnrollments", path: "/enrollment/enrollments", key: "Enrollments", call: (s) => s.getEnrollments({ locationIds: [1] }) },
    { method: "getServices", path: "/sale/services", key: "Services", call: (s) => s.getServices({ sessionTypeIds: [1] }) },
    { method: "getPackages", path: "/sale/packages", key: "Packages", call: (s) => s.getPackages(1) },
    { method: "getProducts", path: "/sale/products", key: "Products", call: (s) => s.getProducts({ sellOnline: true }) },
    { method: "getContracts", path: "/sale/contracts", key: "Contracts", call: (s) => s.getContracts({ soldOnline: true }) },
  ];

  for (const c of cases) {
    it(`${c.method} → GET ${c.path} (${c.key}): 5 rows served 2 per page are read in full`, async () => {
      const server = new PagingServer({ total: 5, serverCap: 2, key: c.key, row });
      const result = await c.call(new MindbodyService(server as any));
      expect(server.calls.map((call) => call.url)).toEqual([c.path, c.path, c.path]);
      expect(server.limits).toEqual([200, 200, 200]);
      expect(server.offsets).toEqual([0, 2, 4]);
      expect(result.items.map((item) => item.id ?? item.scheduledItemId)).toEqual(range(5));
      expect(result.total).toBe(5);
    });
  }

  it("getClientVisits pages /client/clientvisits and summarises attendance across pages", async () => {
    const visit = (id: number) => ({ ...row(id), SignedIn: id !== 5, LateCancelled: id === 5 });
    const server = new PagingServer({ total: 5, serverCap: 2, key: "Visits", row: visit });
    const result = await new MindbodyService(server as any).getClientVisits({ clientId: "c1" });
    expect(server.offsets).toEqual([0, 2, 4]);
    expect(result.total).toBe(5);
    expect(result.summary.totalAttended).toBe(4);
    expect(result.summary.totalLateCancels).toBe(1);
    expect(result.summary.byLocation).toEqual({ L: 4 });
  });

  it("getClientAccountBalances pages /client/clientaccountbalances and reads the client's balance", async () => {
    const balance = (id: number) => ({ Id: id, AccountBalance: 12.5, ClientCreditCards: [{ Balance: 3, CardType: "Visa", LastFour: "4242" }] });
    const server = new PagingServer({ total: 1, key: "Clients", row: balance });
    const result = await new MindbodyService(server as any).getClientAccountBalances("c1");
    expect(server.calls[0].url).toBe("/client/clientaccountbalances");
    expect(server.calls[0].params).toMatchObject({ ClientIds: ["c1"], Limit: 200, Offset: 0 });
    expect(result).toEqual({ accountBalance: 12.5, creditCardBalances: [{ amount: 3, cardType: "Visa", lastFour: "4242" }] });
  });

  it("getActivationCode is the one single GET: /site/activationcode is not paginated in the spec", async () => {
    const calls: string[] = [];
    const single = { get: async (url: string) => (calls.push(url), { ActivationCode: "AC", ActivationLink: "https://x" }) };
    const result = await new MindbodyService(single as any).getActivationCode();
    expect(calls).toEqual(["/site/activationcode"]);
    expect(result).toEqual({ activationCode: "AC", activationLink: "https://x" });
  });
});

describe("nextjs-app MindbodyService reads whole lists through the pager", () => {
  const classRow = (id: number) => ({
    Id: id,
    ClassScheduleId: 1,
    Location: { Id: 1, Name: "Studio" },
    ClassDescription: { Id: 2, Name: "Vinyasa" },
    Staff: { Id: 3, FirstName: "A", LastName: "B" },
    StartDateTime: "2026-10-18T08:00:00",
    EndDateTime: "2026-10-18T09:00:00",
  });

  it("getClasses collects every class across pages and reports the server total", async () => {
    const server = new PagingServer({ total: 7, serverCap: 3, key: "Classes", row: classRow });
    const service = new MindbodyService(server as any);
    const result = await service.getClasses({ locationIds: [1] });
    expect(result.items.map((c) => c.id)).toEqual(range(7));
    expect(result.total).toBe(7);
    expect(server.limits).toEqual([200, 200, 200]);
    expect(server.offsets).toEqual([0, 3, 6]);
    expect(server.calls[0].params.LocationIds).toEqual([1]);
    expect(server.calls[0].params).not.toHaveProperty("limit");
  });

  // getEnrollments, addClientToEnrollment and getClientEnrollments are covered
  // in tests/nextjs-enrollment.test.ts.
});
