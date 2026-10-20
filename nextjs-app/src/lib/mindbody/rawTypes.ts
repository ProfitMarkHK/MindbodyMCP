// Raw Mindbody API row shapes for the client domain, derived from
// docs/openapi.json (`Mindbody.PublicApi.Dto.Models.V6.*`). These are the
// PascalCase wire shapes, distinct from the camelCase output types in `types.ts`.

export interface MindbodyLiability {
  AgreementDate: string;
  IsReleased: boolean;
  ReleasedBy?: number;
}

export interface MindbodyClientCreditCard {
  CardType?: string;
  LastFour?: string;
}

export interface MindbodyProgram {
  Id?: number;
  Name?: string;
  ScheduleType?: string;
}

export interface MindbodyClient {
  Id: string;
  FirstName: string;
  LastName: string;
  Email?: string;
  MobilePhone?: string;
  HomePhone?: string;
  BirthDate?: string;
  AddressLine1?: string;
  AddressLine2?: string;
  City?: string;
  State?: string;
  PostalCode?: string;
  Country?: string;
  Gender?: string;
  IsProspect?: boolean;
  IsCompany?: boolean;
  Active?: boolean;
  SendAccountEmails?: boolean;
  Liability?: MindbodyLiability;
  EmergencyContactInfoName?: string;
  EmergencyContactInfoPhone?: string;
  EmergencyContactInfoRelationship?: string;
  CreationDate?: string;
  Status?: string;
  MembershipIcon?: number;
  AccountBalance?: number;
  ClientCreditCard?: MindbodyClientCreditCard;
  ReferredBy?: string;
  PhotoUrl?: string;
  Notes?: string;
}

export interface MindbodyVisit {
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

export interface MindbodyClientMembership {
  Id: number;
  Name: string;
  Remaining?: number;
  ActiveDate: string;
  ExpirationDate?: string;
  PaymentDate?: string;
  Program?: MindbodyProgram;
  SiteId: number;
  // Sandbox-verified (C-31): a string on the wire (e.g. "6"), matching the spec.
  IconCode?: string;
  Action?: string;
}

export interface MindbodyClientContract {
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

export interface MindbodyAddClientResponse {
  Client: MindbodyClient;
  Status?: string;
}

export interface MindbodyUpdateClientResponse {
  Client: MindbodyClient;
}

export interface MindbodyAddArrivalResponse {
  ArrivalAdded: boolean;
  ClientService?: unknown;
}
