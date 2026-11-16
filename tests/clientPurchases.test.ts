/**
 * getClientPurchasesTool (`GET /client/clientpurchases`), issue #25.
 *
 * Requests go through `SpecValidatingClient`, so every query parameter is
 * checked against docs/openapi.json and the fixture is paged as Mindbody pages it.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { AxiosRequestConfig } from "axios";
import { SpecValidatingClient } from "./spec-validating-client.js";
import { getClientPurchasesTool } from "../src/tools/clientManagement.js";
import type { IMindbodyClient } from "../src/api/client.js";
import { SimpleCache } from "../src/cache/index.js";

const spec = JSON.parse(readFileSync(resolve(__dirname, "../docs/openapi.json"), "utf-8"));
const definitions = spec.definitions as Record<string, { properties: Record<string, unknown> }>;
const props = (name: string) => Object.keys(definitions[`Mindbody.PublicApi.Dto.Models.V6.${name}`].properties);

/** Routes GETs to spec-validating fixtures by path and refuses every write. */
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
    throw new Error("getClientPurchases must not write");
  }

  async request<T>(): Promise<T> {
    throw new Error("not used");
  }

  purchaseCalls() {
    return this.calls.filter((c) => c.url === "/client/clientpurchases");
  }
}

const page = (key: string, rows: unknown[]) => ({
  PaginationResponse: { RequestedLimit: 200, RequestedOffset: 0, PageSize: rows.length, TotalResults: rows.length },
  [key]: rows,
});

/** The sandbox web-app sale from the issue: a 10 Class Card sold at an overridden 77. */
const RECORD = {
  Description: "10 Class Card",
  AccountPayment: false,
  Price: 77,
  AmountPaid: 83.16,
  Discount: 0,
  Tax: 6.16,
  Returned: false,
  Quantity: 1,
  Sale: {
    Id: 100170630,
    SaleDateTime: "2026-10-28T10:15:00Z",
    ClientId: "100000123",
    LocationId: 1,
    PurchasedItems: [
      {
        SaleDetailId: 5,
        Id: 1192,
        IsService: true,
        Description: "10 Class Card",
        ContractId: 0,
        UnitPrice: 77,
        Quantity: 1,
        DiscountPercent: 0,
        DiscountAmount: 0,
        TaxAmount: 6.16,
        TotalAmount: 83.16,
        Returned: false,
        ExpDate: "2027-10-28T00:00:00",
        ActiveDate: "2026-10-28T00:00:00",
      },
    ],
    Payments: [{ Id: 77001, Amount: 83.16, Method: 1, Type: "Cash", Notes: "", TransactionId: 555 }],
  },
};

const purchasesClient = (rows: unknown[], extra: Record<string, unknown> = {}) =>
  new RoutedClient({ "/client/clientpurchases": page("Purchases", rows), ...extra });

const sites = (tz: string) => page("Sites", [{ Id: -99, Name: "Stub", TimeZone: tz }]);

describe("getClientPurchasesTool", () => {
  it("sends ClientId with explicit StartDate/EndDate and reads every page", async () => {
    const rows = Array.from({ length: 450 }, (_, i) => ({ ...RECORD, Sale: { ...RECORD.Sale, Id: i + 1 } }));
    const client = purchasesClient(rows);
    const result = await getClientPurchasesTool(
      "100000123",
      { startDate: "2026-10-01", endDate: "2026-10-31" },
      client,
      client.cache
    );

    expect(result.totalPurchases).toBe(450);
    expect(new Set(result.purchases.map((p) => p.sale?.id)).size).toBe(450);
    const calls = client.purchaseCalls();
    expect(calls.length).toBe(3);
    expect(calls[0].params).toMatchObject({
      ClientId: "100000123",
      StartDate: "2026-10-01T00:00:00",
      EndDate: "2026-10-31T23:59:59",
    });
    // Explicit dates need no site lookup.
    expect(client.calls.map((c) => c.url)).not.toContain("/site/sites");
  });

  it("defaults to 365 days back through the end of today in the site timezone", async () => {
    // 17:00Z on 31 Oct is already 1 Nov in Hong Kong.
    const client = purchasesClient([], { "/site/sites": sites("Asia/Hong_Kong") });
    await getClientPurchasesTool("c-1", {}, client, client.cache, new Date("2026-10-31T17:00:00Z"));
    expect(client.purchaseCalls()[0].params).toMatchObject({
      StartDate: "2025-11-01T00:00:00",
      EndDate: "2026-11-01T23:59:59",
    });
  });

  it("a supplied startDate keeps the default endDate", async () => {
    const client = purchasesClient([], { "/site/sites": sites("America/Los_Angeles") });
    await getClientPurchasesTool("c-1", { startDate: "2026-10-28" }, client, client.cache, new Date("2026-11-01T05:00:00Z"));
    expect(client.purchaseCalls()[0].params).toMatchObject({
      StartDate: "2026-10-28T00:00:00",
      EndDate: "2026-10-31T23:59:59",
    });
  });

  it("maps every listed field, including the nested sale items and payments", async () => {
    const client = purchasesClient([RECORD]);
    const result = await getClientPurchasesTool("100000123", { startDate: "2026-10-28", endDate: "2026-10-28" }, client, client.cache);

    expect(result.purchases).toEqual([
      {
        description: "10 Class Card",
        price: 77,
        amountPaid: 83.16,
        discount: 0,
        tax: 6.16,
        returned: false,
        quantity: 1,
        accountPayment: false,
        sale: {
          id: 100170630,
          // The spurious Z (D-11) is stripped: SaleDateTime is site-local.
          saleDateTime: "2026-10-28T10:15:00",
          locationId: 1,
          purchasedItems: [
            {
              id: 1192,
              isService: true,
              description: "10 Class Card",
              unitPrice: 77,
              quantity: 1,
              totalAmount: 83.16,
              returned: false,
              contractId: 0,
              expDate: "2027-10-28T00:00:00",
              activeDate: "2026-10-28T00:00:00",
            },
          ],
          payments: [{ id: 77001, amount: 83.16, method: 1, type: "Cash", transactionId: 555 }],
        },
      },
    ]);
  });

  it("invents no field: every output key exists on its spec model", async () => {
    const client = purchasesClient([RECORD]);
    const [purchase] = (await getClientPurchasesTool("c-1", { startDate: "2026-10-28", endDate: "2026-10-28" }, client, client.cache)).purchases;
    const pascal = (k: string) => k[0].toUpperCase() + k.slice(1);
    const has = (model: string, obj: object) =>
      expect(Object.keys(obj).map(pascal).filter((k) => !props(model).includes(k))).toEqual([]);

    has("ClientPurchaseRecord", purchase);
    has("Sale", purchase.sale!);
    has("PurchasedItem", purchase.sale!.purchasedItems[0]);
    has("SalePayment", purchase.sale!.payments[0]);
  });

  it("surfaces AccountPayment: true as accountPayment: true", async () => {
    const accountPayment = { ...RECORD, Description: "Account Payment", AccountPayment: true };
    const client = purchasesClient([RECORD, accountPayment]);
    const result = await getClientPurchasesTool("c-1", { startDate: "2026-10-28", endDate: "2026-10-28" }, client, client.cache);
    expect(result.totalPurchases).toBe(2);
    expect(result.purchases[1]).toMatchObject({ description: "Account Payment", accountPayment: true });
  });

  it("saleId narrows the request to that sale and returns one record", async () => {
    const client = purchasesClient([RECORD]);
    const result = await getClientPurchasesTool(
      "c-1",
      { startDate: "2026-10-28", endDate: "2026-10-28", saleId: 100170630 },
      client,
      client.cache
    );
    expect(client.purchaseCalls()[0].params).toMatchObject({ SaleId: 100170630 });
    expect(result.totalPurchases).toBe(1);
    expect(result.purchases[0].sale?.id).toBe(100170630);
  });

  it("an empty result returns no purchases after one call", async () => {
    const client = purchasesClient([]);
    const result = await getClientPurchasesTool("c-1", { startDate: "2026-10-28", endDate: "2026-10-28" }, client, client.cache);
    expect(result).toEqual({ purchases: [], totalPurchases: 0 });
    expect(client.purchaseCalls().length).toBe(1);
  });

  it("refuses an empty clientId before any request", async () => {
    const client = purchasesClient([]);
    await expect(getClientPurchasesTool("", {}, client, client.cache)).rejects.toThrow("clientId");
    expect(client.calls.length).toBe(0);
  });
});
