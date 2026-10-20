/**
 * Enrollment domain: courses, workshops and series, and a client's part in them.
 *
 * Mindbody has no "enrollment record". An enrollment is a ClassSchedule whose
 * Program has ScheduleType `Enrollment` (GET /enrollment/enrollments returns
 * those schedules, with `Classes` and `Clients` null). Each session is a Class
 * (GET /class/classes, `ClassScheduleId` links back), and a client's seat in a
 * session is a Visit on the client's schedule (GET /client/clientschedule).
 * The visit record itself has no enrollment marker (`VisitType`/`TypeGroup` are
 * the same for enrollment and drop-in visits in the sandbox), so a visit is an
 * enrollment visit when its ClassId resolves to a class whose
 * ClassDescription.Program.ScheduleType is `Enrollment`.
 *
 *   create : POST /enrollment/addclienttoenrollment   (addClientToEnrollmentTool)
 *   view   : GET  /enrollment/enrollments             (getEnrollmentsTool)
 *            GET  /client/clientschedule + /class/classes (getClientEnrollmentsTool)
 *   cancel : POST /class/removeclientfromclass        (cancelEnrollmentVisitsTool)
 *   change : no endpoint. Cancel the sessions, then add the client again with
 *            `enrollOpenDates` or `enrollDateForward`. Nothing here pretends
 *            otherwise.
 *
 * Every paginated GET goes through `fetchAllPages` (Gate 13).
 */
import { fetchAllPages, mindbodyClient, type IMindbodyClient } from '../api/client.js';
import { classCache, SimpleCache } from '../cache/index.js';
import { errorMessage } from '../utils/errors.js';
import { LATE_CANCEL_WINDOW_UNKNOWN, lateCancelWindowHours, lateCancelWindowRefusal } from '../utils/lateCancel.js';
import {
  getSiteTimeZone,
  siteDateString,
  siteDateStringPlusDays,
  siteLocalToEpochMs,
  withDefaultDates,
} from '../utils/siteTime.js';

/** Program.ScheduleType value that marks an enrollment (course/workshop/series). */
export const ENROLLMENT_SCHEDULE_TYPE = 'Enrollment';

/** Default lookahead for getEnrollments and getClientEnrollments, in days. */
export const DEFAULT_ENROLLMENT_WINDOW_DAYS = 365;

/** GET /class/classes `ClassIds` per request, to keep the query string bounded. */
const CLASS_LOOKUP_CHUNK = 50;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

function staffName(staff: any): string {
  if (!staff) return '';
  return staff.Name || `${staff.FirstName || ''} ${staff.LastName || ''}`.trim();
}

function scheduledDays(schedule: any): string[] {
  return DAY_NAMES.filter((day) => schedule?.[`Day${day}`] === true);
}

function isEnrollmentClass(cls: any): boolean {
  return cls?.ClassDescription?.Program?.ScheduleType === ENROLLMENT_SCHEDULE_TYPE;
}

/**
 * GET /class/classes for a set of class IDs, in chunks, every chunk paged.
 * Returns a map ClassId -> Class. Dates bound the lookup the same way the
 * caller bounded the visits, so a class outside the window is simply absent.
 */
async function lookupClasses(
  client: IMindbodyClient,
  classIds: number[],
  startDateTime: string,
  endDateTime: string
): Promise<Map<number, any>> {
  const byId = new Map<number, any>();
  const unique = [...new Set(classIds)];
  for (let i = 0; i < unique.length; i += CLASS_LOOKUP_CHUNK) {
    const { items } = await fetchAllPages<any>(
      client,
      '/class/classes',
      {
        ClassIds: unique.slice(i, i + CLASS_LOOKUP_CHUNK),
        StartDateTime: startDateTime,
        EndDateTime: endDateTime,
        HideCanceledClasses: false,
      },
      'Classes'
    );
    for (const cls of items) byId.set(Number(cls.Id), cls);
  }
  return byId;
}

// ── getEnrollments ───────────────────────────────────────────────────────────

export interface EnrollmentSummary {
  /** ClassSchedule ID. This is the `classScheduleId` addClientToEnrollment takes. */
  id: number;
  name: string;
  description?: string;
  courseId?: number;
  courseName?: string;
  programId?: number;
  programName?: string;
  sessionTypeId?: number;
  sessionTypeName?: string;
  staffId?: number;
  staffName: string;
  locationId?: number;
  locationName: string;
  semesterId?: number;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  days: string[];
  allowOpenEnrollment: boolean;
  allowDateForwardEnrollment: boolean;
  isAvailable: boolean;
}

/**
 * Enrollments scheduled at the site: GET /enrollment/enrollments (paginated,
 * list key `Enrollments`, rows are ClassSchedule). Without dates the window is
 * today through DEFAULT_ENROLLMENT_WINDOW_DAYS in the site's zone.
 *
 * The spec's filters are ClassScheduleIds, LocationIds, StaffIds, ProgramIds,
 * SessionTypeIds, StartDate and EndDate. There is no semester or course filter
 * on this endpoint (those belong to GET /class/courses).
 */
export async function getEnrollmentsTool(
  locationIds?: number[],
  classScheduleIds?: number[],
  staffIds?: number[],
  programIds?: number[],
  sessionTypeIds?: number[],
  startDate?: string,
  endDate?: string,
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache
): Promise<{ enrollments: EnrollmentSummary[]; totalEnrollments: number }> {
  const dates = await withDefaultDates(startDate, endDate, DEFAULT_ENROLLMENT_WINDOW_DAYS, client, cache);
  const { items: rows, totalResults } = await fetchAllPages<any>(
    client,
    '/enrollment/enrollments',
    {
      LocationIds: locationIds,
      ClassScheduleIds: classScheduleIds,
      StaffIds: staffIds,
      ProgramIds: programIds,
      SessionTypeIds: sessionTypeIds,
      StartDate: dates.start,
      EndDate: dates.end,
    },
    'Enrollments'
  );

  const enrollments = rows.map(mapEnrollment);
  return { enrollments, totalEnrollments: totalResults || enrollments.length };
}

function mapEnrollment(schedule: any): EnrollmentSummary {
  const description = schedule.ClassDescription;
  return {
    id: Number(schedule.Id),
    name: description?.Name ?? '',
    description: description?.Description ?? undefined,
    courseId: schedule.Course?.Id ?? undefined,
    courseName: schedule.Course?.Name ?? undefined,
    programId: description?.Program?.Id ?? undefined,
    programName: description?.Program?.Name ?? undefined,
    sessionTypeId: description?.SessionType?.Id ?? undefined,
    sessionTypeName: description?.SessionType?.Name ?? undefined,
    staffId: schedule.Staff?.Id ?? undefined,
    staffName: staffName(schedule.Staff),
    locationId: schedule.Location?.Id ?? undefined,
    locationName: schedule.Location?.Name ?? '',
    semesterId: schedule.SemesterId ?? undefined,
    startDate: schedule.StartDate,
    endDate: schedule.EndDate,
    startTime: schedule.StartTime,
    endTime: schedule.EndTime,
    days: scheduledDays(schedule),
    allowOpenEnrollment: Boolean(schedule.AllowOpenEnrollment),
    allowDateForwardEnrollment: Boolean(schedule.AllowDateForwardEnrollment),
    isAvailable: Boolean(schedule.IsAvailable),
  };
}

// ── addClientToEnrollment ────────────────────────────────────────────────────

export interface AddClientToEnrollmentResult {
  success: boolean;
  classScheduleId: number;
  name?: string;
  /** The sessions Mindbody reports on the schedule after the booking. */
  sessions: Array<{ classId: number; startDateTime: string; endDateTime: string; totalBooked?: number }>;
  message: string;
}

/**
 * Book ONE client into ONE enrollment: POST /enrollment/addclienttoenrollment.
 *
 * Body (names exactly as in docs/openapi.json): ClientId, ClassScheduleId
 * (singular; the enrollment's `id` from getEnrollments), EnrollDateForward,
 * EnrollOpen (array of session date-times), Waitlist, WaitlistEntryId,
 * SendEmail, Test. The response is the ClassSchedule with its `Classes`.
 * Sending `ClassScheduleIds` (plural) is refused by Mindbody with
 * MissingRequiredFields, which is what the previous version did.
 */
export async function addClientToEnrollmentTool(
  clientId: string,
  classScheduleId: number,
  enrollDateForward?: string,
  enrollOpenDates?: string[],
  waitlist: boolean = false,
  sendEmail: boolean = false,
  test: boolean = false,
  waitlistEntryId?: number,
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache
): Promise<AddClientToEnrollmentResult> {
  if (!Number.isInteger(classScheduleId) || classScheduleId <= 0) {
    return {
      success: false,
      classScheduleId,
      sessions: [],
      message: 'classScheduleId must be a positive integer (the enrollment id from getEnrollments)',
    };
  }

  // Mindbody books the same client into the same session twice without
  // complaint (verified on the sandbox), so refuse when the client already
  // holds a seat in any session this request would book. Waitlist requests
  // are not checked: a waitlist entry is not a seat.
  if (!waitlist) {
    let held: ClientEnrollmentSession[];
    try {
      held = await sessionsAlreadyHeld(client, cache, clientId, classScheduleId, enrollDateForward, enrollOpenDates);
    } catch (error: unknown) {
      return {
        success: false,
        classScheduleId,
        sessions: [],
        message: `Could not check the client's existing sessions; nothing was booked: ${errorMessage(error, 'unknown error')}`,
      };
    }
    if (held.length > 0) {
      return {
        success: false,
        classScheduleId,
        sessions: held.map((s) => ({ classId: s.classId, startDateTime: s.startDateTime, endDateTime: s.endDateTime })),
        message:
          `Client ${clientId} already holds ${held.length} of the requested session(s) in enrollment ${classScheduleId} ` +
          `(visit ids ${held.map((s) => s.visitId).join(', ')}); nothing was booked. Cancel them with cancelEnrollmentVisits first to re-book.`,
      };
    }
  }

  try {
    const response = await client.post<any>('/enrollment/addclienttoenrollment', {
      ClientId: clientId,
      ClassScheduleId: classScheduleId,
      EnrollDateForward: enrollDateForward,
      EnrollOpen: enrollOpenDates,
      Waitlist: waitlist,
      WaitlistEntryId: waitlistEntryId,
      SendEmail: sendEmail,
      Test: test,
    });
    const sessions = (Array.isArray(response?.Classes) ? response.Classes : []).map((cls: any) => ({
      classId: Number(cls.Id),
      startDateTime: cls.StartDateTime,
      endDateTime: cls.EndDateTime,
      totalBooked: cls.TotalBooked ?? undefined,
    }));
    const what = waitlist ? 'waitlisted for' : 'enrolled in';
    return {
      success: true,
      classScheduleId: Number(response?.Id ?? classScheduleId),
      name: response?.ClassDescription?.Name ?? undefined,
      sessions,
      message: `${test ? '[test] ' : ''}Client ${clientId} ${what} enrollment ${classScheduleId} (${sessions.length} session(s) on the schedule)`,
    };
  } catch (error: unknown) {
    return {
      success: false,
      classScheduleId,
      sessions: [],
      message: errorMessage(error, 'Failed to add client to enrollment'),
    };
  }
}

/**
 * The client's existing (not late-cancelled, not waitlisted) sessions in
 * `classScheduleId` that a booking with these options would book again.
 * The window is the enrollment's own StartDate..EndDate from
 * GET /enrollment/enrollments; an unknown enrollment yields no held sessions
 * and the booking is left to Mindbody to refuse.
 */
async function sessionsAlreadyHeld(
  client: IMindbodyClient,
  cache: SimpleCache,
  clientId: string,
  classScheduleId: number,
  enrollDateForward?: string,
  enrollOpenDates?: string[]
): Promise<ClientEnrollmentSession[]> {
  const { items: schedules } = await fetchAllPages<any>(
    client,
    '/enrollment/enrollments',
    { ClassScheduleIds: [classScheduleId], StartDate: '2000-01-01', EndDate: '2100-12-31' },
    'Enrollments'
  );
  const schedule = schedules.find((row: any) => Number(row?.Id) === classScheduleId);
  if (!schedule?.StartDate || !schedule?.EndDate) return [];

  const { enrollments } = await getClientEnrollmentsTool(
    clientId,
    String(schedule.StartDate).slice(0, 10),
    String(schedule.EndDate).slice(0, 10),
    client,
    cache
  );
  const mine = enrollments.find((entry) => entry.classScheduleId === classScheduleId);
  if (!mine) return [];

  const wanted = (session: ClientEnrollmentSession): boolean => {
    if (enrollDateForward) return session.startDateTime >= enrollDateForward;
    if (enrollOpenDates && enrollOpenDates.length > 0) return enrollOpenDates.includes(session.startDateTime);
    return true;
  };
  return mine.sessions.filter((session) => !session.lateCancelled && !session.isWaitlisted && wanted(session));
}

// ── getClientEnrollments ─────────────────────────────────────────────────────

export interface ClientEnrollmentSession {
  visitId: number;
  classId: number;
  startDateTime: string;
  endDateTime: string;
  signedIn: boolean;
  lateCancelled: boolean;
  /** Mindbody's `Missed` flag. The sandbox sets it on future, not-yet-attended sessions too, so it is not "absent". */
  missed: boolean;
  makeUp: boolean;
  isWaitlisted: boolean;
  waitlistEntryId?: number;
}

export interface ClientEnrollment {
  classScheduleId: number;
  name: string;
  programId?: number;
  programName?: string;
  staffId?: number;
  staffName: string;
  locationId?: number;
  locationName: string;
  semesterId?: number;
  sessions: ClientEnrollmentSession[];
  totals: { sessions: number; attended: number; missed: number; lateCancelled: number; waitlisted: number };
}

/**
 * A client's enrollments (courses, workshops, series) and their sessions.
 *
 * 1. GET /client/clientschedule (paginated, `Visits`, IncludeWaitlistEntries)
 *    for the window; rows with no ClassId are appointments and are dropped.
 * 2. GET /class/classes (paginated, `ClassIds` in chunks) resolves each class.
 *    A visit is an enrollment visit when its class's
 *    ClassDescription.Program.ScheduleType is `Enrollment`; drop-in class
 *    visits are left out. Sessions are grouped by ClassScheduleId.
 *
 * Without dates the window is today through DEFAULT_ENROLLMENT_WINDOW_DAYS in
 * the site's zone, so past sessions appear only when startDate is given.
 */
export async function getClientEnrollmentsTool(
  clientId: string,
  startDate?: string,
  endDate?: string,
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache
): Promise<{ enrollments: ClientEnrollment[]; totalEnrollments: number; totalSessions: number }> {
  const dates = await withDefaultDates(startDate, endDate, DEFAULT_ENROLLMENT_WINDOW_DAYS, client, cache);
  const { items: visits } = await fetchAllPages<any>(
    client,
    '/client/clientschedule',
    {
      ClientId: clientId,
      StartDate: dates.start,
      EndDate: dates.end,
      IncludeWaitlistEntries: true,
    },
    'Visits'
  );

  const classVisits = visits.filter((visit: any) => Number(visit?.ClassId) > 0);
  if (classVisits.length === 0) return { enrollments: [], totalEnrollments: 0, totalSessions: 0 };

  const classes = await lookupClasses(
    client,
    classVisits.map((visit: any) => Number(visit.ClassId)),
    `${dates.start}T00:00:00`,
    `${dates.end}T23:59:59`
  );

  const grouped = new Map<number, ClientEnrollment>();
  for (const visit of classVisits) {
    const cls = classes.get(Number(visit.ClassId));
    if (!cls || !isEnrollmentClass(cls)) continue;

    const scheduleId = Number(cls.ClassScheduleId);
    let entry = grouped.get(scheduleId);
    if (!entry) {
      entry = {
        classScheduleId: scheduleId,
        name: cls.ClassDescription?.Name ?? visit.Name ?? '',
        programId: cls.ClassDescription?.Program?.Id ?? undefined,
        programName: cls.ClassDescription?.Program?.Name ?? undefined,
        staffId: cls.Staff?.Id ?? visit.StaffId ?? undefined,
        staffName: staffName(cls.Staff),
        locationId: cls.Location?.Id ?? visit.LocationId ?? undefined,
        locationName: cls.Location?.Name ?? '',
        semesterId: cls.SemesterId ?? undefined,
        sessions: [],
        totals: { sessions: 0, attended: 0, missed: 0, lateCancelled: 0, waitlisted: 0 },
      };
      grouped.set(scheduleId, entry);
    }
    const waitlistEntryId = visit.WaitlistInfo?.WaitlistId ?? undefined;
    const session: ClientEnrollmentSession = {
      visitId: Number(visit.Id),
      classId: Number(visit.ClassId),
      startDateTime: visit.StartDateTime,
      endDateTime: visit.EndDateTime,
      signedIn: Boolean(visit.SignedIn),
      lateCancelled: Boolean(visit.LateCancelled),
      missed: Boolean(visit.Missed),
      makeUp: Boolean(visit.MakeUp),
      isWaitlisted: waitlistEntryId != null,
      waitlistEntryId,
    };
    entry.sessions.push(session);
    entry.totals.sessions += 1;
    if (session.signedIn) entry.totals.attended += 1;
    if (session.missed) entry.totals.missed += 1;
    if (session.lateCancelled) entry.totals.lateCancelled += 1;
    if (session.isWaitlisted) entry.totals.waitlisted += 1;
  }

  const enrollments = [...grouped.values()];
  for (const entry of enrollments) {
    entry.sessions.sort((a, b) => a.startDateTime.localeCompare(b.startDateTime));
  }
  enrollments.sort((a, b) => a.sessions[0].startDateTime.localeCompare(b.sessions[0].startDateTime));

  return {
    enrollments,
    totalEnrollments: enrollments.length,
    totalSessions: enrollments.reduce((sum, entry) => sum + entry.totals.sessions, 0),
  };
}

// ── cancelEnrollmentVisits ───────────────────────────────────────────────────

/** Hard cap on visits per cancellation request; a larger list is refused whole. */
export const MAX_ENROLLMENT_CANCELLATIONS_PER_REQUEST = 3;

/** Lookup window: the site-local date today through two years out. */
const CANCELLATION_LOOKUP_WINDOW_DAYS = 365 * 2;

const NOT_FOUND_FOR_CLIENT = 'not found for this client';

export interface CancelEnrollmentVisitsResult {
  success: boolean;
  cancelled: Array<{ visitId: number; classId: number; classScheduleId: number; startDateTime: string }>;
  rejected: Array<{ visitId: number; reason: string }>;
  message: string;
}

function validateCancellationRequest(
  clientId: unknown,
  visitIds: unknown
): Array<{ visitId: number; reason: string }> {
  if (typeof clientId !== 'string' || clientId.trim() === '') {
    return [{ visitId: -1, reason: 'clientId must be a non-empty string' }];
  }
  if (!Array.isArray(visitIds) || visitIds.length === 0) {
    return [{ visitId: -1, reason: 'visitIds must be a non-empty array' }];
  }
  if (visitIds.length > MAX_ENROLLMENT_CANCELLATIONS_PER_REQUEST) {
    return [{
      visitId: -1,
      reason: `at most ${MAX_ENROLLMENT_CANCELLATIONS_PER_REQUEST} visits may be cancelled per request (got ${visitIds.length}); nothing was cancelled`,
    }];
  }
  const rejected: Array<{ visitId: number; reason: string }> = [];
  const seen = new Set<number>();
  for (const id of visitIds) {
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
      rejected.push({
        visitId: typeof id === 'number' && Number.isFinite(id) ? id : -1,
        reason: `visit id ${JSON.stringify(id)} is not a positive integer`,
      });
    } else if (seen.has(id)) {
      rejected.push({ visitId: id, reason: 'duplicate visit id in request' });
    } else {
      seen.add(id);
    }
  }
  return rejected;
}

/** Why a looked-up visit may not be cancelled, or null if it may. */
function visitRejectionReason(
  rows: any[],
  clientId: string,
  classes: Map<number, any>,
  nowMs: number,
  timeZone: string,
  lateCancelWindowHrs?: number
): string | null {
  if (rows.length === 0) return NOT_FOUND_FOR_CLIENT;
  if (rows.length > 1) return 'visit returned more than once by lookup; refusing ambiguous data';
  const row = rows[0];

  // The schedule was fetched for this client; a differing ClientId on the row
  // is treated exactly like "missing", so nothing about other clients leaks.
  if (row.ClientId != null && String(row.ClientId) !== clientId) return NOT_FOUND_FOR_CLIENT;
  if (!(Number(row.ClassId) > 0)) return 'visit is an appointment, not an enrollment session';
  if (row.WaitlistInfo?.WaitlistId != null) {
    return `visit is a waitlist entry (${row.WaitlistInfo.WaitlistId}), not a booked session; remove it from the waitlist instead`;
  }

  const cls = classes.get(Number(row.ClassId));
  if (!cls) return `class ${row.ClassId} could not be resolved`;
  if (!isEnrollmentClass(cls)) return 'visit is a drop-in class, not an enrollment session; use removeClientFromClass';

  const startMs = siteLocalToEpochMs(row.StartDateTime, timeZone);
  if (Number.isNaN(startMs)) return 'visit start time could not be parsed';
  if (startMs <= nowMs) return 'session has already started or is in the past';

  if (row.LateCancelled) return 'visit is already late-cancelled';
  if (row.SignedIn) return 'visit is already signed in';
  // `Missed` is NOT a guard: the sandbox reports Missed: true on every future,
  // not-yet-attended enrollment visit, so it says nothing about cancellability.
  return lateCancelWindowHrs === undefined ? null : lateCancelWindowRefusal(startMs, nowMs, lateCancelWindowHrs);
}

/**
 * Cancel 1..MAX_ENROLLMENT_CANCELLATIONS_PER_REQUEST future enrollment sessions
 * for ONE client, via POST /class/removeclientfromclass (ClientId, ClassId,
 * VisitId, LateCancel, SendEmail). Mindbody accepts enrollment visits on this
 * endpoint (verified on the sandbox with Test: true).
 *
 * Every guard runs before any write: request shape, site zone, ownership
 * (the visit is on the client's own schedule), it is a booked enrollment
 * session (not an appointment, waitlist entry or drop-in class), it is in the
 * future in the site's zone, and it is not already late-cancelled or signed
 * in. All-or-nothing: any rejection means nothing is written. Writes
 * are sequential and stop at the first upstream failure; the ones already
 * made stand and are reported.
 *
 * To move a client to other dates, cancel here and re-add with
 * addClientToEnrollment: Mindbody has no "move" operation for enrollments.
 */
export async function cancelEnrollmentVisitsTool(
  clientId: string,
  visitIds: number[],
  lateCancel?: boolean,
  sendEmail?: boolean,
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache
): Promise<CancelEnrollmentVisitsResult> {
  const shapeErrors = validateCancellationRequest(clientId, visitIds);
  if (shapeErrors.length > 0) {
    return { success: false, cancelled: [], rejected: shapeErrors, message: 'Request rejected; no visits were cancelled.' };
  }

  // `lateCancel` forfeits the session, so it is honoured only inside the site's
  // late-cancel window, which the spec does not expose. Unknown window: refuse.
  const lateWindowHours = lateCancel ? lateCancelWindowHours() : undefined;
  if (lateCancel && lateWindowHours === undefined) {
    return {
      success: false,
      cancelled: [],
      rejected: [{ visitId: -1, reason: LATE_CANCEL_WINDOW_UNKNOWN }],
      message: 'Late-cancel window unknown; no visits were cancelled.',
    };
  }

  let timeZone: string;
  try {
    timeZone = await getSiteTimeZone(client, cache);
  } catch (error: unknown) {
    return {
      success: false,
      cancelled: [],
      rejected: [{ visitId: -1, reason: `site timezone unavailable: ${errorMessage(error, 'unknown error')}` }],
      message: 'Could not determine the site timezone; no visits were cancelled.',
    };
  }

  const now = new Date();
  const start = siteDateString(now, timeZone);
  const end = siteDateStringPlusDays(now, timeZone, CANCELLATION_LOOKUP_WINDOW_DAYS);
  let rows: any[];
  let classes: Map<number, any>;
  try {
    ({ items: rows } = await fetchAllPages<any>(
      client,
      '/client/clientschedule',
      { ClientId: clientId, StartDate: start, EndDate: end, IncludeWaitlistEntries: true },
      'Visits'
    ));
    const wanted = rows.filter((row) => visitIds.includes(Number(row?.Id)) && Number(row?.ClassId) > 0);
    classes = await lookupClasses(
      client,
      wanted.map((row) => Number(row.ClassId)),
      `${start}T00:00:00`,
      `${end}T23:59:59`
    );
  } catch (error: unknown) {
    return {
      success: false,
      cancelled: [],
      rejected: [{ visitId: -1, reason: `visit lookup failed: ${errorMessage(error, 'unknown error')}` }],
      message: 'Could not verify the visits; no visits were cancelled.',
    };
  }

  const rejected: CancelEnrollmentVisitsResult['rejected'] = [];
  const verified = new Map<number, any>();
  for (const id of visitIds) {
    const matches = rows.filter((row) => Number(row?.Id) === id);
    const reason = visitRejectionReason(matches, clientId, classes, Date.now(), timeZone, lateWindowHours);
    if (reason) rejected.push({ visitId: id, reason });
    else verified.set(id, matches[0]);
  }
  if (rejected.length > 0) {
    return {
      success: false,
      cancelled: [],
      rejected,
      message: `${rejected.length} of ${visitIds.length} visit(s) failed verification; none were cancelled (all-or-nothing).`,
    };
  }

  const cancelled: CancelEnrollmentVisitsResult['cancelled'] = [];
  for (const id of visitIds) {
    const row = verified.get(id);
    try {
      await client.post<any>('/class/removeclientfromclass', {
        ClientId: clientId,
        ClassId: Number(row.ClassId),
        VisitId: id,
        LateCancel: lateCancel ?? false,
        SendEmail: sendEmail ?? false,
        Test: false,
      });
      cancelled.push({
        visitId: id,
        classId: Number(row.ClassId),
        classScheduleId: Number(classes.get(Number(row.ClassId))?.ClassScheduleId),
        startDateTime: row.StartDateTime,
      });
    } catch (error: unknown) {
      const notAttempted = visitIds.slice(cancelled.length + 1);
      cache.clear();
      return {
        success: false,
        cancelled,
        rejected: [{ visitId: id, reason: errorMessage(error, 'cancellation failed') }],
        message:
          `Cancelled ${cancelled.length} of ${visitIds.length} before visit ${id} failed; stopped.` +
          (notAttempted.length > 0 ? ` Not attempted: ${notAttempted.join(', ')}.` : ''),
      };
    }
  }

  cache.clear();
  return {
    success: true,
    cancelled,
    rejected: [],
    message: `Cancelled ${cancelled.length} enrollment session(s)${lateCancel ? ' as late cancellations' : ''}.`,
  };
}
