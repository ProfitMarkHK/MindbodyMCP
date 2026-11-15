import { DEFAULT_PAGE_SIZE, fetchAllPages, mindbodyClient, type IMindbodyClient } from '../api/client.js';
import { classCache, type SimpleCache } from '../cache/index.js';
import { errorMessage } from '../utils/errors.js';
import {
  lookupAppointmentsForClient,
  ownedAppointmentRow,
  OWNERSHIP_LOOKBACK_DAYS,
} from './appointmentManagement.js';

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
    /**
     * Lowers this item's price, sent as `DiscountAmount`. Non-negative; Mindbody
     * ignores it for packages. There is no field that raises or replaces a price.
     */
    discountAmount?: number;
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
  cache: SimpleCache = classCache,
  /** Dry run: sends `Test: true`, so Mindbody validates the cart and records nothing. */
  test: boolean = false
): Promise<{
  success: boolean;
  /** Present and true only on a dry run: nothing was charged or recorded. */
  dryRun?: true;
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

  // `DiscountAmount` can only lower a price (a negative value on a 0-priced
  // service left the total at 0 on the sandbox), so refuse anything else.
  const badDiscount = items.filter(
    (item) =>
      item.discountAmount !== undefined &&
      !(typeof item.discountAmount === 'number' && Number.isFinite(item.discountAmount) && item.discountAmount >= 0)
  );
  if (badDiscount.length > 0) {
    return {
      success: false,
      message: `discountAmount must be a non-negative number (got ${badDiscount.map((item) => JSON.stringify(item.discountAmount)).join(', ')}); nothing was charged.`,
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
    // Map items to API format. `Item.Metadata` is rebuilt here, not passed
    // through: only `id` (Service, Product, Package) or `amount` (Tip) is sent,
    // and any other caller key (e.g. `price`) is dropped. The API has no
    // per-sale price override (issue #32), so there is nothing else to send.
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

      if (item.discountAmount !== undefined) {
        baseItem.DiscountAmount = item.discountAmount;
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
      ...(test ? { Test: true } : {}),
    });

    // `ShoppingCart.SaleId` is never surfaced: on a dry run the sandbox returns
    // one that does not exist as a sale (issue #31).
    const result = {
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
    return test ? dryRunResult(result, payments) : result;
  } catch (error: unknown) {
    return {
      success: false,
      message: errorMessage(error, 'Failed to checkout'),
    };
  }
}

/**
 * Label a `Test: true` checkout as a dry run and check its payments. Mindbody
 * does not validate payments in test mode (sandbox, 2026-10-28: Cash 107
 * against a total of 100 passed with Test, was refused without), so the tool
 * compares the payment sum with GrandTotal itself, in whole cents, as the
 * committed call would.
 */
function dryRunResult<T extends { shoppingCart?: { grandTotal: number } }>(
  result: T,
  payments: Array<{ metadata: { amount: number } }>
): T & { success: boolean; dryRun: true; message: string } {
  const paid = payments.reduce((sum, payment) => sum + Number(payment.metadata?.amount ?? 0), 0);
  const grandTotal = Number(result.shoppingCart?.grandTotal);
  if (!Number.isFinite(grandTotal)) {
    return { ...result, success: false, dryRun: true, message: 'Dry run: Mindbody returned no GrandTotal, so the payments could not be checked. Nothing was charged.' };
  }
  if (Math.round(paid * 100) !== Math.round(grandTotal * 100)) {
    return {
      ...result,
      success: false,
      dryRun: true,
      message: `Dry run: the payment total (${paid}) does not match the calculated total (${grandTotal}); the real checkout would be refused. Nothing was charged.`,
    };
  }
  return { ...result, success: true, dryRun: true, message: `Dry run: cart validated and payments match the calculated total (${grandTotal}). Nothing was charged or recorded.` };
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
