// ============================================================================
// MANDATORY PAGINATION - fetchAllPages for the Next.js Mindbody client
// ============================================================================
//
// A port of `fetchAllPages` from the MCP server (src/api/client.ts in the repo
// root) with the same semantics, so that Gate 13 (tests/pagination-gate.test.ts)
// can apply one rule to both code bases: every Mindbody GET endpoint that the
// spec paginates (`request.limit` + `request.offset` in docs/openapi.json) MUST
// be read through this function. A single GET silently returns page one as if
// it were the whole list.
//
// Behavioural contract (kept identical to the root implementation):
//   - sends `Limit` = pageSize (default 200) and advances `Offset` by the number
//     of rows actually received, never by `Limit`;
//   - an empty page ends the walk, unless the server reported a `TotalResults`
//     larger than the rows collected so far (then it throws: a truncated read);
//   - when the server reports `PaginationResponse.TotalResults`, keeps going
//     until that many rows are collected (a server that silently caps `Limit`
//     is still read to the end);
//   - without `TotalResults`, stops on the first page shorter than the smaller
//     of `RequestedLimit` and the first page's length;
//   - throws when more rows have been received than `TotalResults` claims
//     (the claim is checked against the rows, never trusted on its own);
//   - throws after MAX_PAGES pages instead of returning a truncated list;
//   - throws when a page's first row repeats the previous page's first row,
//     which means the server is ignoring `Offset` and would loop forever.
//
// Covered by tests/nextjs-paging.test.ts in the repo root (run by `bun test`).

export const DEFAULT_PAGE_SIZE = 200;

/**
 * Hard ceiling on the number of pages one `fetchAllPages` call will request.
 * At the default page size that is 20,000 rows, far beyond any real studio's
 * catalogue, so reaching it means a misbehaving server or a runaway query.
 */
export const MAX_PAGES = 100;

/** The subset of MindbodyApiClient that the pager needs. */
export interface PagedGetClient {
  get<T>(endpoint: string, options?: { params?: Record<string, any> }): Promise<T>;
}

export interface FetchAllPagesOptions {
  /**
   * Called with every raw page response, in order, before its rows are
   * collected. For endpoints that return a second, non-list structure alongside
   * the paged list, so it can be merged across pages instead of being read from
   * page one only.
   */
  onPage?: (page: any) => void;
}

/** A non-negative integer from a PaginationResponse field, or undefined. */
function paginationCount(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * GET every page of a Mindbody list endpoint and return all of its rows.
 *
 * @param client   the HTTP client (MindbodyApiClient or anything with `.get`)
 * @param url      endpoint path, e.g. '/class/classes'
 * @param params   query parameters; `Limit` and `Offset` are set by the pager
 * @param listKeys the response key(s) holding the rows, e.g. 'Classes'
 * @param pageSize rows requested per page (default 200)
 */
export async function fetchAllPages<T>(
  client: PagedGetClient,
  url: string,
  params: Record<string, unknown> = {},
  listKeys: string | string[],
  pageSize: number = DEFAULT_PAGE_SIZE,
  options: FetchAllPagesOptions = {}
): Promise<{ items: T[]; totalResults: number }> {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError(`fetchAllPages: pageSize must be a positive integer, got ${pageSize}`);
  }

  const items: T[] = [];
  const keys = Array.isArray(listKeys) ? listKeys : [listKeys];
  let offset = 0;
  let totalResults: number | undefined;
  let effectivePageSize: number | undefined;
  let previousFirstItem: string | undefined;

  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) {
      const of = totalResults === undefined ? '' : ` of TotalResults=${totalResults}`;
      throw new Error(
        `fetchAllPages: GET ${url} exceeded MAX_PAGES=${MAX_PAGES} ` +
          `(${items.length} items fetched${of} at Limit=${pageSize}); refusing to return a truncated result`
      );
    }

    const response = await client.get<any>(url, {
      params: {
        ...params,
        Limit: pageSize,
        Offset: offset,
      },
    });
    options.onPage?.(response);

    const pageItems: T[] = keys.flatMap((key) => (Array.isArray(response?.[key]) ? response[key] : []));
    const pagination = response?.PaginationResponse;
    const reportedTotal = paginationCount(pagination?.TotalResults);
    if (reportedTotal !== undefined) {
      totalResults = reportedTotal;
    }

    if (pageItems.length === 0) {
      // An empty page ends the walk only when nothing more was promised.
      if (totalResults !== undefined && items.length < totalResults) {
        throw new Error(
          `fetchAllPages: GET ${url} returned an empty page at Offset=${offset} ` +
            `(${items.length} items fetched of TotalResults=${totalResults}); refusing to return a truncated result`
        );
      }
      break;
    }

    const firstItem = JSON.stringify(pageItems[0]);
    if (previousFirstItem !== undefined && firstItem === previousFirstItem) {
      throw new Error(
        `fetchAllPages: GET ${url} returned the same first item at Offset=${offset} as on the previous page; ` +
          `the server appears to ignore Offset (${items.length} items fetched before the repeat)`
      );
    }
    previousFirstItem = firstItem;

    // TotalResults is the server's claim; the rows received are the evidence. More
    // rows than the claim means the claim is wrong (a stale `0` would otherwise end
    // the walk after page one), so refuse the result instead of trusting either.
    if (totalResults !== undefined && items.length + pageItems.length > totalResults) {
      throw new Error(
        `fetchAllPages: GET ${url} returned ${items.length + pageItems.length} rows by Offset=${offset} ` +
          `but reports TotalResults=${totalResults}; the response is inconsistent, refusing to return it`
      );
    }

    items.push(...pageItems);
    offset += pageItems.length;

    if (totalResults !== undefined) {
      if (items.length === totalResults) break;
      continue;
    }

    if (effectivePageSize === undefined) {
      const requestedLimit = paginationCount(pagination?.RequestedLimit);
      effectivePageSize =
        requestedLimit !== undefined && requestedLimit > 0
          ? Math.min(requestedLimit, pageItems.length)
          : pageItems.length;
    }
    if (pageItems.length < effectivePageSize) {
      break;
    }
  }

  return { items, totalResults: totalResults ?? items.length };
}
