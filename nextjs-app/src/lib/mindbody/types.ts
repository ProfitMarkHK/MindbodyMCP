// ============================================================================
// MINDBODY API TYPES - Strongly Typed Interfaces for All API Operations
// ============================================================================

// Base Types
export interface PaginationResponse {
  RequestedLimit: number;
  RequestedOffset: number;
  PageSize: number;
  TotalResults: number;
}

export interface ApiResponse<T> {
  data: T;
  pagination?: {
    limit: number;
    offset: number;
    total: number;
  };
}

// ============================================================================
// SITE & LOCATION TYPES
// ============================================================================

export interface Site {
  id: number;
  name: string;
  description?: string;
  logoUrl?: string;
  contactEmail?: string;
  /** The site's IANA zone, e.g. "America/Los_Angeles". Every Mindbody
   *  date-time is in this zone; see lib/mindbody/siteTime.ts. */
  timeZone?: string;
  acceptsVisa: boolean;
  acceptsMastercard: boolean;
  acceptsAmex: boolean;
  acceptsDiscover: boolean;
  allowsDirectPay: boolean;
  smsPackageEnabled: boolean;
}

export interface Location {
  id: number;
  name: string;
  description?: string;
  address?: string;
  address2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  phone?: string;
  latitude?: number;
  longitude?: number;
  hasClasses: boolean;
}

export interface Resource {
  id: number;
  name: string;
}

// ============================================================================
// STAFF TYPES
// ============================================================================

export interface Staff {
  id: number;
  firstName: string;
  lastName: string;
  name: string;
  email?: string;
  mobilePhone?: string;
  imageUrl?: string;
  bio?: string;
  isMale?: boolean;
  appointmentTrn?: boolean;
  independentContractor?: boolean;
}

export interface GetStaffParams {
  staffIds?: number[];
  filters?: string[];
  sessionTypeIds?: number[];
  locationIds?: number[];
  startDateTime?: string;
  limit?: number;
  offset?: number;
}

// ============================================================================
// CLIENT TYPES
// ============================================================================

export interface Client {
  id: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  mobilePhone?: string;
  homePhone?: string;
  birthDate?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  gender?: string;
  isProspect: boolean;
  isCompany: boolean;
  status: string;
  active: boolean;
  sendAccountEmails: boolean;
  referredBy?: string;
  photoUrl?: string;
  notes?: string;
  emergencyContact?: {
    name: string;
    phone?: string;
    relationship?: string;
  };
  liability?: {
    isReleased: boolean;
    agreedDate?: string;
  };
  accountBalance: number;
  creationDate?: string;
  membershipIcon?: number;
}

export interface GetClientsParams {
  searchText?: string;
  clientIds?: string[];
  lastModifiedDate?: string;
  isProspect?: boolean;
  limit?: number;
  offset?: number;
}

export interface AddClientParams {
  firstName: string;
  lastName: string;
  email?: string;
  mobilePhone?: string;
  birthDate?: string;
  addressLine1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  emergencyContactRelationship?: string;
  sendAccountEmails?: boolean;
  referredBy?: string;
}

export interface UpdateClientParams {
  clientId: string;
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
}

export interface ClientVisit {
  id: number;
  classId: number;
  className: string;
  startTime: string;
  endTime: string;
  location?: string;
  instructor?: string;
  signedIn: boolean;
  webSignup: boolean;
  lateCancel: boolean;
  serviceId?: number;
  serviceName?: string;
}

export interface ClientMembership {
  id: number;
  name: string;
  remainingClasses?: number;
  activeDate: string;
  expirationDate?: string;
  paymentDate?: string;
  programName?: string;
  programId?: number;
  siteId: number;
  iconCode?: string;
  action?: string;
}

export interface ClientContract {
  id: number;
  name: string;
  soldDate?: string;
  startDate: string;
  endDate?: string;
  autopayStatus?: string;
  siteId: number;
}

export interface GetClientVisitsParams {
  clientId: string;
  startDate?: string;
  endDate?: string;
}

// ============================================================================
// CLASS TYPES
// ============================================================================

export interface ClassDescription {
  id: number;
  name: string;
  description?: string;
  imageUrl?: string;
  category?: string;
  subcategory?: string;
  active: boolean;
}

export interface Class {
  id: number;
  classScheduleId: number;
  location: Location;
  classDescription: ClassDescription;
  staff: Staff;
  startDateTime: string;
  endDateTime: string;
  isCanceled: boolean;
  isWaitlistAvailable: boolean;
  isAvailable: boolean;
  isSubstitute: boolean;
  maxCapacity: number;
  totalBooked: number;
  webCapacity: number;
  totalBookedWaitlist: number;
  virtualStreamLink?: string;
}

export interface ClassSchedule {
  id: number;
  locationId: number;
  classDescriptionId: number;
  staffId?: number;
  startTime: string;
  endTime: string;
  startDate: string;
  endDate?: string;
  daysOfWeek: string[];
  maxCapacity?: number;
  webCapacity?: number;
  isActive: boolean;
}

export interface GetClassesParams {
  classDescriptionIds?: number[];
  classIds?: number[];
  staffIds?: number[];
  startDateTime?: string;
  endDateTime?: string;
  locationIds?: number[];
  limit?: number;
  offset?: number;
}

export interface AddClientToClassParams {
  clientId: string;
  classId: number;
  requirePayment?: boolean;
  waitlist?: boolean;
  sendEmail?: boolean;
}

export interface RemoveClientFromClassParams {
  clientId: string;
  classId: number;
  lateCancel?: boolean;
  sendEmail?: boolean;
}

export interface WaitlistEntry {
  id: number;
  classId: number;
  clientId: string;
  clientName: string;
  requestDateTime: string;
  visitRefNo?: number;
  webSignup: boolean;
}

export interface SubstituteTeacherParams {
  classId: number;
  staffId: number;
  sendClientEmail?: boolean;
  sendOriginalTeacherEmail?: boolean;
  sendSubstituteTeacherEmail?: boolean;
}

// ============================================================================
// APPOINTMENT TYPES
// ============================================================================

export interface Appointment {
  id: number;
  status: string;
  staffId: number;
  staffName: string;
  sessionTypeId: number;
  sessionTypeName: string;
  locationId: number;
  locationName: string;
  startDateTime: string;
  endDateTime: string;
  clientId?: string;
  clientName?: string;
  clientEmail?: string;
  clientPhone?: string;
  notes?: string;
  staffRequested: boolean;
  providerId?: string;
  duration: number;
  confirmed?: boolean;
  firstAppointment: boolean;
  resources?: Resource[];
}

export interface GetAppointmentsParams {
  staffIds: number[];
  locationIds?: number[];
  startDate?: string;
  endDate?: string;
  appointmentIds?: number[];
  clientIds?: string[];
  limit?: number;
}

export interface AddAppointmentParams {
  clientId: string;
  staffId: number;
  locationId: number;
  sessionTypeId: number;
  startDateTime: string;
  resourceIds?: number[];
  notes?: string;
  staffRequested?: boolean;
  executePayment?: boolean;
  sendEmail?: boolean;
  applyPayment?: boolean;
}

export interface UpdateAppointmentParams {
  appointmentId: number;
  staffId?: number;
  startDateTime?: string;
  endDateTime?: string;
  resourceIds?: number[];
  notes?: string;
  executePayment?: boolean;
  sendEmail?: boolean;
  applyPayment?: boolean;
}

export interface BookableItem {
  scheduledItemId: number;
  staffId: number;
  staffName: string;
  sessionTypeId: number;
  sessionTypeName: string;
  locationId: number;
  locationName: string;
  startDateTime: string;
  endDateTime: string;
  isAvailable: boolean;
  isSingleSessionBookable?: boolean;
}

export interface GetBookableItemsParams {
  sessionTypeIds: number[];
  locationIds?: number[];
  staffIds?: number[];
  startDate?: string;
  endDate?: string;
  appointmentId?: number;
}

export interface ScheduleItem {
  id: number;
  isAvailable: boolean;
  isUnavailable: boolean;
  staffId: number;
  staffName: string;
  sessionTypeId: number;
  sessionTypeName: string;
  locationId: number;
  locationName: string;
  startDateTime: string;
  endDateTime: string;
}

export interface ActiveSessionTime {
  id: number;
  sessionTypeId: number;
  sessionTypeName: string;
  scheduleType: string;
  monday?: { startTime: string; endTime: string; bookable: boolean };
  tuesday?: { startTime: string; endTime: string; bookable: boolean };
  wednesday?: { startTime: string; endTime: string; bookable: boolean };
  thursday?: { startTime: string; endTime: string; bookable: boolean };
  friday?: { startTime: string; endTime: string; bookable: boolean };
  saturday?: { startTime: string; endTime: string; bookable: boolean };
  sunday?: { startTime: string; endTime: string; bookable: boolean };
}

// ============================================================================
// ENROLLMENT TYPES
// ============================================================================

/**
 * One enrollment (course, workshop or series) as GET /enrollment/enrollments
 * returns it. Mindbody has no enrollment record of its own: each row is a
 * ClassSchedule whose program has ScheduleType `Enrollment`. `id` is the
 * `classScheduleId` that addClientToEnrollment takes. Name, description,
 * program and session type come from `ClassDescription`; the scheduled days
 * are the spec's seven `DaySunday`..`DaySaturday` booleans, collapsed into
 * `days`. A ClassSchedule carries no capacity: that lives on each Class.
 */
export interface Enrollment {
  /** ClassSchedule ID: the `classScheduleId` addClientToEnrollment takes. */
  id: number;
  name: string;
  description?: string;
  courseId?: number;
  courseName?: string;
  programId?: number;
  programName?: string;
  sessionTypeId?: number;
  sessionTypeName?: string;
  staffId?: number;
  staffName: string;
  locationId?: number;
  locationName: string;
  semesterId?: number;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  /** Day names, e.g. ['Monday', 'Wednesday']. */
  days: string[];
  /** Booking after the enrollment has started is allowed (`enrollOpenDates`). */
  allowOpenEnrollment: boolean;
  /** Booking from a date forward is allowed (`enrollDateForward`). */
  allowDateForwardEnrollment: boolean;
  isAvailable: boolean;
}

/**
 * One session a client holds in an enrollment, as returned by
 * MindbodyService.getClientEnrollments: a row of GET /client/clientschedule
 * whose class belongs to an `Enrollment` program. `id` is the visit ID.
 */
export interface ClientEnrollmentVisit {
  /** Visit ID. */
  id: string;
  classId: number;
  /** ClassSchedule ID of the enrollment this session belongs to. */
  classScheduleId: number;
  /** Enrollment name (from the class's ClassDescription). */
  name: string;
  programId?: number;
  programName?: string;
  staffId?: number;
  staffName: string;
  locationId?: number;
  locationName: string;
  startDateTime: string;
  endDateTime: string;
  isWaitlisted: boolean;
  waitlistEntryId?: number;
  signedIn: boolean;
  lateCancelled: boolean;
  missed: boolean;
  makeUp: boolean;
}

/**
 * Filters of GET /enrollment/enrollments. These are the only ones the spec
 * defines; there is no semester or course filter on this endpoint.
 */
export interface GetEnrollmentsParams {
  locationIds?: number[];
  classScheduleIds?: number[];
  staffIds?: number[];
  programIds?: number[];
  sessionTypeIds?: number[];
  /** YYYY-MM-DD; default today. */
  startDate?: string;
  /** YYYY-MM-DD; default 365 days after startDate. */
  endDate?: string;
  limit?: number;
}

/** Body of POST /enrollment/addclienttoenrollment, in the spec's own terms. */
export interface AddClientToEnrollmentParams {
  clientId: string;
  /** The enrollment `id` from getEnrollments (ClassScheduleId, singular). */
  classScheduleId: number;
  /**
   * Book every session from this site-local date-time on (EnrollDateForward).
   * Takes priority over `enrollOpenDates`. Needs allowDateForwardEnrollment.
   */
  enrollDateForward?: string;
  /** Book only these session date-times (EnrollOpen). Needs allowOpenEnrollment. */
  enrollOpenDates?: string[];
  /** Add to the enrollment's waiting list instead (default false). */
  waitlist?: boolean;
  /** Promote this waiting-list entry into the enrollment. */
  waitlistEntryId?: number;
  sendEmail?: boolean;
  /** Validate only, commit nothing (default false). */
  test?: boolean;
}

/** What addClientToEnrollment reports back: the ClassSchedule's sessions after the booking. */
export interface EnrollmentBookingResult {
  classScheduleId: number;
  name?: string;
  sessions: Array<{ classId: number; startDateTime: string; endDateTime: string; totalBooked?: number }>;
}

// ============================================================================
// SALES & COMMERCE TYPES
// ============================================================================

export interface Service {
  id: number;
  name: string;
  price: number;
  onlinePrice?: number;
  taxIncluded: boolean;
  taxRate?: number;
  programId?: number;
  sessionTypeId?: number;
  count?: number;
  expirationUnit?: string;
  expirationLength?: number;
  membershipId?: number;
  priority?: number;
  prerequisite?: string;
}

export interface Package {
  id: number;
  name: string;
  classCount: number;
  price: number;
  onlinePrice?: number;
  taxIncluded: boolean;
  active: boolean;
  productId?: number;
  sellOnline: boolean;
  services?: Array<{ id: number; name: string; count: number }>;
}

export interface Product {
  id: string;
  name: string;
  price: number;
  onlinePrice?: number;
  description?: string;
  category?: string;
  subCategory?: string;
  color?: string;
  size?: string;
  taxIncluded: boolean;
  taxRate?: number;
  sellOnline: boolean;
}

export interface Contract {
  id: number;
  name: string;
  description?: string;
  assignsMembershipId?: number;
  assignsMembershipName?: string;
  soldOnline: boolean;
  contractType: string;
  agreementTerms?: string;
  autopaySchedule?: {
    frequency: string;
    duration?: number;
    paymentAmount: number;
  };
  introOffer?: {
    id: string;
    name: string;
    price: number;
  };
  locationId?: number;
}

export interface GetServicesParams {
  programIds?: number[];
  sessionTypeIds?: number[];
  locationId?: number;
  classId?: number;
  hideRelatedPrograms?: boolean;
  limit?: number;
}

export interface GetProductsParams {
  productIds?: number[];
  searchText?: string;
  categoryIds?: string[];
  subCategoryIds?: string[];
  sellOnline?: boolean;
  limit?: number;
}

export interface GetContractsParams {
  contractIds?: number[];
  soldOnline?: boolean;
  locationId?: number;
}

// Shopping Cart Types
export interface CartItem {
  item: {
    type: 'Service' | 'Product' | 'Package' | 'Tip';
    metadata: {
      /** Service, Product or Package ID. Not used for a Tip, which carries `amount`. */
      id?: number;
      name?: string;
      amount?: number;
    };
  };
  quantity: number;
  appointmentBookingRequests?: Array<{
    staffId: number;
    locationId: number;
    sessionTypeId: number;
    startDateTime: string;
    notes?: string;
  }>;
}

export interface Payment {
  type: 'Cash' | 'Check' | 'CreditCard' | 'Comp' | 'Custom' | 'StoredCard';
  metadata: {
    amount: number;
    notes?: string;
    lastFour?: string;
    cardholderName?: string;
    billingAddress?: string;
    billingCity?: string;
    billingState?: string;
    billingPostalCode?: string;
  };
}

export interface CheckoutParams {
  clientId: string;
  items: CartItem[];
  payments: Payment[];
  inStore?: boolean;
  promotionCode?: string;
  sendEmail?: boolean;
  locationId?: number;
}

export interface ShoppingCartResult {
  id: string;
  subTotal: number;
  taxTotal: number;
  discountTotal: number;
  grandTotal: number;
  items: Array<{
    id: number;
    name: string;
    price: number;
    quantity: number;
    discountAmount: number;
    tax: number;
    total: number;
  }>;
}

export interface PurchaseContractParams {
  clientId: string;
  contractId: number;
  startDate: string;
  firstPaymentOccurs?: 'StartDate' | 'UponSale' | 'BillingDate';
  clientSignature?: string;
  promotionCode?: string;
  locationId?: number;
}

// ============================================================================
// PROGRAM & SESSION TYPE TYPES
// ============================================================================

export interface Program {
  id: number;
  name: string;
  scheduleType?: string;
  cancelOffset?: number;
  contentFormats?: string[];
}

export interface SessionType {
  id: number;
  name: string;
  type?: string;
  defaultTimeLength?: number;
  numDeducted?: number;
  programId?: number;
  onlineDescription?: string;
  category?: string;
  subcategory?: string;
}

export interface GetProgramsParams {
  scheduleType?: 'All' | 'Class' | 'Enrollment' | 'Appointment';
  onlineOnly?: boolean;
  limit?: number;
}

export interface GetSessionTypesParams {
  programIds?: number[];
  onlineOnly?: boolean;
  limit?: number;
}

// ============================================================================
// TEACHER SCHEDULE (Optimized Type)
// ============================================================================

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
    duration: number;
    location: string;
    isSubstitute: boolean;
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

// ============================================================================
// API RESULT TYPES (for consistent return types)
// ============================================================================

export interface OperationResult<T = void> {
  success: boolean;
  data?: T;
  message: string;
  error?: string;
}

export interface ListResult<T> {
  items: T[];
  total: number;
}

export interface VisitSummary {
  totalAttended: number;
  totalNoShows: number;
  totalLateCancels: number;
  byLocation: Record<string, number>;
  byClassType: Record<string, number>;
  byInstructor: Record<string, number>;
}
