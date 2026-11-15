import { mindbodyClient, type IMindbodyClient } from '../api/client.js';
import { classCache, SimpleCache } from '../cache/index.js';
import { ClientServiceWithActivationType, GetClientCompleteInfoResponse } from '../types/mindbody.js';
import { toContract, toMembership } from './clientAccount.js';
import { nameFor } from './clientActivity.js';
import { locationNames } from './lookups.js';

/**
 * Client complete info — a client's whole wallet in one read.
 *
 * Its own module so `clientAccount.ts` stays near the ~200-line guideline.
 * `clientManagement.ts` remains the public barrel.
 */

/** One purchased pricing option, as `getClientCompleteInfoTool` reports it. */
function toService(service: ClientServiceWithActivationType) {
  return {
    id: service.Id,
    productId: service.ProductId,
    name: service.Name,
    count: service.Count,
    remaining: service.Remaining,
    current: service.Current,
    activeDate: service.ActiveDate,
    expirationDate: service.ExpirationDate,
    paymentDate: service.PaymentDate,
    programName: service.Program?.Name,
    programId: service.Program?.Id,
    siteId: service.SiteId,
    activationType: service.ActivationType,
    cannotPayForClassesBeforeActivation: service.CannotPayForClassesBeforeActivation,
  };
}

/**
 * A client's whole wallet in one request (`GET /client/clientcompleteinfo`):
 * the client record with its `AccountBalance`, purchased services, contracts,
 * memberships and arrival programs. It replaces four separate reads.
 *
 * The endpoint returns all four collections in one object and has no
 * pagination envelope, so this is a single `client.get`, not `fetchAllPages`.
 *
 * `requiredClientData` is deliberately not sent. The spec documents it with no
 * enum, and its prose names values (`Services`, `Contracts`, `Memberships`,
 * `ArrivalPrograms`) that do not match the response keys. The v6 API ignores an
 * unknown query value silently, so a wrong one would return a different subset
 * with no error. Omitting it returns all four collections, which is what a
 * snapshot needs.
 *
 * `startDate`, `endDate`, `showActiveOnly`, `useActivateDate` and the
 * cross-regional options are not exposed either: the call takes the API's
 * defaults. The spec states the default for `StartDate` and `EndDate` as
 * "today's date", which, if literal, would drop services and memberships bought
 * before today. That is not sandbox-verified, so it is a known gap: see
 * `docs/API.md`.
 *
 * `client` is `undefined` when the response carries no `Client`. `arrivals`
 * location names come from the cached location catalogue and are `undefined`
 * when it does not hold an id.
 */
export async function getClientCompleteInfoTool(
  clientId: string,
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache
): Promise<{
  client?: {
    id: string;
    firstName: string;
    lastName: string;
    accountBalance?: number;
  };
  services: Array<ReturnType<typeof toService>>;
  contracts: Array<ReturnType<typeof toContract>>;
  memberships: Array<ReturnType<typeof toMembership>>;
  arrivals: Array<{
    arrivalProgramId: number;
    arrivalProgramName?: string;
    canAccess: boolean;
    locations: Array<{ id: number; name?: string }>;
  }>;
}> {
  // SPEC-ALIGNED BUT UNVERIFIED: no sandbox probe of the default date window.
  const response = await client.get<GetClientCompleteInfoResponse>('/client/clientcompleteinfo', {
    params: { ClientId: clientId },
  });

  const arrivalRows = response.ClientArrivals ?? [];
  // Only fetch the catalogue when there is an arrival to name. Fails open to an
  // empty index, so a catalogue that cannot be read leaves names undefined.
  const locations = arrivalRows.length > 0 ? await locationNames(client, cache) : new Map<number, string>();

  const record = response.Client;
  return {
    client: record && {
      id: record.Id,
      firstName: record.FirstName,
      lastName: record.LastName,
      accountBalance: record.AccountBalance,
    },
    services: (response.ClientServices ?? []).map(toService),
    contracts: (response.ClientContracts ?? []).map(toContract),
    memberships: (response.ClientMemberships ?? []).map(toMembership),
    arrivals: arrivalRows.map((arrival) => ({
      arrivalProgramId: arrival.ArrivalProgramID,
      arrivalProgramName: arrival.ArrivalProgramName,
      canAccess: arrival.CanAccess,
      locations: (arrival.LocationsIDs ?? []).map((id) => ({ id, name: nameFor(locations, id) })),
    })),
  };
}
