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
    esi?: string;
    taxInclusivePrices: boolean;
    currency: string;
    countryCode: string;
    timeZone?: string;
    totalLocations: number;
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
      esi: site.ESI,
      taxInclusivePrices: site.TaxInclusivePrices,
      currency: site.Currency,
      countryCode: site.CountryCode,
      timeZone: site.TimeZone,
      totalLocations: site.TotalLocations,
    },
  };
}

// Get locations (studio locations)
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
    facilities?: Array<{
      id: number;
      name: string;
    }>;
    amenities?: Array<{
      id: number;
      name: string;
    }>;
    businessHours?: Array<{
      day: string;
      startTime?: string;
      endTime?: string;
      isClosed: boolean;
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
    facilities: location.AdditionalImageURLs?.map((f: any) => ({
      id: f.Id,
      name: f.Name,
    })),
    amenities: location.Amenities?.map((a: any) => ({
      id: a.Id,
      name: a.Name,
    })),
    businessHours: location.BusinessHours ? Object.keys(location.BusinessHours).map(day => ({
      day,
      startTime: location.BusinessHours[day].StartTime,
      endTime: location.BusinessHours[day].EndTime,
      isClosed: location.BusinessHours[day].IsClosed,
    })) : undefined,
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

// Get resources (rooms, equipment, etc.)
export async function getResourcesTool(
  sessionTypeIds?: number[],
  locationId?: number,
  startDateTime?: string,
  endDateTime?: string,
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
      SessionTypeIds: sessionTypeIds,
      LocationId: locationId,
      StartDateTime: startDateTime,
      EndDateTime: endDateTime,
    },
    // docs/openapi.json types this 200 response only as `{"type": "object"}` (no
    // schema, so no documented list key). 'Resources' is the key the live API
    // returns; it cannot be checked against the spec until the spec documents it.
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
    defaultDuration?: number;
    defaultDurationType?: string;
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
    defaultDurationType: session.DefaultTimeLengthType,
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

// Get staff (all staff members)
export async function getStaffTool(
  staffIds?: number[],
  filters?: string[],
  sessionTypeIds?: number[],
  locationIds?: number[],
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
      SessionTypeIds: sessionTypeIds,
      LocationIds: locationIds,
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
    isMale: member.isMale,
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