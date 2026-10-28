import { DEFAULT_PAGE_SIZE, fetchAllPages, mindbodyClient, type IMindbodyClient } from '../api/client.js';
import { classCache, type SimpleCache } from '../cache/index.js';
import { errorMessage } from '../utils/errors.js';
import {
  lookupAppointmentsForClient,
  ownedAppointmentRow,
  OWNERSHIP_LOOKBACK_DAYS,
} from './appointmentManagement.js';

/**
 * Get available services (pricing options: class packs, memberships).
 *
 * `GET /sale/services` (`Mindbody.PublicApi.Dto.Models.V6.Service`).
 *
 * Removed output fields (C-19, `docs/mindbody-spec-discrepancies.md`):
 * - `sessionTypeId` — `Service` has no per-row session type. Session-type
 *   applicability is the `sessionTypeIds` REQUEST filter; the sandbox confirms
 *   no `SessionTypeId` key on any of the 21 rows.
 * - `prerequisite` — `Service` has no prerequisite field anywhere in the spec or
 *   the sandbox.
 * Both used to render as `undefined` on every row.
 *
 * Two field TYPES were also wrong, and both produced garbage rather than nothing:
 * - `priority` is `"High" | "Medium" | "Low"` (a string) in the spec, so the old
 *   `Number(Priority)` yielded `NaN`. It is passed through as a string.
 * - `taxIncluded` is the AMOUNT of tax included in the price (a number), not a
 *   flag, so the old `Boolean(TaxIncluded)` turned any non-zero tax into `true`
 *   and any zero tax into `false`. It is now `taxIncludedAmount`, the number the
 *   API documents; it is `0` when the price has no tax baked in.
 */
export async function getServicesTool(
  programIds?: number[],
  sessionTypeIds?: number[],
  locationId?: number,
  classId?: number,
  hideRelatedPrograms: boolean = false,
  client: IMindbodyClient = mindbodyClient
): Promise<{
  services: Array<{
    id: number;
    name: string;
    price: number;
    onlinePrice?: number;
    /** The tax amount already included in `price` (spec: "The amount of tax
     *  included in the price, if inclusive pricing is enabled"). */
    taxIncludedAmount?: number;
    taxRate?: number;
    programId?: number;
    count?: number;
    expirationUnit?: string;
    expirationLength?: number;
    membershipId?: number;
    /** "High" | "Medium" | "Low" — a string in the spec, not a number. */
    priority?: string;
  }>;
  totalServices: number;
}> {
  const { items: servicesRaw, totalResults } = await fetchAllPages<any>(
    client,
    '/sale/services',
    {
      ProgramIds: programIds,
      SessionTypeIds: sessionTypeIds,
      LocationId: locationId,
      ClassId: classId,
      HideRelatedPrograms: hideRelatedPrograms,
    },
    'Services'
  );

  const services = servicesRaw.map((service: any) => ({
    id: Number(service.Id ?? service.id),
    name: service.Name,
    price: Number(service.Price ?? 0),
    onlinePrice: service.OnlinePrice != null ? Number(service.OnlinePrice) : undefined,
    taxIncludedAmount: service.TaxIncluded != null ? Number(service.TaxIncluded) : undefined,
    taxRate: service.TaxRate != null ? Number(service.TaxRate) : undefined,
    programId: service.ProgramId != null ? Number(service.ProgramId) : undefined,
    count: service.Count != null ? Number(service.Count) : undefined,
    expirationUnit: service.ExpirationUnit,
    expirationLength: service.ExpirationLength != null ? Number(service.ExpirationLength) : undefined,
    membershipId: service.MembershipId != null ? Number(service.MembershipId) : undefined,
    priority: service.Priority,
  }));

  return {
    services,
    totalServices: totalResults,
  };
}

/**
 * Get packages (bundles of services and products).
 *
 * `GET /sale/packages` (`Mindbody.PublicApi.Dto.Models.V6.Package`).
 *
 * The request accepts only `request.locationId`, `request.packageIds`,
 * `request.sellOnline` (plus paging). `classScheduleId` was dropped: it is not
 * in the spec and the sandbox silently ignores it (C-20 — a `ClassScheduleId`
 * that matches nothing still returns the full list).
 *
 * `Package` is `{ DiscountPercentage, Id, Name, Products[], SellOnline,
 * Services[] }`. Removed output fields, none of which exist on `Package`:
 * - `taxIncluded`, `active`, `productId` — dropped outright; no spec field and
 *   no sandbox key. `ProductId` is replaced by the real `products` sub-list.
 * - `onlinePrice` — dropped as a package-level field. A package has no price of
 *   its own, and its services disagree on online price, so a single value would
 *   be a fabrication. Per-service online price is in `services[].onlinePrice`,
 *   and authoritatively at `GET /sale/services`.
 *
 * `price` and `classCount` are DERIVED, not read: `Package` has neither. Both
 * are sums over the nested `Services[]` (which is a `Service[]`, so `Count` and
 * `Price` are real spec fields). `price` is therefore the package's list value
 * before `discountPercentage` is applied; the authoritative per-service price is
 * `GET /sale/services`. Both are `undefined` when `Services[]` is empty or absent.
 */
export async function getPackagesTool(
  locationId?: number,
  packageIds?: number[],
  sellOnline?: boolean,
  client: IMindbodyClient = mindbodyClient
): Promise<{
  packages: Array<{
    id: number;
    name: string;
    discountPercentage?: number;
    sellOnline?: boolean;
    classCount?: number;
    price?: number;
    services?: Array<{
      id: number;
      name: string;
      count?: number;
      price?: number;
      onlinePrice?: number;
    }>;
    products?: Array<{
      id: string;
      name: string;
      price?: number;
      onlinePrice?: number;
    }>;
  }>;
  totalPackages: number;
}> {
  const { items: packageRows, totalResults } = await fetchAllPages<any>(
    client,
    '/sale/packages',
    {
      LocationId: locationId,
      PackageIds: packageIds,
      SellOnline: sellOnline,
    },
    'Packages'
  );

  const packages = packageRows.map((pkg: any) => {
    const services = Array.isArray(pkg.Services) ? pkg.Services : [];
    const products = Array.isArray(pkg.Products) ? pkg.Products : [];

    return {
      id: pkg.Id,
      name: pkg.Name,
      discountPercentage: pkg.DiscountPercentage != null ? Number(pkg.DiscountPercentage) : undefined,
      sellOnline: pkg.SellOnline,
      classCount:
        services.length > 0
          ? services.reduce((sum: number, s: any) => sum + (s.Count != null ? Number(s.Count) : 0), 0)
          : undefined,
      price:
        services.length > 0
          ? services.reduce((sum: number, s: any) => sum + (s.Price != null ? Number(s.Price) : 0), 0)
          : undefined,
      services:
        services.length > 0
          ? services.map((s: any) => ({
              id: Number(s.Id ?? 0),
              name: s.Name,
              count: s.Count != null ? Number(s.Count) : undefined,
              price: s.Price != null ? Number(s.Price) : undefined,
              onlinePrice: s.OnlinePrice != null ? Number(s.OnlinePrice) : undefined,
            }))
          : undefined,
      products:
        products.length > 0
          ? products.map((p: any) => ({
              id: p.Id,
              name: p.Name,
              price: p.Price != null ? Number(p.Price) : undefined,
              onlinePrice: p.OnlinePrice != null ? Number(p.OnlinePrice) : undefined,
            }))
          : undefined,
    };
  });

  return {
    packages,
    totalPackages: totalResults || packages.length,
  };
}

/**
 * Get products (retail items, equipment).
 *
 * `GET /sale/products` (`Mindbody.PublicApi.Dto.Models.V6.Product`).
 *
 * Removed output fields (C-21 — none of these exist on `Product` in the spec or
 * in any of the 41 sandbox rows; they always rendered as `undefined`):
 * - `category` / `subcategory` — the API returns no category NAMES, only
 *   `CategoryId` / `SubCategoryId` / `SecondaryCategoryId`, so those are exposed
 *   as `categoryId` / `subCategoryId` instead. Resolve a name with `GET /sale/categories`.
 * - `sellOnline` — per-row `SellOnline` does not exist; it is a REQUEST filter.
 *
 * Added: `longDescription` (`LongDescription`), `categoryId` (`CategoryId`),
 * `subCategoryId` (`SubCategoryId`). `description` now reads `ShortDescription`,
 * not the non-existent `Description`.
 */
export async function getProductsTool(
  productIds?: number[],
  searchText?: string,
  categoryIds?: number[],
  subCategoryIds?: number[],
  sellOnline?: boolean,
  client: IMindbodyClient = mindbodyClient
): Promise<{
  products: Array<{
    id: string;
    name: string;
    price: number;
    onlinePrice?: number;
    description?: string;
    longDescription?: string;
    categoryId?: number;
    subCategoryId?: number;
    color?: string;
    size?: string;
    /** The tax amount already included in `price` (spec: "If tax inclusive-pricing
     *  is enabled, this field shows how much tax was added to the price"), so it is
     *  a number and not a flag. */
    taxIncludedAmount?: number;
    taxRate?: number;
  }>;
  totalProducts: number;
}> {
  const { items: productRows, totalResults } = await fetchAllPages<any>(
    client,
    '/sale/products',
    {
      ProductIds: productIds,
      SearchText: searchText,
      CategoryIds: categoryIds,
      SubCategoryIds: subCategoryIds,
      SellOnline: sellOnline,
    },
    'Products'
  );

  const products = productRows.map((product: any) => ({
    id: product.Id,
    name: product.Name,
    price: product.Price,
    onlinePrice: product.OnlinePrice,
    description: product.ShortDescription,
    longDescription: product.LongDescription,
    categoryId: product.CategoryId != null ? Number(product.CategoryId) : undefined,
    subCategoryId: product.SubCategoryId != null ? Number(product.SubCategoryId) : undefined,
    color: product.Color?.Name,
    size: product.Size?.Name,
    taxIncludedAmount: product.TaxIncluded != null ? Number(product.TaxIncluded) : undefined,
    taxRate: product.TaxRate != null ? Number(product.TaxRate) : undefined,
  }));

  return {
    products,
    totalProducts: totalResults || products.length,
  };
}

// Checkout shopping cart
export async function checkoutShoppingCartTool(
  clientId: string,
  items: Array<{
    item: {
      type: 'Service' | 'Product' | 'Package' | 'Tip';
      metadata: {
        id: number;
        name?: string;
        amount?: number; // For tips
      };
    };
    quantity: number;
    /** Existing appointment IDs this item pays for (reconciles). */
    appointmentIds?: number[];
    appointmentBookingRequests?: Array<{
      staffId: number;
      locationId: number;
      sessionTypeId: number;
      startDateTime: string;
      notes?: string;
    }>;
  }>,
  payments: Array<{
    type: 'Cash' | 'Check' | 'CreditCard' | 'Comp' | 'Custom' | 'StoredCard';
    metadata: {
      amount: number;
      id?: number; // Custom only: the id from getCustomPaymentMethods
      notes?: string;
      lastFour?: string; // For stored cards
      cardholderName?: string;
      billingAddress?: string;
      billingCity?: string;
      billingState?: string;
      billingPostalCode?: string;
    };
  }>,
  inStore: boolean = false,
  promotionCode?: string,
  sendEmail: boolean = true,
  locationId?: number,
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache
): Promise<{
  success: boolean;
  shoppingCart?: {
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
      taxRate?: number;
      total: number;
      /** IDs of the appointments this cart item reconciled; absent when the API returned none. */
      appointments?: number[];
    }>;
  };
  appointments?: Array<{
    id: number;
    status: string;
    startDateTime: string;
    endDateTime: string;
    notes?: string;
  }>;
  message: string;
}> {
  // Mindbody identifies a custom payment method by id only; without one the
  // payment cannot be attributed, so refuse before any lookup or charge.
  const badCustom = payments.filter(
    (payment) => payment.type === 'Custom' && !(Number.isInteger(payment.metadata?.id) && payment.metadata.id! > 0)
  );
  if (badCustom.length > 0) {
    return {
      success: false,
      message: 'A Custom payment needs metadata.id, a positive integer from getCustomPaymentMethods; nothing was charged.',
    };
  }

  // A cart item's appointmentIds are paid for by THIS client's payments, so each
  // must be this client's own. All-or-nothing, before anything is sent; fails
  // closed when the site zone or the lookup is unavailable.
  const appointmentIds = [...new Set(items.flatMap((item) => item.appointmentIds ?? []))];
  if (appointmentIds.length > 0) {
    const invalid = appointmentIds.filter((id) => !Number.isInteger(id) || id <= 0);
    if (invalid.length > 0) {
      return {
        success: false,
        message: `Appointment id(s) ${invalid.map((id) => JSON.stringify(id)).join(', ')} are not positive integers; nothing was charged.`,
      };
    }
    const lookup = await lookupAppointmentsForClient(client, cache, clientId, appointmentIds, OWNERSHIP_LOOKBACK_DAYS);
    if (!lookup.ok) {
      return { success: false, message: `Could not verify the appointments (${lookup.reason}); nothing was charged.` };
    }
    const refused = appointmentIds
      .map((id) => ({ id, owned: ownedAppointmentRow(lookup.rows, id, clientId) }))
      .filter((entry) => 'reason' in entry.owned)
      .map((entry) => `${entry.id}: ${(entry.owned as { reason: string }).reason}`);
    if (refused.length > 0) {
      return { success: false, message: `Appointment(s) failed verification (${refused.join('; ')}); nothing was charged.` };
    }
  }

  try {
    // Map items to API format
    const cartItems = items.map(item => {
      const baseItem: any = {
        Quantity: item.quantity,
      };

      if (item.item.type === 'Service') {
        baseItem.Item = {
          Type: 'Service',
          Metadata: {
            Id: item.item.metadata.id,
          },
        };
      } else if (item.item.type === 'Product') {
        baseItem.Item = {
          Type: 'Product',
          Metadata: {
            Id: item.item.metadata.id,
          },
        };
      } else if (item.item.type === 'Package') {
        baseItem.Item = {
          Type: 'Package',
          Metadata: {
            Id: item.item.metadata.id,
          },
        };
      } else if (item.item.type === 'Tip') {
        baseItem.Item = {
          Type: 'Tip',
          Metadata: {
            Amount: item.item.metadata.amount,
          },
        };
      }

      if (item.appointmentIds && item.appointmentIds.length > 0) {
        baseItem.AppointmentIds = item.appointmentIds;
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

    // Map payments to API format
    const paymentMethods = payments.map(payment => {
      const basePayment: any = {
        Type: payment.type,
        Metadata: {
          Amount: payment.metadata.amount,
        },
      };

      if (payment.metadata.notes) {
        basePayment.Metadata.Notes = payment.metadata.notes;
      }

      if (payment.type === 'Custom') {
        basePayment.Metadata.Id = payment.metadata.id;
      }

      if (payment.type === 'StoredCard' && payment.metadata.lastFour) {
        basePayment.Metadata.LastFour = payment.metadata.lastFour;
      }

      if (payment.type === 'CreditCard') {
        if (payment.metadata.cardholderName) {
          basePayment.Metadata.CardholderName = payment.metadata.cardholderName;
        }
        if (payment.metadata.billingAddress) {
          basePayment.Metadata.BillingAddress = payment.metadata.billingAddress;
          basePayment.Metadata.BillingCity = payment.metadata.billingCity;
          basePayment.Metadata.BillingState = payment.metadata.billingState;
          basePayment.Metadata.BillingPostalCode = payment.metadata.billingPostalCode;
        }
      }

      return basePayment;
    });

    const response = await client.post<any>('/sale/checkoutshoppingcart', {
      ClientId: clientId,
      Items: cartItems,
      Payments: paymentMethods,
      InStore: inStore,
      PromotionCode: promotionCode,
      SendEmail: sendEmail,
      LocationId: locationId,
    });

    return {
      success: true,
      shoppingCart: response.ShoppingCart ? {
        id: response.ShoppingCart.Id,
        subTotal: response.ShoppingCart.SubTotal,
        taxTotal: response.ShoppingCart.TaxTotal,
        discountTotal: response.ShoppingCart.DiscountTotal,
        grandTotal: response.ShoppingCart.GrandTotal,
        items: (response.ShoppingCart.CartItems ?? []).map((item: any) => ({
          // `CompletedSale.CartItem` is { Item, DiscountAmount, Quantity, Id,
          // VisitIds, AppointmentIds, Appointments }. It has no Name/UnitPrice/
          // TaxAmount/Total; name and money live on the nested `Item`, whose
          // spec definition (`CompletedSale.ItemBase`) lists no properties, so
          // the fields read below are the sandbox-observed shape
          // { Id, Name, Count, OnlinePrice, Price, TaxRate, ProductId,
          // ProgramId, TaxIncluded }.
          id: item.Id,
          name: item.Item?.Name,
          price: item.Item?.Price,
          quantity: item.Quantity,
          discountAmount: item.DiscountAmount,
          // No per-line server tax exists on `CartItem`, and `Item.TaxRate` is
          // documented only as "the tax rate applied" with no scale, so a money
          // value cannot be derived without guessing. The raw rate is passed
          // through instead; `shoppingCart.taxTotal` is the authoritative tax.
          taxRate: item.Item?.TaxRate,
          total: Number(item.Item?.Price ?? 0) * Number(item.Quantity ?? 0) - Number(item.DiscountAmount ?? 0),
          ...reconciledAppointmentIds(item.Appointments ?? item.AppointmentIds),
        })),
      } : undefined,
      appointments: response.Appointments?.map((apt: any) => ({
        id: apt.Id,
        status: apt.Status,
        startDateTime: apt.StartDateTime,
        endDateTime: apt.EndDateTime,
        notes: apt.Notes,
      })),
      message: 'Checkout completed successfully',
    };
  } catch (error: unknown) {
    return {
      success: false,
      message: errorMessage(error, 'Failed to checkout'),
    };
  }
}

// SANDBOX-OBSERVED (differs from spec): a committed reconciling checkout returns empty CartItem.Appointments/AppointmentIds, so an absent list here does not mean the sale failed to reconcile.
// Recorded in docs/mindbody-spec-discrepancies.md section D-8.
/**
 * Read the appointment IDs a cart item reconciled. `CartItem.Appointments` is
 * documented as "the IDs of the appointments that were reconciled by this cart
 * item" but typed `Appointment[]`, and the sibling `AppointmentIds` ("Gets or
 * sets the item.") is the list we sent. Accept both shapes and surface plain
 * IDs; omitted entirely when neither list is returned.
 *
 * The list is frequently EMPTY even on a sale that reconciled, so callers that
 * need to know which appointment a sale paid for must re-read the appointment.
 */
function reconciledAppointmentIds(raw: unknown): { appointments?: number[] } {
  if (!Array.isArray(raw)) return {};
  const ids = raw
    .map((entry: any) => (typeof entry === 'number' ? entry : Number(entry?.Id)))
    .filter((id) => Number.isFinite(id));
  return { appointments: ids };
}

/**
 * Purchase a contract (membership / auto-renew).
 *
 * ── Why `useAccountCredit` exists ───────────────────────────────────────────
 * `/sale/purchasecontract` answers HTTP 400 `MissingRequiredFields` — "At
 * least one of the following parameters must be passed: CreditCardInfo,
 * StoredCardInfo, UseDirectDebit, UseAccountCredit" — unless one of those four
 * is present. Three of the four are real payment instruments. `UseAccountCredit`
 * is NOT: it is a boolean meaning "bill this to the client's account balance",
 * and the sandbox accepts it with a zero balance, committing the contract and
 * leaving the charge on account. It is therefore the only way to exercise this
 * endpoint without handing Mindbody payment details, and the reason the live
 * tier can test it at all.
 *
 * The other three are deliberately NOT exposed. This server takes no card
 * numbers, no stored-card ids and no bank details (see the no-op policy in
 * tests/live/README.md), so exposing them would widen the surface for no
 * caller that is allowed to use them.
 *
 * ── Response shape ──────────────────────────────────────────────────────────
 * `PurchaseContractResponse` in docs/openapi.json carries `ClientId,
 * UniqueClientId, LocationId, ContractId, ClientContractId,
 * PaymentProcessingFailures, Totals`. It has NO nested `ClientContract`
 * object — an earlier version of this tool read `response.ClientContract.Id`,
 * which threw on every successful purchase and reported the success as a
 * failure. `ClientContractId` is the id of the ClientContract that was created;
 * read it back through `getClientContracts`.
 */
export async function purchaseContractTool(
  clientId: string,
  contractId: number,
  startDate: string,
  firstPaymentOccurs?: 'StartDate' | 'UponSale' | 'BillingDate',
  clientSignature?: string,
  promotionCode?: string,
  locationId?: number,
  useAccountCredit?: boolean,
  client: IMindbodyClient = mindbodyClient
): Promise<{
  success: boolean;
  /** The id of the ClientContract that was created; `null` on a dry run. */
  clientContractId?: number | null;
  clientId?: string;
  contractId?: number;
  locationId?: number;
  totals?: { subTotal: number; discount: number; tax: number; total: number };
  paymentProcessingFailures?: Array<{ type: string; message: string; authenticationRedirectUrl?: string }>;
  message: string;
}> {
  try {
    // SPEC-ALIGNED BUT UNVERIFIED: POST /sale/purchasecontract cannot be exercised on the sandbox (it rejects the call before producing a body unless a payment instrument is supplied), so the response shape below is taken from docs/openapi.json alone.
    // Recorded in docs/mindbody-spec-discrepancies.md section E-3.
    const response = await client.post<any>('/sale/purchasecontract', {
      ClientId: clientId,
      ContractId: contractId,
      StartDate: startDate,
      FirstPaymentOccurs: firstPaymentOccurs || 'StartDate',
      ClientSignature: clientSignature,
      PromotionCode: promotionCode,
      LocationId: locationId,
      UseAccountCredit: useAccountCredit,
    });

    // `PurchaseContractResponse` is FLAT:
    // { ClientId, UniqueClientId, LocationId, ContractId, ClientContractId,
    //   Totals, PaymentProcessingFailures }. There is no `ClientContract`
    // object; reading one used to throw on every successful purchase and the
    // catch below then reported `success: false` for a sale that had committed.
    // `contractName`, `startDate`, `endDate`, `paymentAmount`, `frequency` and
    // `remainingPayments` are dropped — none exist on the response. A purchased
    // contract's detail is at `GET /client/clientcontracts`.
    return {
      success: true,
      clientContractId: response.ClientContractId ?? null,
      clientId: response.ClientId,
      contractId: response.ContractId,
      locationId: response.LocationId,
      totals: response.Totals
        ? {
            subTotal: response.Totals.SubTotal,
            discount: response.Totals.Discount,
            tax: response.Totals.Tax,
            total: response.Totals.Total,
          }
        : undefined,
      paymentProcessingFailures: response.PaymentProcessingFailures?.map((failure: any) => ({
        type: failure.Type,
        message: failure.Message,
        authenticationRedirectUrl: failure.AuthenticationRedirectUrl,
      })),
      message: 'Contract purchased successfully',
    };
  } catch (error: unknown) {
    return {
      success: false,
      message: errorMessage(error, 'Failed to purchase contract'),
    };
  }
}

/**
 * Get contracts (membership types).
 *
 * `GET /sale/contracts` (`Mindbody.PublicApi.Dto.Models.V6.Contract`).
 *
 * `locationId` is REQUIRED: the spec marks `request.locationId` required and the
 * sandbox answers HTTP 400 `LocationId is a required parameter.
 * (MissingRequiredFields)` without it. It is never defaulted or resolved from a
 * catalogue, so a caller cannot silently ask for "all locations".
 *
 * Removed output fields, none of which exist on `Contract`:
 * - `contractType` — unavailable. `Contract` has no type discriminator; the
 *   closest real fields are `AutopayTriggerType` and `ClientsChargedOn`, which
 *   are left out rather than renamed into something they are not.
 * - `locationId` — unavailable on the row. Contracts are scoped by the request's
 *   `locationId`, which the caller already supplied.
 * - `autopaySchedule.paymentAmount` — `AutopaySchedule` is only
 *   `{ FrequencyType, FrequencyValue, FrequencyTimeUnit }`. The money fields
 *   live on `Contract`: `FirstPaymentAmountTotal`,
 *   `RecurringPaymentAmountTotal`, `TotalContractAmountTotal`. The first two
 *   are exposed; `totalContractAmountTotal` is not yet mapped.
 * - `introOffer` as an object — `Contract.IntroOffer` is a STRING ("None",
 *   "NewAndReturningConsumer"), so `introOffer` is now `string | undefined`.
 */
export async function getContractsTool(
  locationId: number,
  contractIds?: number[],
  soldOnline?: boolean,
  client: IMindbodyClient = mindbodyClient
): Promise<{
  contracts: Array<{
    id: number;
    name: string;
    description?: string;
    assignsMembershipId?: number;
    assignsMembershipName?: string;
    soldOnline: boolean;
    agreementTerms?: string;
    autopaySchedule?: {
      frequencyType: string;
      frequencyValue?: number;
      frequencyTimeUnit?: string;
      recurringPaymentAmountTotal?: number;
    };
    introOffer?: string;
  }>;
  totalContracts: number;
}> {
  const { items: contractRows, totalResults } = await fetchAllPages<any>(
    client,
    '/sale/contracts',
    {
      LocationId: locationId,
      ContractIds: contractIds,
      SoldOnline: soldOnline,
    },
    'Contracts'
  );

  const contracts = contractRows.map((contract: any) => ({
    id: contract.Id,
    name: contract.Name,
    description: contract.Description,
    assignsMembershipId: contract.AssignsMembershipId,
    assignsMembershipName: contract.AssignsMembershipName,
    soldOnline: contract.SoldOnline,
    agreementTerms: contract.AgreementTerms,
    autopaySchedule: contract.AutopaySchedule ? {
      frequencyType: contract.AutopaySchedule.FrequencyType,
      frequencyValue: contract.AutopaySchedule.FrequencyValue,
      frequencyTimeUnit: contract.AutopaySchedule.FrequencyTimeUnit,
      recurringPaymentAmountTotal: contract.RecurringPaymentAmountTotal,
    } : undefined,
    introOffer: contract.IntroOffer,
  }));

  return {
    contracts,
    totalContracts: totalResults || contracts.length,
  };
}
/**
 * Lists the site's custom payment methods (GET /sale/custompaymentmethods).
 * A `Custom` checkout payment needs one of these ids as `metadata.id`; the
 * back office shows only names.
 */
export async function getCustomPaymentMethodsTool(
  client: IMindbodyClient = mindbodyClient
): Promise<{
  paymentMethods: Array<{ id: number; name: string }>;
  totalPaymentMethods: number;
}> {
  const { items, totalResults } = await fetchAllPages<any>(
    client,
    '/sale/custompaymentmethods',
    {},
    'PaymentMethods',
    DEFAULT_PAGE_SIZE,
    // The -99 sandbox reports TotalResults=0 alongside its rows (verified 2026-10-28).
    { ignoreTotalResults: true }
  );

  const paymentMethods = items.map((method: any) => ({ id: method.Id, name: method.Name }));

  return {
    paymentMethods,
    totalPaymentMethods: totalResults,
  };
}
