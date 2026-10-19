// ============================================================================
// MINDBODY MODULE - Public API
// ============================================================================

// Client & Service
export { MindbodyApiClient, getMindbodyClient, resetMindbodyClient } from './client';
export { MindbodyService, getMindbodyService, resetMindbodyService } from './service';
export { fetchAllPages, DEFAULT_PAGE_SIZE, MAX_PAGES } from './paging';
export type { PagedGetClient } from './paging';
export {
  SITE_ID_ENV,
  SITE_INFO_CACHE_KEY,
  SITE_TIMEZONE_ENV,
  SiteSelectionError,
  SimpleTtlCache,
  assertTimeZone,
  configuredSiteId,
  defaultDateRange,
  epochMsToSiteLocal,
  fetchSiteInfo,
  getSelectedSite,
  getSiteTimeZone,
  isValidTimeZone,
  resetSiteTimeWarningForTests,
  resolveReadTimeZone,
  selectSite,
  siteDateString,
  siteDateStringPlusDays,
  siteLocalToEpochMs,
  withDefaultDates,
} from './siteTime';
export type { SiteSummary, TtlCache } from './siteTime';

// Studio-time rendering (client-safe: pure, no API calls). Prefer these over
// `new Date(...).toLocale*()`, which renders in the VIEWER's browser zone.
export {
  formatSiteDate,
  formatSiteDateTime,
  formatSiteDateTimeLong,
  formatSiteDateWithWeekday,
  formatSiteDateWithWeekdayLong,
  formatSiteTimeOfDay,
} from './formatSiteTime';
export type { SiteFormatOptions, SiteWallClock } from './formatSiteTime';

// Types - Core Entities
export type {
  Site,
  Location,
  Resource,
  Staff,
  Client,
  ClassDescription,
  Class,
  ClassSchedule,
  Appointment,
  Enrollment,
  Service,
  Package,
  Product,
  Contract,
  Program,
  SessionType,
} from './types';

// Types - Request Parameters
export type {
  GetStaffParams,
  GetClientsParams,
  AddClientParams,
  UpdateClientParams,
  GetClientVisitsParams,
  GetClassesParams,
  AddClientToClassParams,
  RemoveClientFromClassParams,
  SubstituteTeacherParams,
  GetAppointmentsParams,
  AddAppointmentParams,
  UpdateAppointmentParams,
  GetBookableItemsParams,
  GetEnrollmentsParams,
  AddClientToEnrollmentParams,
  GetServicesParams,
  GetProductsParams,
  GetContractsParams,
  CheckoutParams,
  PurchaseContractParams,
  GetProgramsParams,
  GetSessionTypesParams,
} from './types';

// Types - Response Types
export type {
  ClientVisit,
  ClientMembership,
  ClientContract,
  WaitlistEntry,
  BookableItem,
  ScheduleItem,
  ActiveSessionTime,
  ClientEnrollmentVisit,
  EnrollmentBookingResult,
  ShoppingCartResult,
  CartItem,
  Payment,
  TeacherSchedule,
  OperationResult,
  ListResult,
  VisitSummary,
  ApiResponse,
  PaginationResponse,
} from './types';
