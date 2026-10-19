import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { mindbodyAuth } from './auth.js';

export interface IMindbodyClient {
  request<T>(config: AxiosRequestConfig, retries?: number): Promise<T>;
  get<T>(url: string, config?: AxiosRequestConfig): Promise<T>;
  post<T>(url: string, data?: any, config?: AxiosRequestConfig): Promise<T>;
}

class MindbodyApiClient implements IMindbodyClient {
  private client: AxiosInstance;
  private readonly maxRetries = 3;
  private readonly retryDelay = 1000;

  constructor() {
    const apiUrl = process.env.MINDBODY_API_URL || 'https://api.mindbodyonline.com/public/v6';

    this.client = axios.create({
      baseURL: apiUrl,
      timeout: 30000,
    });

    // Add request interceptor to add auth headers
    this.client.interceptors.request.use(async (config) => {
      const headers = await mindbodyAuth.getAuthHeaders();
      Object.assign(config.headers, headers);
      return config;
    });

    // Add response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => response,
      async (error) => {
        if (error.response?.status === 401 && !error.config._retried) {
          // Token might be expired, reset and retry once
          error.config._retried = true;
          mindbodyAuth.resetTokenState();
          const headers = await mindbodyAuth.getAuthHeaders();
          Object.assign(error.config.headers, headers);
          return this.client.request(error.config);
        }
        throw error;
      }
    );
  }

  async request<T>(config: AxiosRequestConfig, retries = 0): Promise<T> {
    try {
      const response = await this.client.request<T>(config);
      return response.data;
    } catch (error: any) {
      if (retries < this.maxRetries && this.shouldRetry(error)) {
        await this.delay(this.retryDelay * Math.pow(2, retries));
        return this.request<T>(config, retries + 1);
      }

      throw this.formatError(error);
    }
  }

  private shouldRetry(error: any): boolean {
    // Retry on network errors or 5xx errors, but NOT on 401/403 auth errors
    if (!error.response) return true;
    return error.response.status >= 500;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private formatError(error: any): Error {
    if (error.response?.data?.Error) {
      const mbError = error.response.data.Error;
      return new Error(`Mindbody API Error: ${mbError.Message} (Code: ${mbError.Code})`);
    }

    if (error.response) {
      const status = error.response.status;
      const statusText = error.response.statusText;
      if (status === 401 || status === 403) {
        return new Error(
          `Mindbody Auth Error (${status}): ${statusText}. ` +
          `Check that your MINDBODY_API_KEY is valid and activated for site ${process.env.MINDBODY_SITE_ID}. ` +
          `If using source credentials, verify MINDBODY_SOURCE_NAME and MINDBODY_SOURCE_PASSWORD are correct.`
        );
      }
      return new Error(`API Error: ${status} - ${statusText}`);
    }

    return new Error(`Network Error: ${error.message}`);
  }

  // Convenience methods
  async get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    return this.request<T>({ ...config, method: 'GET', url });
  }

  async post<T>(url: string, data?: any, config?: AxiosRequestConfig): Promise<T> {
    return this.request<T>({ ...config, method: 'POST', url, data });
  }
}

/** Default `Limit` sent on every page. Callers may override it per call. */
export const DEFAULT_PAGE_SIZE = 200;

/**
 * Hard ceiling on the number of pages one `fetchAllPages` call will request.
 * Reaching it throws rather than returning a truncated list: at the default page
 * size that is 20,000 rows, far beyond any real studio's catalogue, so hitting it
 * means a misbehaving server or a runaway query, never "the data really ends here".
 */
export const MAX_PAGES = 100;

export interface FetchAllPagesOptions {
  /**
   * Called with every raw page response, in order, before its items are
   * collected. For endpoints that return a second, non-list structure alongside
   * the paged list (e.g. `SessionTypeActiveSessionTimes`), so it can be merged
   * across pages instead of being read from page one only.
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
 * Every Mindbody GET that accepts `request.limit`/`request.offset` in
 * docs/openapi.json must be called through this function (enforced by
 * tests/pagination-gate.test.ts, Gate 13).
 *
 * Termination, in order of precedence:
 *   1. An empty page ends the walk, unless the server reported a `TotalResults`
 *      larger than the rows collected so far: that is a truncated read and throws.
 *   2. When the server reports `PaginationResponse.TotalResults`, keep going
 *      until that many rows have been collected. The page length is NOT used as
 *      a stop signal here, so a server that silently caps `Limit` below what we
 *      asked for (200 asked, 100 served) is still read to the end.
 *   3. Without `TotalResults`, stop on the first page shorter than the effective
 *      page size: the smaller of `PaginationResponse.RequestedLimit` (when
 *      present) and the length of the first page. Using the first page's length
 *      as an upper bound is what makes a silent server cap safe here too.
 *      (`PageSize` is not consulted: per the spec it is the number of rows in
 *      that response, i.e. the page length itself, not a cap.)
 *
 * `Offset` advances by the number of rows actually received, never by `Limit`.
 *
 * Fails loudly instead of truncating or looping:
 *   - more than `MAX_PAGES` pages throws, naming the path and the row count;
 *   - an empty page before `TotalResults` rows were collected throws;
 *   - more rows received than `TotalResults` claims throws: the claim is
 *     checked against the rows, never trusted on its own (a `TotalResults: 0`
 *     beside a non-empty first page would otherwise end the walk after page one);
 *   - a page whose first row is identical to the previous page's first row
 *     throws, because the server is ignoring `Offset` and would loop forever.
 */
export async function fetchAllPages<T>(
  client: IMindbodyClient,
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

export const mindbodyClient = new MindbodyApiClient();
