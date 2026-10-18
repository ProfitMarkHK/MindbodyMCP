import { fetchAllPages, mindbodyClient, type IMindbodyClient } from '../api/client.js';
import { classCache, SimpleCache } from '../cache/index.js';
import { locationNames, sessionTypeNames } from './lookups.js';
import {
  getSiteTimeZone,
  siteDateStringPlusDays,
  siteLocalToEpochMs,
  withDefaultDates,
} from '../utils/siteTime.js';

/**
 * The name on an embedded `AppointmentStaff`: `DisplayName` if present, else
 * first and last name joined. `AppointmentStaff` documents only `Id`,
 * `FirstName`, `LastName` and `DisplayName`, so anything else is undefined —
 * never an empty string, which would read as a name the API gave us.
 */
function appointmentStaffName(staff: any): string | undefined {
  const displayName = typeof staff?.DisplayName === 'string' ? staff.DisplayName.trim() : '';
  if (displayName !== '') return displayName;
  const first = typeof staff?.FirstName === 'string' ? staff.FirstName.trim() : '';
  const last = typeof staff?.LastName === 'string' ? staff.LastName.trim() : '';
  const joined = `${first} ${last}`.trim();
  return joined === '' ? undefined : joined;
}

/**
 * A name index for `idField`, read only when at least one row carries a usable
 * id for it. Keeps a read that needs no cross-reference from paying for one.
 */
async function lazyNames(
  rows: any[],
  idField: string,
  load: () => Promise<Map<number, string>>
): Promise<Map<number, string>> {
  const needed = rows.some((row) => {
    const id = row?.[idField];
    return typeof id === 'number' && Number.isFinite(id);
  });
  return needed ? load() : new Map<number, string>();
}

// Get appointments
/**
 * Appointments for the given staff and date range.
 *
 * `GET /appointment/staffappointments` returns `Appointment` rows, which carry
 * only `ClientId`: the client name, email and phone are not returned by this
 * endpoint and are deliberately absent from this result — join `clientId`
 * through `GET /client/clients` if they are needed. `sessionTypeName` and
 * `locationName` are resolved from `SessionTypeId`/`LocationId` against the
 * cached `/site/sessiontypes` and `/site/locations` catalogues, and are
 * undefined when the catalogue does not contain that id.
 */
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
    staffName?: string;
    sessionTypeId: number;
    sessionTypeName?: string;
    locationId: number;
    locationName?: string;
    startDateTime: string;
    endDateTime: string;
    clientId?: string;
    notes?: string;
    staffRequested: boolean;
    providerId?: string;
    duration: number;
    confirmed: boolean;
    firstAppointment: boolean;
    resources?: Array<{ id: number; name: string }>;
  }>;
  totalAppointments: number;
}> {
  const dates = await withDefaultDates(startDate, endDate, 7, client, cache);
  // SANDBOX-OBSERVED (differs from spec): rows with Status Cancelled or LateCancelled are never returned, although Appointment.Status documents both values.
  // Recorded in docs/mindbody-spec-discrepancies.md section D-4.
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

  // `Appointment` has no `SessionType`/`Location` object to read a name from, so
  // both names come from the cached catalogues (fail-open: a failed catalogue read
  // leaves the names undefined and the ids intact). Each catalogue is fetched
  // ONLY when some row actually carries the id it would resolve, so a call whose
  // rows have no SessionTypeId or no LocationId costs exactly the one request it
  // always did.
  const [sessionTypes, locations] = await Promise.all([
    lazyNames(appointmentRows, 'SessionTypeId', () => sessionTypeNames(client, cache)),
    lazyNames(appointmentRows, 'LocationId', () => locationNames(client, cache)),
  ]);

  const appointments = appointmentRows.map((apt: any) => ({
    id: apt.Id,
    status: apt.Status,
    staffId: apt.StaffId ?? apt.Staff?.Id,
    staffName: appointmentStaffName(apt.Staff),
    sessionTypeId: apt.SessionTypeId,
    sessionTypeName: sessionTypes.get(apt.SessionTypeId),
    locationId: apt.LocationId,
    locationName: locations.get(apt.LocationId),
    startDateTime: apt.StartDateTime,
    endDateTime: apt.EndDateTime,
    clientId: apt.ClientId,
    notes: apt.Notes,
    staffRequested: apt.StaffRequested,
    providerId: apt.ProviderId,
    duration: apt.Duration,
    // `Appointment` has no `Confirmed` flag; confirmation is the status.
    confirmed: apt.Status === 'Confirmed',
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
    staffName?: string;
    sessionTypeId: number;
    locationId: number;
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

    // The returned `Appointment` carries no `SessionType`/`Location` object, only
    // their ids, so the ids are what this result reports.
    return {
      success: true,
      appointment: {
        id: response.Appointment.Id,
        status: response.Appointment.Status,
        startDateTime: response.Appointment.StartDateTime,
        endDateTime: response.Appointment.EndDateTime,
        duration: response.Appointment.Duration,
        staffName: appointmentStaffName(response.Appointment.Staff),
        sessionTypeId: response.Appointment.SessionTypeId,
        locationId: response.Appointment.LocationId,
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

// Appointment ownership verification
//
// updateAppointment and cancelAppointments both act on ONE appointment that must
// belong to ONE client, so they share one lookup and one comparison. A row whose
// owner cannot be read, or whose owner is not the requested client, is reported
// exactly as a row that was never returned, so a guessed appointment id cannot
// be used to discover whose an appointment is.

/** How far the shared lookup reaches into the past, in site-calendar days. */
const OWNERSHIP_LOOKBACK_DAYS = 365;
/** How far the shared lookup reaches into the future, in site-calendar days. */
const OWNERSHIP_LOOKAHEAD_DAYS = 365 * 2;

/**
 * Statuses that settle an appointment's attendance. A completed or no-show
 * appointment is over: it can still be annotated, but no status action, no
 * payment and no reschedule may be applied to it.
 */
const ATTENDANCE_FINAL_STATUSES = new Set(['Completed', 'NoShow']);

/**
 * Statuses after which an appointment is closed to every write, notes included.
 * Nothing in this server reverses a cancellation, so writing to a cancelled
 * appointment could only corrupt history or resurrect attendance.
 */
const TERMINAL_STATUSES = new Set(['Cancelled', 'LateCancelled']);

/** Statuses from which a cancellation is refused. */
const NON_CANCELLABLE_STATUSES = new Set([...TERMINAL_STATUSES, ...ATTENDANCE_FINAL_STATUSES]);

const NOT_FOUND_FOR_CLIENT = 'not found for this client';
const AMBIGUOUS_LOOKUP = 'appointment returned more than once by lookup; refusing ambiguous data';

/** One discriminated shape, so `if (!result.ok)` narrows for the compiler too. */
interface OwnershipLookup {
  ok: boolean;
  timeZone?: string;
  rows?: any[];
  kind?: 'site timezone' | 'lookup';
  reason?: string;
}

/**
 * Read the appointments with these ids AS THIS CLIENT sees them, together with
 * the site's IANA zone, which is what any timing guard has to be judged in.
 * Fails closed: without the zone the caller cannot decide a timing guard, so the
 * failure is reported rather than guessed.
 */
async function lookupAppointmentsForClient(
  client: IMindbodyClient,
  cache: SimpleCache,
  clientId: string,
  appointmentIds: number[],
  lookbackDays: number
): Promise<OwnershipLookup> {
  let timeZone: string;
  try {
    timeZone = await getSiteTimeZone(client, cache);
  } catch (error: any) {
    return {
      ok: false,
      kind: 'site timezone',
      reason: `site timezone unavailable: ${error?.message ?? 'unknown error'}`,
    };
  }

  const now = new Date();
  try {
    const { items: rows } = await fetchAllPages<any>(
      client,
      '/appointment/staffappointments',
      {
        AppointmentIds: appointmentIds,
        // The spec defines a single `request.clientId`, not a list.
        ClientId: clientId,
        StartDate: siteDateStringPlusDays(now, timeZone, -lookbackDays),
        EndDate: siteDateStringPlusDays(now, timeZone, OWNERSHIP_LOOKAHEAD_DAYS),
      },
      'Appointments'
    );
    return { ok: true, timeZone, rows };
  } catch (error: any) {
    return {
      ok: false,
      kind: 'lookup',
      reason: `appointment lookup failed: ${error?.message ?? 'unknown error'}`,
    };
  }
}

/** The single row for `appointmentId` when it is unambiguously this client's. */
function ownedAppointmentRow(
  rows: any[],
  appointmentId: number,
  clientId: string
): { row: any } | { reason: string } {
  const matches = rows.filter((row) => Number(row?.Id) === appointmentId);
  if (matches.length === 0) return { reason: NOT_FOUND_FOR_CLIENT };
  if (matches.length > 1) return { reason: AMBIGUOUS_LOOKUP };

  const row = matches[0];
  const rowClientId = row.ClientId ?? row.Client?.Id;
  if (rowClientId === undefined || rowClientId === null || String(rowClientId) !== clientId) {
    // Never reveal which client owns it; a mismatch looks exactly like "missing".
    return { reason: NOT_FOUND_FOR_CLIENT };
  }
  return { row };
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

/**
 * Execute values that settle an appointment's outcome. A booked or confirmed
 * appointment can still be completed; a completed or no-show one cannot be
 * arrived, un-arrived or completed again, because those are exactly the
 * attendance and revenue writes this tool must not be able to replay.
 */
const OUTCOME_SETTLING_EXECUTIONS = new Set<UpdateAppointmentExecute>([
  'arrive',
  'unarrive',
  'complete',
]);

/**
 * Execute values that may only be applied once the appointment has started,
 * compared in the site's zone.
 *
 * ONLY `complete` is gated. It is the revenue write: it finalises attendance and,
 * with a purchased service on the appointment, the money. Applying it to an
 * appointment that has not begun is the one act that is pure corruption once
 * ownership has been verified.
 *
 * `arrive` and `unarrive` are deliberately NOT time-gated. Arrival is recorded
 * against a booked appointment in the salon workflow, including against a slot
 * booked for a later day, so a started-only rule would refuse legitimate
 * check-ins. What makes `arrive` safe here is ownership — the appointment must
 * be the requested client's, and must not have settled already — not its clock.
 * `confirm`/`unconfirm` move no attendance and no money, so they are ungated.
 */
const STARTED_ONLY_EXECUTIONS = new Set<UpdateAppointmentExecute>(['complete']);

/** Lookback for updateAppointment's ownership lookup, in site-calendar days. */
const UPDATE_LOOKBACK_DAYS = 365;

export interface UpdateAppointmentResult {
  success: boolean;
  appointment?: {
    id: number;
    status: string;
    startDateTime: string;
    endDateTime: string;
    staffName: string;
  };
  rejected: Array<{ id: number; reason: string }>;
  message: string;
}

/** Every refusal reads the same way: the reason, and the fact nothing was written. */
function updateRefusal(id: number, reason: string): UpdateAppointmentResult {
  return {
    success: false,
    rejected: [{ id, reason }],
    message: `Rejected: ${reason}. The appointment was not updated.`,
  };
}

/** Why a looked-up, owned appointment may not be updated, or null if it may. */
function updateRejectionReason(
  row: any,
  request: {
    execute?: UpdateAppointmentExecute;
    applyPayment: boolean;
    reschedule: boolean;
  },
  nowMs: number,
  timeZone: string
): string | null {
  const status = row?.Status;
  if (TERMINAL_STATUSES.has(status)) {
    return `appointment status is ${status}, which is final; no update can be made to it`;
  }
  if (ATTENDANCE_FINAL_STATUSES.has(status)) {
    if (request.execute !== undefined && OUTCOME_SETTLING_EXECUTIONS.has(request.execute)) {
      return `appointment status is ${status}, which has settled the appointment's outcome; only its details can still be changed`;
    }
    if (request.applyPayment) {
      return `appointment status is ${status}; a payment cannot be applied to an appointment that has already taken place`;
    }
    if (request.reschedule) {
      return `appointment status is ${status}; an appointment that has already taken place cannot be rescheduled`;
    }
  }

  if (request.execute !== undefined && STARTED_ONLY_EXECUTIONS.has(request.execute)) {
    // Site-local wall time read in the SITE's zone, never this process's. An
    // unparseable value is refused rather than compared against.
    const startMs = siteLocalToEpochMs(row.StartDateTime, timeZone);
    if (Number.isNaN(startMs)) return 'appointment start time could not be parsed';
    if (startMs > nowMs) {
      return `execute ${request.execute} needs the appointment to have started; it starts at ${row.StartDateTime} site time`;
    }
  }
  return null;
}

/**
 * Update ONE appointment belonging to ONE client: reschedule, change staff,
 * notes or resources, or apply one status action.
 *
 * Every guard runs before any write, and none can be skipped by omitting an
 * argument:
 *   1. request shape (clientId, appointmentId) — no calls;
 *   2. the execute allow-list, which also refuses the cancel verbs — no calls;
 *   3. applyPayment may not ride along with a reschedule — no calls;
 *   4. ownership: the appointment must belong to `clientId` and be inside the
 *      lookup window, else "not found for this client";
 *   5. status: a cancelled appointment is final, and an attendance-final one
 *      takes no status action, no payment and no reschedule;
 *   6. timing: `complete` needs the appointment to have started, in site time.
 */
export async function updateAppointmentTool(
  clientId: string,
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
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache
): Promise<UpdateAppointmentResult> {
  if (typeof clientId !== 'string' || clientId.trim() === '') {
    return updateRefusal(-1, 'clientId must be a non-empty string');
  }
  if (typeof appointmentId !== 'number' || !Number.isInteger(appointmentId) || appointmentId <= 0) {
    return updateRefusal(-1, `appointment id ${JSON.stringify(appointmentId)} is not a positive integer`);
  }

  // MCP arguments are untyped at runtime, so the union above is not a guarantee.
  if (
    execute !== undefined &&
    !(UPDATE_APPOINTMENT_EXECUTE_VALUES as readonly string[]).includes(execute)
  ) {
    const value = String(execute);
    const isCancel = value.toLowerCase() === 'cancel' || value.toLowerCase() === 'latecancel';
    return updateRefusal(
      -1,
      isCancel
        ? 'updateAppointment does not cancel appointments. Use cancelAppointments, which verifies the client, timing and status before cancelling.'
        : `Unsupported execute value "${value}". Allowed: ${UPDATE_APPOINTMENT_EXECUTE_VALUES.join(', ')}. To cancel, use cancelAppointments.`
    );
  }

  // ApplyPayment applies "a current applicable client service from the client's
  // account" to THIS appointment, chosen against the appointment's current time
  // (docs/openapi.json, UpdateAppointmentRequest). Moving the appointment in the
  // same call makes it unresolvable afterwards which service was consumed, and
  // no MCP path reverses a sale, so the two are never combined.
  const reschedule = startDateTime !== undefined || endDateTime !== undefined;
  if (applyPayment === true && reschedule) {
    return updateRefusal(
      -1,
      'applyPayment cannot be combined with a reschedule; move the appointment first, then apply the payment in a second call'
    );
  }

  const lookup = await lookupAppointmentsForClient(
    client,
    cache,
    clientId,
    [appointmentId],
    UPDATE_LOOKBACK_DAYS
  );
  if (!lookup.ok) return updateRefusal(-1, lookup.reason);

  const owned = ownedAppointmentRow(lookup.rows, appointmentId, clientId);
  if ('reason' in owned) return updateRefusal(appointmentId, owned.reason);

  const reason = updateRejectionReason(
    owned.row,
    { execute, applyPayment: applyPayment === true, reschedule },
    Date.now(),
    lookup.timeZone
  );
  if (reason) return updateRefusal(appointmentId, reason);

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
      rejected: [],
      message: 'Appointment updated successfully',
    };
  } catch (error: any) {
    return {
      success: false,
      rejected: [],
      message: error.message || 'Failed to update appointment',
    };
  }
}

// Cancel appointments

/** Hard ceiling on how many appointments one cancelAppointments call may touch. */
export const MAX_CANCELLATIONS_PER_REQUEST = 3;

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

/**
 * Why an OWNED appointment may not be cancelled, or null if it may. Ownership is
 * already settled by `ownedAppointmentRow`; this is the timing and status half.
 */
function cancellationRejectionReason(row: any, nowMs: number, timeZone: string): string | null {
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

  // Fail closed, via the shared lookup: without the site's zone "today" and
  // "already started" cannot be decided, so nothing is looked up or written.
  const lookup = await lookupAppointmentsForClient(client, cache, clientId, appointmentIds, 0);
  if (!lookup.ok) {
    return {
      success: false,
      cancelled: [],
      rejected: [{ id: -1, reason: lookup.reason }],
      message: lookup.kind === 'site timezone'
        ? 'Could not determine the site timezone; no appointments were cancelled.'
        : 'Could not verify the appointments; no appointments were cancelled.',
    };
  }

  const { timeZone, rows } = lookup;
  const rejected: Array<{ id: number; reason: string }> = [];
  const verified = new Map<number, any>();
  for (const id of appointmentIds) {
    const owned = ownedAppointmentRow(rows, id, clientId);
    if ('reason' in owned) {
      rejected.push({ id, reason: owned.reason });
      continue;
    }
    const reason = cancellationRejectionReason(owned.row, Date.now(), timeZone);
    if (reason) {
      rejected.push({ id, reason });
    } else {
      verified.set(id, owned.row);
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
//
// There is no day-of-week filter: the endpoint documents only `scheduleType`,
// `sessionTypeIds`, `startTime` and `endTime`, and the sandbox ignores any other
// name, so this tool takes no `days` argument.
export async function getActiveSessionTimesTool(
  scheduleType?: 'All' | 'Class' | 'Enrollment' | 'Appointment',
  sessionTypeIds?: number[],
  startTime?: string,
  endTime?: string,
  client: IMindbodyClient = mindbodyClient
): Promise<{
  activeTimes: string[];
  bySessionType: Array<{ sessionTypeId: number; activeTimes: string[] }>;
  totalActiveTimes: number;
}> {
  const merged = new Map<unknown, Set<string>>();
  // SANDBOX-OBSERVED (differs from spec): SessionTypeActiveSessionTimes is present only when SessionTypeIds is sent, which the published schema documents as "omitted when SessionTypeIds is not supplied".
  // Recorded in docs/mindbody-spec-discrepancies.md section D-1.
  const { items: timeRows } = await fetchAllPages<unknown>(
    client,
    '/appointment/activesessiontimes',
    {
      ScheduleType: scheduleType || 'All',
      SessionTypeIds: sessionTypeIds,
      StartTime: startTime,
      EndTime: endTime,
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
  ignorePrepFinishTimes: boolean = false,
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache
): Promise<{
  appointments: Array<{
    id: number;
    status: string;
    staffId: number;
    staffName?: string;
    sessionTypeId: number;
    sessionTypeName?: string;
    locationId: number;
    locationName?: string;
    startDateTime: string;
    endDateTime: string;
  }>;
  availabilities: Array<{
    id: number;
    staffId: number;
    staffName?: string;
    startDateTime: string;
    endDateTime: string;
    bookableEndDateTime: string;
    prepTime: number;
    finishTime: number;
    isMasked: boolean;
    showPublic: boolean;
  }>;
  unavailabilities: Array<{
    id: number;
    staffId: number;
    staffName?: string;
    startDateTime: string;
    endDateTime: string;
    description: string;
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
      IgnorePrepFinishTimes: ignorePrepFinishTimes,
    },
    'StaffMembers'
  );

  // `Appointment` rows carry `SessionTypeId`/`LocationId` but no `SessionType` or
  // `Location` object, so the names come from the cached catalogues (fail-open: a
  // failed catalogue read leaves the names undefined and the ids intact). Read
  // lazily, so a window with no appointments costs no extra requests.
  const nestedAppointments = scheduleRows.flatMap((member: any) => member.Appointments ?? []);
  const [sessionTypes, locations] = await Promise.all([
    lazyNames(nestedAppointments, 'SessionTypeId', () => sessionTypeNames(client, cache)),
    lazyNames(nestedAppointments, 'LocationId', () => locationNames(client, cache)),
  ]);

  // The three lists are separate in the spec's model (`Staff.Appointments`,
  // `Staff.Availabilities`, `Staff.Unavailabilities`), so they stay separate here
  // rather than being flattened into one row type.
  const appointments = scheduleRows.flatMap((member: any) =>
    (member.Appointments ?? []).map((apt: any) => ({
      id: apt.Id,
      status: apt.Status,
      staffId: member.Id,
      staffName: member.Name,
      sessionTypeId: apt.SessionTypeId,
      sessionTypeName: sessionTypes.get(apt.SessionTypeId),
      locationId: apt.LocationId,
      locationName: locations.get(apt.LocationId),
      startDateTime: apt.StartDateTime,
      endDateTime: apt.EndDateTime,
    }))
  );

  const availabilities = scheduleRows.flatMap((member: any) =>
    (member.Availabilities ?? []).map((slot: any) => ({
      id: slot.Id,
      staffId: member.Id,
      staffName: member.Name,
      startDateTime: slot.StartDateTime,
      endDateTime: slot.EndDateTime,
      bookableEndDateTime: slot.BookableEndDateTime,
      prepTime: slot.PrepTime,
      finishTime: slot.FinishTime,
      isMasked: slot.IsMasked,
      showPublic: slot.ShowPublic,
    }))
  );

  const unavailabilities = scheduleRows.flatMap((member: any) =>
    (member.Unavailabilities ?? []).map((block: any) => ({
      id: block.Id,
      staffId: member.Id,
      staffName: member.Name,
      startDateTime: block.StartDateTime,
      endDateTime: block.EndDateTime,
      description: block.Description,
    }))
  );

  return {
    appointments,
    availabilities,
    unavailabilities,
    totalItems: totalResults || appointments.length,
  };
}