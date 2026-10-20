// Mindbody API Types

export interface PaginationResponse {
  PaginationResponse: {
    RequestedLimit: number;
    RequestedOffset: number;
    PageSize: number;
    TotalResults: number;
  };
}

export interface Staff {
  Id: number;
  FirstName: string;
  LastName: string;
  Name: string;
  Email?: string;
  MobilePhone?: string;
  ImageUrl?: string;
  Bio?: string;
  isMale?: boolean;
}

export interface Location {
  Id: number;
  Name: string;
  Description?: string;
  Address?: string;
  Address2?: string;
  City?: string;
  State?: string;
  PostalCode?: string;
}

export interface ClassDescription {
  Id: number;
  Name: string;
  Description?: string;
  ImageUrl?: string;
}

export interface Class {
  Id: number;
  ClassScheduleId: number;
  Location: Location;
  ClassDescription: ClassDescription;
  Staff: Staff;
  StartDateTime: string;
  EndDateTime: string;
  IsCanceled: boolean;
  IsWaitlistAvailable: boolean;
  IsAvailable: boolean;
  /**
   * The wire field is `Substitute`, not `IsSubstitute` (C-6). The TypeScript
   * field is spelled `Substitute` so the two cannot drift again; the tool
   * output field is `substitute`.
   */
  Substitute: boolean;
  MaxCapacity: number;
  TotalBooked: number;
  WebCapacity: number;
  TotalBookedWaitlist: number;
}

export interface GetClassesRequest {
  ClassDescriptionIds?: number[];
  ClassIds?: number[];
  StaffIds?: number[];
  StartDateTime?: string;
  EndDateTime?: string;
  LocationIds?: number[];
  Limit?: number;
  Offset?: number;
}

export interface GetClassesResponse extends PaginationResponse {
  Classes: Class[];
}

export interface GetStaffRequest {
  StaffIds?: number[];
  Filters?: string[];
  SessionTypeIds?: number[];
  LocationIds?: number[];
  StartDateTime?: string;
  Limit?: number;
  Offset?: number;
}

export interface GetStaffResponse extends PaginationResponse {
  StaffMembers: Staff[];
}

// Helper types for our tools
export interface TeacherSchedule {
  teacher: {
    id: number;
    name: string;
    email?: string;
  };
  dateRange: {
    start: string;
    end: string;
  };
  totalClasses: number;
  classes: Array<{
    id: number;
    name: string;
    startTime: string;
    endTime: string;
    duration: number; // in minutes
    location: string;
    /** From `Class.Substitute`; the output field is named after the wire field (C-6). */
    substitute: boolean;
    isCanceled: boolean;
    spotsAvailable: number;
    totalSpots: number;
  }>;
  summary: {
    byDay: Record<string, number>;
    byLocation: Record<string, number>;
    byClassType: Record<string, number>;
  };
}

// Additional request/response types
export interface AddClientToClassRequest {
  ClientId: string;
  ClassId: number;
  RequirePayment?: boolean;
  Waitlist?: boolean;
}

export interface RemoveClientFromClassRequest {
  ClientId: string;
  ClassId: number;
  LateCancel?: boolean;
}

export interface GetClientsRequest {
  SearchText?: string;
  ClientIds?: string[];
  LastModifiedDate?: string;
  IsProspect?: boolean;
  Limit?: number;
  Offset?: number;
}

export interface GetServicesRequest {
  ProgramIds?: number[];
  SessionTypeIds?: number[];
  LocationId?: number;
  ClassId?: number;
  HideRelatedPrograms?: boolean;
  Limit?: number;
}

export interface GetPackagesRequest {
  LocationId?: number;
  ClassScheduleId?: number;
  Limit?: number;
}

export interface GetProductsRequest {
  ProductIds?: number[];
  SearchText?: string;
  CategoryIds?: string[];
  SubCategoryIds?: string[];
  SellOnline?: boolean;
  Limit?: number;
}

export interface GetLocationsRequest {
  Limit?: number;
}

export interface GetProgramsRequest {
  ScheduleType?: 'All' | 'Class' | 'Enrollment' | 'Appointment';
  OnlineOnly?: boolean;
  Limit?: number;
}

export interface GetSessionTypesRequest {
  ProgramIds?: number[];
  OnlineOnly?: boolean;
  Limit?: number;
}

export interface GetAppointmentsRequest {
  StaffIds: number[];
  LocationIds?: number[];
  StartDate?: string;
  EndDate?: string;
  AppointmentIds?: number[];
  ClientIds?: string[];
  Limit?: number;
}

export interface GetEnrollmentsRequest {
  LocationIds?: number[];
  ClassScheduleIds?: number[];
  StaffIds?: number[];
  ProgramIds?: number[];
  SessionTypeIds?: number[];
  SemesterIds?: number[];
  CourseIds?: number[];
  StartDate?: string;
  EndDate?: string;
  Limit?: number;
}

// Class Visits types
export interface GetClassVisitsRequest {
  ClassId: number;
  LastModifiedDate?: string;
  Limit?: number;
  Offset?: number;
}

export interface ClassVisit {
  Id: number;
  ClassId: number;
  ClientId: string;
  Client?: {
    Id: string;
    FirstName: string;
    LastName: string;
    Email?: string;
    MobilePhone?: string;
    HomePhone?: string;
  };
  StartDateTime: string;
  EndDateTime: string;
  SignedIn: boolean;
  WebSignup: boolean;
  MakeUp: boolean;
  LateCancelled: boolean;
  Service?: {
    Id: number;
    Name: string;
  };
  Location?: Location;
}

export interface GetClassVisitsResponse extends PaginationResponse {
  Visits: ClassVisit[];
}

// ---------------------------------------------------------------------------
// Client domain (spec-derived from docs/openapi.json, `Mindbody.PublicApi.Dto
// .Models.V6.*`). Field *types* are copied from the spec, not inferred from
// neighbouring names; see the note on `ClientMembership.IconCode` for one place
// the wire type is still in question.
// ---------------------------------------------------------------------------

/** `Liability` — a client's liability-waiver agreement. */
export interface Liability {
  AgreementDate: string;
  IsReleased: boolean;
  ReleasedBy?: number;
}

/** `ClientCreditCard` — a stored card (only the fields the tools read). */
export interface ClientCreditCard {
  CardType?: string;
  LastFour?: string;
}

/** `Program` — a service category. */
export interface Program {
  Id?: number;
  Name?: string;
  ScheduleType?: string;
}

/** `Client` — a client record. Only the fields the client tools read are typed. */
export interface Client {
  Id: string;
  FirstName: string;
  LastName: string;
  Email?: string;
  MobilePhone?: string;
  HomePhone?: string;
  BirthDate?: string;
  AddressLine1?: string;
  City?: string;
  State?: string;
  PostalCode?: string;
  Country?: string;
  IsProspect?: boolean;
  SendAccountEmails?: boolean;
  Liability?: Liability;
  EmergencyContactInfoName?: string;
  EmergencyContactInfoPhone?: string;
  EmergencyContactInfoRelationship?: string;
  CreationDate: string;
  Status: string;
  MembershipIcon?: number;
  AccountBalance?: number;
  ClientCreditCard?: ClientCreditCard;
}

/** `ClientSuspensionInfo`. */
export interface ClientSuspensionInfo {
  BookingSuspended?: boolean;
  SuspensionStartDate?: string;
  SuspensionEndDate?: string;
}

/** `ClientWithSuspensionInfo` — `/client/clients` returns these (Client + suspension info). */
export interface ClientWithSuspensionInfo extends Client {
  SuspensionInfo?: ClientSuspensionInfo;
}

/** `Visit` — a client-visit row from `/client/clientvisits`. */
export interface Visit {
  Id: number;
  ClassId: number;
  Name: string;
  StartDateTime: string;
  EndDateTime: string;
  LocationId?: number;
  StaffId?: number;
  SignedIn: boolean;
  WebSignup: boolean;
  LateCancelled: boolean;
  ServiceId?: number;
  ServiceName?: string;
}

/** `ClientMembership` — an active membership. */
export interface ClientMembership {
  Id: number;
  Name: string;
  Remaining?: number;
  ActiveDate: string;
  ExpirationDate?: string;
  PaymentDate?: string;
  Program?: Program;
  SiteId: number;
  // Sandbox-verified (C-31): `IconCode` is a string on the wire (e.g. "6"), matching
  // the spec ("text code that represents the MembershipIcon"). The integer
  // `MembershipIcon` is a separate field on `Client`. The previous `number` typing
  // was a type lie; aligned to the spec.
  IconCode?: string;
  Action?: string;
}

/** `ClientContract` — a client contract. */
export interface ClientContract {
  Id: number;
  ContractID?: number;
  ContractName: string;
  AgreementDate?: string;
  StartDate: string;
  EndDate?: string;
  AutopayStatus?: string;
  AutoRenewing?: boolean;
  IsMonthToMonth?: boolean;
  TerminationDate?: string;
  SiteId: number;
}

/** `AddClientResponse`. */
export interface AddClientResponse {
  Client: Client;
  Status?: string;
}

/** `UpdateClientResponse`. */
export interface UpdateClientResponse {
  Client: ClientWithSuspensionInfo;
}

/** `AddArrivalResponse` — note: the spec defines no `Message` field here. */
export interface AddArrivalResponse {
  ArrivalAdded: boolean;
  ClientService?: unknown;
}
