import { fetchAllPages, mindbodyClient, type IMindbodyClient } from '../api/client.js';
import { classCache, SimpleCache } from '../cache/index.js';
import { errorMessage } from '../utils/errors.js';
import { withDefaultDates } from '../utils/siteTime.js';
import { locationNames, staffNames } from './lookups.js';

/**
 * Name for a catalogue id, or `undefined` when the catalogue does not hold it.
 *
 * `Visit` carries foreign keys only, so a name can come from exactly one place:
 * the cached catalogue. A miss is reported as `undefined` — never `''` and never
 * a placeholder such as `'Unknown'`, which reads like a real location to a caller.
 * The id itself stays on the row, so "no such id" is always distinguishable from
 * a resolved name.
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
 * Search and filter clients (`GET /client/clients`, read through every page).
 *
 * `LiabilityRelease` is a boolean on `Client`; the agreement details are the
 * separate `Liability { AgreementDate, IsReleased, ReleasedBy }` object, which is
 * what the `liability` block reads. The boolean is not surfaced — it carries no
 * information the `liability` block does not.
 */
export async function getClientsTool(
  searchText?: string,
  clientIds?: string[],
  lastModifiedDate?: string,
  isProspect?: boolean,
  client: IMindbodyClient = mindbodyClient
): Promise<{
  clients: Array<{
    id: string;
    firstName: string;
    lastName: string;
    email?: string;
    phone?: string;
    birthDate?: string;
    addressLine1?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
    isProspect: boolean;
    isOptedIn: boolean;
    liability?: {
      isReleased: boolean;
      agreedDate?: string;
    };
    emergencyContact?: {
      name: string;
      phone: string;
      relationship: string;
    };
    createdDate: string;
    status: string;
    membershipIcon?: number;
  }>;
  totalClients: number;
}> {
  const { items: clientRows, totalResults } = await fetchAllPages<any>(
    client,
    '/client/clients',
    {
      SearchText: searchText,
      ClientIds: clientIds,
      LastModifiedDate: lastModifiedDate,
      IsProspect: isProspect,
    },
    'Clients'
  );

  const clients = clientRows.map((client: any) => ({
    id: client.Id,
    firstName: client.FirstName,
    lastName: client.LastName,
    email: client.Email,
    phone: client.MobilePhone || client.HomePhone,
    birthDate: client.BirthDate,
    addressLine1: client.AddressLine1,
    city: client.City,
    state: client.State,
    postalCode: client.PostalCode,
    country: client.Country,
    isProspect: client.IsProspect || false,
    isOptedIn: client.SendAccountEmails || false,
    liability: client.Liability ? {
      isReleased: client.Liability.IsReleased,
      agreedDate: client.Liability.AgreementDate,
    } : undefined,
    emergencyContact: client.EmergencyContactInfoName ? {
      name: client.EmergencyContactInfoName,
      phone: client.EmergencyContactInfoPhone,
      relationship: client.EmergencyContactInfoRelationship,
    } : undefined,
    createdDate: client.CreationDate,
    status: client.Status,
    membershipIcon: client.MembershipIcon,
  }));

  return {
    clients,
    totalClients: totalResults,
  };
}

/**
 * Create a client (`POST /client/addclient`).
 *
 * This tool commits a real client record: the API has no dry-run mode (no `Test`
 * flag is sent, because the endpoint refuses `Test: true`), so there is no way
 * to validate a payload without writing it.
 */
export async function addClientTool(
  firstName: string,
  lastName: string,
  email?: string,
  mobilePhone?: string,
  birthDate?: string,
  addressLine1?: string,
  city?: string,
  state?: string,
  postalCode?: string,
  country?: string,
  emergencyContactName?: string,
  emergencyContactPhone?: string,
  emergencyContactRelationship?: string,
  sendAccountEmails: boolean = true,
  referredBy?: string,
  client: IMindbodyClient = mindbodyClient
): Promise<{
  success: boolean;
  client?: {
    id: string;
    firstName: string;
    lastName: string;
    email?: string;
  };
  message: string;
}> {
  try {
    const payload: Record<string, unknown> = {
      FirstName: firstName,
      LastName: lastName,
      Email: email,
      MobilePhone: mobilePhone,
      BirthDate: birthDate,
      AddressLine1: addressLine1,
      City: city,
      State: state,
      PostalCode: postalCode,
      Country: country,
      EmergencyContactInfoName: emergencyContactName,
      EmergencyContactInfoPhone: emergencyContactPhone,
      EmergencyContactInfoRelationship: emergencyContactRelationship,
      SendAccountEmails: sendAccountEmails,
      ReferredBy: referredBy ?? 'MindbodyMCP',
    };

    // SANDBOX-OBSERVED (differs from spec): addclient on site -99 rejects a request with no Birthday, a field AddClientRequest does not define (the schema field is BirthDate), so both spellings are sent.
    // See docs/mindbody-spec-discrepancies.md section D-5.
    // `Street` and `MobileNumber` are likewise undocumented aliases the sandbox tolerates for `AddressLine1` and `MobilePhone`.
    if (addressLine1) payload.Street = addressLine1;
    if (mobilePhone) payload.MobileNumber = mobilePhone;
    if (birthDate) payload.Birthday = birthDate;

    // SANDBOX-OBSERVED (differs from spec): addclient refuses Test: true ("Test mode is not allowed for this endpoint"), so no Test flag is sent and this tool always commits a real client.
    // See docs/mindbody-spec-discrepancies.md section D-10.
    const response = await client.post<any>('/client/addclient', payload);

    return {
      success: true,
      client: {
        id: response.Client.Id,
        firstName: response.Client.FirstName,
        lastName: response.Client.LastName,
        email: response.Client.Email,
      },
      message: 'Client successfully created',
    };
  } catch (error: unknown) {
    return {
      success: false,
      message: errorMessage(error, 'Failed to create client'),
    };
  }
}

// Update client information
export async function updateClientTool(
  clientId: string,
  updates: {
    firstName?: string;
    lastName?: string;
    email?: string;
    mobilePhone?: string;
    birthDate?: string;
    addressLine1?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    emergencyContactName?: string;
    emergencyContactPhone?: string;
    sendAccountEmails?: boolean;
  },
  client: IMindbodyClient = mindbodyClient
): Promise<{
  success: boolean;
  client?: {
    id: string;
    firstName: string;
    lastName: string;
    email?: string;
  };
  message: string;
}> {
  try {
    // UpdateClientRequest (docs/openapi.json) requires the fields nested under
    // `Client`; top-level fields are refused with `Client (Code: MissingRequiredFields)`.
    const updateData: any = {
      Id: clientId,
    };

    // Map updates to API format
    if (updates.firstName) updateData.FirstName = updates.firstName;
    if (updates.lastName) updateData.LastName = updates.lastName;
    if (updates.email) updateData.Email = updates.email;
    if (updates.mobilePhone) updateData.MobilePhone = updates.mobilePhone;
    if (updates.birthDate) updateData.BirthDate = updates.birthDate;
    if (updates.addressLine1) updateData.AddressLine1 = updates.addressLine1;
    if (updates.city) updateData.City = updates.city;
    if (updates.state) updateData.State = updates.state;
    if (updates.postalCode) updateData.PostalCode = updates.postalCode;
    if (updates.emergencyContactName) updateData.EmergencyContactInfoName = updates.emergencyContactName;
    if (updates.emergencyContactPhone) updateData.EmergencyContactInfoPhone = updates.emergencyContactPhone;
    if (updates.sendAccountEmails !== undefined) updateData.SendAccountEmails = updates.sendAccountEmails;

    // SANDBOX-OBSERVED (differs from spec): updateclient on a non-regional site answers "The current site does not belong to a region" unless CrossRegionalUpdate is explicitly false; the spec documents no default.
    // See docs/mindbody-spec-discrepancies.md section D-6.
    const response = await client.post<any>('/client/updateclient', {
      Client: updateData,
      CrossRegionalUpdate: false,
    });

    return {
      success: true,
      client: {
        id: response.Client.Id,
        firstName: response.Client.FirstName,
        lastName: response.Client.LastName,
        email: response.Client.Email,
      },
      message: 'Client successfully updated',
    };
  } catch (error: unknown) {
    return {
      success: false,
      message: errorMessage(error, 'Failed to update client'),
    };
  }
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
  const { items: visitsRaw, totalResults } = await fetchAllPages<any>(
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
  const wantsLocations = visitsRaw.some((visit: any) => typeof visit?.LocationId === 'number');
  const wantsStaff = visitsRaw.some((visit: any) => typeof visit?.StaffId === 'number');
  const [locations, staff] = await Promise.all([
    wantsLocations ? locationNames(client, cache) : new Map<number, string>(),
    wantsStaff ? staffNames(client, cache) : new Map<number, string>(),
  ]);

  const visits = visitsRaw.map((visit: any) => ({
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

/**
 * A client's active memberships (`GET /client/activeclientmemberships`).
 *
 * `ClientMembership.Program` is a `Program` object, not a label, so the two
 * fields a caller can use are exposed separately: `programName` from
 * `Program.Name` and `programId` from `Program.Id`. `Program` also carries
 * `ScheduleType`, which is not exposed here; read the membership record
 * directly if you need it.
 */
export async function getClientMembershipsTool(
  clientId: string,
  locationId?: number,
  client: IMindbodyClient = mindbodyClient
): Promise<{
  memberships: Array<{
    id: number;
    name: string;
    remainingClasses?: number;
    activeDate: string;
    expirationDate?: string;
    paymentDate?: string;
    programName?: string;
    programId?: number;
    siteId: number;
    iconCode?: number;
    action?: string;
  }>;
  totalMemberships: number;
}> {
  const { items: membershipRows } = await fetchAllPages<any>(
    client,
    '/client/activeclientmemberships',
    {
      ClientId: clientId,
      LocationId: locationId,
    },
    'ClientMemberships'
  );

  const memberships = membershipRows.map((membership: any) => ({
    id: membership.Id,
    name: membership.Name,
    remainingClasses: membership.Remaining,
    activeDate: membership.ActiveDate,
    expirationDate: membership.ExpirationDate,
    paymentDate: membership.PaymentDate,
    programName: membership.Program?.Name,
    programId: membership.Program?.Id,
    siteId: membership.SiteId,
    iconCode: membership.IconCode,
    action: membership.Action,
  }));

  return {
    memberships,
    totalMemberships: memberships.length,
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
    const response = await client.post<any>('/client/addarrival', {
      ClientId: clientId,
      LocationId: locationId,
    });

    return {
      success: true,
      arrivalAdded: response.ArrivalAdded,
      message: response.Message || 'Client checked in successfully',
    };
  } catch (error: unknown) {
    return {
      success: false,
      arrivalAdded: false,
      message: errorMessage(error, 'Failed to check in client'),
    };
  }
}

/**
 * A client's account balance (`GET /client/clientaccountbalances`).
 *
 * The API exposes no per-card balance: `Client.ClientCreditCard` is a single
 * stored card, not a list, and neither `Client` nor `ClientCreditCard` carries a
 * money field for it. What is available is the client's own `AccountBalance`
 * and the stored card's identity (`CardType`, `LastFour`), so
 * `creditCardBalances` is not reported — a balance per card cannot be derived
 * from this endpoint.
 */
export async function getClientAccountBalancesTool(
  clientId: string,
  client: IMindbodyClient = mindbodyClient
): Promise<{
  accountBalance: number;
  creditCard?: {
    cardType?: string;
    lastFour?: string;
  };
}> {
  const { items: balanceRows } = await fetchAllPages<any>(
    client,
    '/client/clientaccountbalances',
    { ClientIds: [clientId] },
    'Clients'
  );

  const clientData = balanceRows[0] ?? {};
  const card = clientData.ClientCreditCard;
  return {
    accountBalance: clientData.AccountBalance || 0,
    creditCard: card ? {
      cardType: card.CardType,
      lastFour: card.LastFour,
    } : undefined,
  };
}

/**
 * A client's contracts (`GET /client/clientcontracts`).
 *
 * `soldDate` is read from `AgreementDate`, the closest documented equivalent —
 * `ClientContract` has no `SoldDate`.
 *
 * Three fields the tool used to report are not available and are dropped:
 * `description`, `balance` and `contractType`. `ClientContract` has no
 * `Description`, `Balance` or `ContractType` property, and none can be derived
 * from the ones it does carry.
 */
export async function getClientContractsTool(
  clientId: string,
  client: IMindbodyClient = mindbodyClient
): Promise<{
  contracts: Array<{
    id: number;
    contractId?: number;
    name: string;
    soldDate?: string;
    startDate: string;
    endDate?: string;
    autopayStatus?: string;
    autoRenewing?: boolean;
    isMonthToMonth?: boolean;
    terminationDate?: string;
    siteId: number;
  }>;
  totalContracts: number;
}> {
  const { items: contractsRaw, totalResults } = await fetchAllPages<any>(
    client,
    '/client/clientcontracts',
    { ClientId: clientId },
    'Contracts'
  );

  const contracts = contractsRaw.map((contract: any) => ({
    id: contract.Id,
    contractId: contract.ContractID,
    name: contract.ContractName,
    soldDate: contract.AgreementDate,
    startDate: contract.StartDate,
    endDate: contract.EndDate,
    autopayStatus: contract.AutopayStatus,
    autoRenewing: contract.AutoRenewing,
    isMonthToMonth: contract.IsMonthToMonth,
    terminationDate: contract.TerminationDate,
    siteId: contract.SiteId,
  }));

  return {
    contracts,
    totalContracts: totalResults || contracts.length,
  };
}