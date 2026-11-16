/**
 * cancelClientBooking: turn "this client, this booking, now" into the one
 * correct cancel write, late or normal.
 *
 * The resolver owns the decision and none of the writing. It finds the booking
 * on the client's schedule (`getClientScheduleTool`), picks late or normal from
 * the late-cancel window that applies to it (`src/utils/lateCancel.ts`), and hands
 * the write to the existing guarded tool for the booking's kind:
 *
 *   appointment -> cancelAppointmentsTool      (POST /appointment/updateappointment)
 *   enrollment  -> cancelEnrollmentVisitsTool  (POST /class/removeclientfromclass, VisitId)
 *   class       -> removeClientFromClassTool   (POST /class/removeclientfromclass, ClassId)
 *   waitlist    -> refused: a waitlist entry is not a seat
 *
 * So ownership, status, timezone and all-or-nothing guards stay in one place.
 * The resolver never calls a write endpoint itself: it passes the delegate a
 * client that records the POST it sends, which is how `receipt.request` is the
 * exact body. The POST is never retried. When it fails, the schedule is read
 * once more and the outcome says whether the booking is gone.
 *
 * `observeBalance: true` adds `impact` next to `receipt` (issue #26): the
 * paying service's `Remaining` and the account balance, read before and after
 * the write (`src/tools/cancelImpact.ts`). It never changes the write path or
 * the outcome: a failed read only makes `impact.observed` false.
 */
import type { AxiosRequestConfig } from 'axios';
import { mindbodyClient, type IMindbodyClient } from '../api/client.js';
import { classCache, SimpleCache } from '../cache/index.js';
import { errorMessage } from '../utils/errors.js';
import {
  LATE_CANCEL_WINDOW_ENV,
  LATE_CANCEL_WINDOW_UNKNOWN,
  lateCancelConfig,
  lateCancelConfigRefusal,
  lateCancelWindowRefusal,
  positiveIdOrUndefined,
  resolveLateCancelWindow,
  type LateCancelConfig,
  type LateCancelContext,
  type LateCancelWindow,
} from '../utils/lateCancel.js';
import { getSiteTimeZone, siteDateString, siteDateStringPlusDays, siteLocalToEpochMs } from '../utils/siteTime.js';
import { cancelAppointmentsTool, lookupAppointmentsForClient, ownedAppointmentRow } from './appointmentManagement.js';
import { buildImpact, readSnapshot, resolvePayingService, type CancelImpact } from './cancelImpact.js';
import { removeClientFromClassTool } from './classManagement.js';
import { DEFAULT_CLIENT_SCHEDULE_WINDOW_DAYS, getClientScheduleTool, type ClientBooking } from './clientSchedule.js';
import { cancelEnrollmentVisitsTool } from './enrollmentManagement.js';

export type CancelOutcome = 'cancelled' | 'still-booked' | 'unknown' | 'refused';
export type CancelMode = 'late' | 'normal';
export type CancelDelegate = 'cancelAppointments' | 'cancelEnrollmentVisits' | 'removeClientFromClass';

export interface CancelClientBookingRequest {
  clientId: string;
  /** Exactly one of these four locates the booking. */
  classId?: number;
  appointmentId?: number;
  visitId?: number;
  /** Site-local `YYYY-MM-DDTHH:MM[:SS]`, no offset, as Mindbody returns it. */
  startDateTime?: string;
  /** Narrows a `startDateTime` match to one class schedule. Only with `startDateTime`. */
  classScheduleId?: number;
  sendEmail?: boolean;
  /** Omitted: the resolver decides. `true`: refused outside the window. `false`: normal cancel. */
  lateCancel?: boolean;
  /** Read the paying service's Remaining and the account balance before and after the write. Default false. */
  observeBalance?: boolean;
}

/** How late vs normal was chosen. */
export interface CancelDecision {
  mode: CancelMode;
  /** The caller's `lateCancel`, unchanged; undefined when omitted. */
  requested?: boolean;
  /** The window that applied, in hours; undefined when none did. */
  windowHours?: number;
  /** Where `windowHours` came from: MINDBODY_LATE_CANCEL_WINDOW_HOURS or a MINDBODY_LATE_CANCEL_WINDOW_RULES entry. */
  windowSource?: string;
  /** From the decision instant to the booking's start, site zone. */
  hoursUntilStart: number;
  reason: string;
}

/** What was sent to Mindbody and what came back. The receipt is the record. */
export interface CancelReceipt {
  tool: CancelDelegate;
  /** The POST path. Undefined when the delegate refused before writing. */
  endpoint?: string;
  /** The exact POST body. Undefined when nothing was sent. */
  request?: Record<string, unknown>;
  /** Mindbody's response body, when the POST succeeded. */
  response?: unknown;
  /** The POST's error message, when it failed. */
  error?: string;
  /** ISO instant the POST was sent. */
  sentAt?: string;
  /** The delegate tool's own return value, unchanged. */
  toolResult: unknown;
}

/** The one schedule re-read after a failed POST. */
export interface CancelReconcile {
  readAt: string;
  /** The booking's row as re-read; null when it is no longer on the schedule. */
  booking: ClientBooking | null;
  /** Set when the re-read itself failed (outcome `unknown`). */
  error?: string;
}

export interface CancelClientBookingResult {
  success: boolean;
  outcome: CancelOutcome;
  /** Undefined only when refused before the booking was resolved. */
  mode?: CancelMode;
  /** The resolved booking. */
  booking?: ClientBooking;
  /** On a refused resolution: the rows the locator matched, so the caller can choose. */
  candidates?: ClientBooking[];
  decision?: CancelDecision;
  receipt?: CancelReceipt;
  reconcile?: CancelReconcile;
  /** Only with `observeBalance: true`, once the write was attempted or refused by the delegate. */
  impact?: CancelImpact;
  message: string;
}

interface PostRecord {
  endpoint: string;
  body: Record<string, unknown>;
  sentAt: string;
  response?: unknown;
  error?: string;
}

/**
 * `inner` with only `post` overridden to record each body and result; errors
 * are rethrown. Every other method is inherited through the prototype, so
 * reads go through `inner` untouched.
 */
function recordingClient(inner: IMindbodyClient): { client: IMindbodyClient; posts: PostRecord[] } {
  const posts: PostRecord[] = [];
  const client = Object.create(inner) as IMindbodyClient;
  client.post = async <T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> => {
    const record: PostRecord = { endpoint: url, body: { ...(data as Record<string, unknown>) }, sentAt: new Date().toISOString() };
    posts.push(record);
    try {
      const response = await inner.post<T>(url, data, config);
      record.response = response;
      return response;
    } catch (error: unknown) {
      record.error = errorMessage(error, 'request failed');
      throw error;
    }
  };
  return { client, posts };
}

const LOCATORS = ['classId', 'appointmentId', 'visitId', 'startDateTime'] as const;
const START_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
/** Appointment statuses that mean the seat is already released. */
const RELEASED_APPOINTMENT_STATUSES = new Set(['Cancelled', 'LateCancelled']);

const refused = (message: string, extra: Partial<CancelClientBookingResult> = {}): CancelClientBookingResult => ({
  success: false,
  outcome: 'refused',
  ...extra,
  message,
});

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** `YYYY-MM-DDTHH:MM` gains `:00`, so it compares equal to Mindbody's form. */
function normaliseStart(value: string): string {
  return value.length === 16 ? `${value}:00` : value;
}

function requestErrors(req: CancelClientBookingRequest): string[] {
  const errors: string[] = [];
  if (typeof req.clientId !== 'string' || req.clientId.trim() === '') errors.push('clientId is required');
  const given = LOCATORS.filter((key) => req[key] !== undefined);
  if (given.length !== 1) {
    errors.push(`exactly one of ${LOCATORS.join(', ')} is required (got ${given.length === 0 ? 'none' : given.join(', ')})`);
  }
  for (const key of ['classId', 'appointmentId', 'visitId', 'classScheduleId'] as const) {
    if (req[key] !== undefined && !isPositiveInteger(req[key])) errors.push(`${key} must be a positive integer`);
  }
  if (req.startDateTime !== undefined && !(typeof req.startDateTime === 'string' && START_DATE_TIME.test(req.startDateTime))) {
    errors.push('startDateTime must be site-local YYYY-MM-DDTHH:MM[:SS] with no offset');
  }
  if (req.classScheduleId !== undefined && req.startDateTime === undefined) {
    errors.push('classScheduleId narrows a startDateTime match and needs startDateTime');
  }
  return errors;
}

function matchesLocator(row: ClientBooking, req: CancelClientBookingRequest): boolean {
  if (req.classId !== undefined) return row.classId === req.classId;
  if (req.appointmentId !== undefined) return row.appointmentId === req.appointmentId;
  if (req.visitId !== undefined) return row.visitId === req.visitId;
  if (normaliseStart(String(row.startDateTime)) !== normaliseStart(req.startDateTime!)) return false;
  return req.classScheduleId === undefined || row.classScheduleId === req.classScheduleId;
}

/** Why `row` is not a cancellable seat, or null when it is. */
function notCancellableReason(row: ClientBooking, nowMs: number, timeZone: string): string | null {
  if (row.kind === 'waitlist' || row.isWaitlisted) return 'is a waitlist entry, not a seat; nothing to cancel';
  if (row.signedIn) return 'the client is already signed in';
  if (row.lateCancelled) return 'is already late-cancelled';
  if (row.appointmentStatus && RELEASED_APPOINTMENT_STATUSES.has(row.appointmentStatus)) {
    return `appointment status is already ${row.appointmentStatus}`;
  }
  const startMs = siteLocalToEpochMs(String(row.startDateTime), timeZone);
  if (Number.isNaN(startMs)) return 'start time could not be parsed';
  if (startMs <= nowMs) return 'has already started or is in the past';
  return null;
}

function describe(row: ClientBooking): string {
  return `${row.kind} visit ${row.visitId}${row.name ? ` "${row.name}"` : ''} at ${row.startDateTime}`;
}

/** The same booking in a re-read schedule: appointments by appointmentId, others by visitId. */
function sameBooking(row: ClientBooking, booking: ClientBooking): boolean {
  return booking.kind === 'appointment' ? row.appointmentId === booking.appointmentId : row.visitId === booking.visitId;
}

function stillBooked(row: ClientBooking | null): boolean {
  if (!row || row.lateCancelled) return false;
  return !(row.appointmentStatus && RELEASED_APPOINTMENT_STATUSES.has(row.appointmentStatus));
}

/**
 * The booking's window: resolved, none configured for it (`unmatched`), or a
 * refusal that a late cancel must not get past.
 */
type WindowResolution = { window: LateCancelWindow } | { refusal: string; unmatched?: true };

/**
 * Rule context for the booking. Class and enrollment rows carry it; an
 * appointment's program and session type need its row (one GET), read only
 * when rules are configured. A failed read leaves them unknown.
 */
async function bookingContext(
  booking: ClientBooking,
  clientId: string,
  client: IMindbodyClient,
  cache: SimpleCache
): Promise<LateCancelContext> {
  if (booking.kind !== 'appointment') {
    return { serviceId: booking.productId, programId: booking.programId, sessionTypeId: booking.sessionTypeId };
  }
  const lookup = await lookupAppointmentsForClient(client, cache, clientId, [booking.appointmentId!], 0);
  if (!lookup.ok) return {};
  const owned = ownedAppointmentRow(lookup.rows ?? [], booking.appointmentId!, clientId);
  if ('reason' in owned) return {};
  return { programId: positiveIdOrUndefined(owned.row?.ProgramId), sessionTypeId: positiveIdOrUndefined(owned.row?.SessionTypeId) };
}

async function windowFor(
  booking: ClientBooking,
  clientId: string,
  config: LateCancelConfig,
  client: IMindbodyClient,
  cache: SimpleCache
): Promise<WindowResolution> {
  // No rules: the default alone, with no extra read (the behaviour before rules existed).
  if (config.rules.length === 0) {
    return config.defaultHours === undefined
      ? { refusal: LATE_CANCEL_WINDOW_UNKNOWN, unmatched: true }
      : { window: { hours: config.defaultHours, source: LATE_CANCEL_WINDOW_ENV } };
  }
  return resolveLateCancelWindow(await bookingContext(booking, clientId, client, cache), config);
}

/** Late or normal, or a refusal message. */
function decide(
  req: CancelClientBookingRequest,
  startMs: number,
  nowMs: number,
  resolution: WindowResolution,
  rulesConfigured: boolean
): { decision: CancelDecision } | { refusal: string; decision: CancelDecision } {
  const hoursUntilStart = Math.round(((startMs - nowMs) / 3_600_000) * 100) / 100;
  const window = 'window' in resolution ? resolution.window : undefined;
  const base = { requested: req.lateCancel, windowHours: window?.hours, windowSource: window?.source, hoursUntilStart };
  if (req.lateCancel === false) {
    return { decision: { ...base, mode: 'normal', reason: 'lateCancel: false was requested' } };
  }
  if (req.lateCancel === true) {
    // With nothing configured, lateCancel: true is refused before any read; here a window, or a rule refusal.
    const refusal = window
      ? lateCancelWindowRefusal(startMs, nowMs, window.hours, window.source)
      : (resolution as { refusal: string }).refusal;
    const decision: CancelDecision = { ...base, mode: 'late', reason: 'lateCancel: true was requested' };
    return refusal ? { refusal, decision } : { decision };
  }
  if (!window) {
    if ('unmatched' in resolution && resolution.unmatched) {
      return {
        decision: {
          ...base,
          mode: 'normal',
          reason: rulesConfigured
            ? `no rule in MINDBODY_LATE_CANCEL_WINDOW_RULES matches and ${LATE_CANCEL_WINDOW_ENV} is unset, so the cancellation is not treated as late`
            : 'MINDBODY_LATE_CANCEL_WINDOW_HOURS is unset, so no cancellation is treated as late',
        },
      };
    }
    // A rule might apply but cannot be decided: neither late nor normal is safe to guess.
    const refusal = `${(resolution as { refusal: string }).refusal} (lateCancel was omitted, and neither late nor normal can be chosen safely: pass lateCancel explicitly)`;
    return { refusal, decision: { ...base, mode: 'normal', reason: 'the late-cancel window could not be decided' } };
  }
  const inside = lateCancelWindowRefusal(startMs, nowMs, window.hours, window.source) === null;
  const of = window.source === LATE_CANCEL_WINDOW_ENV ? '' : ` of ${window.source}`;
  return {
    decision: {
      ...base,
      mode: inside ? 'late' : 'normal',
      reason: inside
        ? `starts in ${hoursUntilStart}h, inside the ${window.hours}h late-cancel window${of}`
        : `starts in ${hoursUntilStart}h, outside the ${window.hours}h late-cancel window${of}`,
    },
  };
}

/** The delegate's refusal or failure text, from whichever shape it returns. */
function delegateMessage(result: any): string {
  const reasons = Array.isArray(result?.rejected)
    ? result.rejected.map((r: any) => r?.reason).filter(Boolean)
    : [];
  return [result?.message, ...reasons].filter(Boolean).join(': ');
}

/**
 * Cancel one booking for one client, choosing late or normal.
 *
 * 1. Validate the request; `lateCancel: true` with no configured window, or
 *    any lateCancel other than `false` with invalid rules, is refused here,
 *    before any read.
 * 2. Resolve the site zone (fail closed) and read the client's schedule: the
 *    locator's day for `startDateTime`, otherwise today through
 *    DEFAULT_CLIENT_SCHEDULE_WINDOW_DAYS.
 * 3. Match the locator, keep booked, non-waitlisted, non-signed-in, future rows.
 *    Exactly one proceeds; zero or several refuse with the candidates.
 * 4. Resolve the booking's window (the default, or the first matching rule),
 *    decide late vs normal, then delegate the write. Never retried.
 * 5. If the POST failed, re-read the schedule once: `cancelled` when the
 *    booking is gone, `still-booked` when present, `unknown` when the read fails.
 */
export async function cancelClientBookingTool(
  req: CancelClientBookingRequest,
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache
): Promise<CancelClientBookingResult> {
  const errors = requestErrors(req);
  if (errors.length > 0) return refused(`Request rejected; nothing was cancelled: ${errors.join('; ')}.`);

  const loaded = lateCancelConfig();
  if (req.lateCancel !== false) {
    // Invalid rules refuse an omitted lateCancel too: the decision would rest on a configuration that cannot be read.
    const configRefusal = 'error' in loaded ? loaded.error : req.lateCancel === true ? lateCancelConfigRefusal(loaded) : null;
    if (configRefusal) return refused(`${configRefusal}. Nothing was cancelled.`);
  }
  const lateConfig: LateCancelConfig = 'config' in loaded ? loaded.config : { rules: [] };

  let timeZone: string;
  try {
    timeZone = await getSiteTimeZone(client, cache);
  } catch (error: unknown) {
    return refused(`Could not determine the site timezone; nothing was cancelled: ${errorMessage(error, 'unknown error')}`);
  }

  const now = new Date();
  const startDate = req.startDateTime ? req.startDateTime.slice(0, 10) : siteDateString(now, timeZone);
  const endDate = req.startDateTime ? startDate : siteDateStringPlusDays(now, timeZone, DEFAULT_CLIENT_SCHEDULE_WINDOW_DAYS);

  let bookings: ClientBooking[];
  try {
    ({ bookings } = await getClientScheduleTool(req.clientId, startDate, endDate, client, cache));
  } catch (error: unknown) {
    return refused(`Could not read the client's schedule; nothing was cancelled: ${errorMessage(error, 'unknown error')}`);
  }

  const nowMs = now.getTime();
  const matched = bookings.filter((row) => matchesLocator(row, req));
  const cancellable = matched.filter((row) => notCancellableReason(row, nowMs, timeZone) === null);
  if (cancellable.length === 0) {
    if (matched.length === 0) {
      return refused(`No booking for client ${req.clientId} matches the locator between ${startDate} and ${endDate}; nothing was cancelled.`);
    }
    const reasons = matched.map((row) => `${describe(row)} ${notCancellableReason(row, nowMs, timeZone)}`);
    return refused(`No cancellable booking matches; nothing was cancelled: ${reasons.join('; ')}.`, { candidates: matched });
  }
  if (cancellable.length > 1) {
    return refused(
      `${cancellable.length} bookings match; nothing was cancelled. Narrow the request with classId, appointmentId or visitId.`,
      { candidates: cancellable }
    );
  }

  const booking = cancellable[0];
  const startMs = siteLocalToEpochMs(String(booking.startDateTime), timeZone);
  const resolution: WindowResolution = req.lateCancel === false
    ? { refusal: LATE_CANCEL_WINDOW_UNKNOWN, unmatched: true }
    : await windowFor(booking, req.clientId, lateConfig, client, cache);
  const decided = decide(req, startMs, nowMs, resolution, lateConfig.rules.length > 0);
  const { decision } = decided;
  const mode = decision.mode;
  if ('refusal' in decided) {
    return refused(`${decided.refusal}. Nothing was cancelled.`, { mode, booking, decision });
  }

  const late = mode === 'late';
  const sendEmail = req.sendEmail ?? false;
  if (booking.kind === 'class' && sendEmail) {
    return refused(
      'sendEmail is not supported for a drop-in class: removeClientFromClass sends no SendEmail. Cancel without sendEmail; nothing was cancelled.',
      { mode, booking, decision }
    );
  }

  // Before the write: which service pays, and its count. Reads never block the cancel.
  const observe = req.observeBalance === true;
  const serviceRef = observe ? await resolvePayingService(booking, req.clientId, client, cache) : undefined;
  const before = serviceRef ? await readSnapshot(req.clientId, serviceRef.serviceId, client, cache) : undefined;

  const recorder = recordingClient(client);
  let tool: CancelDelegate;
  let toolResult: any;
  if (booking.kind === 'appointment') {
    tool = 'cancelAppointments';
    toolResult = await cancelAppointmentsTool(req.clientId, [booking.appointmentId!], late, sendEmail, recorder.client, cache);
  } else if (booking.kind === 'enrollment') {
    tool = 'cancelEnrollmentVisits';
    toolResult = await cancelEnrollmentVisitsTool(req.clientId, [booking.visitId], late, sendEmail, recorder.client, cache);
  } else {
    tool = 'removeClientFromClass';
    toolResult = await removeClientFromClassTool(req.clientId, booking.classId!, late, recorder.client, cache);
  }

  const post = recorder.posts.at(-1);
  const receipt: CancelReceipt = {
    tool,
    endpoint: post?.endpoint,
    request: post?.body,
    response: post?.response,
    error: post?.error,
    sentAt: post?.sentAt,
    toolResult,
  };
  // After the write: read again only when a POST was sent and the before read worked.
  const after = before && post && !before.error ? await readSnapshot(req.clientId, serviceRef!.serviceId, client, cache) : undefined;
  const impact = before ? buildImpact(serviceRef!, before, after) : undefined;
  const common = { mode, booking, decision, receipt, ...(impact ? { impact } : {}) };
  const what = `${late ? 'late' : 'normal'} cancel of ${describe(booking)} via ${tool}`;

  if (!post) {
    return refused(`${tool} refused the ${what}: ${delegateMessage(toolResult)}`, common);
  }
  if (post.error === undefined) {
    return { success: true, outcome: 'cancelled', ...common, message: `Done: ${what}.` };
  }

  // The POST failed and may or may not have landed. Never retry: read once.
  const readAt = new Date().toISOString();
  let reconcile: CancelReconcile;
  try {
    const { bookings: after } = await getClientScheduleTool(req.clientId, startDate, endDate, client, cache);
    reconcile = { readAt, booking: after.find((row) => sameBooking(row, booking)) ?? null };
  } catch (error: unknown) {
    reconcile = { readAt, booking: null, error: errorMessage(error, 'unknown error') };
    return {
      success: false,
      outcome: 'unknown',
      ...common,
      reconcile,
      message: `The ${what} failed (${post.error}) and the schedule re-read failed too (${reconcile.error}); check the booking in Mindbody before retrying.`,
    };
  }

  if (stillBooked(reconcile.booking)) {
    return {
      success: false,
      outcome: 'still-booked',
      ...common,
      reconcile,
      message: `The ${what} failed (${post.error}); the schedule re-read still shows the booking, so it was not cancelled.`,
    };
  }
  return {
    success: true,
    outcome: 'cancelled',
    ...common,
    reconcile,
    message: `The ${what} reported a failure (${post.error}), but the schedule re-read no longer shows the booking as booked: it was cancelled.`,
  };
}
