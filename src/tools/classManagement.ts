import { fetchAllPages, mindbodyClient, type IMindbodyClient } from '../api/client.js';
import { classCache, SimpleCache } from '../cache/index.js';
import { errorMessage } from '../utils/errors.js';
import { LATE_CANCEL_WINDOW_UNKNOWN, lateCancelWindowHours, lateCancelWindowRefusal } from '../utils/lateCancel.js';
import {
  epochMsToSiteLocal,
  getSiteTimeZone,
  resolveReadTimeZone,
  siteDateStringPlusDays,
  siteLocalToEpochMs,
} from '../utils/siteTime.js';
import {
  GetClassesRequest,
  Class,
} from '../types/mindbody.js';
import { locationNames } from './lookups.js';

// Get all classes with filtering options
/**
 * `GET /class/classes`, paged to the end.
 *
 * `substitute` comes from `Class.Substitute` (the spec field; there is no
 * `IsSubstitute`, so the output field is named `substitute` to match).
 */
export async function getClassesTool(
  startDate?: string,
  endDate?: string,
  locationIds?: number[],
  classDescriptionIds?: number[],
  staffIds?: number[],
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache
): Promise<{
  classes: Array<{
    id: number;
    name: string;
    description: string;
    instructor: string;
    startTime: string;
    endTime: string;
    location: string;
    spotsAvailable: number;
    totalSpots: number;
    isWaitlistAvailable: boolean;
    isCanceled: boolean;
    substitute: boolean;
    virtualStreamLink?: string;
  }>;
  summary: {
    totalClasses: number;
    totalAvailableSpots: number;
    byInstructor: Record<string, number>;
    byLocation: Record<string, number>;
    byClassType: Record<string, number>;
  };
}> {
  const cacheKey = `classes:${startDate}:${endDate}:${locationIds?.join(',')}:${classDescriptionIds?.join(',')}:${staffIds?.join(',')}`;
  let cached = cache.get<Class[]>(cacheKey);

  if (!cached) {
    // Defaults: from "now" to seven days on, expressed as site-local wall time
    // (Mindbody reads offset-less date-times in the site's zone).
    // The zone is only resolved (once) if a default is actually needed.
    let zone: Promise<string> | undefined;
    const siteNow = async (offsetMs: number) =>
      epochMsToSiteLocal(Date.now() + offsetMs, await (zone ??= resolveReadTimeZone(client, cache)));
    const request: GetClassesRequest = {
      StartDateTime: startDate ? `${startDate}T00:00:00` : await siteNow(0),
      EndDateTime: endDate ? `${endDate}T23:59:59` : await siteNow(7 * 24 * 60 * 60 * 1000),
      LocationIds: locationIds,
      ClassDescriptionIds: classDescriptionIds,
      StaffIds: staffIds,
    };

    ({ items: cached } = await fetchAllPages<Class>(client, '/class/classes', { ...request }, 'Classes'));

    cache.set(cacheKey, cached);
  }

  // Process and format results
  const formattedClasses = cached.map((cls) => ({
    id: cls.Id,
    name: cls.ClassDescription?.Name || '',
    description: cls.ClassDescription?.Description || '',
    instructor: cls.Staff?.Name || `${cls.Staff?.FirstName || ''} ${cls.Staff?.LastName || ''}`.trim() || '',
    startTime: cls.StartDateTime,
    endTime: cls.EndDateTime,
    location: cls.Location?.Name || '',
    spotsAvailable: cls.MaxCapacity - cls.TotalBooked,
    totalSpots: cls.MaxCapacity,
    isWaitlistAvailable: cls.IsWaitlistAvailable,
    isCanceled: cls.IsCanceled,
    substitute: cls.Substitute,
    virtualStreamLink: (cls as any).VirtualStreamLink,
  }));

  // Generate summary
  const summary = {
    totalClasses: formattedClasses.filter(c => !c.isCanceled).length,
    totalAvailableSpots: formattedClasses.reduce((sum, c) => sum + (c.isCanceled ? 0 : c.spotsAvailable), 0),
    byInstructor: {} as Record<string, number>,
    byLocation: {} as Record<string, number>,
    byClassType: {} as Record<string, number>,
  };

  formattedClasses.forEach((cls) => {
    if (!cls.isCanceled) {
      summary.byInstructor[cls.instructor] = (summary.byInstructor[cls.instructor] || 0) + 1;
      summary.byLocation[cls.location] = (summary.byLocation[cls.location] || 0) + 1;
      summary.byClassType[cls.name] = (summary.byClassType[cls.name] || 0) + 1;
    }
  });

  return { classes: formattedClasses, summary };
}

// Get class descriptions (types of classes offered)
/** `GET /class/classdescriptions`, paged. `imageUrl` comes from `ImageURL`. */
export async function getClassDescriptionsTool(
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache
): Promise<{
  classTypes: Array<{
    id: number;
    name: string;
    description: string;
    imageUrl?: string;
    prerequisites?: string;
    level?: string;
  }>;
  totalTypes: number;
}> {
  const cacheKey = 'class-descriptions';
  let cached = cache.get<any[]>(cacheKey);

  if (!cached) {
    ({ items: cached } = await fetchAllPages<any>(client, '/class/classdescriptions', {}, 'ClassDescriptions'));
    cache.set(cacheKey, cached, 60); // Cache for 60 minutes
  }

  const classTypes = cached.map((desc: any) => ({
    id: desc.Id,
    name: desc.Name,
    description: desc.Description || '',
    imageUrl: desc.ImageURL,
    prerequisites: desc.Prereq,
    level: desc.Level?.Name,
  }));

  return {
    classTypes,
    totalTypes: classTypes.length,
  };
}

// Add client to class (book a class)
/**
 * `POST /class/addclienttoclass`.
 *
 * `AddClientToClassResponse` contains ONLY `Visit`. It carries no
 * `PaymentRequired` flag and no `ServicePaymentInfo`, so this tool does not
 * report an amount due: `serviceId` being absent or null on the returned Visit
 * is the only payment signal the endpoint offers, and it is returned as
 * `serviceId` rather than being interpreted here.
 */
export async function addClientToClassTool(
  clientId: string,
  classId: number,
  requirePayment: boolean = true,
  waitlist: boolean = false,
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache
): Promise<{
  success: boolean;
  visitId?: number;
  serviceId?: number;
  message: string;
}> {
  try {
    const response = await client.post<any>('/class/addclienttoclass', {
      ClientId: clientId,
      ClassId: classId,
      RequirePayment: requirePayment,
      Waitlist: waitlist,
    });

    // Clear cache after booking
    cache.clear();

    return {
      success: true,
      visitId: response.Visit?.Id,
      serviceId: response.Visit?.ServiceId ?? undefined,
      message: waitlist ? 'Successfully added to waitlist' : 'Successfully booked class',
    };
  } catch (error: unknown) {
    return {
      success: false,
      message: errorMessage(error, 'Failed to book class'),
    };
  }
}

/** How far ahead the class lookup for a late cancel looks, matching the appointment and enrollment guards. */
const LATE_CANCEL_LOOKUP_WINDOW_DAYS = 365 * 2;

/**
 * Why a late cancel of `classId` is refused, or null if it may go ahead.
 * Every failure refuses (fail closed): unknown window, unknown site zone, a
 * failed lookup, a class that is absent or ambiguous, or one outside the window.
 * The lookup starts at "now", so a class that has already started is "not found".
 */
async function lateCancelRefusal(
  classId: number,
  client: IMindbodyClient,
  cache: SimpleCache
): Promise<string | null> {
  const windowHours = lateCancelWindowHours();
  if (windowHours === undefined) return LATE_CANCEL_WINDOW_UNKNOWN;

  let timeZone: string;
  try {
    timeZone = await getSiteTimeZone(client, cache);
  } catch (error: unknown) {
    return `late cancel refused: site timezone unavailable: ${errorMessage(error, 'unknown error')}`;
  }

  const nowMs = Date.now();
  let rows: any[];
  try {
    ({ items: rows } = await fetchAllPages<any>(
      client,
      '/class/classes',
      {
        ClassIds: [classId],
        StartDateTime: epochMsToSiteLocal(nowMs, timeZone),
        EndDateTime: `${siteDateStringPlusDays(new Date(nowMs), timeZone, LATE_CANCEL_LOOKUP_WINDOW_DAYS)}T23:59:59`,
      },
      'Classes'
    ));
  } catch (error: unknown) {
    return `late cancel refused: class lookup failed: ${errorMessage(error, 'unknown error')}`;
  }
  if (rows.length === 0) return `late cancel refused: class ${classId} was not found as an upcoming class`;
  if (rows.length > 1) return `late cancel refused: class ${classId} returned more than once by lookup; refusing ambiguous data`;

  const startMs = siteLocalToEpochMs(rows[0].StartDateTime, timeZone);
  if (Number.isNaN(startMs)) return `late cancel refused: class ${classId} start time could not be parsed`;
  return lateCancelWindowRefusal(startMs, nowMs, windowHours);
}

// Remove client from class (cancel booking). `lateCancel` forfeits the visit,
// so it is honoured only inside the site's late-cancel window (see lateCancel.ts).
export async function removeClientFromClassTool(
  clientId: string,
  classId: number,
  lateCancel: boolean = false,
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache
): Promise<{
  success: boolean;
  message: string;
}> {
  if (lateCancel) {
    const refusal = await lateCancelRefusal(classId, client, cache);
    if (refusal) return { success: false, message: refusal };
  }

  try {
    await client.post('/class/removeclientfromclass', {
      ClientId: clientId,
      ClassId: classId,
      LateCancel: lateCancel,
    });

    // Clear cache after cancellation
    cache.clear();

    return {
      success: true,
      message: 'Successfully cancelled class booking',
    };
  } catch (error: unknown) {
    return {
      success: false,
      message: errorMessage(error, 'Failed to cancel class'),
    };
  }
}

// Get waitlist entries for a class

/** Filters this tool accepts; the endpoint needs at least one of them. */
const WAITLIST_FILTERS = ['classScheduleIds', 'classIds', 'clientIds'] as const;

/**
 * `GET /class/waitlistentries`, paged.
 *
 * **At least one filter is required.** The endpoint answers HTTP 400
 * `At least one of the following parameters must be passed: ClassScheduleIds,
 * ClientIds, WaitlistEntryIds, ClassIds (Code: MissingRequiredFields)` when it
 * gets none, so this tool refuses the call itself rather than spending a request
 * on a guaranteed failure.
 *
 * **There is no queue position here.** `WaitlistEntry` is
 * `{Id, ClassId, ClassDate, ClassSchedule, Client, EnrollmentDateForward,
 * RequestDateTime, VisitRefNo, Web}` and carries no position field, so none is
 * returned. `GET /client/clientschedule` exposes `WaitlistInfo.WaitlistOrderNumber`
 * per client instead.
 */
export async function getWaitlistEntriesTool(
  classScheduleIds?: number[],
  classIds?: number[],
  clientIds?: string[],
  client: IMindbodyClient = mindbodyClient
): Promise<{
  entries: Array<{
    id: number;
    classId: number;
    className?: string;
    classDate?: string;
    classScheduleId?: number;
    clientId?: string;
    clientName?: string;
    enrollmentDateForward?: string;
    requestDatetime?: string;
    visitRefNo?: number;
    web?: boolean;
  }>;
  totalEntries: number;
}> {
  const filters: Record<string, unknown[]> = { classScheduleIds, classIds, clientIds };
  const supplied = WAITLIST_FILTERS.filter((name) => {
    const value = filters[name];
    return Array.isArray(value) && value.length > 0;
  });
  if (supplied.length === 0) {
    throw new Error(
      `getWaitlistEntries needs at least one filter: pass one of ${WAITLIST_FILTERS.join(', ')}. ` +
        'GET /class/waitlistentries rejects a request that carries none of ClassScheduleIds, ' +
        'ClientIds, WaitlistEntryIds or ClassIds.'
    );
  }

  const { items: entryRows } = await fetchAllPages<any>(
    client,
    '/class/waitlistentries',
    {
      ClassScheduleIds: classScheduleIds,
      ClassIds: classIds,
      ClientIds: clientIds,
    },
    'WaitlistEntries'
  );

  const entries = entryRows.map((entry: any) => {
    const classDescription = entry.ClassSchedule?.ClassDescription;
    const clientObject = entry.Client;
    const clientName =
      clientObject?.FirstName || clientObject?.LastName
        ? `${clientObject.FirstName ?? ''} ${clientObject.LastName ?? ''}`.trim()
        : undefined;
    return {
      id: entry.Id,
      classId: entry.ClassId,
      className: classDescription?.Name,
      classDate: entry.ClassDate,
      classScheduleId: entry.ClassSchedule?.Id,
      clientId: clientObject?.Id,
      clientName,
      enrollmentDateForward: entry.EnrollmentDateForward,
      requestDatetime: entry.RequestDateTime,
      visitRefNo: entry.VisitRefNo,
      web: entry.Web,
    };
  });

  return {
    entries,
    totalEntries: entries.length,
  };
}

// Substitute class teacher
/**
 * `POST /class/substituteclassteacher`.
 *
 * `SubstituteClassTeacherRequest` is `{ClassId, StaffId, OverrideConflicts,
 * SendClientEmail, SendOriginalTeacherEmail, SendSubstituteTeacherEmail}`, and
 * `StaffId` is documented as "the staff ID of the teacher to substitute" — the
 * incoming teacher. The original teacher is implied by the class, so it is not
 * a parameter here: sending it as `StaffId` would substitute the original
 * teacher with themselves.
 *
 * The response row is a `SubstituteTeacherClass` carrying `Staff` and the
 * boolean `Substitute`. There is no `Class.SubstituteTeacher` field, so
 * `teacherName` is the (now substituting) staff member's name.
 */
// SPEC-ALIGNED BUT UNVERIFIED: POST /class/substituteclassteacher has no Test flag, so the request
// and response shapes above are taken from docs/openapi.json alone and have never been exercised against the sandbox.
export async function substituteClassTeacherTool(
  classId: number,
  substituteTeacherId: number,
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache
): Promise<{
  success: boolean;
  message: string;
  updatedClass?: {
    id: number;
    name: string;
    teacherId?: number;
    teacherName?: string;
    substitute?: boolean;
    startTime?: string;
  };
}> {
  try {
    const response = await client.post<any>('/class/substituteclassteacher', {
      ClassId: classId,
      StaffId: substituteTeacherId,
    });

    // Clear cache after substitution
    cache.clear();

    const staff = response.Class?.Staff;
    const teacherName =
      staff?.Name ||
      (staff?.FirstName || staff?.LastName
        ? `${staff.FirstName ?? ''} ${staff.LastName ?? ''}`.trim()
        : undefined);

    return {
      success: true,
      message: 'Successfully substituted teacher',
      updatedClass: response.Class
        ? {
            id: response.Class.Id,
            name: response.Class.ClassDescription?.Name,
            teacherId: staff?.Id,
            teacherName,
            substitute: response.Class.Substitute,
            startTime: response.Class.StartDateTime,
          }
        : undefined,
    };
  } catch (error: unknown) {
    return {
      success: false,
      message: errorMessage(error, 'Failed to substitute teacher'),
    };
  }
}

// Get class schedules
/** Weekday order, matching `ClassSchedule.Day*`'s seven booleans. */
const SCHEDULE_DAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/**
 * `GET /class/classschedules`, paged.
 *
 * `ClassSchedule` carries seven booleans (`DaySunday`..`DaySaturday`) rather
 * than a single day, so `days` lists the weekdays the schedule runs on. There
 * is no `DayOfWeek` and no `IsActive`; the schedule's own availability flag is
 * `IsAvailable`, returned as `isAvailable`.
 *
 * `classDescriptionIds` is not a parameter of this endpoint. It is accepted by
 * the sandbox only because unknown query parameters are ignored there, so it
 * never filtered anything; use `sessionTypeIds`, which the endpoint does
 * define.
 */
export async function getClassSchedulesTool(
  locationIds?: number[],
  sessionTypeIds?: number[],
  staffIds?: number[],
  programIds?: number[],
  client: IMindbodyClient = mindbodyClient
): Promise<{
  schedules: Array<{
    id: number;
    className: string;
    instructor: string;
    location: string;
    days: string[];
    startTime: string;
    endTime: string;
    startDate: string;
    endDate?: string;
    isAvailable: boolean;
  }>;
  totalSchedules: number;
}> {
  const { items: scheduleRows } = await fetchAllPages<any>(
    client,
    '/class/classschedules',
    {
      LocationIds: locationIds,
      SessionTypeIds: sessionTypeIds,
      StaffIds: staffIds,
      ProgramIds: programIds,
    },
    'ClassSchedules'
  );

  const schedules = scheduleRows.map((schedule: any) => ({
    id: schedule.Id,
    className: schedule.ClassDescription?.Name || '',
    instructor: schedule.Staff?.Name || `${schedule.Staff?.FirstName || ''} ${schedule.Staff?.LastName || ''}`.trim() || '',
    location: schedule.Location?.Name || '',
    days: SCHEDULE_DAYS.filter((day) => schedule[`Day${day}`] === true),
    startTime: schedule.StartTime,
    endTime: schedule.EndTime,
    startDate: schedule.StartDate,
    endDate: schedule.EndDate,
    isAvailable: schedule.IsAvailable,
  }));

  return {
    schedules,
    totalSchedules: schedules.length,
  };
}

// Get visits for a specific class (attendance/booking history)
/**
 * `GET /class/classvisits` — a single GET; the endpoint is not paginated in the spec.
 *
 * **No client names here.** A `Visit` carries `ClientId`, `ClientUniqueId`,
 * `ClientPhotoUrl`, `LocationId`, `StaffId`, `Service`, `ServiceId` and
 * `ServiceName`, with no `Client` object and no first name, last name, email or
 * phone, so those fields are gone and `clientId`/`clientUniqueId` are returned
 * instead. Resolving names needs `GET /client/clients`, which this tool does not
 * call. `locationName` is resolved through the cached `/site/locations`
 * catalogue and is `undefined` when `locationId` is not in it.
 */
export async function getClassVisitsTool(
  classId: number,
  lastModifiedDate?: string,
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache
): Promise<{
  classInfo: {
    id: number;
    name: string;
    instructor: string;
    startTime: string;
    endTime: string;
    location: string;
  };
  visits: Array<{
    id: number;
    classId: number;
    clientId?: string;
    clientUniqueId?: number;
    staffId?: number;
    startDateTime: string;
    endDateTime: string;
    signedIn: boolean;
    webSignup: boolean;
    makeUp: boolean;
    lateCancel: boolean;
    serviceName?: string;
    serviceId?: number;
    locationId?: number;
    locationName?: string;
  }>;
  totalVisits: number;
  summary: {
    totalSignedIn: number;
    totalNotSignedIn: number;
    totalLateCancels: number;
    totalWebSignups: number;
  };
}> {
  const response = await client.get<any>('/class/classvisits', {
    params: {
      ClassId: classId,
      LastModifiedDate: lastModifiedDate,
    },
  });

  const classInfo = {
    id: response.Class?.Id || classId,
    name: response.Class?.ClassDescription?.Name || '',
    instructor: response.Class?.Staff?.DisplayName || `${response.Class?.Staff?.FirstName || ''} ${response.Class?.Staff?.LastName || ''}`.trim() || '',
    startTime: response.Class?.StartDateTime,
    endTime: response.Class?.EndDateTime,
    location: response.Class?.Location?.Name || '',
  };

  const rawVisits: any[] = response.Class?.Visits || [];
  // Read the catalogue only when a visit actually carries a LocationId to
  // resolve, so a class with no visits costs exactly the one request it always did.
  const locations = rawVisits.some((v: any) => typeof v?.LocationId === 'number')
    ? await locationNames(client, cache)
    : new Map<number, string>();

  const visits = rawVisits.map((visit: any) => ({
    id: visit.Id,
    classId: visit.ClassId || classId,
    clientId: visit.ClientId,
    clientUniqueId: visit.ClientUniqueId,
    staffId: visit.StaffId,
    startDateTime: visit.StartDateTime,
    endDateTime: visit.EndDateTime,
    signedIn: visit.SignedIn || false,
    webSignup: visit.WebSignup || false,
    makeUp: visit.MakeUp || false,
    lateCancel: visit.LateCancelled || false,
    serviceName: visit.ServiceName ?? visit.Service?.Name,
    serviceId: visit.ServiceId ?? visit.Service?.Id,
    locationId: visit.LocationId,
    locationName: locations.get(visit.LocationId as number),
  }));

  // Generate summary
  const summary = {
    totalSignedIn: visits.filter((v: any) => v.signedIn).length,
    totalNotSignedIn: visits.filter((v: any) => !v.signedIn && !v.lateCancel).length,
    totalLateCancels: visits.filter((v: any) => v.lateCancel).length,
    totalWebSignups: visits.filter((v: any) => v.webSignup).length,
  };

  return {
    classInfo,
    visits,
    totalVisits: visits.length,
    summary,
  };
}