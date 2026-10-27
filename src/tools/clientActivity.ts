import { fetchAllPages, mindbodyClient, type IMindbodyClient } from '../api/client.js';
import { classCache, SimpleCache } from '../cache/index.js';
import { errorMessage } from '../utils/errors.js';
import { withDefaultDates } from '../utils/siteTime.js';
import { AddArrivalResponse, Visit } from '../types/mindbody.js';
import { locationNames, staffNames } from './lookups.js';

/**
 * Client activity — attendance: visit history and check-in (arrival).
 *
 * Split out of `clientManagement.ts` so each client-domain module stays near
 * the ~200-line guideline. `clientManagement.ts` remains the public barrel.
 */

/**
 * Name for a catalogue id, or `undefined` when the catalogue does not hold it.
 *
 * `Visit` carries foreign keys only, so a name can come from exactly one place:
 * the cached catalogue. A miss is reported as `undefined` — never `''` and never
 * a placeholder such as `'Unknown'`, which reads like a real location to a caller.
 * The id itself stays on the row, so "no such id" is always distinguishable from
 * a resolved name.
 *
 * NOTE: `src/utils/referenceData.ts` exports a *different* `nameFor` that falls
 * back to `String(id)` or `''`. Do not merge the two: this one deliberately
 * never invents a placeholder.
 */
function nameFor(index: Map<number, string>, id: unknown): string | undefined {
  return typeof id === 'number' && Number.isFinite(id) ? index.get(id) : undefined;
}

/**
 * Roll-up key for a summary map: the resolved name when there is one, otherwise
 * the raw id as a string. A visit with neither a name nor a numeric id cannot be
 * grouped and is skipped rather than filed under a placeholder.
 */
function rollupKey(name: string | undefined, id: unknown): string | undefined {
  if (name !== undefined) return name;
  return typeof id === 'number' && Number.isFinite(id) ? String(id) : undefined;
}

/**
 * Client attendance history (`GET /client/clientvisits`).
 *
 * `Visit` carries `LocationId` and `StaffId` and no embedded location or staff
 * object, so `location` and `instructor` are resolved against the cached
 * `/site/locations` and `/staff/staff` catalogues and are `undefined` when the
 * catalogue does not hold the id. Each row also exposes `locationId` and
 * `staffId`, so a caller can always tell "no such id in the catalogue" from a
 * real name. The `byLocation` and `byInstructor` roll-ups group by the resolved
 * name when there is one and by the raw id as a string when there is not;
 * `byClassType` groups by the visit's own `Name`.
 */
export async function getClientVisitsTool(
  clientId: string,
  startDate?: string,
  endDate?: string,
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache
): Promise<{
  visits: Array<{
    id: number;
    classId: number;
    className: string;
    startTime: string;
    endTime: string;
    locationId?: number;
    location?: string;
    staffId?: number;
    instructor?: string;
    signedIn: boolean;
    webSignup: boolean;
    lateCancel: boolean;
    serviceId?: number;
    serviceName?: string;
  }>;
  totalVisits: number;
  summary: {
    totalAttended: number;
    totalNoShows: number;
    totalLateCancels: number;
    byLocation: Record<string, number>;
    byClassType: Record<string, number>;
    byInstructor: Record<string, number>;
  };
}> {
  // Default window: the last 30 site-local days, ending today at the site.
  const dates = await withDefaultDates(startDate, endDate, -30, client, cache);
  const { items: visitsRaw, totalResults } = await fetchAllPages<Visit>(
    client,
    '/client/clientvisits',
    {
      ClientId: clientId,
      StartDate: dates.start,
      EndDate: dates.end,
    },
    'Visits'
  );

  // Both catalogues are cached and fail open to an empty index, so a catalogue
  // that cannot be read leaves the names undefined instead of failing the read.
  // Neither is fetched when no visit carries the id it would resolve, so a
  // response with nothing to look up costs no extra requests.
  const wantsLocations = visitsRaw.some((visit: Visit) => typeof visit?.LocationId === 'number');
  const wantsStaff = visitsRaw.some((visit: Visit) => typeof visit?.StaffId === 'number');
  const [locations, staff] = await Promise.all([
    wantsLocations ? locationNames(client, cache) : new Map<number, string>(),
    wantsStaff ? staffNames(client, cache) : new Map<number, string>(),
  ]);

  const visits = visitsRaw.map((visit: Visit) => ({
    id: visit.Id,
    classId: visit.ClassId,
    className: visit.Name,
    startTime: visit.StartDateTime,
    endTime: visit.EndDateTime,
    locationId: visit.LocationId,
    location: nameFor(locations, visit.LocationId),
    staffId: visit.StaffId,
    instructor: nameFor(staff, visit.StaffId),
    signedIn: visit.SignedIn,
    webSignup: visit.WebSignup,
    lateCancel: visit.LateCancelled,
    serviceId: visit.ServiceId,
    serviceName: visit.ServiceName,
  }));

  // Generate summary
  const summary = {
    totalAttended: visits.filter(v => v.signedIn).length,
    totalNoShows: visits.filter(v => !v.signedIn && !v.lateCancel).length,
    totalLateCancels: visits.filter(v => v.lateCancel).length,
    byLocation: {} as Record<string, number>,
    byClassType: {} as Record<string, number>,
    byInstructor: {} as Record<string, number>,
  };

  visits.forEach((visit) => {
    if (!visit.signedIn) return;
    const location = rollupKey(visit.location, visit.locationId);
    const instructor = rollupKey(visit.instructor, visit.staffId);
    if (location !== undefined) {
      summary.byLocation[location] = (summary.byLocation[location] || 0) + 1;
    }
    if (visit.className !== undefined) {
      summary.byClassType[visit.className] = (summary.byClassType[visit.className] || 0) + 1;
    }
    if (instructor !== undefined) {
      summary.byInstructor[instructor] = (summary.byInstructor[instructor] || 0) + 1;
    }
  });

  return {
    visits,
    totalVisits: totalResults || visits.length,
    summary,
  };
}

// Add client arrival (check-in)
export async function addClientArrivalTool(
  clientId: string,
  locationId: number,
  client: IMindbodyClient = mindbodyClient
): Promise<{
  success: boolean;
  arrivalAdded: boolean;
  message: string;
}> {
  try {
    const response = await client.post<AddArrivalResponse>('/client/addarrival', {
      ClientId: clientId,
      LocationId: locationId,
    });

    return {
      success: true,
      arrivalAdded: response.ArrivalAdded,
      // `AddArrivalResponse` defines no `Message` field (see docs/mindbody-spec-discrepancies.md),
      // so the success text is fixed rather than read from the response.
      message: 'Client checked in successfully',
    };
  } catch (error: unknown) {
    return {
      success: false,
      arrivalAdded: false,
      message: errorMessage(error, 'Failed to check in client'),
    };
  }
}
