import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { AxiosRequestConfig } from "axios";
import { SpecValidatingClient } from "./spec-validating-client.js";
import { getSalesTool, APPOINTMENT_MATCH_NOTE } from "../src/tools/salesHistory.js";
import type { IMindbodyClient } from "../src/api/client.js";
import { SimpleCache } from "../src/cache/index.js";

const spec = JSON.parse(readFileSync(resolve(__dirname, "../docs/openapi.json"), "utf-8"));

/**
 * Routes each GET to a spec-validating fixture by path, so every request is
 * checked against docs/openapi.json and paged like Mindbody pages it.
 */
class RoutedClient implements IMindbodyClient {
  calls: Array<{ url: string; params: Record<string, unknown> }> = [];
  readonly cache = new SimpleCache(5);
  private readonly routes: Record<string, SpecValidatingClient>;

  constructor(fixtures: Record<string, unknown>) {
    this.routes = Object.fromEntries(
      Object.entries(fixtures).map(([url, fixture]) => [url, new SpecValidatingClient(spec, fixture)])
    );
  }

  async get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    this.calls.push({ url, params: config?.params ?? {} });
    const route = this.routes[url];
    if (!route) throw new Error(`unexpected GET ${url}`);
    return route.get<T>(url, config);
  }

  async post<T>(): Promise<T> {
    throw new Error("getSales must not write");
  }

  async request<T>(): Promise<T> {
    throw new Error("not used");
  }

  urls(): string[] {
    return this.calls.map((c) => c.url);
  }
}

const page = (key: string, rows: unknown[]) => ({
  PaginationResponse: { RequestedLimit: 200, RequestedOffset: 0, PageSize: rows.length, TotalResults: rows.length },
  [key]: rows,
});

const STAFF = page("StaffMembers", [
  { Id: 7, FirstName: "Lena", LastName: "Ko" },
  { Id: 8, FirstName: "Ana", LastName: "Ruiz" },
]);

const product = (id: number, total: number, extra: Record<string, unknown> = {}) => ({
  Id: id, IsService: false, Description: `Product ${id}`, UnitPrice: total, Quantity: 1, TotalAmount: total, Returned: false, ...extra,
});
const service = (id: number, total: number) => ({
  Id: id, IsService: true, Description: `Service ${id}`, UnitPrice: total, Quantity: 1, TotalAmount: total, Returned: false,
});

const SALES = [
  // Rep 7 (wire shape: site-local time with a spurious Z, D-11): shampoo x2 plus a haircut, and a returned conditioner that must not count.
  { Id: 1, SaleDateTime: "2026-11-03T10:15:00Z", SalesRepId: 7, ClientId: "c1", LocationId: 1,
    PurchasedItems: [product(101, 40, { Quantity: 2 }), service(201, 90), product(102, 25, { Returned: true })],
    Payments: [{ Id: 9, Amount: 155, Method: 1, Type: "Cash" }] },
  // Rep 8: service only.
  { Id: 2, SaleDateTime: "2026-11-04T12:00:00", SalesRepId: 8, ClientId: "c2", LocationId: 1,
    PurchasedItems: [service(202, 60)], Payments: [] },
  // No rep set: a product sale that only the appointment match can attribute.
  { Id: 3, SaleDateTime: "2026-11-05T16:30:00", ClientId: "c3", LocationId: 1,
    PurchasedItems: [product(103, 18.5)], Payments: [] },
];

const salesClient = (extra: Record<string, unknown> = {}) =>
  new RoutedClient({ "/sale/sales": page("Sales", SALES), "/staff/staff": STAFF, ...extra });

const run = (client: RoutedClient, options = {}) =>
  getSalesTool({ startDate: "2026-11-01", endDate: "2026-11-11", ...options }, client, client.cache);

describe("getSalesTool", () => {
  it("reads every page of /sale/sales over the full site-local day range, read-only", async () => {
    const rows = Array.from({ length: 450 }, (_, i) => ({ Id: i + 1, SaleDateTime: "2026-11-02T09:00:00", SalesRepId: 7, ClientId: "c1", PurchasedItems: [], Payments: [] }));
    const client = new RoutedClient({ "/sale/sales": page("Sales", rows), "/staff/staff": STAFF });
    const result = await run(client);

    expect(result.totalSales).toBe(450);
    expect(new Set(result.sales.map((s) => s.id)).size).toBe(450);
    const saleCalls = client.calls.filter((c) => c.url === "/sale/sales");
    expect(saleCalls.length).toBe(3);
    expect(saleCalls[0].params).toMatchObject({ StartSaleDateTime: "2026-11-01T00:00:00", EndSaleDateTime: "2026-11-11T23:59:59" });
    // Explicit dates need no site lookup; staff names are one request.
    expect(client.urls().filter((u) => u === "/staff/staff").length).toBe(1);
    expect(client.urls()).not.toContain("/site/sites");
  });

  it("maps sales to camelCase and groups product sales by credited rep", async () => {
    const result = await run(salesClient());

    expect(result.sales[0]).toEqual({
      id: 1, saleDateTime: "2026-11-03T10:15:00", salesRepId: 7, clientId: "c1", locationId: 1,
      items: [
        { id: 101, description: "Product 101", isService: false, categoryId: undefined, unitPrice: 40, quantity: 2, totalAmount: 40, returned: false },
        { id: 201, description: "Service 201", isService: true, categoryId: undefined, unitPrice: 90, quantity: 1, totalAmount: 90, returned: false },
        { id: 102, description: "Product 102", isService: false, categoryId: undefined, unitPrice: 25, quantity: 1, totalAmount: 25, returned: true },
      ],
      payments: [{ id: 9, amount: 155, method: 1, type: "Cash" }],
    });
    expect(result.bySalesRep).toEqual([
      { salesRepId: 7, staffName: "Lena Ko", saleCount: 1, productItemCount: 2, productTotal: 40 },
      { salesRepId: 8, staffName: "Ana Ruiz", saleCount: 1, productItemCount: 0, productTotal: 0 },
    ]);
    expect("byAppointmentStaff" in result).toBe(false);
    expect(result.startDate).toBe("2026-11-01");
  });

  it("productsOnly keeps only IsService false items and drops sales left empty", async () => {
    const result = await run(salesClient(), { productsOnly: true });

    expect(result.sales.map((s) => s.id)).toEqual([1, 3]);
    expect(result.sales[0].items.map((i) => i.id)).toEqual([101, 102]);
    expect(result.bySalesRep.map((r) => r.salesRepId)).toEqual([7]);
  });

  it("drops tip lines everywhere, and sales that were only a tip", async () => {
    const tip = (amount: number) => product(10, amount, { Description: "Tip", CategoryId: 21 });
    const rows = [
      { Id: 4, SaleDateTime: "2026-11-06T10:00:00", SalesRepId: 7, ClientId: "c4", LocationId: 1,
        PurchasedItems: [product(104, 30), tip(50)], Payments: [] },
      { Id: 5, SaleDateTime: "2026-11-06T11:00:00", SalesRepId: 8, ClientId: "c5", LocationId: 1,
        PurchasedItems: [tip(200)], Payments: [] },
    ];
    const client = new RoutedClient({ "/sale/sales": page("Sales", rows), "/staff/staff": STAFF });
    const result = await run(client);

    expect(result.sales.map((s) => s.id)).toEqual([4]);
    expect(result.sales[0].items.map((i) => i.id)).toEqual([104]);
    expect(result.bySalesRep).toEqual([
      { salesRepId: 7, staffName: "Lena Ko", saleCount: 1, productItemCount: 1, productTotal: 30 },
    ]);
  });

  it("filters by salesRepIds and clientIds client-side", async () => {
    expect((await run(salesClient(), { salesRepIds: [8] })).sales.map((s) => s.id)).toEqual([2]);
    expect((await run(salesClient(), { clientIds: ["c3", "c1"] })).sales.map((s) => s.id)).toEqual([1, 3]);
  });

  it("matchAppointments credits product sales to same-client same-day appointment staff", async () => {
    const appointments = page("Appointments", [
      { Id: 50, ClientId: "c3", StaffId: 8, StartDateTime: "2026-11-05T14:00:00", Status: "Completed" },
      { Id: 51, ClientId: "c3", StaffId: 7, StartDateTime: "2026-11-05T09:00:00", Status: "Completed" },
      // Same client, other day: no match.
      { Id: 52, ClientId: "c1", StaffId: 8, StartDateTime: "2026-11-02T09:00:00", Status: "Completed" },
      // Other client on the sale day: no match.
      { Id: 53, ClientId: "c9", StaffId: 8, StartDateTime: "2026-11-03T09:00:00", Status: "Completed" },
    ]);
    const client = salesClient({ "/appointment/staffappointments": appointments });
    const result = await run(client, { matchAppointments: true });

    expect(result.byAppointmentStaff).toEqual([
      { staffId: 7, staffName: "Lena Ko", saleCount: 1, productItemCount: 1, productTotal: 18.5 },
      { staffId: 8, staffName: "Ana Ruiz", saleCount: 1, productItemCount: 1, productTotal: 18.5 },
    ]);
    // Sale 1 has products but no same-day appointment; sale 2 has no products.
    expect(result.unmatchedProductSales).toBe(1);
    expect(result.appointmentMatchNote).toBe(APPOINTMENT_MATCH_NOTE);
    expect(client.calls.find((c) => c.url === "/appointment/staffappointments")?.params).toMatchObject({
      StartDate: "2026-11-01", EndDate: "2026-11-11",
    });
  });

  describe("default range is month-to-date in the site timezone", () => {
    const sites = (tz: string) => page("Sites", [{ Id: -99, Name: "Stub", TimeZone: tz }]);
    const at = async (tz: string, iso: string) => {
      const client = salesClient({ "/site/sites": sites(tz) });
      const result = await getSalesTool({}, client, client.cache, new Date(iso));
      return [result.startDate, result.endDate];
    };

    it("still October in Los Angeles at 05:00Z on 1 November", async () => {
      expect(await at("America/Los_Angeles", "2026-11-01T05:00:00Z")).toEqual(["2026-10-01", "2026-10-31"]);
    });

    it("already November in Hong Kong at 17:00Z on 31 October", async () => {
      expect(await at("Asia/Hong_Kong", "2026-10-31T17:00:00Z")).toEqual(["2026-11-01", "2026-11-01"]);
    });

    it("a supplied startDate keeps the default endDate", async () => {
      const client = salesClient({ "/site/sites": sites("Asia/Hong_Kong") });
      const result = await getSalesTool({ startDate: "2026-09-15" }, client, client.cache, new Date("2026-11-11T03:00:00Z"));
      expect([result.startDate, result.endDate]).toEqual(["2026-09-15", "2026-11-11"]);
    });
  });
});
