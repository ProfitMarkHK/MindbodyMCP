import { fetchAllPages, mindbodyClient, type IMindbodyClient } from '../api/client.js';
import { classCache, SimpleCache } from '../cache/index.js';
import { Sale } from '../types/mindbody.js';
import { getStaffNames, nameFor } from '../utils/referenceData.js';
import { resolveReadTimeZone, siteDateString } from '../utils/siteTime.js';

export interface GetSalesOptions {
  startDate?: string;
  endDate?: string;
  productsOnly?: boolean;
  salesRepIds?: number[];
  clientIds?: string[];
  matchAppointments?: boolean;
}

export interface StaffSalesSummary {
  staffId: number;
  staffName: string;
  saleCount: number;
  productItemCount: number;
  productTotal: number;
}

export const APPOINTMENT_MATCH_NOTE =
  'Best-effort: each product sale is credited to the staff on every appointment the same client had ' +
  'on the same site-local day. Appointments carry no sales data, so this is a correlation, not a record; ' +
  'bySalesRep (SalesRepId) is what Mindbody credits.';

/**
 * Default window: the 1st of the current month through today, both as site-local
 * calendar dates. A caller-supplied date always wins.
 */
async function salesDateRange(
  startDate: string | undefined,
  endDate: string | undefined,
  client: IMindbodyClient,
  cache: SimpleCache,
  now: Date
): Promise<{ start: string; end: string }> {
  if (startDate && endDate) return { start: startDate, end: endDate };
  const today = siteDateString(now, await resolveReadTimeZone(client, cache));
  return { start: startDate || `${today.slice(0, 8)}01`, end: endDate || today };
}

/** Sum product (IsService false) lines; returned lines are not counted as sold. */
function productLines(sale: ReturnType<typeof mapSale>) {
  return sale.items.filter((i) => i.isService === false && !i.returned);
}

function mapSale(s: Sale) {
  return {
    id: s.Id,
    // SANDBOX-OBSERVED: SaleDateTime is site-local but carries a spurious `Z` (D-11); drop it so nobody converts it as UTC.
    saleDateTime: s.SaleDateTime?.replace(/Z$/, ''),
    salesRepId: s.SalesRepId,
    clientId: s.ClientId,
    locationId: s.LocationId,
    items: (s.PurchasedItems ?? []).map((i) => ({
      id: i.Id,
      description: i.Description,
      isService: i.IsService,
      categoryId: i.CategoryId,
      unitPrice: i.UnitPrice,
      quantity: i.Quantity,
      totalAmount: i.TotalAmount,
      returned: i.Returned,
    })),
    payments: (s.Payments ?? []).map((p) => ({ id: p.Id, amount: p.Amount, method: p.Method, type: p.Type })),
  };
}

type MappedSale = ReturnType<typeof mapSale>;

/** Group sales by a staff id per sale (a sale may credit several staff). */
function summarise(
  sales: MappedSale[],
  staffFor: (sale: MappedSale) => number[],
  names: ReadonlyMap<number, string>
): StaffSalesSummary[] {
  const byStaff = new Map<number, StaffSalesSummary>();
  for (const sale of sales) {
    const lines = productLines(sale);
    for (const staffId of staffFor(sale)) {
      const row = byStaff.get(staffId) ?? {
        staffId,
        staffName: nameFor(names, staffId),
        saleCount: 0,
        productItemCount: 0,
        productTotal: 0,
      };
      row.saleCount += 1;
      row.productItemCount += lines.reduce((n, i) => n + (i.quantity ?? 1), 0);
      // Round to cents so float sums of prices stay readable.
      row.productTotal = Math.round((row.productTotal + lines.reduce((n, i) => n + (i.totalAmount ?? 0), 0)) * 100) / 100;
      byStaff.set(staffId, row);
    }
  }
  return [...byStaff.values()].sort((a, b) => b.productTotal - a.productTotal || a.staffId - b.staffId);
}

/**
 * Sales history (`GET /sale/sales`), read-only, with a per-rep summary and an
 * optional best-effort match of product sales to same-day appointment staff.
 */
export async function getSalesTool(
  options: GetSalesOptions = {},
  client: IMindbodyClient = mindbodyClient,
  cache: SimpleCache = classCache,
  now: Date = new Date()
) {
  const { start, end } = await salesDateRange(options.startDate, options.endDate, client, cache, now);

  const { items: rows } = await fetchAllPages<Sale>(
    client,
    '/sale/sales',
    { StartSaleDateTime: `${start}T00:00:00`, EndSaleDateTime: `${end}T23:59:59` },
    'Sales'
  );

  const repFilter = options.salesRepIds?.length ? new Set(options.salesRepIds) : undefined;
  const clientFilter = options.clientIds?.length ? new Set(options.clientIds.map(String)) : undefined;
  let sales = rows
    .map(mapSale)
    .filter((s) => !repFilter || (s.salesRepId !== undefined && repFilter.has(s.salesRepId)))
    .filter((s) => !clientFilter || (s.clientId !== undefined && clientFilter.has(String(s.clientId))));
  if (options.productsOnly) {
    sales = sales
      .map((s) => ({ ...s, items: s.items.filter((i) => i.isService === false) }))
      .filter((s) => s.items.length > 0);
  }

  const names = await getStaffNames({ client, cache });
  const bySalesRep = summarise(
    sales,
    (s) => (s.salesRepId === undefined || s.salesRepId === null ? [] : [s.salesRepId]),
    names
  ).map(({ staffId, ...rest }) => ({ salesRepId: staffId, ...rest }));

  const result = { startDate: start, endDate: end, sales, totalSales: sales.length, bySalesRep };
  if (!options.matchAppointments) return result;

  const { items: appointments } = await fetchAllPages<any>(
    client,
    '/appointment/staffappointments',
    { StartDate: start, EndDate: end },
    'Appointments'
  );
  // "clientId|YYYY-MM-DD" → staff ids with an appointment for that client that day.
  const staffByClientDay = new Map<string, Set<number>>();
  for (const apt of appointments) {
    const staffId = apt.StaffId ?? apt.Staff?.Id;
    if (!apt.ClientId || staffId === undefined || !apt.StartDateTime) continue;
    const key = `${apt.ClientId}|${String(apt.StartDateTime).slice(0, 10)}`;
    (staffByClientDay.get(key) ?? staffByClientDay.set(key, new Set()).get(key)!).add(staffId);
  }
  const productSales = sales.filter((s) => productLines(s).length > 0);
  const staffFor = (s: MappedSale) =>
    s.clientId && s.saleDateTime
      ? [...(staffByClientDay.get(`${s.clientId}|${s.saleDateTime.slice(0, 10)}`) ?? [])]
      : [];

  return {
    ...result,
    byAppointmentStaff: summarise(productSales, staffFor, names),
    unmatchedProductSales: productSales.filter((s) => staffFor(s).length === 0).length,
    appointmentMatchNote: APPOINTMENT_MATCH_NOTE,
  };
}
