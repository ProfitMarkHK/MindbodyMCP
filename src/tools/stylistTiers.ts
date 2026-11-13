import { mindbodyClient, type IMindbodyClient } from '../api/client.js';
import { configuredSiteId } from '../utils/siteTime.js';
import {
  emptyPricingMap,
  loadPricingMap,
  PRICING_MAP_DIR_ENV,
  PricingMapError,
  savePricingMap,
  STYLIST_TIERS,
  type StylistTier,
} from '../utils/pricingMap.js';
import { getStaffTool } from './siteManagement.js';

/** Live staff names keyed by ID. `getStaff` returns every staff member, so the
 *  set is complete and an absent ID means "no longer on the staff list". */
async function liveStaffNames(client: IMindbodyClient): Promise<Map<string, string>> {
  const { staff } = await getStaffTool(undefined, undefined, undefined, undefined, undefined, client);
  return new Map(staff.map((s) => [String(s.id), s.name]));
}

/**
 * The local pricing map with live staff names attached. Entries whose staff ID is
 * no longer on the staff list are flagged, not dropped, so history stays readable.
 */
export async function getPricingMapTool(client: IMindbodyClient = mindbodyClient) {
  const state = await loadPricingMap();
  if (state.status !== 'ok') {
    return { status: state.status, reason: state.reason, tiers: STYLIST_TIERS };
  }
  const names = await liveStaffNames(client);
  const staff = Object.entries(state.map.staff)
    .map(([id, tier]) => ({
      staffId: Number(id),
      name: names.get(id) ?? null,
      tier,
      inLiveStaff: names.has(id),
    }))
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  const sessionTypeServices = Object.entries(state.map.sessionTypeServices).map(([id, tiers]) => ({
    sessionTypeId: Number(id),
    services: tiers,
  }));
  return { status: 'ok', mapVersion: state.mapVersion, tiers: STYLIST_TIERS, staff, sessionTypeServices };
}

/**
 * Set or clear one staff member's title. The staff ID must be on the live staff
 * list, so a typo cannot create a mapping for nobody. A missing file is created
 * on first write. Ungated until RBAC lands (operator decision).
 */
export async function setStylistTierTool(
  staffId: number,
  tier: StylistTier | null,
  client: IMindbodyClient = mindbodyClient
): Promise<{ status: 'updated'; staffId: number; name: string | null; old: StylistTier | null; new: StylistTier | null; mapVersion: string }> {
  if (!Number.isInteger(staffId) || staffId <= 0) {
    throw new PricingMapError('staffId must be a positive integer');
  }
  if (tier !== null && !(STYLIST_TIERS as readonly string[]).includes(tier)) {
    throw new PricingMapError(`tier must be one of ${STYLIST_TIERS.join(', ')}, or null to clear`);
  }
  const siteId = configuredSiteId();
  if (siteId === undefined) throw new PricingMapError('MINDBODY_SITE_ID must be set before pricing maps can be written');

  const state = await loadPricingMap(siteId);
  if (state.status === 'invalid') throw new PricingMapError(`pricing map is invalid: ${state.reason}`);
  if (state.status === 'absent' && state.file === undefined) {
    throw new PricingMapError(`${PRICING_MAP_DIR_ENV} is not set; cannot save the pricing map`);
  }

  const names = await liveStaffNames(client);
  const key = String(staffId);
  if (!names.has(key)) throw new PricingMapError(`staff ${staffId} is not on the live staff list`);

  const base = state.status === 'ok' ? state.map : emptyPricingMap(siteId);
  const expected = state.status === 'ok' ? state.mapVersion : 'absent';
  const old = base.staff[key] ?? null;

  const next = { ...base, staff: { ...base.staff } };
  if (tier === null) delete next.staff[key];
  else next.staff[key] = tier;

  const { mapVersion } = await savePricingMap(siteId, next, expected, [
    { kind: 'staff', key, old, new: tier },
  ]);
  return { status: 'updated', staffId, name: names.get(key) ?? null, old, new: tier, mapVersion };
}
