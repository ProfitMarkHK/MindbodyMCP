/**
 * ID → display-name cross-references.
 *
 * Several Mindbody list endpoints (`Appointment`, `Visit`, `Class`) carry only
 * foreign keys — `SessionTypeId`, `LocationId`, `StaffId` — and no embedded
 * object to read a name from. Rather than invent a field the API does not
 * return, the tools resolve those keys here against the three documented
 * catalogue endpoints (`/site/sessiontypes`, `/site/locations`, `/staff/staff`),
 * which this repo already reads and caches.
 *
 * Contracts, so callers can report honestly:
 *  - a name is `undefined` when the catalogue does not contain that id. Callers
 *    surface the id as well, so a caller can always tell "no such id" from
 *    "we never learned the name";
 *  - a catalogue read that fails is logged once per process and treated as an
 *    empty index, so a secondary lookup can never fail an otherwise-good read.
 *    This mirrors `resolveReadTimeZone`'s fail-open-to-UTC in `utils/siteTime.ts`.
 */
import { fetchAllPages, mindbodyClient, type IMindbodyClient } from '../api/client.js';
import { classCache, SimpleCache } from '../cache/index.js';

/** Catalogue data is stable for an hour, matching the other static caches. */
const TTL_MINUTES = 60;

/** Ids arrive as numbers or as numeric strings from different endpoints. */
function asId(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** First non-empty string among the candidates, or undefined. */
function firstName(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return undefined;
}

const warned = new Set<string>();

function warnOnce(key: string, error: unknown): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.error(
    `[lookups] GET ${key} failed (${(error as any)?.message ?? 'unknown error'}); ` +
      'names for that catalogue will be omitted from tool output.'
  );
}

/**
 * Cache-or-build an id → name index from one already-fetched catalogue page
 * walk. `pick` maps a raw row to its id and name.
 *
 * The three catalogue GETs below call `fetchAllPages` themselves with a literal
 * path, because Gate 13's scanner (tests/pagination-gate.test.ts rule 5) only
 * accepts a resolvable string-literal path at a `fetchAllPages` call site.
 */
async function buildIndex<T>(
  cache: SimpleCache,
  cacheKey: string,
  rows: T[],
  pick: (row: any) => { id: number | undefined; name: string | undefined },
  warnKey: string,
  fetchIt: () => Promise<T[]>
): Promise<Map<number, string>> {
  let cached = cache.get<Map<number, string>>(cacheKey);
  if (cached) return cached;

  const index = new Map<number, string>();
  let source = rows;
  if (source === undefined) {
    try {
      source = await fetchIt();
    } catch (error) {
      warnOnce(warnKey, error);
      return index; // not cached: a later call may succeed
    }
  }
  for (const row of source) {
    const { id, name } = pick(row);
    if (id !== undefined && name !== undefined) index.set(id, name);
  }

  cache.set(cacheKey, index, TTL_MINUTES);
  return index;
}

/** `SessionType.Id` → `SessionType.Name`, from the cached `/site/sessiontypes` list. */
export async function sessionTypeNames(
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache
): Promise<Map<number, string>> {
  return buildIndex<any>(
    cache,
    'session-type-names',
    undefined as unknown as any[],
    (row) => ({ id: asId(row?.Id), name: firstName(row?.Name) }),
    '/site/sessiontypes',
    async () => {
      const { items } = await fetchAllPages<any>(client, '/site/sessiontypes', {}, 'SessionTypes');
      return items;
    }
  );
}

/** `Location.Id` → `Location.Name`, from the cached `/site/locations` list. */
export async function locationNames(
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache
): Promise<Map<number, string>> {
  return buildIndex<any>(
    cache,
    'location-names',
    undefined as unknown as any[],
    (row) => ({ id: asId(row?.Id), name: firstName(row?.Name) }),
    '/site/locations',
    async () => {
      const { items } = await fetchAllPages<any>(client, '/site/locations', {}, 'Locations');
      return items;
    }
  );
}

/** `Staff.Id` → `Staff.Name`, from the cached `/staff/staff` list. */
export async function staffNames(
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache
): Promise<Map<number, string>> {
  return buildIndex<any>(
    cache,
    'staff-names',
    undefined as unknown as any[],
    (row) => ({
      id: asId(row?.Id),
      name: firstName(
        row?.Name,
        row?.DisplayName,
        [row?.FirstName, row?.LastName].filter(Boolean).join(' ')
      ),
    }),
    '/staff/staff',
    async () => {
      const { items } = await fetchAllPages<any>(client, '/staff/staff', {}, 'StaffMembers');
      return items;
    }
  );
}