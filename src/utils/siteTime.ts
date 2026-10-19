/**
 * Site-local time handling.
 *
 * Mindbody returns and accepts every date-time in the SITE's local timezone with
 * no UTC offset (e.g. "2026-10-18T08:00:00"). The process running this server may
 * sit in a different zone (an operator in Hong Kong driving a Los Angeles site),
 * so neither `new Date()`'s local calendar nor `new Date(siteLocalString)` can be
 * trusted. Everything here takes an explicit IANA zone name and does the
 * conversion with `Intl`, independent of the process's own `TZ`.
 *
 * DST disambiguation (matches Temporal's and java.time's "compatible" mode):
 *   - Ambiguous wall time (fall back; e.g. 2026-11-01T01:30 in Los Angeles occurs
 *     twice) resolves to the EARLIER instant, i.e. the pre-transition offset
 *     (01:30 PDT = 08:30Z).
 *   - Nonexistent wall time (spring forward; e.g. 2026-03-08T02:30 in Los Angeles
 *     never happens) is interpreted with the pre-transition offset, which moves it
 *     forward by the gap (02:30 PST = 10:30Z = 03:30 PDT).
 */
import { fetchAllPages, mindbodyClient, type IMindbodyClient } from '../api/client.js';
import { classCache, SimpleCache } from '../cache/index.js';

/** Cache key shared with `getSitesTool`, so there is one cached site record. */
export const SITE_INFO_CACHE_KEY = 'site-info';
const SITE_INFO_TTL_MINUTES = 60;

/** Optional operator override, used only when the API gives no usable zone. */
export const SITE_TIMEZONE_ENV = 'MINDBODY_SITE_TIMEZONE';

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Site record ──────────────────────────────────────────────────────────────

/**
 * Every site GET /site/sites returns, as `{ Sites }`, cached for 60 minutes under
 * 'site-info' (suffixed with the site id when one is known). The single source of
 * truth for the site record: `getSitesTool` and `getSiteTimeZone` both resolve
 * THE site from it through `selectSite`, never by taking `Sites[0]` blindly.
 *
 * /site/sites is paginated in docs/openapi.json, so it is read through
 * `fetchAllPages` like every other paged endpoint (Gate 13), rather than with a
 * single `Limit: 1` GET.
 */
export async function fetchSiteInfo(
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache,
  siteId?: string | number
): Promise<{ Sites: any[] }> {
  const wanted = siteId !== undefined ? String(siteId) : configuredSiteId();
  const cacheKey = wanted === undefined ? SITE_INFO_CACHE_KEY : `${SITE_INFO_CACHE_KEY}:${wanted}`;
  let cached = cache.get<{ Sites: any[] }>(cacheKey);
  if (!cached) {
    // `request.siteIds` pins the lookup to the configured/requested site, so a
    // multi-site API key does not hand back a neighbour's record. The response
    // is still run through `selectSite`, which refuses ambiguity if the server
    // ignores the filter.
    const params = wanted === undefined ? {} : { SiteIds: [wanted] };
    const { items: sites } = await fetchAllPages<any>(client, '/site/sites', params, 'Sites');
    cached = { Sites: sites };
    cache.set(cacheKey, cached, SITE_INFO_TTL_MINUTES);
  }
  return cached;
}

// ── Site selection (multi-site API keys) ─────────────────────────────────────

/** Env var every request already carries as the `SiteId` header. */
export const SITE_ID_ENV = 'MINDBODY_SITE_ID';

/** `MINDBODY_SITE_ID` as configured, or undefined when unset/blank. */
export function configuredSiteId(): string | undefined {
  const value = process.env[SITE_ID_ENV]?.trim();
  return value ? value : undefined;
}

export interface SiteSummary {
  id: number;
  name: string;
}

/**
 * Thrown when the site record cannot be resolved to exactly ONE site. Carries
 * the sites the key can reach so a caller can tell the operator what to pick.
 */
export class SiteSelectionError extends Error {
  readonly availableSites: SiteSummary[];
  constructor(message: string, availableSites: SiteSummary[]) {
    super(message);
    this.name = 'SiteSelectionError';
    this.availableSites = availableSites;
  }
}

function summarise(sites: any[]): SiteSummary[] {
  return sites.map((s) => ({ id: Number(s?.Id), name: String(s?.Name ?? '') }));
}

/**
 * Pick THE site from a /site/sites result. Policy (operator decision): when the
 * API key reaches more than one site, return nothing unless a site was chosen,
 * either explicitly (`requestedSiteId`) or by the configured default
 * (`MINDBODY_SITE_ID`). Never silently take `Sites[0]`.
 */
export function selectSite(sites: unknown, requestedSiteId?: string | number): any {
  const list = Array.isArray(sites) ? sites : [];
  const available = summarise(list);
  if (list.length === 0) {
    throw new SiteSelectionError('GET /site/sites returned no site for this API key', available);
  }

  const wanted = requestedSiteId !== undefined ? String(requestedSiteId) : configuredSiteId();
  if (wanted !== undefined) {
    const matches = list.filter((s) => String(s?.Id) === wanted);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new SiteSelectionError(
        `GET /site/sites returned site ${wanted} ${matches.length} times; refusing ambiguous data`,
        available
      );
    }
    throw new SiteSelectionError(
      `site ${wanted} is not among the ${list.length} site(s) this API key can reach ` +
        `(${available.map((s) => s.id).join(', ')}); check ${SITE_ID_ENV} or pass siteId`,
      available
    );
  }

  if (list.length === 1) return list[0];
  throw new SiteSelectionError(
    `this API key reaches ${list.length} sites (${available.map((s) => s.id).join(', ')}) and no site ` +
      `was specified; set ${SITE_ID_ENV} or pass siteId explicitly`,
    available
  );
}

/** The one site this server is operating on, or a SiteSelectionError. */
export async function getSelectedSite(
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache,
  siteId?: string | number
): Promise<any> {
  const info = await fetchSiteInfo(client, cache, siteId);
  return selectSite(info.Sites, siteId);
}

/** True when `timeZone` is a non-empty zone name `Intl` accepts. */
export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone }).resolvedOptions();
    return true;
  } catch {
    return false;
  }
}

/** Throw a RangeError unless `timeZone` is a valid IANA zone name. */
export function assertTimeZone(timeZone: unknown): asserts timeZone is string {
  if (!isValidTimeZone(timeZone)) {
    throw new RangeError(`Invalid IANA time zone: ${JSON.stringify(timeZone)}`);
  }
}

/** `zone` is set when the record has a usable one; `unreachable` when the site could not be resolved at all. */
async function zoneFromApi(
  client: IMindbodyClient,
  cache: SimpleCache
): Promise<{ zone?: string; problem?: string; unreachable?: boolean }> {
  try {
    const site = await getSelectedSite(client, cache);
    const zone = site?.TimeZone;
    if (isValidTimeZone(zone)) return { zone };
    return { problem: `site record has no usable TimeZone (got ${JSON.stringify(zone)})` };
  } catch (error: any) {
    return { problem: `site lookup failed: ${error?.message ?? 'unknown error'}`, unreachable: true };
  }
}

/**
 * `MINDBODY_SITE_TIMEZONE` never overrides a site we could not resolve: that
 * includes the multi-site refusal from `selectSite`, so it cannot turn a
 * fail-closed refusal into a write. It stands in only for a reachable record
 * with no usable zone. `strict` (write paths) also refuses an override that
 * disagrees with the record's zone, since a wrong zone shifts every now-comparison.
 */
async function resolveSiteTimeZone(client: IMindbodyClient, cache: SimpleCache, strict: boolean): Promise<string> {
  const { zone, problem, unreachable } = await zoneFromApi(client, cache);
  const override = process.env[SITE_TIMEZONE_ENV];
  const hasOverride = override !== undefined && override !== '';

  if (zone) {
    if (strict && hasOverride && override.toLowerCase() !== zone.toLowerCase()) {
      throw new Error(
        `Refusing to proceed: ${SITE_TIMEZONE_ENV}=${JSON.stringify(override)} disagrees with the site record's TimeZone ${JSON.stringify(zone)}; fix or unset ${SITE_TIMEZONE_ENV}`
      );
    }
    return zone;
  }
  if (unreachable) throw new Error(`Cannot determine the site timezone: ${problem}`);

  if (hasOverride) {
    if (isValidTimeZone(override)) return override;
    throw new Error(
      `Cannot determine the site timezone: ${problem}, and ${SITE_TIMEZONE_ENV}=${JSON.stringify(override)} is not a valid IANA zone`
    );
  }
  throw new Error(`Cannot determine the site timezone: ${problem}, and ${SITE_TIMEZONE_ENV} is not set`);
}

/**
 * The site's IANA timezone for WRITE guards (both callers cancel things).
 * Source: the cached GET /site/sites record. `MINDBODY_SITE_TIMEZONE` is used
 * only when the record is reachable but has no usable zone; it is refused when
 * it disagrees with a usable record zone, and never consulted when the site
 * lookup fails (including an ambiguous multi-site key). Throws in all those cases.
 */
export async function getSiteTimeZone(
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache
): Promise<string> {
  return resolveSiteTimeZone(client, cache, true);
}

let warnedUtcFallback = false;

/** Test hook: re-arm the one-time UTC fallback warning. */
export function resetSiteTimeWarningForTests(): void {
  warnedUtcFallback = false;
}

/**
 * Site zone for READ defaults. Reads must not hard-fail, so an unresolvable
 * zone falls back to UTC with a single `console.error` warning per process.
 */
export async function resolveReadTimeZone(
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache
): Promise<string> {
  try {
    // Lenient: a read cannot write, so the record's zone wins over a disagreeing override.
    return await resolveSiteTimeZone(client, cache, false);
  } catch (error: any) {
    if (!warnedUtcFallback) {
      warnedUtcFallback = true;
      console.error(`[siteTime] ${error?.message ?? error}; using UTC for default date ranges.`);
    }
    return 'UTC';
  }
}

/**
 * Default date window in site-local calendar dates. `days >= 0` gives
 * [today, today + days]; `days < 0` gives [today + days, today].
 */
export async function defaultDateRange(
  days: number,
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache,
  now: Date = new Date()
): Promise<{ start: string; end: string }> {
  const timeZone = await resolveReadTimeZone(client, cache);
  const today = siteDateString(now, timeZone);
  const other = siteDateStringPlusDays(now, timeZone, days);
  return days >= 0 ? { start: today, end: other } : { start: other, end: today };
}

/**
 * Caller-supplied dates pass through unchanged; a missing one is filled from
 * `defaultDateRange(days)`. The site zone is only resolved when a default is
 * actually needed, so fully explicit calls make no extra request.
 */
export async function withDefaultDates(
  startDate: string | undefined,
  endDate: string | undefined,
  days: number,
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache
): Promise<{ start: string; end: string }> {
  if (startDate && endDate) return { start: startDate, end: endDate };
  const defaults = await defaultDateRange(days, client, cache);
  return { start: startDate || defaults.start, end: endDate || defaults.end };
}

// ── Pure conversions ─────────────────────────────────────────────────────────

interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    assertTimeZone(timeZone);
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Wall-clock fields at instant `ms` in `timeZone`. */
function wallTimeAt(ms: number, timeZone: string): WallTime {
  const fields: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(ms)) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value);
  }
  return {
    year: fields.year,
    month: fields.month,
    day: fields.day,
    // Some engines render midnight as 24 even with h23.
    hour: fields.hour === 24 ? 0 : fields.hour,
    minute: fields.minute,
    second: fields.second,
  };
}

function wallAsUtcMs(wall: WallTime): number {
  const ms = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  // Date.UTC maps years 0..99 to 1900..1999; pin the real year.
  return wall.year < 100 ? new Date(ms).setUTCFullYear(wall.year) : ms;
}

/** Zone offset (wall minus UTC, in ms) in effect at instant `ms`. */
function offsetAt(ms: number, timeZone: string): number {
  const wholeSecond = Math.floor(ms / 1000) * 1000;
  return wallAsUtcMs(wallTimeAt(wholeSecond, timeZone)) - wholeSecond;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** "YYYY-MM-DDTHH:mm:ss" for instant `ms` at the site. Throws on invalid input. */
export function epochMsToSiteLocal(ms: number, timeZone: string): string {
  assertTimeZone(timeZone);
  if (!Number.isFinite(ms)) throw new RangeError(`Invalid epoch milliseconds: ${ms}`);
  const w = wallTimeAt(ms, timeZone);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`;
}

/** The calendar date at the site at instant `now`, as YYYY-MM-DD. */
export function siteDateString(now: Date, timeZone: string): string {
  return epochMsToSiteLocal(now.getTime(), timeZone).slice(0, 10);
}

/** The site calendar date `days` calendar days after (or before) today. */
export function siteDateStringPlusDays(now: Date, timeZone: string, days: number): string {
  if (!Number.isInteger(days)) throw new RangeError(`days must be an integer (got ${days})`);
  const [year, month, day] = siteDateString(now, timeZone).split('-').map(Number);
  // Calendar arithmetic in UTC, so the host zone's DST cannot shift the date.
  const shifted = new Date(wallAsUtcMs({ year, month, day, hour: 0, minute: 0, second: 0 }) + days * DAY_MS);
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

const LOCAL_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?$/i;

interface ParsedLocal {
  wall: WallTime;
  fractionMs: number;
  /** Explicit offset in ms (wall minus UTC), when the string carried one. */
  explicitOffsetMs?: number;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeap(year) ? 29 : DAYS_IN_MONTH[month - 1];
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function parseOffset(token: string | undefined): number | undefined {
  if (token === undefined) return undefined;
  if (token.toUpperCase() === 'Z') return 0;
  const digits = token.slice(1).replace(':', '');
  const hours = Number(digits.slice(0, 2));
  const minutes = Number(digits.slice(2, 4));
  if (hours > 23 || minutes > 59) return Number.NaN;
  return (token[0] === '-' ? -1 : 1) * (hours * 60 + minutes) * 60 * 1000;
}

function parseLocal(input: string): ParsedLocal | null {
  const match = LOCAL_DATE_TIME.exec(input.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s, frac, offset] = match;
  const wall: WallTime = {
    year: Number(y), month: Number(mo), day: Number(d),
    hour: Number(h), minute: Number(mi), second: s === undefined ? 0 : Number(s),
  };
  const inRange =
    wall.month >= 1 && wall.month <= 12 &&
    wall.day >= 1 && wall.day <= daysInMonth(wall.year, wall.month) &&
    wall.hour <= 23 && wall.minute <= 59 && wall.second <= 59;
  const explicitOffsetMs = parseOffset(offset);
  if (!inRange || Number.isNaN(explicitOffsetMs)) return null;
  const fractionMs = frac === undefined ? 0 : Math.floor(Number(`0.${frac}`) * 1000);
  return { wall, fractionMs, explicitOffsetMs };
}

/** The UTC instant of wall time `naiveMs` (wall-as-UTC) in `timeZone`. */
function resolveWallTime(naiveMs: number, timeZone: string): number {
  const before = offsetAt(naiveMs - DAY_MS, timeZone);
  const after = offsetAt(naiveMs + DAY_MS, timeZone);
  // Every offset that maps back to this exact wall time is a valid reading.
  const valid = [before, after]
    .map((offset) => naiveMs - offset)
    .filter((candidate) => naiveMs - offsetAt(candidate, timeZone) === candidate);
  if (valid.length > 0) return Math.min(...valid); // ambiguous => earlier instant
  return naiveMs - before; // nonexistent => pre-transition offset (shift forward)
}

/**
 * Parse a Mindbody site-local date-time ("YYYY-MM-DDTHH:mm:ss", optionally with
 * fractional seconds) into epoch ms. A trailing `Z` or `±hh:mm` is respected as
 * given. Returns NaN for unparseable input; throws on an invalid zone.
 */
export function siteLocalToEpochMs(localDateTime: string, timeZone: string): number {
  assertTimeZone(timeZone);
  if (typeof localDateTime !== 'string') return Number.NaN;
  const parsed = parseLocal(localDateTime);
  if (!parsed) return Number.NaN;
  const naiveMs = wallAsUtcMs(parsed.wall);
  const instant =
    parsed.explicitOffsetMs !== undefined
      ? naiveMs - parsed.explicitOffsetMs
      : resolveWallTime(naiveMs, timeZone);
  return instant + parsed.fractionMs;
}
