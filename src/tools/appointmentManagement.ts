import { fetchAllPages, mindbodyClient, type IMindbodyClient } from '../api/client.js';
import { classCache, SimpleCache } from '../cache/index.js';
import {
  getSiteTimeZone,
  siteDateString,
  siteDateStringPlusDays,
  siteLocalToEpochMs,
  withDefaultDates,
} from '../utils/siteTime.js';

// Get appointments
export async function getStaffAppointmentsTool(
  staffIds: number[],
  locationIds?: number[],
  startDate?: string,
  endDate?: string,
  appointmentIds?: number[],
  clientId?: string,
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache
): Promise<{
  appointments: Array<{
    id: number;
    status: string;
    staffId: number;
    staffName: string;
    sessionTypeId: number;
    sessionTypeName: string;
    locationId: number;
    locationName: string;
    startDateTime: string;
    endDateTime: string;
    clientId?: string;
    clientName?: string;
    clientEmail?: string;
    clientPhone?: string;
    notes?: string;
    staffRequested: boolean;
    providerId?: string;
    duration: number;
    confirmed?: boolean;
    firstAppointment: boolean;
    resources?: Array<{ id: number; name: string }>;
  }>;
  totalAppointments: number;
}> {
  const dates = await withDefaultDates(startDate, endDate, 7, client, cache);
  const { items: appointmentRows, totalResults } = await fetchAllPages<any>(
    client,
    '/appointment/staffappointments',
    {
      StaffIds: staffIds,
      LocationIds: locationIds,
      StartDate: dates.start,
      EndDate: dates.end,
      AppointmentIds: appointmentIds,
      // The spec defines a single `request.clientId`, not a list.
      ClientId: clientId,
    },
    'Appointments'
  );

  const appointments = appointmentRows.map((apt: any) => ({
    id: apt.Id,
    status: apt.Status,
    staffId: apt.StaffId || apt.Staff?.Id,
    staffName: apt.Staff?.Name || `${apt.Staff?.FirstName} ${apt.Staff?.LastName}`,
    sessionTypeId: apt.SessionTypeId || apt.SessionType?.Id,
    sessionTypeName: apt.SessionType?.Name || '',
    locationId: apt.LocationId || apt.Location?.Id,
    locationName: apt.Location?.Name || '',
    startDateTime: apt.StartDateTime,
    endDateTime: apt.EndDateTime,
    clientId: apt.ClientId || apt.Client?.Id,
    clientName: apt.Client ? `${apt.Client.FirstName} ${apt.Client.LastName}` : undefined,
    clientEmail: apt.Client?.Email,
    clientPhone: apt.Client?.MobilePhone,
    notes: apt.Notes,
    staffRequested: apt.StaffRequested,
    providerId: apt.ProviderId,
    duration: apt.Duration,
    confirmed: apt.Confirmed,
    firstAppointment: apt.FirstAppointment,
    resources: apt.Resources?.map((r: any) => ({ id: r.Id, name: r.Name })),
  }));

  return {
    appointments,
    totalAppointments: totalResults || appointments.length,
  };
}

// Add appointment
export async function addAppointmentTool(
  clientId: string,
  staffId: number,
  locationId: number,
  sessionTypeId: number,
  startDateTime: string,
  resourceIds?: number[],
  notes?: string,
  staffRequested?: boolean,
  // Accepted for backward compatibility and ignored: `ExecutePayment` is not a
  // field of AddAppointmentRequest in docs/openapi.json.
  _executePayment?: boolean,
  sendEmail?: boolean,
  applyPayment?: boolean,
  client: IMindbodyClient = mindbodyClient
): Promise<{
  success: boolean;
  appointment?: {
    id: number;
    status: string;
    startDateTime: string;
    endDateTime: string;
    duration: number;
    staffName: string;
    sessionTypeName: string;
    locationName: string;
  };
  message: string;
}> {
  try {
    const response = await client.post<any>('/appointment/addappointment', {
      ClientId: clientId,
      StaffId: staffId,
      LocationId: locationId,
      SessionTypeId: sessionTypeId,
      StartDateTime: startDateTime,
      ResourceIds: resourceIds,
      Notes: notes,
      StaffRequested: staffRequested,
      SendEmail: sendEmail,
      ApplyPayment: applyPayment,
    });

    return {
      success: true,
      appointment: {
        id: response.Appointment.Id,
        status: response.Appointment.Status,
        startDateTime: response.Appointment.StartDateTime,
        endDateTime: response.Appointment.EndDateTime,
        duration: response.Appointment.Duration,
        staffName: response.Appointment.Staff?.Name || `${response.Appointment.Staff?.FirstName || ''} ${response.Appointment.Staff?.LastName || ''}`.trim() || '',
        sessionTypeName: response.Appointment.SessionType?.Name || '',
        locationName: response.Appointment.Location?.Name || '',
      },
      message: response.Message || 'Appointment booked successfully',
    };
  } catch (error: any) {
    return {
      success: false,
      message: error.message || 'Failed to book appointment',
    };
  }
}

// Update appointment

/**
 * `Execute` values updateAppointment will forward. The spec also allows `cancel`
 * and `latecancel`; those are deliberately excluded here and routed through
 * `cancelAppointmentsTool`, which verifies ownership, timing and status first.
 */
export const UPDATE_APPOINTMENT_EXECUTE_VALUES = [
  'confirm',
  'unconfirm',
  'arrive',
  'unarrive',
  'complete',
] as const;

export type UpdateAppointmentExecute = (typeof UPDATE_APPOINTMENT_EXECUTE_VALUES)[number];

export async function updateAppointmentTool(
  appointmentId: number,
  staffId?: number,
  startDateTime?: string,
  endDateTime?: string,
  resourceIds?: number[],
  notes?: string,
  // Accepted for backward compatibility and ignored: `ExecutePayment` is not a
  // field of UpdateAppointmentRequest in docs/openapi.json.
  _executePayment?: boolean,
  sendEmail?: boolean,
  applyPayment?: boolean,
  execute?: UpdateAppointmentExecute,
  client: IMindbodyClient = mindbodyClient
): Promise<{
  success: boolean;
  appointment?: {
    id: number;
    status: string;
    startDateTime: string;
    endDateTime: string;
    staffName: string;
  };
  message: string;
}> {
  // MCP arguments are untyped at runtime, so the union above is not a guarantee.
  if (
    execute !== undefined &&
    !(UPDATE_APPOINTMENT_EXECUTE_VALUES as readonly string[]).includes(execute)
  ) {
    const value = String(execute);
    const isCancel = value.toLowerCase() === 'cancel' || value.toLowerCase() === 'latecancel';
    return {
      success: false,
      message: isCancel
        ? `updateAppointment does not cancel appointments. Use cancelAppointments, which verifies the client, timing and status before cancelling.`
        : `Unsupported execute value "${value}". Allowed: ${UPDATE_APPOINTMENT_EXECUTE_VALUES.join(', ')}. To cancel, use cancelAppointments.`,
    };
  }

  try {
    const response = await client.post<any>('/appointment/updateappointment', {
      AppointmentId: appointmentId,
      StaffId: staffId,
      StartDateTime: startDateTime,
      EndDateTime: endDateTime,
      ResourceIds: resourceIds,
      Notes: notes,
      Execute: execute,
      SendEmail: sendEmail,
      ApplyPayment: applyPayment,
    });

    return {
      success: true,
      appointment: {
        id: response.Appointment.Id,
        status: response.Appointment.Status,
        startDateTime: response.Appointment.StartDateTime,
        endDateTime: response.Appointment.EndDateTime,
        staffName: response.Appointment.Staff?.Name || `${response.Appointment.Staff?.FirstName || ''} ${response.Appointment.Staff?.LastName || ''}`.trim() || '',
      },
      message: 'Appointment updated successfully',
    };
  } catch (error: any) {
    return {
      success: false,
      message: error.message || 'Failed to update appointment',
    };
  }
}

// Cancel appointments

/** Hard ceiling on how many appointments one cancelAppointments call may touch. */
export const MAX_CANCELLATIONS_PER_REQUEST = 3;

/** Statuses from which a cancellation is refused. */
const NON_CANCELLABLE_STATUSES = new Set(['Cancelled', 'LateCancelled', 'Completed', 'NoShow']);

/** Lookup window: the site-local date today through two years out, so past days are excluded. */
const CANCELLATION_LOOKUP_WINDOW_DAYS = 365 * 2;

const NOT_FOUND_FOR_CLIENT = 'not found for this client';

export interface CancelAppointmentsResult {
  success: boolean;
  cancelled: Array<{ id: number; status: string; startDateTime: string }>;
  rejected: Array<{ id: number; reason: string }>;
  message: string;
}

/** Request-shape checks. Returns rejections; empty means the shape is valid. */
function validateCancellationRequest(
  clientId: unknown,
  appointmentIds: unknown
): Array<{ id: number; reason: string }> {
  if (typeof clientId !== 'string' || clientId.trim() === '') {
    return [{ id: -1, reason: 'clientId must be a non-empty string' }];
  }
  if (!Array.isArray(appointmentIds) || appointmentIds.length === 0) {
    return [{ id: -1, reason: 'appointmentIds must be a non-empty array' }];
  }
  if (appointmentIds.length > MAX_CANCELLATIONS_PER_REQUEST) {
    return [{
      id: -1,
      reason: `at most ${MAX_CANCELLATIONS_PER_REQUEST} appointments may be cancelled per request (got ${appointmentIds.length}); nothing was cancelled`,
    }];
  }

  const rejected: Array<{ id: number; reason: string }> = [];
  const seen = new Set<number>();
  for (const id of appointmentIds) {
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
      rejected.push({
        id: typeof id === 'number' && Number.isFinite(id) ? id : -1,
        reason: `appointment id ${JSON.stringify(id)} is not a positive integer`,
      });
    } else if (seen.has(id)) {
      rejected.push({ id, reason: 'duplicate appointment id in request' });
    } else {
      seen.add(id);
    }
  }
  return rejected;
}

/** Why a looked-up appointment may not be cancelled, or null if it may. */
function cancellationRejectionReason(
  rows: any[],
  clientId: string,
  nowMs: number,
  timeZone: string
): string | null {
  if (rows.length === 0) return NOT_FOUND_FOR_CLIENT;
  if (rows.length > 1) return 'appointment returned more than once by lookup; refusing ambiguous data';

  const row = rows[0];
  // Never reveal which client owns it; a mismatch looks exactly like "missing".
  const rowClientId = row.ClientId ?? row.Client?.Id;
  if (rowClientId === undefined || rowClientId === null || String(rowClientId) !== clientId) {
    return NOT_FOUND_FOR_CLIENT;
  }

  // Mindbody returns StartDateTime as site-local wall time with no UTC offset.
  // It is converted to a UTC instant using the SITE's IANA zone (never this
  // process's zone), so the comparison with "now" is correct wherever the server
  // runs. DST gaps/overlaps follow siteTime.ts's documented disambiguation; an
  // unparseable value is rejected outright.
  const startMs = siteLocalToEpochMs(row.StartDateTime, timeZone);
  if (Number.isNaN(startMs)) return 'appointment start time could not be parsed';
  if (startMs <= nowMs) return 'appointment has already started or is in the past';

  if (NON_CANCELLABLE_STATUSES.has(row.Status)) {
    return `appointment status is ${row.Status}, which cannot be cancelled`;
  }
  return null;
}

/**
 * Cancel 1..MAX_CANCELLATIONS_PER_REQUEST future appointments for ONE client.
 *
 * Every guard is evaluated before any write: request shape, ownership, start
 * time and status. All-or-nothing: if any id fails a guard, nothing is
 * cancelled. Writes are sequential and stop at the first upstream failure.
 */
export async function cancelAppointmentsTool(
  clientId: string,
  appointmentIds: number[],
  lateCancel?: boolean,
  sendEmail?: boolean,
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache
): Promise<CancelAppointmentsResult> {
  const shapeErrors = validateCancellationRequest(clientId, appointmentIds);
  if (shapeErrors.length > 0) {
    return {
      success: false,
      cancelled: [],
      rejected: shapeErrors,
      message: 'Request rejected; no appointments were cancelled.',
    };
  }

  // Fail closed: without the site's zone, "today" and "already started" cannot
  // be decided, so nothing is looked up or written.
  let timeZone: string;
  try {
    timeZone = await getSiteTimeZone(client, cache);
  } catch (error: any) {
    return {
      success: false,
      cancelled: [],
      rejected: [{ id: -1, reason: `site timezone unavailable: ${error?.message ?? 'unknown error'}` }],
      message: 'Could not determine the site timezone; no appointments were cancelled.',
    };
  }

  const now = new Date();
  let rows: any[];
  try {
    ({ items: rows } = await fetchAllPages<any>(
      client,
      '/appointment/staffappointments',
      {
        AppointmentIds: appointmentIds,
        ClientId: clientId,
        StartDate: siteDateString(now, timeZone),
        EndDate: siteDateStringPlusDays(now, timeZone, CANCELLATION_LOOKUP_WINDOW_DAYS),
      },
      'Appointments'
    ));
  } catch (error: any) {
    return {
      success: false,
      cancelled: [],
      rejected: [{ id: -1, reason: `appointment lookup failed: ${error?.message ?? 'unknown error'}` }],
      message: 'Could not verify the appointments; no appointments were cancelled.',
    };
  }

  const rejected: Array<{ id: number; reason: string }> = [];
  const verified = new Map<number, any>();
  for (const id of appointmentIds) {
    const matches = rows.filter((row) => Number(row?.Id) === id);
    const reason = cancellationRejectionReason(matches, clientId, Date.now(), timeZone);
    if (reason) {
      rejected.push({ id, reason });
    } else {
      verified.set(id, matches[0]);
    }
  }

  if (rejected.length > 0) {
    return {
      success: false,
      cancelled: [],
      rejected,
      message: `${rejected.length} of ${appointmentIds.length} appointment(s) failed verification; none were cancelled (all-or-nothing).`,
    };
  }

  const execute = lateCancel ? 'latecancel' : 'cancel';
  const cancelled: CancelAppointmentsResult['cancelled'] = [];
  for (const id of appointmentIds) {
    try {
      const response = await client.post<any>('/appointment/updateappointment', {
        AppointmentId: id,
        Execute: execute,
        SendEmail: sendEmail ?? false,
      });
      const row = verified.get(id);
      cancelled.push({
        id,
        status: response?.Appointment?.Status ?? (lateCancel ? 'LateCancelled' : 'Cancelled'),
        startDateTime: response?.Appointment?.StartDateTime ?? row.StartDateTime,
      });
    } catch (error: any) {
      const notAttempted = appointmentIds.slice(cancelled.length + 1);
      return {
        success: false,
        cancelled,
        rejected: [{ id, reason: error?.message || 'cancellation failed' }],
        message:
          `Cancelled ${cancelled.length} of ${appointmentIds.length} before appointment ${id} failed; stopped.` +
          (notAttempted.length > 0 ? ` Not attempted: ${notAttempted.join(', ')}.` : ''),
      };
    }
  }

  return {
    success: true,
    cancelled,
    rejected: [],
    message: `Cancelled ${cancelled.length} appointment(s)${lateCancel ? ' as late cancellations' : ''}.`,
  };
}

// Get bookable items (services available for appointment booking)
export async function getBookableItemsTool(
  sessionTypeIds: number[],
  locationIds?: number[],
  staffIds?: number[],
  startDate?: string,
  endDate?: string,
  appointmentId?: number,
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache
): Promise<{
  bookableItems: Array<{
    scheduledItemId: number;
    staffId: number;
    staffName: string;
    sessionTypeId: number;
    sessionTypeName: string;
    locationId: number;
    locationName: string;
    startDateTime: string;
    endDateTime: string;
    isAvailable: boolean;
    isSingleSessionBookable?: boolean;
  }>;
  totalItems: number;
}> {
  const dates = await withDefaultDates(startDate, endDate, 7, client, cache);
  const { items: bookableRaw, totalResults } = await fetchAllPages<any>(
    client,
    '/appointment/bookableitems',
    {
      SessionTypeIds: sessionTypeIds,
      LocationIds: locationIds,
      StaffIds: staffIds,
      StartDate: dates.start,
      EndDate: dates.end,
      AppointmentId: appointmentId,
    },
    // GetBookableItemsResponse documents exactly one list key, `Availabilities`.
    'Availabilities'
  );

  const bookableItems = bookableRaw.map((item: any) => ({
    scheduledItemId: item.ScheduledItemId ?? item.Id ?? item.ScheduledId,
    staffId: item.StaffId ?? item.Staff?.Id,
    staffName: item.Staff?.Name || `${item.Staff?.FirstName || ''} ${item.Staff?.LastName || ''}`.trim() || '',
    sessionTypeId: item.SessionTypeId ?? item.SessionType?.Id,
    sessionTypeName: item.SessionType?.Name || item.SessionTypeName || '',
    locationId: item.LocationId ?? item.Location?.Id,
    locationName: item.Location?.Name || item.LocationName || '',
    startDateTime: item.StartDateTime ?? item.StartTime,
    endDateTime: item.EndDateTime ?? item.EndTime,
    isAvailable: item.IsAvailable ?? true,
    isSingleSessionBookable: item.IsSingleSessionBookable,
  }));

  return {
    bookableItems,
    totalItems: totalResults,
  };
}

// Get active session times: the start-time increments at which sessions can be
// scheduled (business hours), not bookable availability (see getBookableItems).
// GET /appointment/activesessiontimes returns plain "HH:MM:SS" strings in
// `ActiveSessionTimes`, plus a per-session-type breakdown in
// `SessionTypeActiveSessionTimes` (documented in GetActiveSessionTimesResponse).
//
// The endpoint is paginated. Pages are walked over `ActiveSessionTimes`; the
// per-session-type breakdown rides along on every page, so it is merged across
// pages by SessionTypeId (first-seen order, each type's times de-duplicated)
// rather than read from page one only.
export async function getActiveSessionTimesTool(
  scheduleType?: 'All' | 'Class' | 'Enrollment' | 'Appointment',
  sessionTypeIds?: number[],
  startTime?: string,
  endTime?: string,
  days?: string[],
  client: IMindbodyClient = mindbodyClient
): Promise<{
  activeTimes: string[];
  bySessionType: Array<{ sessionTypeId: number; activeTimes: string[] }>;
  totalActiveTimes: number;
}> {
  const merged = new Map<unknown, Set<string>>();
  const { items: timeRows } = await fetchAllPages<unknown>(
    client,
    '/appointment/activesessiontimes',
    {
      ScheduleType: scheduleType || 'All',
      SessionTypeIds: sessionTypeIds,
      StartTime: startTime,
      EndTime: endTime,
      Days: days,
    },
    'ActiveSessionTimes',
    undefined,
    {
      onPage: (page) => {
        const groups = Array.isArray(page?.SessionTypeActiveSessionTimes) ? page.SessionTypeActiveSessionTimes : [];
        for (const entry of groups) {
          const times = merged.get(entry?.SessionTypeId) ?? new Set<string>();
          for (const time of toTimeStrings(entry?.ActiveSessionTimes)) times.add(time);
          merged.set(entry?.SessionTypeId, times);
        }
      },
    }
  );

  const activeTimes = toTimeStrings(timeRows);
  const bySessionType = [...merged].map(([sessionTypeId, times]) => ({
    sessionTypeId: sessionTypeId as number,
    activeTimes: [...times],
  }));

  return {
    activeTimes,
    bySessionType,
    totalActiveTimes: activeTimes.length,
  };
}

function toTimeStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((time): time is string => typeof time === 'string') : [];
}

// Get schedule items (appointments in a schedule)
export async function getScheduleItemsTool(
  locationIds?: number[],
  staffIds?: number[],
  startDate?: string,
  endDate?: string,
  ignorePrepFinishBuffer: boolean = false,
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache
): Promise<{
  scheduleItems: Array<{
    id: number;
    isAvailable: boolean;
    isUnavailable: boolean;
    staffId: number;
    staffName: string;
    sessionTypeId: number;
    sessionTypeName: string;
    locationId: number;
    locationName: string;
    startDateTime: string;
    endDateTime: string;
  }>;
  totalItems: number;
}> {
  const dates = await withDefaultDates(startDate, endDate, 7, client, cache);
  const { items: scheduleRows, totalResults } = await fetchAllPages<any>(
    client,
    '/appointment/scheduleitems',
    {
      LocationIds: locationIds,
      StaffIds: staffIds,
      StartDate: dates.start,
      EndDate: dates.end,
      IgnorePrepFinishBuffer: ignorePrepFinishBuffer,
    },
    'StaffMembers'
  );

  const scheduleItems = scheduleRows.flatMap((staff: any) => 
    (staff.Appointments ?? []).map((apt: any) => ({
      id: apt.Id,
      isAvailable: apt.IsAvailable,
      isUnavailable: apt.Unavailable,
      staffId: staff.Id,
      staffName: staff.Name,
      sessionTypeId: apt.SessionType?.Id,
      sessionTypeName: apt.SessionType?.Name,
      locationId: apt.Location?.Id,
      locationName: apt.Location?.Name,
      startDateTime: apt.StartDateTime,
      endDateTime: apt.EndDateTime,
    }))
  );

  return {
    scheduleItems,
    totalItems: totalResults || scheduleItems.length,
  };
}