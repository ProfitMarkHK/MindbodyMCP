import { fetchAllPages, mindbodyClient, type IMindbodyClient } from '../api/client.js';
import { classCache, SimpleCache } from '../cache/index.js';
import { withDefaultDates } from '../utils/siteTime.js';

// Get clients with search and filtering
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
    liability: client.LiabilityRelease ? {
      isReleased: client.LiabilityRelease.IsReleased,
      agreedDate: client.LiabilityRelease.AgreementDate,
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

// Add a new client
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

    if (addressLine1) payload.Street = addressLine1;
    if (mobilePhone) payload.MobileNumber = mobilePhone;
    if (birthDate) payload.Birthday = birthDate;

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
  } catch (error: any) {
    return {
      success: false,
      message: error.message || 'Failed to create client',
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

    // CrossRegionalUpdate defaults to true, which a site outside a region refuses
    // ("The current site does not belong to a region"), so always update locally.
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
  } catch (error: any) {
    return {
      success: false,
      message: error.message || 'Failed to update client',
    };
  }
}

// Get client visits (attendance history)
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
    location: string;
    instructor: string;
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

  const visits = visitsRaw.map((visit: any) => ({
    id: visit.Id,
    classId: visit.ClassId,
    className: visit.Name,
    startTime: visit.StartDateTime,
    endTime: visit.EndDateTime,
    location: visit.Location?.Name || 'Unknown',
    instructor: visit.Staff?.Name || 'Unknown',
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
    if (visit.signedIn) {
      summary.byLocation[visit.location] = (summary.byLocation[visit.location] || 0) + 1;
      summary.byClassType[visit.className] = (summary.byClassType[visit.className] || 0) + 1;
      summary.byInstructor[visit.instructor] = (summary.byInstructor[visit.instructor] || 0) + 1;
    }
  });

  return {
    visits,
    totalVisits: totalResults || visits.length,
    summary,
  };
}

// Get active client memberships
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
    program: string;
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
    program: membership.Program,
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
  } catch (error: any) {
    return {
      success: false,
      arrivalAdded: false,
      message: error.message || 'Failed to check in client',
    };
  }
}

// Get client account balances
export async function getClientAccountBalancesTool(
  clientId: string,
  client: IMindbodyClient = mindbodyClient
): Promise<{
  accountBalance: number;
  creditCardBalances: Array<{
    amount: number;
    cardType: string;
    lastFour: string;
  }>;
}> {
  const { items: balanceRows } = await fetchAllPages<any>(
    client,
    '/client/clientaccountbalances',
    { ClientIds: [clientId] },
    'Clients'
  );

  const clientData = balanceRows[0];
  return {
    accountBalance: clientData.AccountBalance || 0,
    creditCardBalances: clientData.ClientCreditCards?.map((card: any) => ({
      amount: card.Balance || 0,
      cardType: card.CardType,
      lastFour: card.LastFour,
    })) || [],
  };
}

// Get client contracts (memberships/packages)
export async function getClientContractsTool(
  clientId: string,
  client: IMindbodyClient = mindbodyClient
): Promise<{
  contracts: Array<{
    id: number;
    name: string;
    description?: string;
    soldDate: string;
    startDate: string;
    endDate?: string;
    autopayStatus?: string;
    balance?: number;
    contractType: string;
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
    name: contract.ContractName,
    description: contract.Description,
    soldDate: contract.SoldDate,
    startDate: contract.StartDate,
    endDate: contract.EndDate,
    autopayStatus: contract.AutopayStatus,
    balance: contract.Balance,
    contractType: contract.ContractType,
    siteId: contract.SiteId,
  }));

  return {
    contracts,
    totalContracts: totalResults || contracts.length,
  };
}