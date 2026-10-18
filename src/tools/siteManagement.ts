import { fetchAllPages, mindbodyClient, type IMindbodyClient } from '../api/client.js';
import { classCache, SimpleCache } from '../cache/index.js';
import { getSelectedSite, SiteSelectionError, type SiteSummary } from '../utils/siteTime.js';

/**
 * Get site information for THE site this server operates on.
 *
 * Multi-site policy (operator decision): when the API key can reach more than
 * one site, no site data is returned unless a site was chosen, either by the
 * configured default `MINDBODY_SITE_ID` or by an explicit `siteId` argument.
 * In that case `site` is absent and `error` + `availableSites` say what to pick.
 *
 * Every field below is a real `Site` property in docs/openapi.json. There is no
 * `esi`: `Site` has neither `ESI` nor `TotalLocations`, and the sandbox returns
 * neither, so `esi` is not exposed at all (rather than exposed as `''` or
 * `undefined`). `currency` is `Site.CurrencyIsoCode` (e.g. "USD") — the plain
 * `Currency` name this tool used to read does not exist.
 *
 * `totalLocations` is derived, not read: `Site` carries no count, so it is
 * counted from `GET /site/locations` through the same injected `client` and
 * `cache`, i.e. the same 'locations' cache entry `getLocationsTool` reads. If
 * that read fails, `totalLocations` is `undefined` (never 0, which would be a
 * false claim) and the rest of the site record is still returned.
 */
export async function getSitesTool(
  siteId?: string | number,
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache
): Promise<{
  error?: string;
  availableSites?: SiteSummary[];
  site?: {
    id: number;
    name: string;
    description?: string;
    logoUrl?: string;
    pageColor1?: string;
    pageColor2?: string;
    pageColor3?: string;
    pageColor4?: string;
    acceptsVisa: boolean;
    acceptsMasterCard: boolean;
    acceptsDiscover: boolean;
    acceptsAmex: boolean;
    contactEmail?: string;
    taxInclusivePrices: boolean;
    currency: string;
    countryCode: string;
    timeZone?: string;
    /** Counted from GET /site/locations; undefined when that read fails. */
    totalLocations?: number;
  };
}> {
  // Shared with getSiteTimeZone: one cached site record (60 minutes), resolved
  // to exactly one site or refused.
  let site: any;
  try {
    site = await getSelectedSite(client, cache, siteId);
  } catch (error) {
    if (error instanceof SiteSelectionError) {
      return { error: error.message, availableSites: error.availableSites };
    }
    throw error;
  }

  // Derived, not read: `Site` has no TotalLocations. One documented, already
  // cached endpoint supplies the count, through the injected client and cache, so
  // this shares the 'locations' entry with getLocationsTool instead of issuing a
  // second query. Fails open — undefined, never 0.
  let totalLocations: number | undefined;
  try {
    totalLocations = (await getLocationsTool(client, cache)).totalLocations;
  } catch {
    totalLocations = undefined;
  }

  return {
    site: {
      id: site.Id,
      name: site.Name,
      description: site.Description,
      logoUrl: site.LogoUrl,
      pageColor1: site.PageColor1,
      pageColor2: site.PageColor2,
      pageColor3: site.PageColor3,
      pageColor4: site.PageColor4,
      acceptsVisa: site.AcceptsVisa,
      acceptsMasterCard: site.AcceptsMasterCard,
      acceptsDiscover: site.AcceptsDiscover,
      acceptsAmex: site.AcceptsAmericanExpress,
      contactEmail: site.ContactEmail,
      taxInclusivePrices: site.TaxInclusivePrices,
      currency: site.CurrencyIsoCode,
      countryCode: site.CountryCode,
      timeZone: site.TimeZone,
      totalLocations,
    },
  };
}

/**
 * Get locations (studio locations).
 *
 * `imageUrls` is `Location.AdditionalImageURLs`, which is a `string[]` in
 * docs/openapi.json and in the sandbox. This tool used to map it as a list of
 * `{id, name}` objects, which silently produced `{id: undefined, name: undefined}`
 * for every row; there is no `facilities` field any more.
 *
 * `amenities` is `Location.Amenities`, a list of `{Id, Name}` — unchanged.
 *
 * There is no business-hours field: `Location` in docs/openapi.json has no
 * `BusinessHours`, and the sandbox does not return one. A location's active
 * hours come from `GET /appointment/activesessiontimes`, not from the location
 * record, so `businessHours` has been dropped rather than left always undefined.
 */
export async function getLocationsTool(
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache
): Promise<{
  locations: Array<{
    id: number;
    name: string;
    description?: string;
    hasClasses: boolean;
    phoneExtension?: string;
    address?: string;
    address2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    latitude?: number;
    longitude?: number;
    phone?: string;
    /** Location.AdditionalImageURLs — image URLs, not facility records. */
    imageUrls?: string[];
    amenities?: Array<{
      id: number;
      name: string;
    }>;
  }>;
  totalLocations: number;
}> {
  const cacheKey = 'locations';
  let cached = cache.get<any>(cacheKey);

  if (!cached) {
    cached = await fetchAllPages<any>(client, '/site/locations', {}, 'Locations');
    cache.set(cacheKey, cached, 60); // Cache for 60 minutes
  }

  const locations = (cached.items ?? cached.Locations ?? []).map((location: any) => ({
    id: location.Id,
    name: location.Name,
    description: location.Description,
    hasClasses: location.HasClasses,
    phoneExtension: location.PhoneExtension,
    address: location.Address,
    address2: location.Address2,
    city: location.City,
    state: location.StateProvCode,
    postalCode: location.PostalCode,
    latitude: location.Latitude,
    longitude: location.Longitude,
    phone: location.Phone,
    imageUrls: location.AdditionalImageURLs,
    amenities: location.Amenities?.map((a: any) => ({
      id: a.Id,
      name: a.Name,
    })),
  }));

  return {
    locations,
    totalLocations: cached.totalResults ?? cached.PaginationResponse?.TotalResults ?? locations.length,
  };
}

// Get programs (yoga, pilates, etc.)
export async function getProgramsTool(
  scheduleType?: 'All' | 'Class' | 'Enrollment' | 'Appointment',
  onlineOnly: boolean = false,
  client: IMindbodyClient = mindbodyClient
): Promise<{
  programs: Array<{
    id: number;
    name: string;
    scheduleType: string;
    cancelOffset?: number;
    contentFormats?: string[];
  }>;
  totalPrograms: number;
}> {
  const { items: programRows, totalResults } = await fetchAllPages<any>(
    client,
    '/site/programs',
    {
      ScheduleType: scheduleType || 'All',
      OnlineOnly: onlineOnly,
    },
    'Programs'
  );

  const programs = programRows.map((program: any) => ({
    id: program.Id,
    name: program.Name,
    scheduleType: program.ScheduleType,
    cancelOffset: program.CancelOffset,
    contentFormats: program.ContentFormats,
  }));

  return {
    programs,
    totalPrograms: totalResults || programs.length,
  };
}

/**
 * Get resources (rooms, equipment, etc.)
 *
 * Only the parameters docs/openapi.json defines for this path are sent
 * (`locationIds`, `programIds`, `resourceIds`, `scheduleTypes`,
 * `includeInactive`). The session-type and date-time filters this tool used to
 * take (`sessionTypeIds`, `locationId`, `startDateTime`, `endDateTime`) are not
 * defined here and have been removed: the sandbox answers HTTP 500 on
 * `SessionTypeIds` alone and silently ignores the other three.
 */
export async function getResourcesTool(
  locationIds?: number[],
  programIds?: number[],
  resourceIds?: number[],
  scheduleTypes?: string[],
  includeInactive?: boolean,
  client: IMindbodyClient = mindbodyClient
): Promise<{
  resources: Array<{
    id: number;
    name: string;
  }>;
  totalResources: number;
}> {
  const { items: resourceRows, totalResults } = await fetchAllPages<any>(
    client,
    '/site/resources',
    {
      LocationIds: locationIds,
      ProgramIds: programIds,
      ResourceIds: resourceIds,
      ScheduleTypes: scheduleTypes,
      IncludeInactive: includeInactive,
    },
    // docs/openapi.json types this 200 response only as `{"type": "object"}` (no
    // schema, so no documented list key). 'Resources' is the key the live API
    // returns; it cannot be checked against the spec until the spec documents it.
    // SANDBOX-OBSERVED (differs from spec): the 200 response is untyped in docs/openapi.json; the sandbox returns {PaginationResponse, Resources: [{Id, Name}]}, and undocumented SessionTypeIds on this path returns HTTP 500 rather than being ignored.
    // See docs/mindbody-spec-discrepancies.md section D-2.
    'Resources'
  );

  const resources = resourceRows.map((resource: any) => ({
    id: resource.Id,
    name: resource.Name,
  }));

  return {
    resources,
    totalResources: totalResults || resources.length,
  };
}

// Get session types (class types, appointment types)
export async function getSessionTypesTool(
  programIds?: number[],
  onlineOnly: boolean = false,
  client: IMindbodyClient = mindbodyClient
): Promise<{
  sessionTypes: Array<{
    id: number;
    name: string;
    /** SessionType.DefaultTimeLength, in minutes. */
    defaultDuration?: number;
    /** SessionType.StaffTimeLength — the per-staff length, where it differs. */
    staffTimeLength?: number;
    /** SessionType.ResourceRequired — a resource must be booked with this type. */
    resourceRequired?: boolean;
    numDeducted?: number;
    programId: number;
    category?: string;
    categoryId?: number;
    subcategory?: string;
    subcategoryId?: number;
    type: string;
  }>;
  totalSessionTypes: number;
}> {
  const { items: sessionRows, totalResults } = await fetchAllPages<any>(
    client,
    '/site/sessiontypes',
    {
      ProgramIds: programIds,
      OnlineOnly: onlineOnly,
    },
    'SessionTypes'
  );

  const sessionTypes = sessionRows.map((session: any) => ({
    id: session.Id,
    name: session.Name,
    defaultDuration: session.DefaultTimeLength,
    staffTimeLength: session.StaffTimeLength,
    resourceRequired: session.ResourceRequired,
    numDeducted: session.NumDeducted,
    programId: session.ProgramId,
    category: session.Category,
    categoryId: session.CategoryId,
    subcategory: session.Subcategory,
    subcategoryId: session.SubcategoryId,
    type: session.Type,
  }));

  return {
    sessionTypes,
    totalSessionTypes: totalResults || sessionTypes.length,
  };
}

/**
 * Get staff (all staff members)
 *
 * `sessionTypeId` and `locationId` are single ids, because that is all this
 * endpoint has: docs/openapi.json defines `request.sessionTypeId` and
 * `request.locationId`, both requiring `startDateTime`, and there is no plural
 * form. The plural `sessionTypeIds`/`locationIds` this tool used to send were
 * dropped by the API, so those two filters never narrowed anything; they have
 * been replaced with the singular ids. Pass `startDateTime` alongside them — the
 * two filters only narrow the list when a date-time is also supplied.
 *
 * `includeInactive` is deliberately not exposed here. The path documents
 * `request.includeInactive`, but exposing it was not part of this tool's work and
 * an unused parameter on a filter that the sandbox ignores for the plural forms is
 * a liability, not a feature. `getResources` does expose it.
 */
export async function getStaffTool(
  staffIds?: number[],
  filters?: string[],
  sessionTypeId?: number,
  locationId?: number,
  startDateTime?: string,
  client: IMindbodyClient = mindbodyClient
): Promise<{
  staff: Array<{
    id: number;
    firstName: string;
    lastName: string;
    name: string;
    email?: string;
    mobilePhone?: string;
    homePhone?: string;
    workPhone?: string;
    address?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
    imageUrl?: string;
    bio?: string;
    /** Staff.IsMale. The API returns `IsMale`; the lower-cased `isMale` this
     *  tool used to read is always absent, so it is always undefined. */
    isMale?: boolean;
    appointmentInstructor?: boolean;
    alwaysAllowDoubleBooking?: boolean;
    independentContractor?: boolean;
    employmentStart?: string;
    employmentEnd?: string;
  }>;
  totalStaff: number;
}> {
  const { items: staffMembers, totalResults } = await fetchAllPages<any>(
    client,
    '/staff/staff',
    {
      StaffIds: staffIds,
      Filters: filters,
      SessionTypeId: sessionTypeId,
      LocationId: locationId,
      StartDateTime: startDateTime,
    },
    'StaffMembers'
  );

  const staff = staffMembers.map((member: any) => ({
    id: member.Id,
    firstName: member.FirstName,
    lastName: member.LastName,
    name: member.Name,
    email: member.Email,
    mobilePhone: member.MobilePhone,
    homePhone: member.HomePhone,
    workPhone: member.WorkPhone,
    address: member.Address,
    city: member.City,
    state: member.State,
    postalCode: member.PostalCode,
    country: member.Country,
    imageUrl: member.ImageUrl,
    bio: member.Bio,
    isMale: member.IsMale,
    appointmentInstructor: member.AppointmentInstructor,
    alwaysAllowDoubleBooking: member.AlwaysAllowDoubleBooking,
    independentContractor: member.IndependentContractor,
    employmentStart: member.EmploymentStart,
    employmentEnd: member.EmploymentEnd,
  }));

  return {
    staff,
    totalStaff: totalResults,
  };
}

// Get activation code (for site activation)
export async function getActivationCodeTool(
  client: IMindbodyClient = mindbodyClient
): Promise<{
  activationCode: string;
  activationLink: string;
}> {
  const response = await client.get<any>('/site/activationcode');

  return {
    activationCode: response.ActivationCode,
    activationLink: response.ActivationLink,
  };
}