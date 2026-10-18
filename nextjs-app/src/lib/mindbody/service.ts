import { MindbodyApiClient, getMindbodyClient } from './client';
import { fetchAllPages, DEFAULT_PAGE_SIZE } from './paging';
import { getSiteTimeZone, withDefaultDates } from './siteTime';
import type {
  // Site & Location
  Site, Location, Resource,
  // Staff
  Staff, GetStaffParams,
  // Client
  Client, GetClientsParams, AddClientParams, UpdateClientParams,
  ClientVisit, ClientMembership, ClientContract, GetClientVisitsParams,
  // Class
  ClassDescription, Class, ClassSchedule, GetClassesParams,
  AddClientToClassParams, RemoveClientFromClassParams, WaitlistEntry, SubstituteTeacherParams,
  // Appointment
  Appointment, GetAppointmentsParams, AddAppointmentParams, UpdateAppointmentParams,
  BookableItem, GetBookableItemsParams, ScheduleItem, ActiveSessionTime,
  // Enrollment
  Enrollment, GetEnrollmentsParams, AddClientToEnrollmentParams, ClientEnrollmentVisit, EnrollmentBookingResult,
  // Sales
  Service, Package, Product, Contract,
  GetServicesParams, GetProductsParams, GetContractsParams,
  CheckoutParams, ShoppingCartResult, PurchaseContractParams,
  // Program & Session Type
  Program, SessionType, GetProgramsParams, GetSessionTypesParams,
  // Utility
  TeacherSchedule, OperationResult, ListResult, VisitSummary,
} from './types';

// ============================================================================
// ENROLLMENT HELPERS (module-level; see the ENROLLMENT MANAGEMENT section)
// ============================================================================

/** Program.ScheduleType value that marks an enrollment (course/workshop/series). */
export const ENROLLMENT_SCHEDULE_TYPE = 'Enrollment';

/** Default lookahead for getEnrollments and getClientEnrollments, in days. */
export const DEFAULT_ENROLLMENT_WINDOW_DAYS = 365;

/** GET /class/classes `ClassIds` per request, to keep the query string bounded. */
const CLASS_LOOKUP_CHUNK = 50;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/**
 * The weekday of a Mindbody SITE-LOCAL date-time ("2026-10-18T08:00:00", no
 * offset), taken from the string's own calendar fields.
 *
 * `new Date(s).toLocaleDateString(...)` happens to name the same day — a string
 * with no offset is parsed AND formatted in the host's zone, so its calendar date
 * survives — but it is right by accident and leans on the host's locale data.
 * Reading the weekday out of the date the studio gave is what the summary means
 * (Mindbody's own weekday, not a re-derivation), and needs no zone at all: a
 * Y-M-D names the same weekday everywhere. A string that is not site-local
 * carries no calendar to read, so it keeps the old host reading.
 */
function siteLocalWeekday(siteLocalDateTime: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T/.exec(siteLocalDateTime?.trim() ?? '');
  const [, y, mo, d] = match ?? [];
  const parsed = y && new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  // A rolled-over or impossible date (month 13, day 32) is not a calendar date.
  if (!parsed || parsed.getUTCMonth() !== Number(mo) - 1 || parsed.getUTCDate() !== Number(d)) {
    return new Date(siteLocalDateTime).toLocaleDateString('en-US', { weekday: 'long' });
  }
  return DAY_NAMES[parsed.getUTCDay()];
}

function staffDisplayName(staff: any): string {
  if (!staff) return '';
  return staff.Name || `${staff.FirstName || ''} ${staff.LastName || ''}`.trim();
}

/** The day names whose `Day<Name>` flag is true on a ClassSchedule. */
function scheduledDays(schedule: any): string[] {
  return DAY_NAMES.filter((day) => schedule?.[`Day${day}`] === true);
}

/** A GET /enrollment/enrollments row (ClassSchedule) as an Enrollment. */
function mapEnrollment(schedule: any): Enrollment {
  const description = schedule.ClassDescription;
  return {
    id: Number(schedule.Id),
    name: description?.Name ?? '',
    description: description?.Description ?? undefined,
    courseId: schedule.Course?.Id ?? undefined,
    courseName: schedule.Course?.Name ?? undefined,
    programId: description?.Program?.Id ?? undefined,
    programName: description?.Program?.Name ?? undefined,
    sessionTypeId: description?.SessionType?.Id ?? undefined,
    sessionTypeName: description?.SessionType?.Name ?? undefined,
    staffId: schedule.Staff?.Id ?? undefined,
    staffName: staffDisplayName(schedule.Staff),
    locationId: schedule.Location?.Id ?? undefined,
    locationName: schedule.Location?.Name ?? '',
    semesterId: schedule.SemesterId ?? undefined,
    startDate: schedule.StartDate,
    endDate: schedule.EndDate,
    startTime: schedule.StartTime,
    endTime: schedule.EndTime,
    days: scheduledDays(schedule),
    allowOpenEnrollment: Boolean(schedule.AllowOpenEnrollment),
    allowDateForwardEnrollment: Boolean(schedule.AllowDateForwardEnrollment),
    isAvailable: Boolean(schedule.IsAvailable),
  };
}

// ============================================================================
// UNIFIED MINDBODY SERVICE - All API Operations in One Place
// ============================================================================

export class MindbodyService {
  private client: MindbodyApiClient;

  constructor(client?: MindbodyApiClient) {
    this.client = client || getMindbodyClient();
  }

  /**
   * The date window for a read. The caller's dates when both are given —
   * unchanged, with no extra request — otherwise the SITE's own calendar window:
   * `days >= 0` is [today, today + days], `days < 0` is [today + days, today].
   *
   * The window must be in the site's timezone: Mindbody reads StartDate/EndDate
   * as site-local dates, so a host-UTC default gives a studio on the other side
   * of the date line the wrong day (and, for a site west of the host, the wrong
   * window entirely). The site zone comes from GET /site/sites via
   * ./siteTime, cached for an hour; when it cannot be resolved the read falls
   * back to UTC with one warning rather than failing.
   */
  private async defaultRange(
    startDate: string | undefined,
    endDate: string | undefined,
    days: number
  ): Promise<{ start: string; end: string }> {
    return withDefaultDates(startDate, endDate, days, this.client);
  }

  /**
   * The same window as `defaultRange`, as full site-local date-TIMES suitable
   * for a `StartDateTime`/`EndDateTime` filter (`T00:00:00` to `T23:59:59`).
   *
   * Mindbody wants these as site-local strings with no offset, so the host's
   * UTC clock cannot produce them: for a studio west of the server, "now" is
   * the wrong day, and appending a `Z` asserts a zone the API does not want.
   * Use this wherever a caller must fill in a date-time window itself — the
   * sync job is the case in point. Falls back to UTC, with the same one-time
   * warning, when the site zone cannot be resolved.
   */
  async defaultDateTimeRange(
    startDate?: string,
    endDate?: string,
    days: number = 30
  ): Promise<{ start: string; end: string }> {
    const { start, end } = await this.defaultRange(startDate, endDate, days);
    return { start: `${start}T00:00:00`, end: `${end}T23:59:59` };
  }

  // ==========================================================================
  // SITE & LOCATION MANAGEMENT
  // ==========================================================================

  async getSites(): Promise<ListResult<Site>> {
    const { items: rows } = await fetchAllPages<any>(this.client, '/site/sites', {}, 'Sites');
    const sites = rows.map((site: any) => ({
      id: site.Id,
      name: site.Name,
      description: site.Description,
      logoUrl: site.LogoUrl,
      contactEmail: site.ContactEmail,
      acceptsVisa: site.AcceptsVisa ?? true,
      acceptsMastercard: site.AcceptsMastercard ?? true,
      acceptsAmex: site.AcceptsAmex ?? true,
      acceptsDiscover: site.AcceptsDiscover ?? true,
      allowsDirectPay: site.AllowsDirectPay ?? false,
      smsPackageEnabled: site.SmsPackageEnabled ?? false,
    }));
    return { items: sites, total: sites.length };
  }

  /**
   * The site's IANA timezone, for rendering timestamps in the studio's own zone.
   *
   * Goes through `getSiteTimeZone` rather than reading `Sites[0].TimeZone`, so
   * the multi-site policy in ./siteTime holds: the site must resolve to exactly
   * one (by `requestedSiteId`, else `MINDBODY_SITE_ID`), and the
   * `MINDBODY_SITE_TIMEZONE` override applies when the record has none. Throws
   * rather than guessing, because a wrong zone mislabels every time on screen.
   */
  async getSiteTimeZone(): Promise<string> {
    return getSiteTimeZone(this.client);
  }

  async getLocations(): Promise<ListResult<Location>> {
    const { items: rows } = await fetchAllPages<any>(this.client, '/site/locations', {}, 'Locations');
    const locations = rows.map((loc: any) => ({
      id: loc.Id,
      name: loc.Name,
      description: loc.Description,
      address: loc.Address,
      address2: loc.Address2,
      city: loc.City,
      state: loc.StateProvCode,
      postalCode: loc.PostalCode,
      country: loc.Country,
      phone: loc.Phone,
      latitude: loc.Latitude,
      longitude: loc.Longitude,
      hasClasses: loc.HasClasses ?? true,
    }));
    return { items: locations, total: locations.length };
  }

  async getResources(): Promise<ListResult<Resource>> {
    const { items: rows } = await fetchAllPages<any>(this.client, '/site/resources', {}, 'Resources');
    const resources = rows.map((res: any) => ({
      id: res.Id,
      name: res.Name,
    }));
    return { items: resources, total: resources.length };
  }

  async getActivationCode(): Promise<{ activationCode: string; activationLink: string }> {
    const response = await this.client.get<any>('/site/activationcode');
    return {
      activationCode: response.ActivationCode,
      activationLink: response.ActivationLink,
    };
  }

  // ==========================================================================
  // PROGRAM & SESSION TYPE MANAGEMENT
  // ==========================================================================

  async getPrograms(params?: GetProgramsParams): Promise<ListResult<Program>> {
    const { items: rows } = await fetchAllPages<any>(
      this.client,
      '/site/programs',
      {
        ScheduleType: params?.scheduleType,
        OnlineOnly: params?.onlineOnly,
      },
      'Programs',
      params?.limit || DEFAULT_PAGE_SIZE
    );
    const programs = rows.map((prog: any) => ({
      id: prog.Id,
      name: prog.Name,
      scheduleType: prog.ScheduleType,
      cancelOffset: prog.CancelOffset,
      contentFormats: prog.ContentFormats || [],
    }));
    return { items: programs, total: programs.length };
  }

  async getSessionTypes(params?: GetSessionTypesParams): Promise<ListResult<SessionType>> {
    const { items: rows } = await fetchAllPages<any>(
      this.client,
      '/site/sessiontypes',
      {
        ProgramIds: params?.programIds,
        OnlineOnly: params?.onlineOnly,
      },
      'SessionTypes',
      params?.limit || DEFAULT_PAGE_SIZE
    );
    const sessionTypes = rows.map((st: any) => ({
      id: st.Id,
      name: st.Name,
      type: st.Type,
      defaultTimeLength: st.DefaultTimeLength,
      numDeducted: st.NumDeducted,
      programId: st.ProgramId,
      onlineDescription: st.OnlineDescription,
      category: st.Category,
      subcategory: st.Subcategory,
    }));
    return { items: sessionTypes, total: sessionTypes.length };
  }

  // ==========================================================================
  // STAFF MANAGEMENT
  // ==========================================================================

  async getStaff(params?: GetStaffParams): Promise<ListResult<Staff>> {
    const { items: rows, totalResults } = await fetchAllPages<any>(
      this.client,
      '/staff/staff',
      {
        StaffIds: params?.staffIds,
        Filters: params?.filters,
        SessionTypeIds: params?.sessionTypeIds,
        LocationIds: params?.locationIds,
        StartDateTime: params?.startDateTime,
      },
      'StaffMembers',
      params?.limit || DEFAULT_PAGE_SIZE
    );
    const staff = rows.map((s: any) => ({
      id: s.Id,
      firstName: s.FirstName,
      lastName: s.LastName,
      name: s.Name || `${s.FirstName} ${s.LastName}`,
      email: s.Email,
      mobilePhone: s.MobilePhone,
      imageUrl: s.ImageUrl,
      bio: s.Bio,
      isMale: s.isMale,
      appointmentTrn: s.AppointmentTrn,
      independentContractor: s.IndependentContractor,
    }));
    return { items: staff, total: totalResults };
  }

  async getStaffById(staffId: number): Promise<Staff | null> {
    const result = await this.getStaff({ staffIds: [staffId] });
    return result.items[0] || null;
  }

  // ==========================================================================
  // CLIENT MANAGEMENT
  // ==========================================================================

  async getClients(params?: GetClientsParams): Promise<ListResult<Client>> {
    const { items: rows, totalResults } = await fetchAllPages<any>(
      this.client,
      '/client/clients',
      {
        SearchText: params?.searchText,
        ClientIds: params?.clientIds,
        LastModifiedDate: params?.lastModifiedDate,
        IsProspect: params?.isProspect,
      },
      'Clients',
      params?.limit || DEFAULT_PAGE_SIZE
    );
    const clients = rows.map((c: any) => ({
      id: c.Id,
      firstName: c.FirstName,
      lastName: c.LastName,
      email: c.Email,
      phone: c.MobilePhone || c.HomePhone,
      mobilePhone: c.MobilePhone,
      homePhone: c.HomePhone,
      birthDate: c.BirthDate,
      addressLine1: c.AddressLine1,
      addressLine2: c.AddressLine2,
      city: c.City,
      state: c.State,
      postalCode: c.PostalCode,
      country: c.Country,
      gender: c.Gender,
      isProspect: c.IsProspect ?? false,
      isCompany: c.IsCompany ?? false,
      status: c.Status || 'Active',
      active: c.Active ?? true,
      sendAccountEmails: c.SendAccountEmails ?? true,
      referredBy: c.ReferredBy,
      photoUrl: c.PhotoUrl,
      notes: c.Notes,
      emergencyContact: c.EmergencyContactInfoName ? {
        name: c.EmergencyContactInfoName,
        phone: c.EmergencyContactInfoPhone,
        relationship: c.EmergencyContactInfoRelationship,
      } : undefined,
      liability: c.LiabilityRelease ? {
        isReleased: c.LiabilityRelease.IsReleased,
        agreedDate: c.LiabilityRelease.AgreementDate,
      } : undefined,
      accountBalance: c.AccountBalance || 0,
      creationDate: c.CreationDate,
      membershipIcon: c.MembershipIcon,
    }));
    return { items: clients, total: totalResults };
  }

  async getClientById(clientId: string): Promise<Client | null> {
    const result = await this.getClients({ clientIds: [clientId] });
    return result.items[0] || null;
  }

  async addClient(params: AddClientParams): Promise<OperationResult<Client>> {
    try {
      const response = await this.client.post<any>('/client/addclient', {
        FirstName: params.firstName,
        LastName: params.lastName,
        Email: params.email,
        MobilePhone: params.mobilePhone,
        BirthDate: params.birthDate,
        AddressLine1: params.addressLine1,
        City: params.city,
        State: params.state,
        PostalCode: params.postalCode,
        Country: params.country,
        EmergencyContactInfoName: params.emergencyContactName,
        EmergencyContactInfoPhone: params.emergencyContactPhone,
        EmergencyContactInfoRelationship: params.emergencyContactRelationship,
        SendAccountEmails: params.sendAccountEmails ?? true,
        ReferredBy: params.referredBy,
      });

      return {
        success: true,
        data: {
          id: response.Client.Id,
          firstName: response.Client.FirstName,
          lastName: response.Client.LastName,
          email: response.Client.Email,
          phone: response.Client.MobilePhone,
          isProspect: response.Client.IsProspect ?? false,
          isCompany: false,
          status: response.Client.Status || 'Active',
          active: true,
          sendAccountEmails: true,
          accountBalance: 0,
        },
        message: 'Client created successfully',
      };
    } catch (error: any) {
      return { success: false, message: error.message || 'Failed to create client' };
    }
  }

  async updateClient(params: UpdateClientParams): Promise<OperationResult<Client>> {
    try {
      const updateData: any = { Id: params.clientId };
      if (params.firstName) updateData.FirstName = params.firstName;
      if (params.lastName) updateData.LastName = params.lastName;
      if (params.email) updateData.Email = params.email;
      if (params.mobilePhone) updateData.MobilePhone = params.mobilePhone;
      if (params.birthDate) updateData.BirthDate = params.birthDate;
      if (params.addressLine1) updateData.AddressLine1 = params.addressLine1;
      if (params.city) updateData.City = params.city;
      if (params.state) updateData.State = params.state;
      if (params.postalCode) updateData.PostalCode = params.postalCode;
      if (params.emergencyContactName) updateData.EmergencyContactInfoName = params.emergencyContactName;
      if (params.emergencyContactPhone) updateData.EmergencyContactInfoPhone = params.emergencyContactPhone;
      if (params.sendAccountEmails !== undefined) updateData.SendAccountEmails = params.sendAccountEmails;

      const response = await this.client.post<any>('/client/updateclient', updateData);

      return {
        success: true,
        data: {
          id: response.Client.Id,
          firstName: response.Client.FirstName,
          lastName: response.Client.LastName,
          email: response.Client.Email,
          phone: response.Client.MobilePhone,
          isProspect: response.Client.IsProspect ?? false,
          isCompany: false,
          status: response.Client.Status || 'Active',
          active: true,
          sendAccountEmails: true,
          accountBalance: 0,
        },
        message: 'Client updated successfully',
      };
    } catch (error: any) {
      return { success: false, message: error.message || 'Failed to update client' };
    }
  }

  async getClientVisits(params: GetClientVisitsParams): Promise<{ visits: ClientVisit[]; total: number; summary: VisitSummary }> {
    const { start, end } = await this.defaultRange(params.startDate, params.endDate, -30);

    const { items: rows } = await fetchAllPages<any>(
      this.client,
      '/client/clientvisits',
      {
        ClientId: params.clientId,
        StartDate: start,
        EndDate: end,
      },
      'Visits'
    );

    const visits: ClientVisit[] = rows.map((v: any) => ({
      id: v.Id,
      classId: v.ClassId,
      className: v.Name,
      startTime: v.StartDateTime,
      endTime: v.EndDateTime,
      location: v.Location?.Name || 'Unknown',
      instructor: v.Staff?.Name || 'Unknown',
      signedIn: v.SignedIn,
      webSignup: v.WebSignup,
      lateCancel: v.LateCancelled,
      serviceId: v.ServiceId,
      serviceName: v.ServiceName,
    }));

    // Generate summary
    const summary: VisitSummary = {
      totalAttended: visits.filter(v => v.signedIn).length,
      totalNoShows: visits.filter(v => !v.signedIn && !v.lateCancel).length,
      totalLateCancels: visits.filter(v => v.lateCancel).length,
      byLocation: {},
      byClassType: {},
      byInstructor: {},
    };

    visits.forEach((visit) => {
      if (visit.signedIn) {
        summary.byLocation[visit.location] = (summary.byLocation[visit.location] || 0) + 1;
        summary.byClassType[visit.className] = (summary.byClassType[visit.className] || 0) + 1;
        summary.byInstructor[visit.instructor] = (summary.byInstructor[visit.instructor] || 0) + 1;
      }
    });

    return { visits, total: visits.length, summary };
  }

  async getClientMemberships(clientId: string, locationId?: number): Promise<ListResult<ClientMembership>> {
    const { items: rows } = await fetchAllPages<any>(
      this.client,
      '/client/activeclientmemberships',
      { ClientId: clientId, LocationId: locationId },
      'ClientMemberships'
    );
    const memberships = rows.map((m: any) => ({
      id: m.Id,
      name: m.Name,
      remainingClasses: m.Remaining,
      activeDate: m.ActiveDate,
      expirationDate: m.ExpirationDate,
      paymentDate: m.PaymentDate,
      program: m.Program,
      siteId: m.SiteId,
      iconCode: m.IconCode,
      action: m.Action,
    }));
    return { items: memberships, total: memberships.length };
  }

  async getClientContracts(clientId: string): Promise<ListResult<ClientContract>> {
    const { items: rows } = await fetchAllPages<any>(
      this.client,
      '/client/clientcontracts',
      { ClientId: clientId },
      'Contracts'
    );
    const contracts = rows.map((c: any) => ({
      id: c.Id,
      name: c.ContractName,
      description: c.Description,
      soldDate: c.SoldDate,
      startDate: c.StartDate,
      endDate: c.EndDate,
      autopayStatus: c.AutopayStatus,
      balance: c.Balance,
      contractType: c.ContractType,
      siteId: c.SiteId,
    }));
    return { items: contracts, total: contracts.length };
  }

  async getClientAccountBalances(clientId: string): Promise<{ accountBalance: number; creditCardBalances: Array<{ amount: number; cardType: string; lastFour: string }> }> {
    const { items: rows } = await fetchAllPages<any>(
      this.client,
      '/client/clientaccountbalances',
      { ClientIds: [clientId] },
      'Clients'
    );
    const client = rows[0];
    return {
      accountBalance: client?.AccountBalance || 0,
      creditCardBalances: client?.ClientCreditCards?.map((card: any) => ({
        amount: card.Balance || 0,
        cardType: card.CardType,
        lastFour: card.LastFour,
      })) || [],
    };
  }

  async addClientArrival(clientId: string, locationId: number): Promise<OperationResult<{ arrivalAdded: boolean }>> {
    try {
      const response = await this.client.post<any>('/client/addarrival', {
        ClientId: clientId,
        LocationId: locationId,
      });
      return {
        success: true,
        data: { arrivalAdded: response.ArrivalAdded },
        message: response.Message || 'Client checked in successfully',
      };
    } catch (error: any) {
      return { success: false, message: error.message || 'Failed to check in client' };
    }
  }

  // ==========================================================================
  // CLASS MANAGEMENT
  // ==========================================================================

  async getClasses(params?: GetClassesParams): Promise<ListResult<Class>> {
    const { items: rows, totalResults } = await fetchAllPages<any>(
      this.client,
      '/class/classes',
      {
        ClassDescriptionIds: params?.classDescriptionIds,
        ClassIds: params?.classIds,
        StaffIds: params?.staffIds,
        StartDateTime: params?.startDateTime,
        EndDateTime: params?.endDateTime,
        LocationIds: params?.locationIds,
      },
      'Classes',
      params?.limit || DEFAULT_PAGE_SIZE
    );
    const classes = rows.map((c: any) => ({
      id: c.Id,
      classScheduleId: c.ClassScheduleId,
      location: {
        id: c.Location.Id,
        name: c.Location.Name,
        description: c.Location.Description,
        hasClasses: true,
      },
      classDescription: {
        id: c.ClassDescription.Id,
        name: c.ClassDescription.Name,
        description: c.ClassDescription.Description,
        imageUrl: c.ClassDescription.ImageUrl,
        active: true,
      },
      staff: {
        id: c.Staff.Id,
        firstName: c.Staff.FirstName,
        lastName: c.Staff.LastName,
        name: c.Staff.Name || `${c.Staff.FirstName} ${c.Staff.LastName}`,
        email: c.Staff.Email,
        imageUrl: c.Staff.ImageUrl,
      },
      startDateTime: c.StartDateTime,
      endDateTime: c.EndDateTime,
      isCanceled: c.IsCanceled,
      isWaitlistAvailable: c.IsWaitlistAvailable,
      isAvailable: c.IsAvailable,
      isSubstitute: c.IsSubstitute,
      maxCapacity: c.MaxCapacity,
      totalBooked: c.TotalBooked,
      webCapacity: c.WebCapacity,
      totalBookedWaitlist: c.TotalBookedWaitlist,
      virtualStreamLink: c.VirtualStreamLink,
    }));
    return { items: classes, total: totalResults };
  }

  async getClassById(classId: number): Promise<Class | null> {
    const result = await this.getClasses({ classIds: [classId] });
    return result.items[0] || null;
  }

  async getClassDescriptions(): Promise<ListResult<ClassDescription>> {
    const { items: rows } = await fetchAllPages<any>(this.client, '/class/classdescriptions', {}, 'ClassDescriptions');
    const descriptions = rows.map((cd: any) => ({
      id: cd.Id,
      name: cd.Name,
      description: cd.Description,
      imageUrl: cd.ImageUrl,
      category: cd.Category,
      subcategory: cd.Subcategory,
      active: cd.Active ?? true,
    }));
    return { items: descriptions, total: descriptions.length };
  }

  async getClassSchedules(params?: { locationIds?: number[]; classDescriptionIds?: number[]; staffIds?: number[]; startDate?: string; endDate?: string }): Promise<ListResult<ClassSchedule>> {
    const { items: rows } = await fetchAllPages<any>(
      this.client,
      '/class/classschedules',
      {
        LocationIds: params?.locationIds,
        ClassDescriptionIds: params?.classDescriptionIds,
        StaffIds: params?.staffIds,
        StartDate: params?.startDate,
        EndDate: params?.endDate,
      },
      'ClassSchedules'
    );
    const schedules = rows.map((cs: any) => ({
      id: cs.Id,
      locationId: cs.Location?.Id,
      classDescriptionId: cs.ClassDescription?.Id,
      staffId: cs.Staff?.Id,
      startTime: cs.StartTime,
      endTime: cs.EndTime,
      startDate: cs.StartDate,
      endDate: cs.EndDate,
      daysOfWeek: cs.DaysOfWeek || [],
      maxCapacity: cs.MaxCapacity,
      webCapacity: cs.WebCapacity,
      isActive: cs.IsActive ?? true,
    }));
    return { items: schedules, total: schedules.length };
  }

  async addClientToClass(params: AddClientToClassParams): Promise<OperationResult<{ visit: { id: number; classId: number; clientId: string } }>> {
    try {
      const response = await this.client.post<any>('/class/addclienttoclass', {
        ClientId: params.clientId,
        ClassId: params.classId,
        RequirePayment: params.requirePayment,
        Waitlist: params.waitlist,
        SendEmail: params.sendEmail,
      });
      return {
        success: true,
        data: {
          visit: {
            id: response.Visit?.Id || 0,
            classId: params.classId,
            clientId: params.clientId,
          },
        },
        message: 'Client added to class successfully',
      };
    } catch (error: any) {
      return { success: false, message: error.message || 'Failed to add client to class' };
    }
  }

  async removeClientFromClass(params: RemoveClientFromClassParams): Promise<OperationResult> {
    try {
      await this.client.post<any>('/class/removeclientfromclass', {
        ClientId: params.clientId,
        ClassId: params.classId,
        LateCancel: params.lateCancel,
        SendEmail: params.sendEmail,
      });
      return { success: true, message: 'Client removed from class successfully' };
    } catch (error: any) {
      return { success: false, message: error.message || 'Failed to remove client from class' };
    }
  }

  async getWaitlistEntries(classIds?: number[], clientIds?: string[], hidePastEntries?: boolean): Promise<ListResult<WaitlistEntry>> {
    const { items: rows } = await fetchAllPages<any>(
      this.client,
      '/class/waitlistentries',
      {
        ClassIds: classIds,
        ClientIds: clientIds,
        HidePastEntries: hidePastEntries,
      },
      'WaitlistEntries'
    );
    const entries = rows.map((entry: any) => ({
      id: entry.Id,
      classId: entry.ClassId,
      clientId: entry.Client?.Id,
      clientName: entry.Client ? `${entry.Client.FirstName} ${entry.Client.LastName}` : 'Unknown',
      requestDateTime: entry.RequestDateTime,
      visitRefNo: entry.VisitRefNo,
      webSignup: entry.WebSignup,
    }));
    return { items: entries, total: entries.length };
  }

  async substituteClassTeacher(params: SubstituteTeacherParams): Promise<OperationResult> {
    try {
      await this.client.post<any>('/class/substituteclassteacher', {
        ClassId: params.classId,
        SubstituteStaffId: params.staffId,
        SendClientEmail: params.sendClientEmail,
        SendOriginalTeacherEmail: params.sendOriginalTeacherEmail,
        SendSubstituteTeacherEmail: params.sendSubstituteTeacherEmail,
      });
      return { success: true, message: 'Teacher substituted successfully' };
    } catch (error: any) {
      return { success: false, message: error.message || 'Failed to substitute teacher' };
    }
  }

  // ==========================================================================
  // TEACHER SCHEDULE (OPTIMIZED)
  // ==========================================================================

  async getTeacherSchedule(teacherId: number, startDate?: string, endDate?: string): Promise<TeacherSchedule> {
    const { start, end } = await this.defaultRange(startDate, endDate, 7);

    const [staffResult, classesResult] = await Promise.all([
      this.getStaff({ staffIds: [teacherId] }),
      this.getClasses({ staffIds: [teacherId], startDateTime: start, endDateTime: end }),
    ]);

    const teacher = staffResult.items[0];
    if (!teacher) {
      throw new Error(`Teacher with ID ${teacherId} not found`);
    }

    const classes = classesResult.items;
    const summary = {
      byDay: {} as Record<string, number>,
      byLocation: {} as Record<string, number>,
      byClassType: {} as Record<string, number>,
    };

    classes.forEach((c) => {
      const day = siteLocalWeekday(c.startDateTime);
      summary.byDay[day] = (summary.byDay[day] || 0) + 1;
      summary.byLocation[c.location.name] = (summary.byLocation[c.location.name] || 0) + 1;
      summary.byClassType[c.classDescription.name] = (summary.byClassType[c.classDescription.name] || 0) + 1;
    });

    return {
      teacher: {
        id: teacher.id,
        name: teacher.name,
        email: teacher.email,
      },
      dateRange: { start, end },
      totalClasses: classes.length,
      classes: classes.map((c) => {
        // Both are site-local strings read in the SAME zone — whatever zone that
        // is — so their difference is the true elapsed time; the only way it can
        // be off is a DST transition between the two instants in that zone, which
        // a class session of minutes cannot span.
        const startTime = new Date(c.startDateTime);
        const endTime = new Date(c.endDateTime);
        return {
          id: c.id,
          name: c.classDescription.name,
          startTime: c.startDateTime,
          endTime: c.endDateTime,
          duration: Math.round((endTime.getTime() - startTime.getTime()) / 60000),
          location: c.location.name,
          isSubstitute: c.isSubstitute,
          isCanceled: c.isCanceled,
          spotsAvailable: c.maxCapacity - c.totalBooked,
          totalSpots: c.maxCapacity,
        };
      }),
      summary,
    };
  }

  // ==========================================================================
  // APPOINTMENT MANAGEMENT
  // ==========================================================================

  async getAppointments(params: GetAppointmentsParams): Promise<ListResult<Appointment>> {
    const { start, end } = await this.defaultRange(params.startDate, params.endDate, 7);

    const { items: rows, totalResults } = await fetchAllPages<any>(
      this.client,
      '/appointment/staffappointments',
      {
        StaffIds: params.staffIds,
        LocationIds: params.locationIds,
        StartDate: start,
        EndDate: end,
        AppointmentIds: params.appointmentIds,
        ClientIds: params.clientIds,
      },
      'Appointments',
      params.limit || DEFAULT_PAGE_SIZE
    );

    const appointments = rows.map((apt: any) => ({
      id: apt.Id,
      status: apt.Status,
      staffId: apt.StaffId || apt.Staff?.Id,
      staffName: apt.Staff?.Name || `${apt.Staff?.FirstName || ''} ${apt.Staff?.LastName || ''}`.trim(),
      sessionTypeId: apt.SessionTypeId || apt.SessionType?.Id,
      sessionTypeName: apt.SessionType?.Name || '',
      locationId: apt.LocationId || apt.Location?.Id,
      locationName: apt.Location?.Name || '',
      startDateTime: apt.StartDateTime,
      endDateTime: apt.EndDateTime,
      clientId: apt.ClientId || apt.Client?.Id,
      clientName: apt.Client ? `${apt.Client.FirstName} ${apt.Client.LastName}` : undefined,
      clientEmail: apt.Client?.Email,
      clientPhone: apt.Client?.MobilePhone,
      notes: apt.Notes,
      staffRequested: apt.StaffRequested,
      providerId: apt.ProviderId,
      duration: apt.Duration,
      confirmed: apt.Confirmed,
      firstAppointment: apt.FirstAppointment,
      resources: apt.Resources?.map((r: any) => ({ id: r.Id, name: r.Name })),
    }));

    return { items: appointments, total: totalResults };
  }

  async addAppointment(params: AddAppointmentParams): Promise<OperationResult<Appointment>> {
    try {
      const response = await this.client.post<any>('/appointment/addappointment', {
        ClientId: params.clientId,
        StaffId: params.staffId,
        LocationId: params.locationId,
        SessionTypeId: params.sessionTypeId,
        StartDateTime: params.startDateTime,
        ResourceIds: params.resourceIds,
        Notes: params.notes,
        StaffRequested: params.staffRequested,
        ExecutePayment: params.executePayment,
        SendEmail: params.sendEmail,
        ApplyPayment: params.applyPayment,
      });

      return {
        success: true,
        data: {
          id: response.Appointment.Id,
          status: response.Appointment.Status,
          staffId: response.Appointment.Staff?.Id,
          staffName: response.Appointment.Staff?.Name || '',
          sessionTypeId: response.Appointment.SessionType?.Id,
          sessionTypeName: response.Appointment.SessionType?.Name || '',
          locationId: response.Appointment.Location?.Id,
          locationName: response.Appointment.Location?.Name || '',
          startDateTime: response.Appointment.StartDateTime,
          endDateTime: response.Appointment.EndDateTime,
          duration: response.Appointment.Duration,
          staffRequested: response.Appointment.StaffRequested,
          firstAppointment: response.Appointment.FirstAppointment,
        },
        message: 'Appointment booked successfully',
      };
    } catch (error: any) {
      return { success: false, message: error.message || 'Failed to book appointment' };
    }
  }

  async updateAppointment(params: UpdateAppointmentParams): Promise<OperationResult<Appointment>> {
    try {
      const response = await this.client.post<any>('/appointment/updateappointment', {
        AppointmentId: params.appointmentId,
        StaffId: params.staffId,
        StartDateTime: params.startDateTime,
        EndDateTime: params.endDateTime,
        ResourceIds: params.resourceIds,
        Notes: params.notes,
        ExecutePayment: params.executePayment,
        SendEmail: params.sendEmail,
        ApplyPayment: params.applyPayment,
      });

      return {
        success: true,
        data: {
          id: response.Appointment.Id,
          status: response.Appointment.Status,
          staffId: response.Appointment.Staff?.Id,
          staffName: response.Appointment.Staff?.Name || '',
          sessionTypeId: response.Appointment.SessionType?.Id,
          sessionTypeName: response.Appointment.SessionType?.Name || '',
          locationId: response.Appointment.Location?.Id,
          locationName: response.Appointment.Location?.Name || '',
          startDateTime: response.Appointment.StartDateTime,
          endDateTime: response.Appointment.EndDateTime,
          duration: response.Appointment.Duration,
          staffRequested: response.Appointment.StaffRequested,
          firstAppointment: response.Appointment.FirstAppointment,
        },
        message: 'Appointment updated successfully',
      };
    } catch (error: any) {
      return { success: false, message: error.message || 'Failed to update appointment' };
    }
  }

  async getBookableItems(params: GetBookableItemsParams): Promise<ListResult<BookableItem>> {
    const { start, end } = await this.defaultRange(params.startDate, params.endDate, 7);

    // The spec documents `Availabilities` as the one list key of
    // GetBookableItemsResponse; `BookableItems` is not in docs/openapi.json.
    const { items: rows } = await fetchAllPages<any>(
      this.client,
      '/appointment/bookableitems',
      {
        SessionTypeIds: params.sessionTypeIds,
        LocationIds: params.locationIds,
        StaffIds: params.staffIds,
        StartDate: start,
        EndDate: end,
        AppointmentId: params.appointmentId,
      },
      'Availabilities'
    );

    const items = rows.map((item: any) => ({
      scheduledItemId: item.Id ?? item.ScheduledItemId,
      staffId: item.StaffId || item.Staff?.Id,
      staffName: item.Staff?.Name || `${item.Staff?.FirstName || ''} ${item.Staff?.LastName || ''}`.trim(),
      sessionTypeId: item.SessionTypeId || item.SessionType?.Id,
      sessionTypeName: item.SessionType?.Name || '',
      locationId: item.LocationId || item.Location?.Id,
      locationName: item.Location?.Name || '',
      startDateTime: item.StartDateTime,
      endDateTime: item.EndDateTime,
      isAvailable: item.IsAvailable,
      isSingleSessionBookable: item.IsSingleSessionBookable,
    }));

    return { items, total: items.length };
  }

  async getScheduleItems(params?: { locationIds?: number[]; staffIds?: number[]; startDate?: string; endDate?: string; ignorePrepFinishBuffer?: boolean }): Promise<ListResult<ScheduleItem>> {
    const { start, end } = await this.defaultRange(params?.startDate, params?.endDate, 7);

    const { items: rows } = await fetchAllPages<any>(
      this.client,
      '/appointment/scheduleitems',
      {
        LocationIds: params?.locationIds,
        StaffIds: params?.staffIds,
        StartDate: start,
        EndDate: end,
        IgnorePrepFinishBuffer: params?.ignorePrepFinishBuffer,
      },
      'StaffMembers'
    );

    const scheduleItems = rows.flatMap((staff: any) =>
      staff.Appointments.map((apt: any) => ({
        id: apt.Id,
        isAvailable: apt.IsAvailable,
        isUnavailable: apt.Unavailable,
        staffId: staff.Id,
        staffName: staff.Name,
        sessionTypeId: apt.SessionType?.Id,
        sessionTypeName: apt.SessionType?.Name,
        locationId: apt.Location?.Id,
        locationName: apt.Location?.Name,
        startDateTime: apt.StartDateTime,
        endDateTime: apt.EndDateTime,
      }))
    );

    return { items: scheduleItems, total: scheduleItems.length };
  }

  async getActiveSessionTimes(params?: { scheduleType?: 'All' | 'Class' | 'Enrollment' | 'Appointment'; sessionTypeIds?: number[]; startTime?: string; endTime?: string; days?: string[] }): Promise<ListResult<ActiveSessionTime>> {
    const { items: rows } = await fetchAllPages<any>(
      this.client,
      '/appointment/activesessiontimes',
      {
        ScheduleType: params?.scheduleType || 'All',
        SessionTypeIds: params?.sessionTypeIds,
        StartTime: params?.startTime,
        EndTime: params?.endTime,
        Days: params?.days,
      },
      'ActiveSessionTimes'
    );

    const activeTimes = rows.map((time: any) => {
      const result: ActiveSessionTime = {
        id: time.Id,
        sessionTypeId: time.SessionTypeId || time.SessionType?.Id,
        sessionTypeName: time.SessionType?.Name || '',
        scheduleType: time.ScheduleType,
      };

      ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].forEach(day => {
        const dayData = time[day];
        if (dayData) {
          (result as any)[day.toLowerCase()] = {
            startTime: dayData.StartTime,
            endTime: dayData.EndTime,
            bookable: dayData.Bookable,
          };
        }
      });

      return result;
    });

    return { items: activeTimes, total: activeTimes.length };
  }

  // ==========================================================================
  // ENROLLMENT MANAGEMENT
  // ==========================================================================

  // Mindbody has no enrollment record. An enrollment is a ClassSchedule whose
  // Program has ScheduleType `Enrollment`; each session is a Class on that
  // schedule; a client's seat in a session is a Visit on the client's schedule.
  // The visit itself carries no enrollment marker, so a visit is an enrollment
  // visit when its class's ClassDescription.Program.ScheduleType is
  // `Enrollment`. This mirrors src/tools/enrollmentManagement.ts in the MCP
  // server, field for field against docs/openapi.json.

  /**
   * Enrollments scheduled at the site: GET /enrollment/enrollments (paginated,
   * list key `Enrollments`, rows are ClassSchedule). Without dates the window
   * is today through DEFAULT_ENROLLMENT_WINDOW_DAYS; the API's own default is
   * today only (EndDate defaults to StartDate). The spec's filters are
   * ClassScheduleIds, LocationIds, StaffIds, ProgramIds, SessionTypeIds,
   * StartDate and EndDate; there is no semester or course filter here.
   */
  async getEnrollments(params?: GetEnrollmentsParams): Promise<ListResult<Enrollment>> {
    const { start, end } = await this.defaultRange(params?.startDate, params?.endDate, DEFAULT_ENROLLMENT_WINDOW_DAYS);
    const { items: rows, totalResults } = await fetchAllPages<any>(
      this.client,
      '/enrollment/enrollments',
      {
        LocationIds: params?.locationIds,
        ClassScheduleIds: params?.classScheduleIds,
        StaffIds: params?.staffIds,
        ProgramIds: params?.programIds,
        SessionTypeIds: params?.sessionTypeIds,
        StartDate: start,
        EndDate: end,
      },
      'Enrollments',
      params?.limit || DEFAULT_PAGE_SIZE
    );

    const enrollments = rows.map(mapEnrollment);
    return { items: enrollments, total: totalResults || enrollments.length };
  }

  /**
   * Book one client into one enrollment: POST /enrollment/addclienttoenrollment.
   * Body field names follow the spec exactly: ClientId, ClassScheduleId
   * (singular), EnrollDateForward (one date-time, takes priority), EnrollOpen
   * (an ARRAY of session date-times), Waitlist, WaitlistEntryId, SendEmail,
   * Test. With neither date option the client is booked into every session.
   * The response is the ClassSchedule with its `Classes`; those are returned
   * as `data.sessions`.
   */
  async addClientToEnrollment(params: AddClientToEnrollmentParams): Promise<OperationResult<EnrollmentBookingResult>> {
    if (!Number.isInteger(params.classScheduleId) || params.classScheduleId <= 0) {
      return {
        success: false,
        message: 'classScheduleId must be a positive integer (the enrollment id from getEnrollments)',
      };
    }
    try {
      const response = await this.client.post<any>('/enrollment/addclienttoenrollment', {
        ClientId: params.clientId,
        ClassScheduleId: params.classScheduleId,
        EnrollDateForward: params.enrollDateForward,
        EnrollOpen: params.enrollOpenDates,
        Waitlist: params.waitlist ?? false,
        WaitlistEntryId: params.waitlistEntryId,
        SendEmail: params.sendEmail ?? false,
        Test: params.test ?? false,
      });
      const sessions = (Array.isArray(response?.Classes) ? response.Classes : []).map((cls: any) => ({
        classId: Number(cls.Id),
        startDateTime: cls.StartDateTime,
        endDateTime: cls.EndDateTime,
        totalBooked: cls.TotalBooked ?? undefined,
      }));
      const what = params.waitlist ? 'waitlisted for' : 'enrolled in';
      return {
        success: true,
        data: {
          classScheduleId: Number(response?.Id ?? params.classScheduleId),
          name: response?.ClassDescription?.Name ?? undefined,
          sessions,
        },
        message: `${params.test ? '[test] ' : ''}Client ${params.clientId} ${what} enrollment ${params.classScheduleId} (${sessions.length} session(s) on the schedule)`,
      };
    } catch (error: any) {
      return { success: false, message: error.message || 'Failed to add client to enrollment' };
    }
  }

  /**
   * The sessions a client holds in enrollments (courses, workshops, series).
   *
   * 1. GET /client/clientschedule (paginated, `Visits`, IncludeWaitlistEntries)
   *    for the window; rows with no ClassId are appointments and are dropped.
   *    There is no GET /client/clientenrollments in docs/openapi.json (the
   *    live API answers 404).
   * 2. GET /class/classes (paginated, `ClassIds` in chunks) resolves each
   *    visit's class. A visit is kept only when that class's
   *    ClassDescription.Program.ScheduleType is `Enrollment`; drop-in class
   *    visits are left out. Without this step the schedule rows cannot be told
   *    apart: `VisitType`/`TypeGroup` are the same for both.
   *
   * Without dates the window is today through DEFAULT_ENROLLMENT_WINDOW_DAYS,
   * so past sessions appear only when startDate is given.
   */
  async getClientEnrollments(clientId: string, startDate?: string, endDate?: string): Promise<ListResult<ClientEnrollmentVisit>> {
    const { start, end } = await this.defaultRange(startDate, endDate, DEFAULT_ENROLLMENT_WINDOW_DAYS);
    const { items: rows } = await fetchAllPages<any>(
      this.client,
      '/client/clientschedule',
      {
        ClientId: clientId,
        StartDate: start,
        EndDate: end,
        IncludeWaitlistEntries: true,
      },
      'Visits'
    );

    const classVisits = rows.filter((visit: any) => Number(visit?.ClassId) > 0);
    if (classVisits.length === 0) return { items: [], total: 0 };

    const classes = await this.lookupClassesById(
      classVisits.map((visit: any) => Number(visit.ClassId)),
      `${start}T00:00:00`,
      `${end}T23:59:59`
    );

    const visits: ClientEnrollmentVisit[] = [];
    for (const visit of classVisits) {
      const cls = classes.get(Number(visit.ClassId));
      if (!cls || cls.ClassDescription?.Program?.ScheduleType !== ENROLLMENT_SCHEDULE_TYPE) continue;
      const waitlistEntryId = visit.WaitlistInfo?.WaitlistId ?? undefined;
      visits.push({
        id: String(visit.Id),
        classId: Number(visit.ClassId),
        classScheduleId: Number(cls.ClassScheduleId),
        name: cls.ClassDescription?.Name ?? visit.Name ?? '',
        programId: cls.ClassDescription?.Program?.Id ?? undefined,
        programName: cls.ClassDescription?.Program?.Name ?? undefined,
        staffId: cls.Staff?.Id ?? visit.StaffId ?? undefined,
        staffName: staffDisplayName(cls.Staff),
        locationId: cls.Location?.Id ?? visit.LocationId ?? undefined,
        locationName: cls.Location?.Name ?? '',
        startDateTime: visit.StartDateTime,
        endDateTime: visit.EndDateTime,
        isWaitlisted: waitlistEntryId != null,
        waitlistEntryId,
        signedIn: Boolean(visit.SignedIn),
        lateCancelled: Boolean(visit.LateCancelled),
        missed: Boolean(visit.Missed),
        makeUp: Boolean(visit.MakeUp),
      });
    }
    visits.sort((a, b) => a.startDateTime.localeCompare(b.startDateTime));

    return { items: visits, total: visits.length };
  }

  /**
   * GET /class/classes for a set of class IDs, in chunks of CLASS_LOOKUP_CHUNK,
   * every chunk paged. Returns a map ClassId -> raw Class. The dates bound the
   * lookup the same way the caller bounded the visits.
   */
  private async lookupClassesById(classIds: number[], startDateTime: string, endDateTime: string): Promise<Map<number, any>> {
    const byId = new Map<number, any>();
    const unique = [...new Set(classIds)];
    for (let i = 0; i < unique.length; i += CLASS_LOOKUP_CHUNK) {
      const { items } = await fetchAllPages<any>(
        this.client,
        '/class/classes',
        {
          ClassIds: unique.slice(i, i + CLASS_LOOKUP_CHUNK),
          StartDateTime: startDateTime,
          EndDateTime: endDateTime,
          HideCanceledClasses: false,
        },
        'Classes'
      );
      for (const cls of items) byId.set(Number(cls.Id), cls);
    }
    return byId;
  }

  // ==========================================================================
  // SALES & COMMERCE
  // ==========================================================================

  async getServices(params?: GetServicesParams): Promise<ListResult<Service>> {
    const { items: rows } = await fetchAllPages<any>(
      this.client,
      '/sale/services',
      {
        ProgramIds: params?.programIds,
        SessionTypeIds: params?.sessionTypeIds,
        LocationId: params?.locationId,
        ClassId: params?.classId,
        HideRelatedPrograms: params?.hideRelatedPrograms,
      },
      'Services',
      params?.limit || DEFAULT_PAGE_SIZE
    );

    const services = rows.map((s: any) => ({
      id: s.Id,
      name: s.Name,
      price: s.Price,
      onlinePrice: s.OnlinePrice,
      taxIncluded: s.TaxIncluded,
      taxRate: s.TaxRate,
      programId: s.ProgramId,
      sessionTypeId: s.SessionTypeId,
      count: s.Count,
      expirationUnit: s.ExpirationUnit,
      expirationLength: s.ExpirationLength,
      membershipId: s.MembershipId,
      priority: s.Priority,
      prerequisite: s.Prerequisite,
    }));

    return { items: services, total: services.length };
  }

  async getPackages(locationId?: number, classScheduleId?: number): Promise<ListResult<Package>> {
    const { items: rows } = await fetchAllPages<any>(
      this.client,
      '/sale/packages',
      {
        LocationId: locationId,
        ClassScheduleId: classScheduleId,
      },
      'Packages'
    );

    const packages = rows.map((p: any) => ({
      id: p.Id,
      name: p.Name,
      classCount: p.Count,
      price: p.Price,
      onlinePrice: p.OnlinePrice,
      taxIncluded: p.TaxIncluded,
      active: p.Active,
      productId: p.ProductId,
      sellOnline: p.SellOnline,
      services: p.Services?.map((s: any) => ({ id: s.Id, name: s.Name, count: s.Count })),
    }));

    return { items: packages, total: packages.length };
  }

  async getProducts(params?: GetProductsParams): Promise<ListResult<Product>> {
    const { items: rows, totalResults } = await fetchAllPages<any>(
      this.client,
      '/sale/products',
      {
        ProductIds: params?.productIds,
        SearchText: params?.searchText,
        CategoryIds: params?.categoryIds,
        SubCategoryIds: params?.subCategoryIds,
        SellOnline: params?.sellOnline,
      },
      'Products',
      params?.limit || DEFAULT_PAGE_SIZE
    );

    const products = rows.map((p: any) => ({
      id: p.Id,
      name: p.Name,
      price: p.Price,
      onlinePrice: p.OnlinePrice,
      description: p.Description,
      category: p.Category,
      subCategory: p.Subcategory,
      color: p.Color?.Name,
      size: p.Size?.Name,
      taxIncluded: p.TaxIncluded,
      taxRate: p.TaxRate,
      sellOnline: p.SellOnline,
    }));

    return { items: products, total: totalResults };
  }

  async getContracts(params?: GetContractsParams): Promise<ListResult<Contract>> {
    const { items: rows } = await fetchAllPages<any>(
      this.client,
      '/sale/contracts',
      {
        ContractIds: params?.contractIds,
        SoldOnline: params?.soldOnline,
        LocationId: params?.locationId,
      },
      'Contracts'
    );

    const contracts = rows.map((c: any) => ({
      id: c.Id,
      name: c.Name,
      description: c.Description,
      assignsMembershipId: c.AssignsMembershipId,
      assignsMembershipName: c.AssignsMembershipName,
      soldOnline: c.SoldOnline,
      contractType: c.ContractType,
      agreementTerms: c.AgreementTerms,
      autopaySchedule: c.AutopaySchedule ? {
        frequency: c.AutopaySchedule.FrequencyType,
        duration: c.AutopaySchedule.FrequencyValue,
        paymentAmount: c.AutopaySchedule.PaymentAmount,
      } : undefined,
      introOffer: c.IntroOffer ? {
        id: c.IntroOffer.Id,
        name: c.IntroOffer.Name,
        price: c.IntroOffer.Price,
      } : undefined,
      locationId: c.LocationId,
    }));

    return { items: contracts, total: contracts.length };
  }

  async checkoutShoppingCart(params: CheckoutParams): Promise<OperationResult<{ shoppingCart?: ShoppingCartResult; appointments?: Array<{ id: number; status: string; startDateTime: string; endDateTime: string }> }>> {
    try {
      const cartItems = params.items.map(item => {
        const baseItem: any = { Quantity: item.quantity };

        if (item.item.type === 'Tip') {
          baseItem.Item = { Type: 'Tip', Metadata: { Amount: item.item.metadata.amount } };
        } else {
          baseItem.Item = { Type: item.item.type, Metadata: { Id: item.item.metadata.id } };
        }

        if (item.appointmentBookingRequests) {
          baseItem.AppointmentBookingRequests = item.appointmentBookingRequests.map(apt => ({
            StaffId: apt.staffId,
            LocationId: apt.locationId,
            SessionTypeId: apt.sessionTypeId,
            StartDateTime: apt.startDateTime,
            Notes: apt.notes,
          }));
        }

        return baseItem;
      });

      const paymentMethods = params.payments.map(payment => {
        const basePayment: any = { Type: payment.type, Metadata: { Amount: payment.metadata.amount } };
        if (payment.metadata.notes) basePayment.Metadata.Notes = payment.metadata.notes;
        if (payment.type === 'StoredCard' && payment.metadata.lastFour) basePayment.Metadata.LastFour = payment.metadata.lastFour;
        if (payment.type === 'CreditCard') {
          if (payment.metadata.cardholderName) basePayment.Metadata.CardholderName = payment.metadata.cardholderName;
          if (payment.metadata.billingAddress) {
            basePayment.Metadata.BillingAddress = payment.metadata.billingAddress;
            basePayment.Metadata.BillingCity = payment.metadata.billingCity;
            basePayment.Metadata.BillingState = payment.metadata.billingState;
            basePayment.Metadata.BillingPostalCode = payment.metadata.billingPostalCode;
          }
        }
        return basePayment;
      });

      const response = await this.client.post<any>('/sale/checkoutshoppingcart', {
        ClientId: params.clientId,
        Items: cartItems,
        Payments: paymentMethods,
        InStore: params.inStore,
        PromotionCode: params.promotionCode,
        SendEmail: params.sendEmail,
        LocationId: params.locationId,
      });

      return {
        success: true,
        data: {
          shoppingCart: response.ShoppingCart ? {
            id: response.ShoppingCart.Id,
            subTotal: response.ShoppingCart.SubTotal,
            taxTotal: response.ShoppingCart.TaxTotal,
            discountTotal: response.ShoppingCart.DiscountTotal,
            grandTotal: response.ShoppingCart.GrandTotal,
            items: response.ShoppingCart.CartItems.map((item: any) => ({
              id: item.Id,
              name: item.Name,
              price: item.UnitPrice,
              quantity: item.Quantity,
              discountAmount: item.DiscountAmount,
              tax: item.TaxAmount,
              total: item.Total,
            })),
          } : undefined,
          appointments: response.Appointments?.map((apt: any) => ({
            id: apt.Id,
            status: apt.Status,
            startDateTime: apt.StartDateTime,
            endDateTime: apt.EndDateTime,
          })),
        },
        message: 'Checkout completed successfully',
      };
    } catch (error: any) {
      return { success: false, message: error.message || 'Failed to checkout' };
    }
  }

  async purchaseContract(params: PurchaseContractParams): Promise<OperationResult<{ clientContract: { id: number; clientId: string; contractName: string; startDate: string; endDate?: string; paymentAmount: number } }>> {
    try {
      const response = await this.client.post<any>('/sale/purchasecontract', {
        ClientId: params.clientId,
        ContractId: params.contractId,
        StartDate: params.startDate,
        FirstPaymentOccurs: params.firstPaymentOccurs || 'StartDate',
        ClientSignature: params.clientSignature,
        PromotionCode: params.promotionCode,
        LocationId: params.locationId,
      });

      return {
        success: true,
        data: {
          clientContract: {
            id: response.ClientContract.Id,
            clientId: response.ClientContract.ClientId,
            contractName: response.ClientContract.ContractName,
            startDate: response.ClientContract.StartDate,
            endDate: response.ClientContract.EndDate,
            paymentAmount: response.ClientContract.PaymentAmount,
          },
        },
        message: 'Contract purchased successfully',
      };
    } catch (error: any) {
      return { success: false, message: error.message || 'Failed to purchase contract' };
    }
  }
}

// Create singleton instance
let serviceInstance: MindbodyService | null = null;

export function getMindbodyService(): MindbodyService {
  if (!serviceInstance) {
    serviceInstance = new MindbodyService();
  }
  return serviceInstance;
}

export function resetMindbodyService(): void {
  serviceInstance = null;
}
