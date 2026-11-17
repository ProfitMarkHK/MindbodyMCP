/**
 * The observed forfeit of a cancellation (issue #26): did it cost the client a
 * pre-paid session? Read, never inferred, and never a fee.
 *
 * The v6 API has no fee field and no account-transaction ledger, so no tool
 * can say "the client was charged X". What it can show is the paying
 * service's `Remaining` count and the client's aggregate `AccountBalance`,
 * read once before the cancel and once after. Both come from one
 * `GET /client/clientcompleteinfo` per read (services and memberships only).
 * An appointment adds one `GET /appointment/staffappointments` to learn its
 * `ClientServiceId`. So `observeBalance` costs two GETs for a class or
 * enrollment session and three for an appointment.
 *
 * Every number in `CancelImpact` is a value read from the API or the
 * difference of two such values. Where a count cannot be read, `observed` is
 * false and `reason` says why; the service is never guessed.
 */
import type { IMindbodyClient } from '../api/client.js';
import type { SimpleCache } from '../cache/index.js';
import { errorMessage } from '../utils/errors.js';
import { lookupAppointmentsForClient, ownedAppointmentRow } from './appointmentManagement.js';
import { getClientCompleteInfoTool } from './clientCompleteInfo.js';
import type { ClientBooking } from './clientSchedule.js';

export interface CancelImpact {
  /** True only when the paying service's `Remaining` was read before and after. */
  observed: boolean;
  /** Why `observed` is false: no service id, service not found, no count, or a read error. */
  reason?: string;
  /** The client service (purchased pricing option) that paid for the booking. */
  serviceId?: number;
  serviceName?: string;
  remainingBefore?: number;
  remainingAfter?: number;
  /** `remainingBefore - remainingAfter`. Negative means a session was returned. */
  consumed?: number;
  /** `Client.AccountBalance` as read. Not attributed to this cancellation. */
  accountBalanceBefore?: number;
  accountBalanceAfter?: number;
  /** `accountBalanceAfter - accountBalanceBefore`, when both were read. */
  accountBalanceDelta?: number;
  /** ISO instant of the before read. */
  readAtBefore: string;
  /** ISO instant of the after read; undefined when it was not made. */
  readAtAfter?: string;
  /** The limits of this observation. Always present. */
  caveats: string[];
}

/** Always returned, whatever was observed. */
export const IMPACT_CAVEATS: readonly string[] = [
  'Mindbody exposes no fee ledger: no fee amount is reported, and accountBalanceDelta is the only money signal.',
  'A fee may be posted outside the read window (after readAtAfter), so a zero accountBalanceDelta does not mean no charge.',
  'An unlimited plan has no remaining count, so its forfeit cannot be observed.',
  'consumed is remainingBefore minus remainingAfter as read. A site that draws the session at booking returns it on a normal cancel, which shows as a negative consumed.',
];

/** One read of the paying service and the account balance. */
interface Snapshot {
  readAt: string;
  accountBalance?: number;
  /** The service row, or why it could not be used. */
  service?: { name?: string; remaining?: number };
  missing?: string;
  error?: string;
}

/** Where the paying service id came from, or why there is none. */
export interface ServiceRef {
  serviceId?: number;
  reason?: string;
}

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * The client service that pays for `booking`: the visit's `ServiceId` for a
 * class or enrollment session, the appointment's `ClientServiceId` for an
 * appointment (one staffappointments read).
 */
export async function resolvePayingService(
  booking: ClientBooking,
  clientId: string,
  client: IMindbodyClient,
  cache: SimpleCache
): Promise<ServiceRef> {
  if (booking.kind !== 'appointment') {
    return booking.serviceId !== undefined && booking.serviceId > 0
      ? { serviceId: booking.serviceId }
      : { reason: 'the visit carries no ServiceId, so the paying service is unknown' };
  }
  const lookup = await lookupAppointmentsForClient(client, cache, clientId, [booking.appointmentId!], 0);
  if (!lookup.ok) return { reason: `could not read the appointment's ClientServiceId: ${lookup.reason}` };
  const owned = ownedAppointmentRow(lookup.rows ?? [], booking.appointmentId!, clientId);
  if ('reason' in owned) return { reason: `could not read the appointment's ClientServiceId: appointment ${owned.reason}` };
  const id = Number(owned.row?.ClientServiceId);
  return Number.isInteger(id) && id > 0
    ? { serviceId: id }
    : { reason: 'the appointment has no ClientServiceId, so the paying service is unknown' };
}

/** Read `Remaining` for `serviceId` and the account balance. Never throws. */
export async function readSnapshot(
  clientId: string,
  serviceId: number | undefined,
  client: IMindbodyClient,
  cache: SimpleCache
): Promise<Snapshot> {
  const readAt = new Date().toISOString();
  try {
    const info = await getClientCompleteInfoTool(clientId, { requiredClientData: ['Services', 'Memberships'] }, client, cache);
    const snapshot: Snapshot = { readAt, accountBalance: finite(info.client?.accountBalance) };
    if (serviceId === undefined) return snapshot;
    const rows = [
      ...info.services.filter((s) => s.id === serviceId).map((s) => ({ name: s.name, remaining: s.remaining })),
      ...info.memberships.filter((m) => m.id === serviceId).map((m) => ({ name: m.name, remaining: m.remainingClasses })),
    ];
    // A membership can also be listed among the services; identical rows are one row.
    const distinct = rows.filter((row, i) => rows.findIndex((r) => r.name === row.name && r.remaining === row.remaining) === i);
    if (distinct.length === 0) snapshot.missing = `client service ${serviceId} was not found on the client's account`;
    else if (distinct.length > 1) snapshot.missing = `client service ${serviceId} matched ${distinct.length} different rows; not guessing`;
    else snapshot.service = { name: distinct[0].name, remaining: finite(distinct[0].remaining) };
    return snapshot;
  } catch (error: unknown) {
    return { readAt, error: errorMessage(error, 'unknown error') };
  }
}

/** Combine the before and after reads into the reported block. */
export function buildImpact(ref: ServiceRef, before: Snapshot, after?: Snapshot): CancelImpact {
  const impact: CancelImpact = {
    observed: false,
    serviceId: ref.serviceId,
    serviceName: before.service?.name ?? after?.service?.name,
    accountBalanceBefore: before.accountBalance,
    accountBalanceAfter: after?.accountBalance,
    readAtBefore: before.readAt,
    readAtAfter: after?.readAt,
    caveats: [...IMPACT_CAVEATS],
  };
  if (impact.accountBalanceBefore !== undefined && impact.accountBalanceAfter !== undefined) {
    impact.accountBalanceDelta = Math.round((impact.accountBalanceAfter - impact.accountBalanceBefore) * 100) / 100;
  }

  const remainingBefore = before.service?.remaining;
  const remainingAfter = after?.service?.remaining;
  impact.remainingBefore = remainingBefore;
  impact.remainingAfter = remainingAfter;

  if (before.error) impact.reason = `the before read failed: ${before.error}`;
  else if (ref.reason) impact.reason = ref.reason;
  else if (before.missing) impact.reason = before.missing;
  else if (remainingBefore === undefined) {
    impact.reason = `client service ${ref.serviceId} has no Remaining count (an unlimited plan), so a forfeit cannot be observed`;
  } else if (!after) impact.reason = 'no cancellation was sent, so the after read was not made';
  else if (after.error) impact.reason = `the after read failed: ${after.error}`;
  else if (after.missing) impact.reason = `after the cancel, ${after.missing}`;
  else if (remainingAfter === undefined) impact.reason = `after the cancel, client service ${ref.serviceId} has no Remaining count`;
  else {
    impact.observed = true;
    impact.consumed = remainingBefore - remainingAfter;
  }
  return impact;
}
