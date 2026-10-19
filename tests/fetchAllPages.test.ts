import { describe, expect, it } from "bun:test";
import type { AxiosRequestConfig } from "axios";
import { DEFAULT_PAGE_SIZE, MAX_PAGES, fetchAllPages, type IMindbodyClient } from "../src/api/client.js";

/** What the mock server puts in `PaginationResponse`. */
type PaginationMode =
  | "full" //                  RequestedLimit (as served), RequestedOffset, PageSize, TotalResults
  | "echo-requested-limit" //  as "full", but RequestedLimit echoes what was ASKED, not what was served
  | "no-total" //              RequestedLimit (as served), RequestedOffset, PageSize — no TotalResults
  | "no-total-echo" //         as "no-total", but RequestedLimit echoes what was asked
  | "none"; //                 no PaginationResponse at all

interface MockOptions {
  /** Rows the server holds. */
  total: number;
  /** Server-side ceiling on rows per page, regardless of the Limit asked for. */
  serverCap?: number;
  pagination?: PaginationMode;
  /** Serve page one for every request, whatever Offset says. */
  ignoreOffset?: boolean;
  /** List key the rows are returned under. */
  key?: string;
  /** Rows served past this many are dropped: later pages come back empty although TotalResults still promises them. */
  rowsAvailable?: number;
  /** TotalResults to report instead of the true row count. */
  reportedTotal?: number;
}

/** A paging Mindbody list endpoint over `total` rows `{ Id: 1..total }`. */
class PagingServer implements IMindbodyClient {
  readonly calls: Array<{ url: string; params: Record<string, unknown> }> = [];
  private readonly rows: Array<{ Id: number }>;

  constructor(private readonly options: MockOptions) {
    this.rows = Array.from({ length: options.rowsAvailable ?? options.total }, (_, i) => ({ Id: i + 1 }));
  }

  async request<T>(): Promise<T> {
    throw new Error("request() is not used by fetchAllPages");
  }

  async post<T>(): Promise<T> {
    throw new Error("post() is not used by fetchAllPages");
  }

  async get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    const params = (config?.params ?? {}) as Record<string, unknown>;
    this.calls.push({ url, params });
    const asked = Number(params.Limit ?? 100);
    const served = Math.min(asked, this.options.serverCap ?? Infinity);
    const offset = this.options.ignoreOffset ? 0 : Number(params.Offset ?? 0);
    const page = this.rows.slice(offset, offset + served);
    const mode = this.options.pagination ?? "full";
    const body: Record<string, unknown> = { [this.options.key ?? "Things"]: page };
    const echoed = mode === "echo-requested-limit" || mode === "no-total-echo" ? asked : served;
    if (mode !== "none") {
      body.PaginationResponse = {
        RequestedLimit: echoed,
        RequestedOffset: offset,
        PageSize: page.length,
        ...(mode === "full" || mode === "echo-requested-limit" ? { TotalResults: this.options.reportedTotal ?? this.options.total } : {}),
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

describe("fetchAllPages — constants", () => {
  it("defaults to a page size of 200 and caps a walk at 100 pages", () => {
    expect(DEFAULT_PAGE_SIZE).toBe(200);
    expect(MAX_PAGES).toBe(100);
  });
});

describe("fetchAllPages — multi-page with TotalResults", () => {
  it("walks every page, sends Limit=pageSize, advances Offset by rows received, keeps caller params", async () => {
    const server = new PagingServer({ total: 450 });
    const { items, totalResults } = await fetchAllPages<{ Id: number }>(
      server, "/sale/products", { SearchText: "mat", LocationId: 1 }, "Things"
    );
    expect(ids(items)).toEqual(range(450));
    expect(totalResults).toBe(450);
    expect(server.offsets).toEqual([0, 200, 400]);
    expect(server.limits).toEqual([200, 200, 200]);
    for (const call of server.calls) {
      expect(call.url).toBe("/sale/products");
      expect(call.params.SearchText).toBe("mat");
      expect(call.params.LocationId).toBe(1);
    }
  });

  it("stops after exactly one GET when the first page already holds TotalResults rows", async () => {
    const server = new PagingServer({ total: 200 });
    const { items } = await fetchAllPages<{ Id: number }>(server, "/x", {}, "Things");
    expect(items).toHaveLength(200);
    expect(server.calls).toHaveLength(1);
  });

  it("honours a caller page size above 200 (the live API does not cap at 200)", async () => {
    // Observed on the -99 sandbox: Limit=500 gave RequestedLimit 500, PageSize 141, TotalResults 141.
    const server = new PagingServer({ total: 141 });
    const { items, totalResults } = await fetchAllPages<{ Id: number }>(server, "/x", {}, "Things", 500);
    expect(items).toHaveLength(141);
    expect(totalResults).toBe(141);
    expect(server.limits).toEqual([500]);
  });

  it("collects rows from every listed key", async () => {
    const pages = [
      { A: [{ Id: 1 }], B: [{ Id: 2 }], PaginationResponse: { TotalResults: 4 } },
      { A: [{ Id: 3 }], B: [{ Id: 4 }], PaginationResponse: { TotalResults: 4 } },
    ];
    const client: IMindbodyClient = {
      request: async () => { throw new Error("unused"); },
      post: async () => { throw new Error("unused"); },
      get: async <T,>(_url: string, config?: AxiosRequestConfig) => pages[Number(config?.params?.Offset) / 2] as T,
    };
    const { items } = await fetchAllPages<{ Id: number }>(client, "/x", {}, ["A", "B"]);
    expect(ids(items)).toEqual([1, 2, 3, 4]);
  });

  it("hands every raw page to onPage, in order", async () => {
    const server = new PagingServer({ total: 5 });
    const seen: unknown[] = [];
    await fetchAllPages(server, "/x", {}, "Things", 2, { onPage: (page) => seen.push(page.PaginationResponse.RequestedOffset) });
    expect(seen).toEqual([0, 2, 4]);
  });
});

describe("fetchAllPages — server caps Limit at 100 while we ask for 200", () => {
  it("still fetches everything when TotalResults is reported", async () => {
    const server = new PagingServer({ total: 350, serverCap: 100 });
    const { items, totalResults } = await fetchAllPages<{ Id: number }>(server, "/x", {}, "Things");
    expect(ids(items)).toEqual(range(350));
    expect(totalResults).toBe(350);
    expect(server.offsets).toEqual([0, 100, 200, 300]);
    expect(server.limits).toEqual([200, 200, 200, 200]);
  });

  it("still fetches everything when RequestedLimit echoes 200 although 100 were served", async () => {
    const server = new PagingServer({ total: 350, serverCap: 100, pagination: "echo-requested-limit" });
    const { items } = await fetchAllPages<{ Id: number }>(server, "/x", {}, "Things");
    expect(ids(items)).toEqual(range(350));
  });

  it("still fetches everything without TotalResults, RequestedLimit reporting the cap", async () => {
    const server = new PagingServer({ total: 350, serverCap: 100, pagination: "no-total" });
    const { items, totalResults } = await fetchAllPages<{ Id: number }>(server, "/x", {}, "Things");
    expect(ids(items)).toEqual(range(350));
    expect(totalResults).toBe(350);
    // 100 + 100 + 100 + 50: the short fourth page ends the walk.
    expect(server.offsets).toEqual([0, 100, 200, 300]);
  });

  it("still fetches everything without TotalResults even when RequestedLimit echoes 200 (silent cap)", async () => {
    // The trap the old loop fell into: page one is 100 < 200, so it stopped there.
    const server = new PagingServer({ total: 350, serverCap: 100, pagination: "no-total-echo" });
    const { items } = await fetchAllPages<{ Id: number }>(server, "/x", {}, "Things");
    expect(ids(items)).toEqual(range(350));
    expect(server.offsets).toEqual([0, 100, 200, 300]);
  });
});

describe("fetchAllPages — no PaginationResponse", () => {
  it("walks until a short page, using the first page's length as the page size", async () => {
    const server = new PagingServer({ total: 450, pagination: "none" });
    const { items, totalResults } = await fetchAllPages<{ Id: number }>(server, "/x", {}, "Things");
    expect(ids(items)).toEqual(range(450));
    expect(totalResults).toBe(450);
    expect(server.offsets).toEqual([0, 200, 400]);
  });

  it("walks until an empty page when the data ends on a page boundary", async () => {
    const server = new PagingServer({ total: 400, pagination: "none" });
    const { items } = await fetchAllPages<{ Id: number }>(server, "/x", {}, "Things");
    expect(items).toHaveLength(400);
    expect(server.offsets).toEqual([0, 200, 400]);
  });

  it("handles a silent cap with no metadata at all", async () => {
    const server = new PagingServer({ total: 250, serverCap: 100, pagination: "none" });
    const { items } = await fetchAllPages<{ Id: number }>(server, "/x", {}, "Things");
    expect(ids(items)).toEqual(range(250));
  });
});

describe("fetchAllPages — empty", () => {
  it("returns no items and TotalResults 0 from an empty first page", async () => {
    const server = new PagingServer({ total: 0 });
    expect(await fetchAllPages(server, "/x", {}, "Things")).toEqual({ items: [], totalResults: 0 });
    expect(server.calls).toHaveLength(1);
  });

  it("returns no items when the list key is absent and there is no PaginationResponse", async () => {
    const server = new PagingServer({ total: 3, pagination: "none", key: "Other" });
    expect(await fetchAllPages(server, "/x", {}, "Things")).toEqual({ items: [], totalResults: 0 });
    expect(server.calls).toHaveLength(1);
  });
});

describe("fetchAllPages — fails loudly instead of truncating or looping", () => {
  it("succeeds at exactly MAX_PAGES pages", async () => {
    const server = new PagingServer({ total: MAX_PAGES });
    const { items } = await fetchAllPages<{ Id: number }>(server, "/x", {}, "Things", 1);
    expect(items).toHaveLength(MAX_PAGES);
    expect(server.calls).toHaveLength(MAX_PAGES);
  });

  it("throws, naming the path and the count, when a walk needs more than MAX_PAGES pages", async () => {
    const server = new PagingServer({ total: MAX_PAGES + 1 });
    await expect(fetchAllPages(server, "/sale/products", {}, "Things", 1)).rejects.toThrow(
      `fetchAllPages: GET /sale/products exceeded MAX_PAGES=100 (100 items fetched of TotalResults=101 at Limit=1); refusing to return a truncated result`
    );
    expect(server.calls).toHaveLength(MAX_PAGES);
  });

  it("throws when the cap is hit without TotalResults too", async () => {
    const server = new PagingServer({ total: MAX_PAGES + 5, pagination: "none" });
    await expect(fetchAllPages(server, "/x", {}, "Things", 1)).rejects.toThrow("exceeded MAX_PAGES=100 (100 items fetched at Limit=1)");
  });

  it("throws, not truncates, when TotalResults promises more rows than the server serves", async () => {
    const server = new PagingServer({ total: 450, rowsAvailable: 250 });
    await expect(fetchAllPages(server, "/sale/products", {}, "Things")).rejects.toThrow(
      "fetchAllPages: GET /sale/products returned an empty page at Offset=250 (250 items fetched of TotalResults=450); refusing to return a truncated result"
    );
    expect(server.offsets).toEqual([0, 200, 250]);
  });

  it("throws when TotalResults is 0 beside a non-empty first page, rather than return page one", async () => {
    const server = new PagingServer({ total: 450, reportedTotal: 0 });
    await expect(fetchAllPages(server, "/client/clients", {}, "Things", 2)).rejects.toThrow(
      "fetchAllPages: GET /client/clients returned 2 rows by Offset=0 but reports TotalResults=0; the response is inconsistent, refusing to return it"
    );
    expect(server.calls).toHaveLength(1);
  });

  it("throws when a later page pushes the rows received past TotalResults", async () => {
    const server = new PagingServer({ total: 5, reportedTotal: 3 });
    await expect(fetchAllPages(server, "/x", {}, "Things", 2)).rejects.toThrow("returned 4 rows by Offset=2 but reports TotalResults=3");
    expect(server.offsets).toEqual([0, 2]);
  });

  it("throws on an empty first page when TotalResults is non-zero", async () => {
    const server = new PagingServer({ total: 3, rowsAvailable: 0 });
    await expect(fetchAllPages(server, "/x", {}, "Things")).rejects.toThrow("0 items fetched of TotalResults=3");
  });

  it("throws when the server ignores Offset and repeats page one (with TotalResults)", async () => {
    const server = new PagingServer({ total: 450, ignoreOffset: true });
    await expect(fetchAllPages(server, "/class/classes", {}, "Things")).rejects.toThrow(
      "fetchAllPages: GET /class/classes returned the same first item at Offset=200 as on the previous page; the server appears to ignore Offset (200 items fetched before the repeat)"
    );
    expect(server.calls).toHaveLength(2);
  });

  it("throws when the server ignores Offset and there is no PaginationResponse", async () => {
    const server = new PagingServer({ total: 1, pagination: "none", ignoreOffset: true });
    await expect(fetchAllPages(server, "/x", {}, "Things")).rejects.toThrow("appears to ignore Offset");
    expect(server.calls).toHaveLength(2);
  });

  it("rejects a non-positive or fractional page size before any request", async () => {
    const server = new PagingServer({ total: 3 });
    await expect(fetchAllPages(server, "/x", {}, "Things", 0)).rejects.toThrow(RangeError);
    await expect(fetchAllPages(server, "/x", {}, "Things", 1.5)).rejects.toThrow(RangeError);
    expect(server.calls).toHaveLength(0);
  });

  it("propagates a request failure", async () => {
    const client: IMindbodyClient = {
      request: async () => { throw new Error("unused"); },
      post: async () => { throw new Error("unused"); },
      get: async () => { throw new Error("Mindbody API Error: down (Code: 500)"); },
    };
    await expect(fetchAllPages(client, "/x", {}, "Things")).rejects.toThrow("down");
  });
});
