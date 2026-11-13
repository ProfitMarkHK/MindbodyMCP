import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, readdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { IMindbodyClient } from "../src/api/client.js";
import { resolveCheckoutServiceTool, getSessionTypePricingOptionsTool, setSessionTypeServiceTool, suggestTier } from "../src/tools/checkoutPricing.js";
import { getPricingMapTool, setStylistTierTool } from "../src/tools/stylistTiers.js";
import {
  PRICING_MAP_DIR_ENV,
  PricingMapConflictError,
  PricingMapError,
  loadPricingMap,
  pricingMapFileName,
  savePricingMap,
  validatePricingMap,
} from "../src/utils/pricingMap.js";
import { SITE_ID_ENV } from "../src/utils/siteTime.js";

const SITE = "1234";
const STAFF = [
  { Id: 111, FirstName: "Ana", LastName: "Lee", Name: "Ana" },
  { Id: 222, FirstName: "Ben", LastName: "Ko", Name: "Ben" },
];
// Services as GET /sale/services returns them, plus the session types each is offered for.
const SERVICES: Array<{ Id: number; Name: string; Price: number; Count: number; sessionTypes: number[] }> = [
  { Id: 14527, Name: "Colour & Finish - Creative Stylist", Price: 1450, Count: 1, sessionTypes: [277] },
  { Id: 15671, Name: "Colour & Finish - Emerging Stylist", Price: 990, Count: 1, sessionTypes: [277] },
  { Id: 14528, Name: "Colour & Finish - S. Stylist", Price: 1800, Count: 1, sessionTypes: [277] },
  { Id: 99001, Name: "Colour & Finish x 5", Price: 5000, Count: 5, sessionTypes: [277] },
];

function stubClient(): IMindbodyClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get(url: string, config?: { params?: Record<string, unknown> }) {
      calls.push(url);
      if (url === "/staff/staff") return { StaffMembers: STAFF, PaginationResponse: { TotalResults: STAFF.length } };
      if (url === "/sale/services") {
        const ids = (config?.params?.SessionTypeIds as number[] | undefined) ?? [];
        const rows = SERVICES.filter((s) => ids.length === 0 || ids.some((id) => s.sessionTypes.includes(id)));
        return {
          Services: rows.map(({ sessionTypes: _ignored, ...row }) => row),
          PaginationResponse: { TotalResults: rows.length },
        };
      }
      throw new Error(`unexpected GET ${url}`);
    },
    async post(url: string) {
      throw new Error(`unexpected POST ${url}`);
    },
    async request(): Promise<never> {
      throw new Error("unexpected request");
    },
  } as IMindbodyClient & { calls: string[] };
}

let dir: string;
const saved = { site: process.env[SITE_ID_ENV], dir: process.env[PRICING_MAP_DIR_ENV] };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pricing-map-"));
  process.env[SITE_ID_ENV] = SITE;
  process.env[PRICING_MAP_DIR_ENV] = dir;
});

afterEach(async () => {
  restore(SITE_ID_ENV, saved.site);
  restore(PRICING_MAP_DIR_ENV, saved.dir);
  await rm(dir, { recursive: true, force: true });
});

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function writeMap(map: unknown) {
  await writeFile(join(dir, pricingMapFileName(SITE)), JSON.stringify(map), "utf8");
}

describe("pricing map loading", () => {
  it("reports absent when the directory is not configured", async () => {
    delete process.env[PRICING_MAP_DIR_ENV];
    const state = await loadPricingMap();
    expect(state.status).toBe("absent");
  });

  it("reports absent when the site file does not exist yet", async () => {
    expect((await loadPricingMap()).status).toBe("absent");
  });

  it("reports invalid when MINDBODY_SITE_ID is unset, so no file can be matched", async () => {
    delete process.env[SITE_ID_ENV];
    expect((await loadPricingMap()).status).toBe("invalid");
  });

  it("returns a version hash that changes when the file changes", async () => {
    await writeMap({ siteId: SITE, staff: { "111": "senior" }, sessionTypeServices: {} });
    const first = await loadPricingMap();
    await writeMap({ siteId: SITE, staff: { "111": "director" }, sessionTypeServices: {} });
    const second = await loadPricingMap();
    expect(first.status === "ok" && second.status === "ok" && first.mapVersion !== second.mapVersion).toBe(true);
  });

  it("refuses a file whose siteId differs from the configured site", async () => {
    await writeMap({ siteId: "9999", staff: {}, sessionTypeServices: {} });
    const state = await loadPricingMap();
    expect(state.status).toBe("invalid");
  });
});

describe("pricing map validation", () => {
  it("rejects a title outside the vocabulary", () => {
    expect(() => validatePricingMap({ siteId: SITE, staff: { "111": "davy" }, sessionTypeServices: {} }, SITE)).toThrow(PricingMapError);
  });

  it("rejects a non-numeric staff key", () => {
    expect(() => validatePricingMap({ siteId: SITE, staff: { Ana: "senior" }, sessionTypeServices: {} }, SITE)).toThrow(PricingMapError);
  });

  it("rejects a non-positive service ID", () => {
    expect(() =>
      validatePricingMap({ siteId: SITE, staff: {}, sessionTypeServices: { "277": { senior: 0 } } }, SITE)
    ).toThrow(PricingMapError);
  });
});

describe("resolveCheckoutService", () => {
  it("returns map_absent when no map is configured", async () => {
    const result = await resolveCheckoutServiceTool(111, 277, undefined, stubClient());
    expect(result.status).toBe("map_absent");
  });

  it("returns no_tier for a stylist without a title, never a default", async () => {
    await writeMap({ siteId: SITE, staff: {}, sessionTypeServices: { "277": { senior: 14528 } } });
    const result = await resolveCheckoutServiceTool(111, 277, undefined, stubClient());
    expect(result.status).toBe("no_tier");
  });

  it("returns no_service_mapping when the title has no service for the session type", async () => {
    await writeMap({ siteId: SITE, staff: { "111": "emerging" }, sessionTypeServices: { "277": { senior: 14528 } } });
    const result = await resolveCheckoutServiceTool(111, 277, undefined, stubClient());
    expect(result.status).toBe("no_service_mapping");
  });

  it("returns service_not_in_catalogue when the mapped service is no longer offered", async () => {
    await writeMap({ siteId: SITE, staff: { "111": "senior" }, sessionTypeServices: { "277": { senior: 1 } } });
    const result = await resolveCheckoutServiceTool(111, 277, undefined, stubClient());
    expect(result.status).toBe("service_not_in_catalogue");
  });

  it("resolves to the mapped service and takes the price from the live catalogue", async () => {
    await writeMap({ siteId: SITE, staff: { "111": "senior" }, sessionTypeServices: { "277": { senior: 14528 } } });
    const result = await resolveCheckoutServiceTool(111, 277, undefined, stubClient());
    expect(result).toMatchObject({ status: "resolved", tier: "senior", serviceId: 14528, price: 1800 });
  });
});

describe("getPricingMap and setStylistTier", () => {
  it("creates the file on first write and records the change in the audit log", async () => {
    const out = await setStylistTierTool(111, "senior", stubClient());
    expect(out).toMatchObject({ status: "updated", old: null, new: "senior", name: "Ana" });
    const audit = await readFile(join(dir, `pricing.${SITE}.audit.jsonl`), "utf8");
    expect(audit).toContain('"key":"111"');
    expect((await loadPricingMap()).status).toBe("ok");
  });

  it("keeps the previous file as .bak on the second write", async () => {
    await setStylistTierTool(111, "senior", stubClient());
    await setStylistTierTool(111, "director", stubClient());
    const files = await readdir(dir);
    expect(files).toContain(`${pricingMapFileName(SITE)}.bak`);
  });

  it("refuses a staff ID that is not on the live staff list", async () => {
    await expect(setStylistTierTool(999, "senior", stubClient())).rejects.toThrow(/not on the live staff list/);
  });

  it("clears a title when tier is null", async () => {
    await setStylistTierTool(111, "senior", stubClient());
    const cleared = await setStylistTierTool(111, null, stubClient());
    expect(cleared.old).toBe("senior");
    const map = await getPricingMapTool(stubClient());
    expect(map.status === "ok" && map.staff).toEqual([]);
  });

  it("flags a mapped staff ID that has left the live list rather than dropping it", async () => {
    await writeMap({ siteId: SITE, staff: { "555": "stylist" }, sessionTypeServices: {} });
    const map = await getPricingMapTool(stubClient());
    expect(map.status === "ok" && map.staff).toEqual([{ staffId: 555, name: null, tier: "stylist", inLiveStaff: false }]);
  });

  it("refuses a write when the file changed since it was read", async () => {
    await writeMap({ siteId: SITE, staff: {}, sessionTypeServices: {} });
    await expect(
      savePricingMap(SITE, validatePricingMap({ siteId: SITE, staff: {}, sessionTypeServices: {} }, SITE), "absent", [])
    ).rejects.toBeInstanceOf(PricingMapConflictError);
  });
});

describe("session type service mapping", () => {
  it("suggests a title from the service name without using it to resolve", () => {
    expect(suggestTier("Colour & Finish - S. Stylist")).toBe("senior");
    expect(suggestTier("Colour & Finish - Emerging Stylist")).toBe("emerging");
    expect(suggestTier("Ladies Cut & Finish - Stylist")).toBe("stylist");
    expect(suggestTier("Ladies Cut and Finish - Davy")).toBeNull();
  });

  it("lists single-visit options only, with suggested titles", async () => {
    const out = await getSessionTypePricingOptionsTool(277, undefined, stubClient());
    expect(out.options.map((o) => o.serviceId)).toEqual([14527, 15671, 14528]);
    expect(out.options[0].suggestedTier).toBe("creative");
  });

  it("refuses a pack as a single-visit mapping", async () => {
    await expect(setSessionTypeServiceTool(277, "creative", 99001, undefined, stubClient())).rejects.toThrow(/pack/);
  });

  it("refuses a service the session type does not offer", async () => {
    await expect(setSessionTypeServiceTool(277, "creative", 123456, undefined, stubClient())).rejects.toThrow(/not offered/);
  });

  it("stores the mapping and then resolves checkout through it", async () => {
    await setStylistTierTool(222, "creative", stubClient());
    await setSessionTypeServiceTool(277, "creative", 14527, undefined, stubClient());
    const result = await resolveCheckoutServiceTool(222, 277, undefined, stubClient());
    expect(result).toMatchObject({ status: "resolved", serviceId: 14527, price: 1450 });
  });
});
