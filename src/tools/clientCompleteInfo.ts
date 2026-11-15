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
 * (Verified against the sandbox 2026-10-26: `Limit`/`Offset` are ignored
 * silently with HTTP 200 and the body carries no `PaginationResponse`.)
 *
 * `options.requiredClientData` narrows the response to a subset of the
 * collections. The accepted values are the spec's prose spellings —
 * `Services`, `Contracts`, `Memberships`, `ArrivalPrograms` — verified against
 * the sandbox. The response-key spellings (`ClientServices`, …) and any other
 * value are ignored silently with HTTP 200, so the tool rejects anything
 * outside the verified set rather than let a typo quietly widen the response
 * back to all four collections.
 *
 * `options.showActiveOnly` sends `ShowActiveOnly: true`, which the sandbox
 * verifiably narrows `ClientServices` to the rows that can pay right now
 * (`Current: true`); the other collections are untouched.
 *
 * `options.startDate` sends `StartDate`. It is NOT sent by default, because
 * the default window — every service expiring on or after today — is exactly
 * the snapshot this tool wants. Send a wide past date (for example
 * `2000-01-01`) to include expired purchase history; see the
 * SANDBOX-OBSERVED note at the call site for what the filter actually
 * compares.
 *
 * `client` is `undefined` when the response carries no `Client`. `arrivals`
 * location names come from the cached location catalogue and are `undefined`
 * when it does not hold an id.
 */
export interface ClientCompleteInfoOptions {
  /** Collections to request. Omit for all four. Verified values only. */
  requiredClientData?: ReadonlyArray<'Services' | 'Contracts' | 'Memberships' | 'ArrivalPrograms'>;
  /** `true` narrows services to the rows that can pay now (`Current`). */
  showActiveOnly?: boolean;
  /** Include services expiring on or after this ISO date. Wide past values recover expired purchases. */
  startDate?: string;
}

export async function getClientCompleteInfoTool(
  clientId: string,
  options: ClientCompleteInfoOptions = {},
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
  const params: Record<string, unknown> = { ClientId: clientId };
  if (options.requiredClientData !== undefined) {
    // The sandbox accepts exactly these four spellings; anything else is
    // dropped silently and the response widens back to all four collections
    // with HTTP 200 (docs/mindbody-spec-discrepancies.md F-3). Reject here so
    // the failure is loud on this side of the wire.
    const invalid = options.requiredClientData.filter(
      (value) => value !== 'Services' && value !== 'Contracts' && value !== 'Memberships' && value !== 'ArrivalPrograms'
    );
    if (invalid.length > 0) {
      throw new Error(
        `requiredClientData accepts only Services, Contracts, Memberships and ArrivalPrograms. ` +
        `The Mindbody API ignores any other value silently and returns every collection instead: ${invalid.join(', ')}`
      );
    }
    if (options.requiredClientData.length > 0) {
      params.RequiredClientData = [...options.requiredClientData];
    }
  }
  if (options.showActiveOnly === true) {
    params.ShowActiveOnly = true;
  }
  if (options.startDate !== undefined) {
    // SANDBOX-OBSERVED (differs from spec): StartDate filters services by EXPIRATION
    // date ("expiring on or after"), not the documented purchase date, and omitted it
    // defaults to today and silently drops expired purchases. Evidence: F-3.
    params.StartDate = options.startDate;
  }

  // SANDBOX-OBSERVED (differs from spec): with RequiredClientData set, the unrequested
  // collections come back as JSON null, not the arrays the response model declares, so
  // the `?? []` mappings below are load-bearing. Evidence: F-3.
  const response = await client.get<GetClientCompleteInfoResponse>('/client/clientcompleteinfo', {
    params,
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
