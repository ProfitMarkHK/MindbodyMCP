/**
 * Studio-local rendering of Mindbody timestamps
 * (nextjs-app/src/lib/mindbody/formatSiteTime.ts).
 *
 * The bug this covers: every page formatted timestamps with
 * `new Date(value).toLocaleString()`, which runs in the VIEWER's browser zone.
 * The clock shown therefore depended on where the reader was, while looking as
 * though it were the studio's own schedule.
 *
 * The central assertion is the INDEPENDENCE one: run the same formatter under
 * several host `TZ` values and require byte-identical output. That is the
 * property the pages needed and could not have before, and it fails loudly if
 * anyone reintroduces a `new Date(...).toLocale*()` round trip. The cases below
 * are the measured behaviours it replaces:
 *
 *   - `new Date('2026-10-18T15:00:00Z').toLocaleString()` rendered "Sun, Oct 18
 *     at 4:00 PM" — the LA 08:00 class as seen from UTC, i.e. the day and clock
 *     both shifted. Correct is 8:00 AM PDT.
 *   - `new Date('1990-05-03').toLocaleDateString()` rendered "May 2, 1990" for a
 *     host in America/Los_Angeles or Pacific/Kiritimati, because a bare date is
 *     parsed as UTC midnight. Correct is May 3.
 *
 * Runs under the root `bun test` (Gate 1); nextjs-app has no runner of its own.
 */
import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'url';
import {
  formatSiteDate,
  formatSiteDateTime,
  formatSiteDateTimeLong,
  formatSiteDateWithWeekday,
  formatSiteDateWithWeekdayLong,
  formatSiteTimeOfDay,
} from '../nextjs-app/src/lib/mindbody/formatSiteTime';

const LA = 'America/Los_Angeles';
const HK = 'Asia/Hong_Kong';

/**
 * Render a fixed battery of values in a child process with `TZ` set, and return
 * the JSON result. A child process is the only way to exercise a host-zone
 * difference, since `TZ` is read once per process.
 */
function renderInHostZone(timeZone: string): string[] {
  // `.pathname` would give "/E:/..." on Windows, which Bun cannot import.
  const modulePath = fileURLToPath(new URL('../nextjs-app/src/lib/mindbody/formatSiteTime.ts', import.meta.url));
  const source = `
    import { formatSiteDate, formatSiteDateTime, formatSiteDateTimeLong,
             formatSiteDateWithWeekday, formatSiteDateWithWeekdayLong,
             formatSiteTimeOfDay } from ${JSON.stringify(modulePath)};
    const LA = ${JSON.stringify(LA)};
    console.log(JSON.stringify([
      formatSiteDateTime('2026-10-18T08:00:00', LA, { withZone: true }),
      formatSiteDateTime('2026-10-18T15:00:00Z', LA, { withZone: true }),
      formatSiteDateTime('1990-05-03', LA, { withZone: true }),
      formatSiteDate('1990-05-03', LA, { withZone: true }),
      formatSiteDateTimeLong('2026-10-18T08:00:00', LA, { withZone: true }),
      formatSiteDateWithWeekday('2026-10-18T08:00:00', LA),
      formatSiteDateWithWeekdayLong('2026-10-18T08:00:00', LA),
      formatSiteTimeOfDay('2026-10-18T08:00:00', LA),
      formatSiteTimeOfDay('2026-10-18T08:00:00', ${JSON.stringify(HK)}),
    ]));
  `;
  const proc = Bun.spawnSync({
    cmd: [process.execPath, '-e', source],
    env: { ...process.env, TZ: timeZone },
  });
  if (proc.exitCode !== 0) {
    throw new Error(`formatter failed under TZ=${timeZone}: ${proc.stderr.toString()}`);
  }
  return JSON.parse(proc.stdout.toString().trim());
}

/**
 * The values renderInHostZone returns, pinned. They are the same under every host zone
 * (the formatter takes the studio zone explicitly), so a change in any one of them is a
 * behaviour change, not a host-zone effect.
 */
const PINNED = [
  'Sun, Oct 18 at 8:00 AM PDT',
  'Sun, Oct 18 at 8:00 AM PDT',
  'Thu, May 3 PDT',
  'May 3, 1990 PDT',
  'Sunday, Oct 18, 8:00 AM PDT',
  'Sun, Oct 18',
  'Sunday, Oct 18',
  '8:00 AM PDT',
  '8:00 AM Hong Kong Time',
];

/** The pre-fix expression, `new Date(value).toLocaleString()`, rendered in a child under `timeZone`. */
function renderHostZoneDate(timeZone: string): string {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, '-e', `console.log(new Date('2026-10-18T15:00:00Z').toLocaleString('en-US'))`],
    env: { ...process.env, TZ: timeZone },
  });
  return proc.stdout.toString().trim();
}

describe('formatSiteTime: output does not depend on the viewer zone', () => {
  const zones = ['UTC', 'America/Los_Angeles', 'Asia/Hong_Kong', 'Pacific/Kiritimati'];

  it('produces byte-identical output under every host TZ', () => {
    const outputs = zones.map((tz) => ({ tz, out: renderInHostZone(tz) }));
    for (const { tz, out } of outputs) {
      expect(out, `differs under TZ=${tz}`).toEqual(outputs[0].out);
    }
  });

  it('matches the pinned values, so a shared wrong output still fails', () => {
    expect(renderInHostZone('UTC')).toEqual(PINNED);
  });

  it('shows the pre-fix expression depends on the host zone (gives the test above teeth)', () => {
    // 15:00Z is 8:00 AM in LA but 11:00 PM in Hong Kong. The old expression shows the
    // host's clock, so it looks right only where the host happens to be LA.
    expect(renderHostZoneDate('America/Los_Angeles')).toContain('8:00:00 AM');
    expect(renderHostZoneDate('Asia/Hong_Kong')).not.toContain('8:00:00 AM');
  });
});

describe('formatSiteTime: studio wall clock', () => {
  it('renders Mindbody site-local strings unchanged', () => {
    // No offset on the wire, so the digits are already the studio's.
    expect(formatSiteDateTime('2026-10-18T08:00:00', LA, { withZone: true })).toBe(
      'Sun, Oct 18 at 8:00 AM PDT'
    );
  });

  it('renders a bare date without inventing a time of day', () => {
    expect(formatSiteDate('1990-05-03', LA, { withZone: true })).toBe('May 3, 1990 PDT');
    // The date-TIME formatter must not manufacture midnight.
    expect(formatSiteDateTime('1990-05-03', LA, { withZone: true })).toBe('Thu, May 3 PDT');
  });

  it('returns the fallback when a time is asked for but the value has none', () => {
    expect(formatSiteTimeOfDay('1990-05-03', LA)).toBe('');
    expect(formatSiteTimeOfDay('1990-05-03', LA, { fallback: '—' })).toBe('—');
  });
});

describe('formatSiteTime: values that carry an offset', () => {
  it('places an instant into the studio zone', () => {
    // 15:00Z is 08:00 in Los Angeles.
    expect(formatSiteDateTime('2026-10-18T15:00:00Z', LA, { withZone: true })).toBe(
      'Sun, Oct 18 at 8:00 AM PDT'
    );
  });

  it('respects a positive offset', () => {
    // 2026-10-19T00:00+09:00 is 2026-10-18T15:00Z, the same instant as the case
    // above, so Los Angeles (UTC-7 in October) reads it as 08:00 the 18th.
    expect(formatSiteDateTime('2026-10-19T00:00:00+09:00', LA, { withZone: true })).toBe(
      'Sun, Oct 18 at 8:00 AM PDT'
    );
  });

  it('labels the studio zone, not the viewer zone', () => {
    // The label names the studio's zone even though the wall clock is the
    // studio's own naive string; it must never leak the rendering host's zone.
    expect(formatSiteDateTime('2026-10-18T08:00:00', LA, { withZone: true })).toContain('PDT');
    expect(formatSiteDateTime('2026-10-18T08:00:00', HK, { withZone: true })).not.toContain('PDT');
    expect(formatSiteDateTime('2026-10-18T08:00:00', HK, { withZone: true })).toContain(
      'Hong Kong Time'
    );
  });

  it('does not label a zone as a bare UTC offset', () => {
    // Europe/London is on BST in July. Reporting "GMT+1" reads as an offset and
    // implies GMT, so the formatter falls back to naming the zone.
    const july = formatSiteDateTime('2026-07-01T12:00:00', 'Europe/London', { withZone: true });
    expect(july).not.toMatch(/GMT[+-]/);
    expect(july).toContain('United Kingdom Time');
  });

  it('keeps the DST-aware abbreviation where one exists', () => {
    expect(formatSiteDateTime('2026-01-15T12:00:00', LA, { withZone: true })).toContain('PST');
    expect(formatSiteDateTime('2026-07-15T12:00:00', LA, { withZone: true })).toContain('PDT');
  });
});

describe('formatSiteTime: graceful degradation', () => {
  it('returns the fallback for absent or unparseable input', () => {
    for (const bad of [null, undefined, '', '   ', 'not-a-date', '2026-13-01', '2026-02-30']) {
      expect(formatSiteDateTime(bad, LA)).toBe('');
      expect(formatSiteDateTime(bad, LA, { fallback: '-' })).toBe('-');
    }
  });

  it('renders unlabelled rather than in a viewer zone when no zone is known', () => {
    expect(formatSiteDateTime('2026-10-18T08:00:00', undefined, { withZone: true })).toBe(
      'Sun, Oct 18 at 8:00 AM'
    );
    expect(formatSiteDateTime('2026-10-18T08:00:00', 'Not/AZone', { withZone: true })).toBe(
      'Sun, Oct 18 at 8:00 AM'
    );
  });
});