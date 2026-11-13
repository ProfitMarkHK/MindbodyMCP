import { mindbodyClient, type IMindbodyClient } from '../api/client.js';
import {
  emptyPricingMap,
  loadPricingMap,
  PricingMapError,
  savePricingMap,
  STYLIST_TIERS,
  type StylistTier,
} from '../utils/pricingMap.js';
import { configuredSiteId } from '../utils/siteTime.js';
import { getServicesTool } from './salesManagement.js';

type ServiceRow = Awaited<ReturnType<typeof getServicesTool>>['services'][number];

/** Single-visit options only: a pack or membership has count > 1 or no count. */
function singleVisit(services: ServiceRow[]): ServiceRow[] {
  return services.filter((s) => s.count === undefined || s.count === 1);
}

/**
 * Best-effort title from a service name, for suggesting map entries. Never used
 * to resolve a checkout: the mapping is explicit, and this only pre-fills it.
 */
export function suggestTier(name: string): StylistTier | null {
  if (/\bS\.?\s*Stylist\b|\bSenior\b/i.test(name)) return 'senior';
  if (/\bEmerging\b/i.test(name)) return 'emerging';
  if (/\bCreative\b/i.test(name)) return 'creative';
  if (/\bDirector\b/i.test(name)) return 'director';
  if (/\bStylist\b/i.test(name)) return 'stylist';
  return null;
}

/**
 * Single-visit services that book a session type, with a suggested title for each,
 * plus the mapping currently stored for it. Use this to fill in `setSessionTypeService`.
 */
export async function getSessionTypePricingOptionsTool(
  sessionTypeId: number,
  locationId?: number,
  client: IMindbodyClient = mindbodyClient
) {
  if (!Number.isInteger(sessionTypeId) || sessionTypeId <= 0) {
    throw new PricingMapError('sessionTypeId must be a positive integer');
  }
  const { services } = await getServicesTool(undefined, [sessionTypeId], locationId, undefined, false, client);
  const state = await loadPricingMap();
  const current = state.status === 'ok' ? state.map.sessionTypeServices[String(sessionTypeId)] ?? {} : null;
  return {
    sessionTypeId,
    options: singleVisit(services).map((s) => ({
      serviceId: s.id,
      name: s.name,
      price: s.price,
      count: s.count ?? 1,
      suggestedTier: suggestTier(s.name),
    })),
    currentMapping: current,
    mapStatus: state.status,
  };
}

/**
 * Set or clear the service a title books for a session type. The service must be
 * offered for that session type in the live catalogue and be single-visit.
 */
export async function setSessionTypeServiceTool(
  sessionTypeId: number,
  tier: StylistTier,
  serviceId: number | null,
  locationId?: number,
  client: IMindbodyClient = mindbodyClient
) {
  if (!Number.isInteger(sessionTypeId) || sessionTypeId <= 0) {
    throw new PricingMapError('sessionTypeId must be a positive integer');
  }
  if (!(STYLIST_TIERS as readonly string[]).includes(tier)) {
    throw new PricingMapError(`tier must be one of ${STYLIST_TIERS.join(', ')}`);
  }
  if (serviceId !== null && (!Number.isInteger(serviceId) || serviceId <= 0)) {
    throw new PricingMapError('serviceId must be a positive integer, or null to clear');
  }
  const siteId = configuredSiteId();
  if (siteId === undefined) throw new PricingMapError('MINDBODY_SITE_ID must be set before pricing maps can be written');

  let serviceName: string | null = null;
  if (serviceId !== null) {
    const { services } = await getServicesTool(undefined, [sessionTypeId], locationId, undefined, false, client);
    const hit = services.find((s) => s.id === serviceId);
    if (!hit) throw new PricingMapError(`service ${serviceId} is not offered for session type ${sessionTypeId}`);
    if (!singleVisit([hit]).length) {
      throw new PricingMapError(`service ${serviceId} is a pack (count ${hit.count}); map single-visit options only`);
    }
    serviceName = hit.name;
  }

  const state = await loadPricingMap(siteId);
  if (state.status === 'invalid') throw new PricingMapError(`pricing map is invalid: ${state.reason}`);
  if (state.status === 'absent' && state.file === undefined) {
    throw new PricingMapError('MINDBODY_PRICING_MAP_DIR is not set; cannot save the pricing map');
  }

  const base = state.status === 'ok' ? state.map : emptyPricingMap(siteId);
  const expected = state.status === 'ok' ? state.mapVersion : 'absent';
  const key = String(sessionTypeId);
  const oldServiceId = base.sessionTypeServices[key]?.[tier] ?? null;

  const next = { ...base, sessionTypeServices: { ...base.sessionTypeServices } };
  const entry = { ...(next.sessionTypeServices[key] ?? {}) };
  if (serviceId === null) delete entry[tier];
  else entry[tier] = serviceId;
  if (Object.keys(entry).length === 0) delete next.sessionTypeServices[key];
  else next.sessionTypeServices[key] = entry;

  const { mapVersion } = await savePricingMap(siteId, next, expected, [
    { kind: 'sessionType', key, tier, old: oldServiceId, new: serviceId },
  ]);
  return {
    status: 'updated' as const,
    sessionTypeId,
    tier,
    old: oldServiceId,
    new: serviceId,
    serviceName,
    mapVersion,
  };
}

/**
 * At checkout: which single-visit service to charge for this staff member's session.
 * Pass the returned `serviceId` as the cart item's `metadata.id`. Every non-resolved
 * status is a reason to stop and ask, never a reason to fall back to a default tier.
 */
export async function resolveCheckoutServiceTool(
  staffId: number,
  sessionTypeId: number,
  locationId?: number,
  client: IMindbodyClient = mindbodyClient
) {
  if (!Number.isInteger(staffId) || staffId <= 0) {
    throw new PricingMapError('staffId must be a positive integer');
  }
  if (!Number.isInteger(sessionTypeId) || sessionTypeId <= 0) {
    throw new PricingMapError('sessionTypeId must be a positive integer');
  }
  const state = await loadPricingMap();
  if (state.status !== 'ok') {
    return { status: state.status === 'absent' ? 'map_absent' : 'map_invalid', reason: state.reason };
  }
  const tier = state.map.staff[String(staffId)];
  if (!tier) return { status: 'no_tier', staffId, reason: 'staff has no title in the pricing map' };

  const serviceId = state.map.sessionTypeServices[String(sessionTypeId)]?.[tier];
  if (serviceId === undefined) {
    return { status: 'no_service_mapping', staffId, sessionTypeId, tier, reason: 'no service mapped for this title and session type' };
  }

  // Check the mapping against the live catalogue before quoting a price.
  const { services } = await getServicesTool(undefined, [sessionTypeId], locationId, undefined, false, client);
  const live = services.find((s) => s.id === serviceId);
  if (!live) {
    return { status: 'service_not_in_catalogue', staffId, sessionTypeId, tier, serviceId, reason: 'mapped service is no longer offered for this session type' };
  }
  return {
    status: 'resolved' as const,
    staffId,
    sessionTypeId,
    tier,
    serviceId,
    serviceName: live.name,
    price: live.price,
    mapVersion: state.mapVersion,
  };
}
