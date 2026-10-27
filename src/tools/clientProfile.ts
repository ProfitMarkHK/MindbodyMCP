import { fetchAllPages, mindbodyClient, type IMindbodyClient } from '../api/client.js';
import { errorMessage } from '../utils/errors.js';
import {
  AddClientResponse,
  ClientWithSuspensionInfo,
  UpdateClientResponse,
} from '../types/mindbody.js';

/**
 * Client identity — search, create and update the client record itself.
 *
 * Split out of `clientManagement.ts` so each client-domain module stays near
 * the ~200-line guideline. `clientManagement.ts` remains the public barrel.
 */

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
      phone?: string;
      relationship?: string;
    };
    createdDate: string;
    status: string;
    membershipIcon?: number;
  }>;
  totalClients: number;
}> {
  const { items: clientRows, totalResults } = await fetchAllPages<ClientWithSuspensionInfo>(
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

  const clients = clientRows.map((client: ClientWithSuspensionInfo) => ({
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
    const response = await client.post<AddClientResponse>('/client/addclient', payload);

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
    const updateData: Record<string, unknown> = {
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
    const response = await client.post<UpdateClientResponse>('/client/updateclient', {
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
