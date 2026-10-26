/**
 * Rendering Mindbody timestamps as the STUDIO sees them.
 *
 * The bug this covers: every page formatted timestamps with
 * `new Date(value).toLocaleString()`. That runs in the VIEWER's browser, so the
 * rendered clock depends on where the viewer happens to be. It reads as though
 * the app is showing the studio's schedule while actually showing the reader's.
 *
 * Two distinct failure modes, both fixed here:
 *
 *   1. A string that carries an explicit offset (`...Z`, `...+09:00`) denotes an
 *      INSTANT. Rendering it without a zone converts it to the viewer's zone, so
 *      a Los Angeles 08:00 class shows as 11:00 PM the previous day in Hong Kong
 *      — the "off by a day" case.
 *   2. A bare date (`1990-05-03`) is parsed by `new Date` as UTC midnight, then
 *      formatted in the viewer's zone, so every viewer west of UTC sees the day
 *      before. Also measured, not theorised — see
 *      tests/nextjs-format-sitetime.test.ts.
 *
 * Mindbody returns and accepts site-local date-times with NO offset
 * (`docs/openapi.json`: Availability.StartDateTime is "in the site local time
 * zone"), which is the third and most common shape: the wall clock in the string
 * is ALREADY the studio's. The correct render for it is to print those fields
 * unchanged — no instant conversion, no zone round-trip, so nothing to get
 * wrong and no DST guesswork.
 *
 * The mechanism is to format the wall clock as if it were UTC. `Intl` then does
 * ordinary locale-aware formatting (weekday names, month names, ordinals) while
 * being handed digits that are already the studio's, so the output cannot depend
 * on the viewer's zone. `timeZone` is used for the two things that genuinely
 * need it: placing an explicitly-offset instant into the studio's zone, and
 * labelling the result (e.g. "PDT") so the displayed time is unambiguous.
 *
 * Pure and synchronous — no React, no API calls — so it is directly testable
 * under the root `bun test` (Gate 1). The zone reaches a component through the
 * `useSiteTimeZone` hook; see nextjs-app/src/hooks/useMindbody.ts.
 */
import { assertTimeZone, isValidTimeZone } from './siteTime';

// ============================================================================
// Parsing
// ============================================================================

/**
 * Accepts every shape Mindbody emits: `YYYY-MM-DD`,
 * `YYYY-MM-DDTHH:mm[:ss[.fraction]]`, each optionally space-separated, each
 * optionally suffixed with `Z` or `±hh[:]mm`.
 */
const SITE_LOCAL_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?$/i;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeap(year) ? 29 : DAYS_IN_MONTH[month - 1];
}

/** Offset in ms (wall minus UTC), or undefined when the string carried none. */
function parseOffset(token: string | undefined): number | undefined {
  if (token === undefined) return undefined;
  if (token.toUpperCase() === 'Z') return 0;
  const digits = token.slice(1).replace(':', '');
  const hours = Number(digits.slice(0, 2));
  const minutes = Number(digits.slice(2, 4));
  if (hours > 23 || minutes > 59) return Number.NaN;
  return (token[0] === '-' ? -1 : 1) * (hours * 60 + minutes) * 60 * 1000;
}

/** Calendar fields exactly as they appear in the string. */
export interface SiteWallClock {
  year: number;
  month: number;
  day: number;
  /** 0–23, or null when the string carried no time of day. */
  hour: number | null;
  minute: number | null;
  second: number | null;
}

interface ParsedSiteValue {
  wall: SiteWallClock;
  /**
   * Set when the string itself pinned an offset. Such a value is an INSTANT, so
   * rendering it in the studio's zone is a real conversion; the naive and
   * bare-date shapes leave this undefined and are printed as-is.
   */
  offsetMs?: number;
}

function parseSiteValue(input: string): ParsedSiteValue | null {
  const match = SITE_LOCAL_PATTERN.exec(input.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s, , offset] = match;

  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = h === undefined ? null : Number(h);
  const minute = mi === undefined ? null : Number(mi);
  const second = s === undefined ? null : Number(s);

  // Roll-over and impossible dates ("2026-13-01", "2026-02-30") are not
  // calendar dates, so they are not rendered as if they were.
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour !== null && (hour > 23 || minute! > 59 || (second ?? 0) > 59)) return null;

  const offsetMs = parseOffset(offset);
  if (offsetMs === undefined) return { wall: { year, month, day, hour, minute, second } };
  if (Number.isNaN(offsetMs)) return null;
  return { wall: { year, month, day, hour, minute, second }, offsetMs };
}

/** Date.UTC maps years 0–99 onto 1900–1999, so pin the real year back. */
function wallAsUtcMs(wall: SiteWallClock): number {
  const ms = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour ?? 0,
    wall.minute ?? 0,
    wall.second ?? 0
  );
  return wall.year < 100 ? new Date(ms).setUTCFullYear(wall.year) : ms;
}

// ============================================================================
// Wall-clock to site zone
// ============================================================================

/**
 * The studio's wall clock for a value that denotes an instant.
 *
 * Without a usable zone there is nothing to convert to, so the instant's own
 * fields are shown unchanged — still better than handing it to the viewer's
 * zone, and the caller can see it is unlabelled.
 */
function wallClockInSiteZone(parsed: ParsedSiteValue, timeZone: string | null | undefined): SiteWallClock {
  if (parsed.offsetMs === undefined || !isValidTimeZone(timeZone)) return parsed.wall;

  const instantMs = wallAsUtcMs(parsed.wall) - parsed.offsetMs;
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instantMs)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  // Some engines render midnight as 24 even under h23.
  const hour = Number(parts.hour);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: hour === 24 ? 0 : hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** The zone name `Intl` reports for an instant, under one `timeZoneName` style. */
function zoneNameFor(instantMs: number, timeZone: string, style: 'short' | 'shortGeneric'): string {
  return (
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: style })
      .formatToParts(instantMs)
      .find((part) => part.type === 'timeZoneName')?.value ?? ''
  );
}

/**
 * ICU zone display names that differ between the CLDR data versions shipped in
 * the fleet's runtimes, normalised to the one this app has always shown. A
 * label that changes with the runtime's CLDR data is the same defect as the
 * date-time combination glue (see `formatWallClock`): bun's Linux build
 * reports the short generic name of Asia/Hong_Kong as "Hong Kong SAR China
 * Time", while its macOS build reports "Hong Kong Time", so the raw name is
 * not used unchecked. Only known variants are mapped; everything else passes
 * through untouched.
 */
const ZONE_NAME_VARIANTS: Record<string, string> = {
  'Hong Kong SAR China Time': 'Hong Kong Time',
};

function canonicalZoneName(name: string): string {
  return ZONE_NAME_VARIANTS[name] ?? name;
}

/**
 * Short zone label for the studio at this value's wall clock ("PDT"), or '' when
 * no usable zone is known. Resolving the abbreviation needs an instant, so a
 * naive value is read through the site's own DST rules — which is also what
 * makes the label correct on the far side of a transition.
 *
 * `short` is preferred because it tracks DST ("PDT" vs "PST"), but it degrades
 * to a bare offset for zones the runtime has no abbreviation for. That is
 * actively misleading — Bun reports "GMT+1" for Europe/London in July, when the
 * zone is on BST and "GMT+1" reads as a UTC offset rather than a place — so an
 * offset-shaped `short` is discarded in favour of `shortGeneric`, which names the
 * zone correctly ("United Kingdom Time").
 */
function siteZoneLabel(parsed: ParsedSiteValue, timeZone: string | null | undefined): string {
  if (!isValidTimeZone(timeZone)) return '';

  let instantMs: number;
  if (parsed.offsetMs !== undefined) {
    instantMs = wallAsUtcMs(parsed.wall) - parsed.offsetMs;
  } else if (parsed.wall.hour === null) {
    instantMs = wallAsUtcMs({ ...parsed.wall, hour: 12, minute: 0, second: 0 });
  } else {
    instantMs = wallAsUtcMs(parsed.wall);
  }

  const short = canonicalZoneName(zoneNameFor(instantMs, timeZone, 'short'));
  if (short && !/^(?:GMT|UTC)(?:[+-]|$)/i.test(short)) return short;

  const generic = canonicalZoneName(zoneNameFor(instantMs, timeZone, 'shortGeneric'));
  if (generic) return generic;

  // No name available at all; the zone id is better than an empty label.
  return timeZone.replace(/_/g, ' ');
}

// ============================================================================
// Public API
// ============================================================================

export interface SiteFormatOptions {
  /** BCP-47 locale. Defaults to 'en-US', matching the rest of the UI. */
  locale?: string;
  /**
   * Append the studio's zone label, so the viewer can see the clock is the
   * studio's rather than their own. Off by default; the pages that show a
   * schedule turn it on.
   */
  withZone?: boolean;
  /** Returned when `value` is absent or unparseable. Defaults to ''. */
  fallback?: string;
}

type DateTimeParts = Intl.DateTimeFormatOptions;

/**
 * Whether the parts name a calendar date (as opposed to a time of day), for a
 * render that shows one, the other, or both.
 */
function hasDateFields(parts: DateTimeParts): boolean {
  return (
    parts.weekday !== undefined ||
    parts.year !== undefined ||
    parts.month !== undefined ||
    parts.day !== undefined
  );
}

function hasClockFields(parts: DateTimeParts): boolean {
  return (
    parts.hour !== undefined ||
    parts.minute !== undefined ||
    parts.second !== undefined ||
    parts.hour12 !== undefined
  );
}

function formatWallClock(
  wall: SiteWallClock,
  timeZone: string | null | undefined,
  parts: DateTimeParts,
  locale: string,
  dateClockSeparator?: string
): string {
  // Formatting the wall clock with timeZone 'UTC' prints exactly these digits
  // while still going through Intl for locale data. The viewer's zone is never
  // consulted, so the output cannot shift with it.
  //
  // A render that shows BOTH a date and a clock is split into two
  // Intl.DateTimeFormats joined by `dateClockSeparator`. A single combined
  // pattern would let ICU insert the CLDR date-time combination glue between
  // the halves — glue that changed for en-US in CLDR 42 ("{date}, {time}" →
  // "{date} 'at' {time}"), so the same code printed "Sun, Oct 18 at 8:00 AM"
  // on a new ICU and "Sun, Oct 18, 8:00 AM" on an older one (the GitHub
  // runner). Neither formatter below combines date and clock fields, so
  // neither consults the glue and the output is identical on every CLDR.
  if (hasDateFields(parts) && hasClockFields(parts)) {
    const ms = wallAsUtcMs(wall);
    const dateOptions: Intl.DateTimeFormatOptions = { timeZone: 'UTC' };
    if (parts.weekday !== undefined) dateOptions.weekday = parts.weekday;
    if (parts.year !== undefined) dateOptions.year = parts.year;
    if (parts.month !== undefined) dateOptions.month = parts.month;
    if (parts.day !== undefined) dateOptions.day = parts.day;

    const clockOptions: Intl.DateTimeFormatOptions = { timeZone: 'UTC' };
    if (parts.hour !== undefined) clockOptions.hour = parts.hour;
    if (parts.minute !== undefined) clockOptions.minute = parts.minute;
    if (parts.second !== undefined) clockOptions.second = parts.second;
    if (parts.hour12 !== undefined) clockOptions.hour12 = parts.hour12;
    if (clockOptions.hour !== undefined || clockOptions.hour12 !== undefined) {
      clockOptions.hourCycle = 'h12';
    }

    const dateText = new Intl.DateTimeFormat(locale, dateOptions).format(ms);
    const clockText = new Intl.DateTimeFormat(locale, clockOptions).format(ms);
    return `${dateText}${dateClockSeparator ?? ' '}${clockText}`;
  }

  const options: Intl.DateTimeFormatOptions = { ...parts, timeZone: 'UTC' };
  if (parts.hour !== undefined || parts.hour12 !== undefined) options.hourCycle = 'h12';
  return new Intl.DateTimeFormat(locale, options).format(wallAsUtcMs(wall));
}

function render(
  value: string | null | undefined,
  timeZone: string | null | undefined,
  parts: DateTimeParts,
  options: SiteFormatOptions = {},
  dateClockSeparator?: string
): string {
  const { locale = 'en-US', withZone = false, fallback = '' } = options;

  if (typeof value !== 'string' || value.trim() === '') return fallback;
  const parsed = parseSiteValue(value);
  if (!parsed) return fallback;

  if (withZone && isValidTimeZone(timeZone)) assertTimeZone(timeZone);
  const wall = wallClockInSiteZone(parsed, timeZone);
  const label = withZone ? siteZoneLabel(parsed, timeZone) : '';

  // A value with no time of day (a birth date, an expiry) has none to show.
  // Printing midnight instead would assert a time the studio never gave, so the
  // clock parts are dropped rather than filled in.
  const effective =
    wall.hour === null || wall.minute === null
      ? { ...parts, hour: undefined, minute: undefined, second: undefined, hour12: undefined }
      : parts;

  const text = formatWallClock(wall, timeZone, effective, locale, dateClockSeparator);
  return label ? `${text} ${label}` : text;
}

/**
 * A site date-TIME, e.g. `formatSiteDateTime('2026-10-18T08:00:00', 'America/Los_Angeles')`
 * → "Sun, Oct 18 at 8:00 AM PDT".
 *
 * The studio's wall clock, never the viewer's. The " at " between date and
 * clock is this module's own literal, not ICU's CLDR date-time combination
 * glue, so the output is the same on every CLDR/ICU version (see
 * `formatWallClock`).
 */
export function formatSiteDateTime(
  value: string | null | undefined,
  timeZone: string | null | undefined,
  options: SiteFormatOptions = {}
): string {
  return render(
    value,
    timeZone,
    {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    },
    options,
    ' at '
  );
}

/**
 * A site DATE-TIME with the weekday spelled out, for the cards that lead with
 * the day ("Sunday, Oct 18, 8:00 AM PDT").
 *
 * The ", " between date and clock is this module's own literal, not ICU's
 * CLDR date-time combination glue, so the output is the same on every
 * CLDR/ICU version (see `formatWallClock`).
 */
export function formatSiteDateTimeLong(
  value: string | null | undefined,
  timeZone: string | null | undefined,
  options: SiteFormatOptions = {}
): string {
  return render(
    value,
    timeZone,
    {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    },
    options,
    ', '
  );
}

/**
 * A site date-TIME showing only the clock, for the "9:00 AM – 10:00 AM PDT"
 * end of a range. `withZone` defaults to ON here, because a bare clock with no
 * date is exactly the case where the zone is most load-bearing.
 *
 * A value carrying no time of day has no clock to show, so it returns the
 * fallback rather than a date where a time was asked for.
 */
export function formatSiteTimeOfDay(
  value: string | null | undefined,
  timeZone: string | null | undefined,
  options: SiteFormatOptions = {}
): string {
  const parsed = typeof value === 'string' ? parseSiteValue(value) : null;
  if (!parsed || parsed.wall.hour === null || parsed.wall.minute === null) {
    return options.fallback ?? '';
  }
  return render(
    value,
    timeZone,
    { hour: 'numeric', minute: '2-digit' },
    { withZone: true, ...options }
  );
}

/** A site date with the weekday, e.g. "Sun, Oct 18". */
export function formatSiteDateWithWeekday(
  value: string | null | undefined,
  timeZone: string | null | undefined,
  options: SiteFormatOptions = {}
): string {
  return render(value, timeZone, { weekday: 'short', month: 'short', day: 'numeric' }, options);
}

/** A site date with the weekday spelled out, e.g. "Sunday, Oct 18". */
export function formatSiteDateWithWeekdayLong(
  value: string | null | undefined,
  timeZone: string | null | undefined,
  options: SiteFormatOptions = {}
): string {
  return render(value, timeZone, { weekday: 'long', month: 'short', day: 'numeric' }, options);
}

/** A bare site date, e.g. "Oct 18, 2026". Used for birth dates and expiries. */
export function formatSiteDate(
  value: string | null | undefined,
  timeZone: string | null | undefined,
  options: SiteFormatOptions = {}
): string {
  return render(value, timeZone, { month: 'short', day: 'numeric', year: 'numeric' }, options);
}