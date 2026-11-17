import { fetchAllPages, mindbodyClient, type IMindbodyClient } from '../api/client.js';
import { classCache, SimpleCache } from '../cache/index.js';
import { ClientPurchaseRecord } from '../types/mindbody.js';
import { defaultDateRange } from '../utils/siteTime.js';

/** Default look-back when no dates are given: 365 days through today, site-local. */
export const CLIENT_PURCHASES_DEFAULT_DAYS = 365;

export interface GetClientPurchasesOptions {
  /** YYYY-MM-DD, site-local. Purchases made on or after the start of this day. */
  startDate?: string;
  /** YYYY-MM-DD, site-local. Purchases made up to the end of this day. */
  endDate?: string;
  /** Narrow to the one record for this sale. */
  saleId?: number;
}

/** A date-only value covers the whole site-local day; a full date-time passes through. */
const dayStart = (d: string) => (d.includes('T') ? d : `${d}T00:00:00`);
const dayEnd = (d: string) => (d.includes('T') ? d : `${d}T23:59:59`);

/** One purchase record. Every key exists on ClientPurchaseRecord, Sale, PurchasedItem or SalePayment. */
function toPurchase(r: ClientPurchaseRecord) {
  const s = r.Sale;
  return {
    description: r.Description,
    price: r.Price,
    amountPaid: r.AmountPaid,
    discount: r.Discount,
    tax: r.Tax,
    returned: r.Returned,
    quantity: r.Quantity,
    accountPayment: r.AccountPayment,
    sale: s && {
      id: s.Id,
      // SANDBOX-OBSERVED: SaleDateTime is site-local but can carry a spurious `Z` (D-11); drop it.
      saleDateTime: s.SaleDateTime?.replace(/Z$/, ''),
      locationId: s.LocationId,
      purchasedItems: (s.PurchasedItems ?? []).map((i) => ({
        id: i.Id,
        isService: i.IsService,
        description: i.Description,
        unitPrice: i.UnitPrice,
        quantity: i.Quantity,
        totalAmount: i.TotalAmount,
        returned: i.Returned,
        contractId: i.ContractId,
        expDate: i.ExpDate,
        activeDate: i.ActiveDate,
      })),
      payments: (s.Payments ?? []).map((p) => ({
        id: p.Id,
        amount: p.Amount,
        method: p.Method,
        type: p.Type,
        transactionId: p.TransactionId,
      })),
    },
  };
}

/**
 * A client's purchase history with prices (`GET /client/clientpurchases`), read-only.
 *
 * The endpoint defaults to `StartDate: now` and `EndDate: end of today`, which
 * returns almost nothing, so both are always sent. With no dates the window is
 * the last 365 days through the end of today in the site timezone.
 *
 * Use a one-day window to check for an existing sale before a checkout, or
 * `saleId` to read one sale back (including a web-app sale at an overridden
 * price, which reads back as plain `price`/`unitPrice` with no override flag).
 * No per-session value is computed here.
 */
export async function getClientPurchasesTool(
  clientId: string,
  options: GetClientPurchasesOptions = {},
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache,
  now: Date = new Date()
) {
  if (!clientId || typeof clientId !== 'string') {
    throw new Error('getClientPurchases needs a clientId');
  }
  let { startDate: start, endDate: end } = options;
  if (!start || !end) {
    const defaults = await defaultDateRange(-CLIENT_PURCHASES_DEFAULT_DAYS, client, cache, now);
    start = start || defaults.start;
    end = end || defaults.end;
  }

  const params: Record<string, unknown> = {
    ClientId: clientId,
    StartDate: dayStart(start),
    EndDate: dayEnd(end),
  };
  if (options.saleId !== undefined) params.SaleId = options.saleId;

  const { items } = await fetchAllPages<ClientPurchaseRecord>(client, '/client/clientpurchases', params, 'Purchases');
  const purchases = items.map(toPurchase);
  return { purchases, totalPurchases: purchases.length };
}
