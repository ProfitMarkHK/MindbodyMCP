/**
 * A client's upcoming bookings, one flat row per booking, shaped so a cancel
 * flow can resolve "Jane's 6pm tonight" to the ids the cancel tools take.
 *
 * Reads GET /client/clientschedule (through the enrollment module's shared
 * `fetchClientSchedule`, so the endpoint is read one way) and, for class rows
 * only, GET /class/classes to learn each class's program. Read-only: no POST.
 *
 * This tool reports timestamps and flags only. Whether a cancellation would be
 * late is the cancel path's decision, not this one's.
 */
import { mindbodyClient, type IMindbodyClient } from '../api/client.js';
import { classCache, SimpleCache } from '../cache/index.js';
import { withDefaultDates } from '../utils/siteTime.js';
import { fetchClientSchedule, isEnrollmentClass, lookupClasses } from './enrollmentManagement.js';
import { nameFor } from './clientActivity.js';
import { locationNames, staffNames } from './lookups.js';

/** Default lookahead in days: today through 30 days out, "what can still be cancelled". */
export const DEFAULT_CLIENT_SCHEDULE_WINDOW_DAYS = 30;

/**
 * What a booking is, which also says which cancel tool takes it:
 *  - `waitlist`: a waitlist entry (`waitlistEntryId`), not a seat
 *  - `appointment`: `appointmentId`, for cancelAppointments
 *  - `enrollment`: a session of an Enrollment program, `visitId` for cancelEnrollmentVisits
 *  - `class`: any other class visit, `classId` for removeClientFromClass
 */
export type ClientBookingKind = 'waitlist' | 'appointment' | 'enrollment' | 'class';

export interface ClientBooking {
  kind: ClientBookingKind;
  visitId: number;
  /** Undefined for an appointment (Mindbody sends `ClassId: 0`). */
  classId?: number;
  /** The class's ClassScheduleId; undefined for appointments and unresolved classes. */
  classScheduleId?: number;
  /** Undefined for a class or enrollment visit (Mindbody sends `AppointmentId: 0`). */
  appointmentId?: number;
  /** Mindbody's `AppointmentStatus`, on appointment rows only. */
  appointmentStatus?: string;
  /** Site-local, no UTC offset, exactly as Mindbody returns it. */
  startDateTime: string;
  endDateTime: string;
  name?: string;
  staffId?: number;
  staffName?: string;
  locationId?: number;
  locationName?: string;
  /** The client's purchase that pays for the visit (Visit.ServiceId). */
  serviceId?: number;
  serviceName?: string;
  /** The pricing option itself (Visit.ProductId); what a late-cancel rule's serviceId matches. */
  productId?: number;
  /** From the class's ClassDescription.Program; undefined for appointments and unresolved classes. */
  programId?: number;
  programName?: string;
  /** From the class's ClassDescription.SessionType; undefined for appointments and unresolved classes. */
  sessionTypeId?: number;
  signedIn: boolean;
  lateCancelled: boolean;
  /** Mindbody's `Missed` flag. The sandbox sets it on future, not-yet-attended enrollment visits too. */
  missed: boolean;
  isWaitlisted: boolean;
  waitlistEntryId?: number;
}

function positiveId(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Precedence: waitlist, then appointment, then enrollment, then class. */
function bookingKind(visit: any, cls: any): ClientBookingKind {
  if (visit?.WaitlistInfo?.WaitlistId != null) return 'waitlist';
  if (positiveId(visit?.AppointmentId) !== undefined) return 'appointment';
  if (cls && isEnrollmentClass(cls)) return 'enrollment';
  return 'class';
}

/**
 * A client's bookings in a window: classes, enrollment sessions, appointments
 * and waitlist entries, sorted by start time.
 *
 * 1. GET /client/clientschedule (every page, `IncludeWaitlistEntries: true`).
 * 2. GET /class/classes for the rows with a ClassId, only when there are any,
 *    to read each class's program. A class the lookup does not return stays
 *    `kind: 'class'` with no program.
 * 3. Staff and location names from the cached catalogues, each read only when
 *    some row carries the id; a missing id leaves the name `undefined`.
 *
 * Without dates the window is today through DEFAULT_CLIENT_SCHEDULE_WINDOW_DAYS
 * in the site's zone. Given dates are sent unchanged.
 */
export async function getClientScheduleTool(
  clientId: string,
  startDate?: string,
  endDate?: string,
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache
): Promise<{ bookings: ClientBooking[]; totalBookings: number }> {
  const dates = await withDefaultDates(startDate, endDate, DEFAULT_CLIENT_SCHEDULE_WINDOW_DAYS, client, cache);
  const visits = await fetchClientSchedule(client, clientId, dates.start, dates.end);
  if (visits.length === 0) return { bookings: [], totalBookings: 0 };

  const classIds = visits.map((visit) => positiveId(visit?.ClassId)).filter((id): id is number => id !== undefined);
  const wantsLocations = visits.some((visit) => typeof visit?.LocationId === 'number');
  const wantsStaff = visits.some((visit) => typeof visit?.StaffId === 'number');
  const [classes, locations, staff] = await Promise.all([
    classIds.length > 0
      ? lookupClasses(client, classIds, `${dates.start}T00:00:00`, `${dates.end}T23:59:59`)
      : new Map<number, any>(),
    wantsLocations ? locationNames(client, cache) : new Map<number, string>(),
    wantsStaff ? staffNames(client, cache) : new Map<number, string>(),
  ]);

  const bookings = visits.map((visit): ClientBooking => {
    const classId = positiveId(visit?.ClassId);
    const appointmentId = positiveId(visit?.AppointmentId);
    const cls = classId === undefined ? undefined : classes.get(classId);
    const program = cls?.ClassDescription?.Program;
    const waitlistEntryId = optionalNumber(visit?.WaitlistInfo?.WaitlistId);
    return {
      kind: bookingKind(visit, cls),
      visitId: Number(visit?.Id),
      classId,
      classScheduleId: positiveId(cls?.ClassScheduleId),
      appointmentId,
      appointmentStatus: appointmentId === undefined ? undefined : visit?.AppointmentStatus ?? undefined,
      startDateTime: visit?.StartDateTime,
      endDateTime: visit?.EndDateTime,
      name: visit?.Name ?? undefined,
      staffId: optionalNumber(visit?.StaffId),
      staffName: nameFor(staff, visit?.StaffId),
      locationId: optionalNumber(visit?.LocationId),
      locationName: nameFor(locations, visit?.LocationId),
      serviceId: optionalNumber(visit?.ServiceId),
      serviceName: visit?.ServiceName ?? undefined,
      productId: optionalNumber(visit?.ProductId),
      programId: optionalNumber(program?.Id),
      programName: program?.Name ?? undefined,
      sessionTypeId: optionalNumber(cls?.ClassDescription?.SessionType?.Id),
      signedIn: Boolean(visit?.SignedIn),
      lateCancelled: Boolean(visit?.LateCancelled),
      missed: Boolean(visit?.Missed),
      isWaitlisted: waitlistEntryId !== undefined,
      waitlistEntryId,
    };
  });
  bookings.sort((a, b) => String(a.startDateTime).localeCompare(String(b.startDateTime)));

  return { bookings, totalBookings: bookings.length };
}
