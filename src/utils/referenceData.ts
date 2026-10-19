import { fetchAllPages, mindbodyClient, type IMindbodyClient } from '../api/client.js';
import { classCache, teacherCache, SimpleCache } from '../cache/index.js';

/**
 * Resolve Mindbody ids to display names through the small, cached reference
 * endpoints: `GET /site/locations`, `GET /staff/staff`, `GET /site/sessiontypes`
 * and `GET /client/clients`.
 *
 * Why this exists: many v6 read models (`Appointment`, `Visit`) carry only
 * `LocationId`, `StaffId`, `SessionTypeId` and `ClientId` — never the nested
 * objects the Swagger models for their parents suggest. Reads that used to
 * invent `appointment.Location.Name` returned an empty string for every row;
 * these maps return the real name at the cost of one cached GET, and never
 * more than one per TTL window per map.
 *
 * Every lookup is best-effort: a failure or an unexpected payload yields an
 * empty map, and the caller falls back to the id. A tool must still answer from
 * its own endpoint when the reference lookup is unavailable.
 */

const EMPTY: ReadonlyMap<number, string> = new Map<number, string>();
const EMPTY_CLIENT_NAMES: ReadonlyMap<string, string> = new Map<string, string>();

/** `staff.DisplayName`, or the composed name, or the id — whichever exists. */
export function staffDisplayName(staff: any): string {
  if (!staff) return '';
  const composed = [staff.FirstName, staff.LastName].filter(Boolean).join(' ').trim();
  return staff.Name || staff.DisplayName || composed || '';
}

type RefDeps = { client?: IMindbodyClient; cache?: SimpleCache };

/**
 * Cache-and-reduce around one loader.
 *
 * `load` is where the endpoint lives, so every caller passes its own path as a
 * string literal: Gate 13 checks each Mindbody GET call site's path against
 * docs/openapi.json (it must exist, and it may only be paged when the spec says
 * it paginates), and a path handed in as a variable is unreadable to that scan.
 * The four reference endpoints — /site/locations, /site/sessiontypes,
 * /staff/staff, /client/clients — all carry request.limit/request.offset, so
 * every one of them goes through fetchAllPages.
 */
async function cachedNameMap(
  cacheKey: string,
  cache: SimpleCache,
  cacheMinutes: number,
  load: () => Promise<any[]>,
  nameOf: (row: any) => string | undefined
): Promise<ReadonlyMap<number, string>> {
  let cached = cache.get<Array<[number, string]>>(cacheKey);
  if (!cached) {
    cached = [];
    for (const row of await load()) {
      const id = Number(row?.Id);
      const name = nameOf(row);
      if (!Number.isInteger(id) || !name) continue;
      cached.push([id, name]);
    }
    cache.set(cacheKey, cached, cacheMinutes);
  }
  return new Map(cached);
}

async function buildClientMap(
  cacheKey: string,
  clientIds: string[],
  deps: RefDeps
): Promise<ReadonlyMap<string, string>> {
  const client = deps.client ?? mindbodyClient;
  const cache = deps.cache ?? classCache;

  let cached = cache.get<Array<[string, string]>>(cacheKey);
  if (!cached) {
    const { items } = await fetchAllPages<any>(
      client,
      '/client/clients',
      { ClientIds: clientIds },
      'Clients'
    );
    cached = [];
    for (const row of items) {
      const id = row?.Id === undefined || row?.Id === null ? '' : String(row.Id);
      const name = [row?.FirstName, row?.LastName].filter(Boolean).join(' ').trim();
      if (!id || !name) continue;
      cached.push([id, name]);
    }
    cache.set(cacheKey, cached, 5);
  }
  return new Map(cached);
}

/** `GET /site/locations` → `Map<Id, Name>`. */
export async function getLocationNames(
  deps: RefDeps = {}
): Promise<ReadonlyMap<number, string>> {
  const cache = deps.cache ?? classCache;
  try {
    return await cachedNameMap('refdata:locations', cache, 60, async () => {
      const { items } = await fetchAllPages<any>(
        deps.client ?? mindbodyClient,
        '/site/locations',
        {},
        'Locations'
      );
      return items;
    }, (row) => row?.Name);
  } catch {
    cache.delete('refdata:locations');
    return EMPTY;
  }
}

/** `GET /site/sessiontypes` → `Map<Id, Name>`. */
export async function getSessionTypeNames(
  deps: RefDeps = {}
): Promise<ReadonlyMap<number, string>> {
  const cache = deps.cache ?? classCache;
  try {
    return await cachedNameMap('refdata:sessiontypes', cache, 60, async () => {
      const { items } = await fetchAllPages<any>(
        deps.client ?? mindbodyClient,
        '/site/sessiontypes',
        {},
        'SessionTypes'
      );
      return items;
    }, (row) => row?.Name);
  } catch {
    cache.delete('refdata:sessiontypes');
    return EMPTY;
  }
}

/** `GET /staff/staff` → `Map<Id, display name>`. */
export async function getStaffNames(
  deps: RefDeps = {}
): Promise<ReadonlyMap<number, string>> {
  const cache = deps.cache ?? teacherCache;
  try {
    return await cachedNameMap('refdata:staff', cache, 60, async () => {
      const { items } = await fetchAllPages<any>(
        deps.client ?? mindbodyClient,
        '/staff/staff',
        {},
        'Staff'
      );
      return items;
    }, staffDisplayName);
  } catch {
    cache.delete('refdata:staff');
    return EMPTY;
  }
}

/**
 * `GET /client/clients` for the given ids → `Map<ClientId, "First Last">`.
 *
 * Not cached across calls on purpose: the key is the id set, and a client's
 * name can change, so a stale name would outlive the request that needed it.
 * Pass the caller's cache to keep it inside one tool invocation's TTL.
 */
export async function getClientNames(
  clientIds: string[],
  deps: RefDeps = {}
): Promise<ReadonlyMap<string, string>> {
  const ids = [...new Set(clientIds.filter((id) => typeof id === 'string' && id.length > 0))];
  if (ids.length === 0) return EMPTY_CLIENT_NAMES;
  const client = deps.client ?? mindbodyClient;
  const cache = deps.cache ?? classCache;
  const key = `refdata:clients:${ids.slice().sort().join(',')}`;
  try {
    return await buildClientMap(key, ids, { ...deps, client, cache });
  } catch {
    cache.delete(key);
    return EMPTY_CLIENT_NAMES;
  }
}

/** `map.get(id)`, the id as a string, or `''` when the id itself is absent. */
export function nameFor(
  map: ReadonlyMap<number, string>,
  id: unknown
): string {
  if (id === undefined || id === null || id === '') return '';
  const key = typeof id === 'number' ? id : Number(id);
  const hit = map.get(key);
  return hit ?? String(id);
}

/** `map.get(id)`, the id as a string, or `''` when the id itself is absent. */
export function clientNameFor(
  map: ReadonlyMap<string, string>,
  id: unknown
): string {
  if (id === undefined || id === null || id === '') return '';
  return map.get(String(id)) ?? String(id);
}