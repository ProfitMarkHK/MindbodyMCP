/**
 * Parity between the two site-timezone resolvers: the MCP server's
 * src/utils/siteTime.ts and its deliberate copy in
 * nextjs-app/src/lib/mindbody/siteTime.ts.
 *
 * One scenario list is run against BOTH modules. If the two drift (a rule
 * changed on one side only, or an error message reworded), the matching row
 * fails. The per-module suites (tests/siteTime.test.ts,
 * tests/nextjs-sitetime.test.ts) cover each resolver in depth; this file only
 * asserts they agree.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { AxiosRequestConfig } from "axios";
import type { IMindbodyClient } from "../src/api/client.js";
import { SimpleCache } from "../src/cache/index.js";
import * as server from "../src/utils/siteTime.js";
import * as nextjs from "../nextjs-app/src/lib/mindbody/siteTime";

const LA = "America/Los_Angeles";
const HK = "Asia/Hong_Kong";

interface SiteRow {
  Id: number;
  Name: string;
  TimeZone?: string;
}

interface Scenario {
  name: string;
  /** Sites GET /site/sites returns (ignored when `lookupError` is set). */
  sites: SiteRow[];
  /** When set, the site lookup throws this message. */
  lookupError?: string;
  /** MINDBODY_SITE_TIMEZONE, if set. */
  override?: string;
  /** MINDBODY_SITE_ID, if set. */
  siteId?: string;
  /** Write guard (strict) or read default (lenient). */
  mode: "strict" | "lenient";
  /** Expected zone, or the exact error message the strict resolver throws. */
  expect: { zone: string } | { error: string };
}

/** Lenient reads fall back to UTC on any failure, so those rows expect UTC. */
const SCENARIOS: Scenario[] = [
  {
    name: "record zone, no override",
    sites: [{ Id: -99, Name: "Sandbox", TimeZone: LA }],
    mode: "strict",
    expect: { zone: LA },
  },
  {
    name: "record zone agrees with override",
    sites: [{ Id: -99, Name: "Sandbox", TimeZone: LA }],
    override: LA,
    mode: "strict",
    expect: { zone: LA },
  },
  {
    name: "record zone agrees with override, case-insensitively",
    sites: [{ Id: -99, Name: "Sandbox", TimeZone: LA }],
    override: "america/los_angeles",
    mode: "strict",
    expect: { zone: LA },
  },
  {
    name: "write: override disagrees with record zone, refused",
    sites: [{ Id: -99, Name: "Sandbox", TimeZone: LA }],
    override: HK,
    mode: "strict",
    expect: {
      error: `Refusing to proceed: MINDBODY_SITE_TIMEZONE="${HK}" disagrees with the site record's TimeZone "${LA}"; fix or unset MINDBODY_SITE_TIMEZONE`,
    },
  },
  {
    name: "read: override disagrees with record zone, record wins",
    sites: [{ Id: -99, Name: "Sandbox", TimeZone: LA }],
    override: HK,
    mode: "lenient",
    expect: { zone: LA },
  },
  {
    name: "record has no usable zone, valid override used",
    sites: [{ Id: 1, Name: "No zone" }],
    override: HK,
    mode: "strict",
    expect: { zone: HK },
  },
  {
    name: "record has no usable zone, valid override used on reads",
    sites: [{ Id: 1, Name: "No zone" }],
    override: HK,
    mode: "lenient",
    expect: { zone: HK },
  },
  {
    name: "record has no usable zone, no override",
    sites: [{ Id: 1, Name: "No zone" }],
    mode: "strict",
    expect: {
      error: "Cannot determine the site timezone: site record has no usable TimeZone (got undefined), and MINDBODY_SITE_TIMEZONE is not set",
    },
  },
  {
    name: "record has no usable zone, invalid override",
    sites: [{ Id: 1, Name: "No zone" }],
    override: "Not/AZone",
    mode: "strict",
    expect: {
      error: 'Cannot determine the site timezone: site record has no usable TimeZone (got undefined), and MINDBODY_SITE_TIMEZONE="Not/AZone" is not a valid IANA zone',
    },
  },
  {
    name: "lookup fails: override is never consulted (write)",
    sites: [],
    lookupError: "down",
    override: HK,
    mode: "strict",
    expect: { error: "Cannot determine the site timezone: site lookup failed: down" },
  },
  {
    name: "lookup fails: override is never consulted (read falls back to UTC)",
    sites: [],
    lookupError: "down",
    override: HK,
    mode: "lenient",
    expect: { zone: "UTC" },
  },
  {
    name: "lookup fails with no override (write)",
    sites: [],
    lookupError: "boom",
    mode: "strict",
    expect: { error: "Cannot determine the site timezone: site lookup failed: boom" },
  },
  {
    name: "multi-site key with no site chosen: refusal beats override (write)",
    sites: [
      { Id: -99, Name: "Sandbox", TimeZone: LA },
      { Id: 12345, Name: "Second Studio", TimeZone: HK },
    ],
    override: HK,
    mode: "strict",
    expect: {
      error:
        "Cannot determine the site timezone: site lookup failed: this API key reaches 2 sites (-99, 12345) and no site was specified; set MINDBODY_SITE_ID or pass siteId explicitly",
    },
  },
  {
    name: "multi-site key with no site chosen: refusal beats override (read falls back to UTC)",
    sites: [
      { Id: -99, Name: "Sandbox", TimeZone: LA },
      { Id: 12345, Name: "Second Studio", TimeZone: HK },
    ],
    override: HK,
    mode: "lenient",
    expect: { zone: "UTC" },
  },
  {
    name: "MINDBODY_SITE_ID pins the record; its zone wins over the override",
    sites: [
      { Id: -99, Name: "Sandbox", TimeZone: LA },
      { Id: 12345, Name: "Second Studio", TimeZone: HK },
    ],
    siteId: "12345",
    override: LA,
    mode: "strict",
    expect: {
      error: `Refusing to proceed: MINDBODY_SITE_TIMEZONE="${LA}" disagrees with the site record's TimeZone "${HK}"; fix or unset MINDBODY_SITE_TIMEZONE`,
    },
  },
];

/**
 * Serves GET /site/sites like Mindbody: honours `SiteIds`, and throws
 * `lookupError` when set. Same shape the per-module suites use.
 */
class ParityApi implements IMindbodyClient {
  constructor(private readonly sites: SiteRow[], private readonly lookupError?: string) {}
  async request<T>(): Promise<T> {
    throw new Error("unused");
  }
  async get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    if (this.lookupError) throw new Error(this.lookupError);
    if (url !== "/site/sites") throw new Error(`ParityApi: unexpected GET ${url}`);
    const wanted: string[] | undefined = (config?.params as any)?.SiteIds?.map(String);
    const rows = wanted ? this.sites.filter((s) => wanted.includes(String(s.Id))) : this.sites;
    return {
      Sites: rows,
      PaginationResponse: { RequestedLimit: 200, RequestedOffset: 0, PageSize: rows.length, TotalResults: rows.length },
    } as T;
  }
  async post<T>(): Promise<T> {
    throw new Error("unused");
  }
}

/** The two resolvers' shared entry points, both taking the same (client, cache). */
const RESOLVERS = [
  {
    label: "server (src/utils/siteTime.ts)",
    strict: (api: ParityApi) => server.getSiteTimeZone(api, new SimpleCache(5)),
    lenient: (api: ParityApi) => server.resolveReadTimeZone(api, new SimpleCache(5)),
    reset: () => server.resetSiteTimeWarningForTests(),
  },
  {
    label: "nextjs (nextjs-app/src/lib/mindbody/siteTime.ts)",
    strict: (api: ParityApi) => nextjs.getSiteTimeZone(api as any, new nextjs.SimpleTtlCache()),
    lenient: (api: ParityApi) => nextjs.resolveReadTimeZone(api as any, new nextjs.SimpleTtlCache()),
    reset: () => nextjs.resetSiteTimeWarningForTests(),
  },
];

describe("site timezone resolvers agree", () => {
  let savedZone: string | undefined;
  let savedSiteId: string | undefined;
  beforeEach(() => {
    savedZone = process.env[server.SITE_TIMEZONE_ENV];
    savedSiteId = process.env[server.SITE_ID_ENV];
    delete process.env[server.SITE_TIMEZONE_ENV];
    delete process.env[server.SITE_ID_ENV];
  });
  afterEach(() => {
    if (savedZone === undefined) delete process.env[server.SITE_TIMEZONE_ENV];
    else process.env[server.SITE_TIMEZONE_ENV] = savedZone;
    if (savedSiteId === undefined) delete process.env[server.SITE_ID_ENV];
    else process.env[server.SITE_ID_ENV] = savedSiteId;
  });

  for (const resolver of RESOLVERS) {
    describe(resolver.label, () => {
      for (const scenario of SCENARIOS) {
        it(scenario.name, async () => {
          if (scenario.override !== undefined) process.env[server.SITE_TIMEZONE_ENV] = scenario.override;
          if (scenario.siteId !== undefined) process.env[server.SITE_ID_ENV] = scenario.siteId;
          const api = new ParityApi(scenario.sites, scenario.lookupError);

          if (scenario.mode === "lenient") {
            resolver.reset();
            const errorSpy = spyOn(console, "error").mockImplementation(() => {});
            try {
              const zone = await resolver.lenient(api);
              expect(zone).toBe("zone" in scenario.expect ? scenario.expect.zone : "UTC");
            } finally {
              errorSpy.mockRestore();
            }
            return;
          }

          if ("zone" in scenario.expect) {
            expect(await resolver.strict(api)).toBe(scenario.expect.zone);
          } else {
            let message: string | undefined;
            try {
              await resolver.strict(api);
            } catch (error: unknown) {
              message = error instanceof Error ? error.message : String(error);
            }
            expect(message).toBe(scenario.expect.error);
          }
        });
      }
    });
  }
});
