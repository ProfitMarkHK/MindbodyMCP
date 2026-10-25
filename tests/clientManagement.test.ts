/**
 * Client-domain tool tests.
 *
 * Every fixture here is SHAPED LIKE THE SPEC (`docs/openapi.json`), because the
 * bugs these tests pin down were exactly the tools reading fields the schema
 * does not have:
 *   - `Client.LiabilityRelease` is a BOOLEAN and the object is `Client.Liability`
 *   - `ClientMembership.Program` is a `Program` OBJECT, not a label
 *   - `Client.ClientCreditCard` is a single card, not a list, and carries no
 *     money field
 *   - `ClientContract` has `AgreementDate`/`ContractID`/`AutoRenewing`/
 *     `IsMonthToMonth`/`TerminationDate` and no `Description`/`SoldDate`/
 *     `Balance`/`ContractType`
 *   - `Visit` has `LocationId`/`StaffId` and no embedded `Location`/`Staff`
 *
 * Requests go through `SpecValidatingClient`, which rejects a query parameter
 * the spec does not document, so a passing call also proves the request shape is
 * spec-valid. It does NOT validate POST bodies, so the sandbox accommodations in
 * `addClientTool`/`updateClientTool` are asserted against a recording client
 * instead.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { AxiosRequestConfig } from "axios";
import { SpecValidatingClient, SpecValidationError } from "./spec-validating-client.js";
import {
  addClientTool,
  getClientAccountBalancesTool,
  getClientCompleteInfoTool,
  getClientContractsTool,
  getClientMembershipsTool,
  getClientVisitsTool,
  getClientsTool,
  updateClientTool,
} from "../src/tools/clientManagement.js";
import { SimpleCache } from "../src/cache/index.js";
import type { IMindbodyClient } from "../src/api/client.js";

const spec = JSON.parse(
  readFileSync(resolve(__dirname, "../docs/openapi.json"), "utf-8")
);

function makeClient(fixture: unknown) {
  return new SpecValidatingClient(spec, fixture);
}

function emptyCache() {
  return new SimpleCache(5);
}

/**
 * `SpecValidatingClient` ignores POST bodies, so the wire-level assertions for
 * the sandbox accommodations use this instead: it records what was posted and
 * returns a canned response.
 */
class RecordingClient implements IMindbodyClient {
  readonly posts: Array<{ url: string; body: Record<string, unknown> }> = [];

  constructor(private readonly response: unknown) {}

  async request<T>(_config?: AxiosRequestConfig, _retries?: number): Promise<T> {
    throw new Error("RecordingClient: request() is not used by these tools");
  }

  async get<T>(_url?: string, _config?: AxiosRequestConfig): Promise<T> {
    throw new Error("RecordingClient: get() is not used by these tests");
  }

  async post<T>(url: string, data?: unknown, _config?: AxiosRequestConfig): Promise<T> {
    this.posts.push({ url, body: (data ?? {}) as Record<string, unknown> });
    return this.response as T;
  }
}

/** Wraps a client to record the URL of every outbound call. */
class UrlRecordingClient implements IMindbodyClient {
  readonly urls: string[] = [];

  constructor(private readonly inner: IMindbodyClient) {}

  async request<T>(config: AxiosRequestConfig, retries?: number): Promise<T> {
    this.urls.push(config.url ?? "");
    return this.inner.request<T>(config, retries);
  }

  async get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    this.urls.push(url);
    return this.inner.get<T>(url, config);
  }

  async post<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    this.urls.push(url);
    return this.inner.post<T>(url, data, config);
  }
}

// ── getClientsTool (C-14) ─────────────────────────────────────────────────────

const clientsFixture = {
  Clients: [
    {
      Id: "c-1",
      FirstName: "Grace",
      LastName: "Hopper",
      Email: "grace@example.invalid",
      MobilePhone: "555-0100",
      HomePhone: "555-0101",
      BirthDate: "1985-12-09",
      AddressLine1: "1 Navy Yard",
      City: "Arlington",
      State: "VA",
      PostalCode: "22201",
      Country: "US",
      IsProspect: false,
      SendAccountEmails: true,
      CreationDate: "2026-01-04T10:00:00",
      Status: "Active",
      MembershipIcon: 4,
      // Spec: `LiabilityRelease` is a boolean. The object is `Liability`.
      LiabilityRelease: true,
      Liability: { AgreementDate: "2024-01-15", IsReleased: true, ReleasedBy: 42 },
      EmergencyContactInfoName: "Alan Turing",
      EmergencyContactInfoPhone: "555-0199",
      EmergencyContactInfoRelationship: "Spouse",
    },
    {
      // `LiabilityRelease: false` with a populated object: the boolean being
      // false must not be what hides the agreement.
      Id: "c-2",
      FirstName: "Alan",
      LastName: "Turing",
      IsProspect: true,
      SendAccountEmails: false,
      CreationDate: "2026-02-28T08:30:00",
      Status: "Lead",
      MembershipIcon: 0,
      LiabilityRelease: false,
      Liability: { AgreementDate: "2025-03-09", IsReleased: false },
    },
    {
      // Neither: no `Liability` object at all.
      Id: "c-3",
      FirstName: "Katherine",
      LastName: "Johnson",
      IsProspect: false,
      SendAccountEmails: true,
      CreationDate: "2026-03-01T09:00:00",
      Status: "Active",
      MembershipIcon: 2,
      LiabilityRelease: false,
    },
  ],
};

describe("getClientsTool", () => {
  it("reads the liability object, not the LiabilityRelease boolean", async () => {
    const result = await getClientsTool(
      undefined, undefined, undefined, undefined, makeClient(clientsFixture)
    );

    expect(result.totalClients).toBe(3);
    expect(result.clients).toHaveLength(3);

    // c-1: LiabilityRelease is the boolean `true`; the dates come from Liability.
    expect(result.clients[0].liability).toEqual({
      isReleased: true,
      agreedDate: "2024-01-15",
    });

    // c-2: LiabilityRelease is `false`, yet Liability is still reported. Reading
    // the boolean (the old code) dropped this block entirely.
    expect(result.clients[1].liability).toEqual({
      isReleased: false,
      agreedDate: "2025-03-09",
    });

    // c-3: no Liability object, so the optional block is absent.
    expect(result.clients[2].liability).toBeUndefined();
  });

  it("maps the remaining documented Client fields", async () => {
    const result = await getClientsTool(
      undefined, undefined, undefined, undefined, makeClient(clientsFixture)
    );

    expect(result.clients[0]).toEqual({
      id: "c-1",
      firstName: "Grace",
      lastName: "Hopper",
      email: "grace@example.invalid",
      phone: "555-0100",
      birthDate: "1985-12-09",
      addressLine1: "1 Navy Yard",
      city: "Arlington",
      state: "VA",
      postalCode: "22201",
      country: "US",
      isProspect: false,
      isOptedIn: true,
      liability: { isReleased: true, agreedDate: "2024-01-15" },
      emergencyContact: {
        name: "Alan Turing",
        phone: "555-0199",
        relationship: "Spouse",
      },
      createdDate: "2026-01-04T10:00:00",
      status: "Active",
      membershipIcon: 4,
    });
  });

  it("sends a spec-valid query, and a bogus one is rejected", async () => {
    const ok = makeClient(clientsFixture);
    await getClientsTool(
      "Hopper", ["c-1", "c-2"], "2026-01-01", true, ok
    );

    const bad = makeClient(clientsFixture);
    await expect(
      bad.get("/client/clients", { params: { BogusParam: "oops" } })
    ).rejects.toThrow(SpecValidationError);
  });
});

// ── getClientVisitsTool (C-15) ───────────────────────────────────────────────

/** Spec `Visit`: ids only, no embedded `Location` or `Staff`. */
const visitRows = [
  {
    Id: 7001,
    ClassId: 101,
    Name: "Vinyasa Flow",
    StartDateTime: "2026-03-02T09:00:00",
    EndDateTime: "2026-03-02T10:00:00",
    LocationId: 1,
    StaffId: 9001,
    SignedIn: true,
    WebSignup: false,
    LateCancelled: false,
    ServiceId: 5,
    ServiceName: "Drop-in",
  },
  {
    Id: 7002,
    ClassId: 102,
    Name: "Power Reformer",
    StartDateTime: "2026-03-03T18:00:00",
    EndDateTime: "2026-03-03T19:00:00",
    LocationId: 2,
    StaffId: 9002,
    SignedIn: false,
    WebSignup: true,
    LateCancelled: true,
    ServiceId: 6,
    ServiceName: "Reformer",
  },
];

const knownCatalogueFixture = {
  Visits: visitRows,
  Locations: [{ Id: 1, Name: "Main Studio" }],
  StaffMembers: [{ Id: 9001, Name: "Ada Lovelace" }],
};

const unknownCatalogueFixture = {
  Visits: visitRows,
  // Neither visit id appears in either catalogue.
  Locations: [{ Id: 99, Name: "Somewhere Else" }],
  StaffMembers: [{ Id: 99, Name: "Somebody Else" }],
};

async function runVisits(fixture: unknown) {
  return getClientVisitsTool(
    "c-1", "2026-03-01", "2026-03-04", makeClient(fixture), emptyCache()
  );
}

describe("getClientVisitsTool", () => {
  it("resolves location and instructor from the catalogues and exposes the ids", async () => {
    const result = await runVisits(knownCatalogueFixture);

    expect(result.totalVisits).toBe(2);
    expect(result.visits[0]).toEqual({
      id: 7001,
      classId: 101,
      className: "Vinyasa Flow",
      startTime: "2026-03-02T09:00:00",
      endTime: "2026-03-02T10:00:00",
      locationId: 1,
      location: "Main Studio",
      staffId: 9001,
      instructor: "Ada Lovelace",
      signedIn: true,
      webSignup: false,
      lateCancel: false,
      serviceId: 5,
      serviceName: "Drop-in",
    });

    // LocationId 2 / StaffId 9002 are absent from the catalogues: undefined,
    // and the id is still on the row.
    expect(result.visits[1].locationId).toBe(2);
    expect(result.visits[1].location).toBeUndefined();
    expect(result.visits[1].staffId).toBe(9002);
    expect(result.visits[1].instructor).toBeUndefined();
  });

  it("never reports an unknown name as 'Unknown' or an empty string", async () => {
    const result = await runVisits(unknownCatalogueFixture);

    for (const visit of result.visits) {
      expect(visit.location).toBeUndefined();
      expect(visit.instructor).toBeUndefined();
      expect(visit.location).not.toBe("Unknown");
      expect(visit.instructor).not.toBe("Unknown");
      expect(visit.location).not.toBe("");
      expect(visit.instructor).not.toBe("");
    }
  });

  it("summarises attendance and groups by resolved name", async () => {
    const result = await runVisits(knownCatalogueFixture);

    expect(result.summary.totalAttended).toBe(1);
    expect(result.summary.totalNoShows).toBe(0);
    expect(result.summary.totalLateCancels).toBe(1);
    expect(result.summary.byLocation).toEqual({ "Main Studio": 1 });
    expect(result.summary.byInstructor).toEqual({ "Ada Lovelace": 1 });
    expect(result.summary.byClassType).toEqual({ "Vinyasa Flow": 1 });
  });

  it("groups by the raw id as a string when the catalogue has no name", async () => {
    const result = await runVisits(unknownCatalogueFixture);

    expect(result.summary.byLocation).toEqual({ "1": 1 });
    expect(result.summary.byInstructor).toEqual({ "9001": 1 });
    expect(result.summary.byClassType).toEqual({ "Vinyasa Flow": 1 });
  });

  it("sends a spec-valid query, and a bogus one is rejected", async () => {
    const bad = makeClient(knownCatalogueFixture);
    await expect(
      bad.get("/client/clientvisits", { params: { BogusParam: "oops" } })
    ).rejects.toThrow(SpecValidationError);
  });

  it("reads a catalogue only when some visit carries the id it resolves", async () => {
    // Name resolution must not add outbound requests when there is nothing to
    // resolve: a page of visits with no `LocationId`/`StaffId` costs the same
    // single GET as before.
    const noIds = {
      Visits: [
        {
          Id: 8001, ClassId: 201, Name: "Barre",
          StartDateTime: "2026-03-05T09:00:00", EndDateTime: "2026-03-05T10:00:00",
          SignedIn: true, WebSignup: false, LateCancelled: false,
        },
      ],
      Locations: [{ Id: 1, Name: "Main Studio" }],
      StaffMembers: [{ Id: 9001, Name: "Ada Lovelace" }],
    };

    const withoutIds = new UrlRecordingClient(makeClient(noIds));
    const flat = await getClientVisitsTool(
      "c-1", "2026-03-01", "2026-03-04", withoutIds, emptyCache()
    );
    expect(flat.visits[0].location).toBeUndefined();
    expect(flat.visits[0].instructor).toBeUndefined();
    expect(withoutIds.urls.filter((u) => u === "/site/locations" || u === "/staff/staff")).toEqual([]);

    // With ids present, both catalogues are read (and then cached).
    const withIds = new UrlRecordingClient(makeClient(knownCatalogueFixture));
    const sharedCache = emptyCache();
    await getClientVisitsTool("c-1", "2026-03-01", "2026-03-04", withIds, sharedCache);
    expect(withIds.urls).toContain("/site/locations");
    expect(withIds.urls).toContain("/staff/staff");

    // A second call on the same cache re-uses them: no further catalogue reads.
    const before = withIds.urls.length;
    await getClientVisitsTool("c-1", "2026-03-01", "2026-03-04", withIds, sharedCache);
    expect(
      withIds.urls.slice(before).filter((u) => u === "/site/locations" || u === "/staff/staff")
    ).toEqual([]);
  });
});

// ── getClientMembershipsTool (C-16) ──────────────────────────────────────────

const membershipsFixture = {
  ClientMemberships: [
    {
      Id: 3001,
      Name: "Unlimited Month",
      Remaining: 8,
      ActiveDate: "2026-02-01",
      ExpirationDate: "2026-03-01",
      PaymentDate: "2026-02-01",
      // Spec: `Program` is a `Program` object.
      Program: { Id: 3, Name: "Yoga", ScheduleType: "Class" },
      SiteId: 1,
      IconCode: "4",
      Action: "AddToWaitlist",
    },
    {
      Id: 3002,
      Name: "Open Gym",
      Remaining: 0,
      ActiveDate: "2026-02-01",
      Program: { Id: 9, Name: "Personal Training", ScheduleType: "Appointment" },
      SiteId: 1,
      IconCode: "0",
    },
  ],
};

describe("getClientMembershipsTool", () => {
  it("maps the Program object to a name and an id, and drops the old `program` field", async () => {
    const result = await getClientMembershipsTool("c-1", 1, makeClient(membershipsFixture));

    expect(result.totalMemberships).toBe(2);
    expect(result.memberships[0]).toEqual({
      id: 3001,
      name: "Unlimited Month",
      remainingClasses: 8,
      activeDate: "2026-02-01",
      expirationDate: "2026-03-01",
      paymentDate: "2026-02-01",
      programName: "Yoga",
      programId: 3,
      siteId: 1,
      iconCode: "4",
      action: "AddToWaitlist",
    });

    expect(result.memberships[1].programName).toBe("Personal Training");
    expect(result.memberships[1].programId).toBe(9);

    // The old field typed `string` but carried an object: it must be gone.
    for (const membership of result.memberships) {
      expect(Object.keys(membership)).not.toContain("program");
      expect("program" in membership).toBe(false);
    }
  });

  it("sends a spec-valid query, and a bogus one is rejected", async () => {
    const bad = makeClient(membershipsFixture);
    await expect(
      bad.get("/client/activeclientmemberships", { params: { BogusParam: "oops" } })
    ).rejects.toThrow(SpecValidationError);
  });
});

// ── getClientAccountBalancesTool (C-17) ──────────────────────────────────────

const balancesFixture = {
  Clients: [
    {
      Id: "c-1",
      AccountBalance: -42.5,
      // Spec: one `ClientCreditCard` object, with no balance field at all.
      ClientCreditCard: {
        CardId: "cc-1",
        CardHolder: "Grace Hopper",
        CardType: "Visa",
        LastFour: "4242",
        ExpMonth: "04",
        ExpYear: "2029",
      },
    },
  ],
};

describe("getClientAccountBalancesTool", () => {
  it("reports the account balance and the single stored card, with no per-card balance", async () => {
    const result = await getClientAccountBalancesTool("c-1", makeClient(balancesFixture));

    expect(result).toEqual({
      accountBalance: -42.5,
      creditCard: { cardType: "Visa", lastFour: "4242" },
    });
    expect("creditCardBalances" in result).toBe(false);
  });

  it("leaves the card absent when the client has none", async () => {
    const result = await getClientAccountBalancesTool("c-1", makeClient({
      Clients: [{ Id: "c-1", AccountBalance: 0 }],
    }));

    expect(result).toEqual({ accountBalance: 0, creditCard: undefined });
    expect(result.creditCard).toBeUndefined();
  });

  it("sends a spec-valid query, and a bogus one is rejected", async () => {
    const bad = makeClient(balancesFixture);
    await expect(
      bad.get("/client/clientaccountbalances", { params: { BogusParam: "oops" } })
    ).rejects.toThrow(SpecValidationError);
  });
});

// ── getClientContractsTool (C-18) ────────────────────────────────────────────

const contractsFixture = {
  Contracts: [
    {
      Id: 42,
      ContractID: 4242,
      ContractName: "Founders Membership",
      AgreementDate: "2026-10-04T00:00:00",
      StartDate: "2026-10-04",
      EndDate: "2027-10-04",
      AutopayStatus: "Active",
      AutoRenewing: true,
      IsMonthToMonth: false,
      TerminationDate: "2027-01-15T00:00:00",
      SiteId: 1,
      PayerClientId: 7,
      OriginationLocationId: 1,
    },
    {
      Id: 43,
      ContractID: 4343,
      ContractName: "Terminated Membership",
      AgreementDate: "2025-05-01T00:00:00",
      StartDate: "2025-05-01",
      AutopayStatus: "Canceled",
      AutoRenewing: false,
      IsMonthToMonth: true,
      TerminationDate: "2025-08-01T00:00:00",
      SiteId: 1,
    },
  ],
};

describe("getClientContractsTool", () => {
  it("maps the real ClientContract fields", async () => {
    const result = await getClientContractsTool("c-1", makeClient(contractsFixture));

    expect(result.totalContracts).toBe(2);
    expect(result.contracts[0]).toEqual({
      id: 42,
      contractId: 4242,
      name: "Founders Membership",
      // `SoldDate` does not exist; `AgreementDate` is the documented equivalent.
      soldDate: "2026-10-04T00:00:00",
      startDate: "2026-10-04",
      endDate: "2027-10-04",
      autopayStatus: "Active",
      autoRenewing: true,
      isMonthToMonth: false,
      terminationDate: "2027-01-15T00:00:00",
      siteId: 1,
    });

    expect(result.contracts[1].autoRenewing).toBe(false);
    expect(result.contracts[1].isMonthToMonth).toBe(true);
    expect(result.contracts[1].endDate).toBeUndefined();
  });

  it("drops description, balance and contractType, which ClientContract does not have", async () => {
    const result = await getClientContractsTool("c-1", makeClient(contractsFixture));

    for (const contract of result.contracts) {
      expect(Object.keys(contract)).not.toContain("description");
      expect(Object.keys(contract)).not.toContain("balance");
      expect(Object.keys(contract)).not.toContain("contractType");
      expect("description" in contract).toBe(false);
      expect("balance" in contract).toBe(false);
      expect("contractType" in contract).toBe(false);
    }
  });

  it("sends a spec-valid query, and a bogus one is rejected", async () => {
    const bad = makeClient(contractsFixture);
    await expect(
      bad.get("/client/clientcontracts", { params: { BogusParam: "oops" } })
    ).rejects.toThrow(SpecValidationError);
  });
});

// ── addClientTool / updateClientTool (D-5, D-6, D-10) ────────────────────────

const createdClientResponse = {
  Client: {
    Id: "c-9",
    FirstName: "Katherine",
    LastName: "Johnson",
    Email: "kj@example.invalid",
  },
};

describe("addClientTool", () => {
  it("sends both Birthday and BirthDate, because the sandbox demands Birthday", async () => {
    const recorder = new RecordingClient(createdClientResponse);

    const result = await addClientTool(
      "Katherine",
      "Johnson",
      "kj@example.invalid",
      "555-0130",
      "1990-08-26",
      "9 Orbit Road",
      "Hampton",
      "VA",
      "23666",
      "US",
      undefined,
      undefined,
      undefined,
      true,
      undefined,
      recorder
    );

    expect(result.success).toBe(true);
    expect(result.client).toEqual({
      id: "c-9",
      firstName: "Katherine",
      lastName: "Johnson",
      email: "kj@example.invalid",
    });

    expect(recorder.posts).toHaveLength(1);
    const [post] = recorder.posts;
    expect(post.url).toBe("/client/addclient");
    // D-5: `Birthday` is not in AddClientRequest, but site -99 rejects a request
    // without it. `BirthDate` (the schema field) is sent as well.
    expect(post.body.Birthday).toBe("1990-08-26");
    expect(post.body.BirthDate).toBe("1990-08-26");
    expect(post.body.Street).toBe("9 Orbit Road");
    expect(post.body.MobileNumber).toBe("555-0130");
    expect(post.body.MobilePhone).toBe("555-0130");
    expect(post.body.FirstName).toBe("Katherine");
    expect(post.body.LastName).toBe("Johnson");
  });

  it("sends no Test flag, so the call always commits", async () => {
    // D-10: the endpoint answers "Test mode is not allowed for this endpoint"
    // even though `AddClientRequest.Test` is documented.
    const recorder = new RecordingClient(createdClientResponse);
    await addClientTool("Katherine", "Johnson", undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, true, undefined, recorder);

    const [post] = recorder.posts;
    expect("Test" in post.body).toBe(false);
    expect(Object.keys(post.body)).not.toContain("Test");
    expect(post.body.Test).toBeUndefined();
    // And no cross-regional flag, which only updateclient needs.
    expect("CrossRegionalUpdate" in post.body).toBe(false);
  });
});

describe("updateClientTool", () => {
  it("always sends CrossRegionalUpdate: false", async () => {
    // D-6: a site outside a region is refused unless the flag is explicitly
    // false, and the spec documents no default.
    const recorder = new RecordingClient(createdClientResponse);

    const result = await updateClientTool("c-9", { firstName: "Grace B" }, recorder);

    expect(result.success).toBe(true);
    expect(recorder.posts).toHaveLength(1);
    const [post] = recorder.posts;
    expect(post.url).toBe("/client/updateclient");
    expect(post.body.CrossRegionalUpdate).toBe(false);
    // UpdateClientRequest requires the fields nested under `Client`.
    expect(post.body.Client).toEqual({ Id: "c-9", FirstName: "Grace B" });
    expect(Object.keys(post.body).sort()).toEqual(["Client", "CrossRegionalUpdate"]);
  });
});
// ── getClientCompleteInfoTool ────────────────────────────────────────────────

/**
 * Serves each GET from the fixture for its path and records every call, so a
 * test can assert both what was requested and how many requests were made.
 */
class RoutedClient implements IMindbodyClient {
  readonly gets: Array<{ url: string; params?: Record<string, unknown> }> = [];

  constructor(private readonly routes: Record<string, unknown>) {}

  async request<T>(): Promise<T> {
    throw new Error("RoutedClient: request() is not used by these tools");
  }

  async get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    this.gets.push({ url, params: config?.params });
    const path = Object.keys(this.routes).find((p) => url.endsWith(p));
    if (path === undefined) throw new Error(`RoutedClient: no route for ${url}`);
    return makeClient(this.routes[path]).get<T>(url, config);
  }

  async post<T>(): Promise<T> {
    throw new Error("RoutedClient: post() is not used by these tools");
  }
}

const completeInfoFixture = {
  Client: {
    Id: "c-1",
    FirstName: "Grace",
    LastName: "Hopper",
    AccountBalance: -42.5,
    // Not part of the wallet the tool reports.
    Email: "grace@example.com",
  },
  ClientServices: [
    {
      Id: 7001,
      ProductId: 55,
      Name: "10 Class Pack",
      Count: 10,
      Remaining: 6,
      Current: true,
      ActiveDate: "2026-02-01T00:00:00",
      ExpirationDate: "2026-08-01T00:00:00",
      PaymentDate: "2026-02-01T00:00:00",
      Program: { Id: 3, Name: "Yoga", ScheduleType: "Class" },
      SiteId: 1,
      ActivationType: "OnFirstVisit",
      CannotPayForClassesBeforeActivation: false,
      Action: "Sold",
    },
  ],
  ClientContracts: [
    {
      Id: 9001,
      ContractID: 12,
      ContractName: "Unlimited Monthly",
      AgreementDate: "2026-02-01T00:00:00",
      StartDate: "2026-02-01T00:00:00",
      AutopayStatus: "Active",
      AutoRenewing: true,
      IsMonthToMonth: true,
      SiteId: 1,
    },
  ],
  ClientMemberships: [
    {
      Id: 3001,
      Name: "Unlimited Month",
      Remaining: 8,
      ActiveDate: "2026-02-01",
      ExpirationDate: "2026-03-01",
      Program: { Id: 3, Name: "Yoga", ScheduleType: "Class" },
      SiteId: 1,
      IconCode: "4",
    },
  ],
  ClientArrivals: [
    {
      ArrivalProgramID: 21,
      ArrivalProgramName: "Front Desk",
      CanAccess: true,
      LocationsIDs: [1, 99],
    },
  ],
};

const locationsFixture = { Locations: [{ Id: 1, Name: "Main Studio" }] };

describe("getClientCompleteInfoTool", () => {
  it("maps all five collections from a single request", async () => {
    const client = new RoutedClient({
      "/client/clientcompleteinfo": completeInfoFixture,
      "/site/locations": locationsFixture,
    });
    const result = await getClientCompleteInfoTool("c-1", client, emptyCache());

    expect(result.client).toEqual({
      id: "c-1",
      firstName: "Grace",
      lastName: "Hopper",
      accountBalance: -42.5,
    });
    expect(result.services).toEqual([
      {
        id: 7001,
        productId: 55,
        name: "10 Class Pack",
        count: 10,
        remaining: 6,
        current: true,
        activeDate: "2026-02-01T00:00:00",
        expirationDate: "2026-08-01T00:00:00",
        paymentDate: "2026-02-01T00:00:00",
        programName: "Yoga",
        programId: 3,
        siteId: 1,
        activationType: "OnFirstVisit",
        cannotPayForClassesBeforeActivation: false,
      },
    ]);
    expect(result.contracts).toEqual([
      {
        id: 9001,
        contractId: 12,
        name: "Unlimited Monthly",
        soldDate: "2026-02-01T00:00:00",
        startDate: "2026-02-01T00:00:00",
        endDate: undefined,
        autopayStatus: "Active",
        autoRenewing: true,
        isMonthToMonth: true,
        terminationDate: undefined,
        siteId: 1,
      },
    ]);
    expect(result.memberships).toEqual([
      {
        id: 3001,
        name: "Unlimited Month",
        remainingClasses: 8,
        activeDate: "2026-02-01",
        expirationDate: "2026-03-01",
        paymentDate: undefined,
        programName: "Yoga",
        programId: 3,
        siteId: 1,
        iconCode: "4",
        action: undefined,
      },
    ]);
    expect(result.arrivals).toEqual([
      {
        arrivalProgramId: 21,
        arrivalProgramName: "Front Desk",
        canAccess: true,
        locations: [{ id: 1, name: "Main Studio" }, { id: 99, name: undefined }],
      },
    ]);

    // The wallet is one request. The only other call is the location catalogue.
    expect(client.gets.filter((g) => g.url.endsWith("/client/clientcompleteinfo"))).toHaveLength(1);
  });

  it("sends only ClientId, so requiredClientData and the date filters are left to the API", async () => {
    const client = new RoutedClient({ "/client/clientcompleteinfo": {} });
    await getClientCompleteInfoTool("c-1", client, emptyCache());

    expect(client.gets).toHaveLength(1);
    expect(client.gets[0].params).toEqual({ ClientId: "c-1" });
  });

  it("leaves accountBalance undefined rather than coercing a missing value to 0", async () => {
    const client = new RoutedClient({
      "/client/clientcompleteinfo": { Client: { Id: "c-1", FirstName: "Grace", LastName: "Hopper" } },
    });
    const result = await getClientCompleteInfoTool("c-1", client, emptyCache());

    expect(result.client?.accountBalance).toBeUndefined();
    expect("accountBalance" in (result.client ?? {})).toBe(true);
  });

  it("returns empty collections, and no catalogue read, when the client holds nothing", async () => {
    const client = new RoutedClient({
      "/client/clientcompleteinfo": {
        Client: { Id: "c-2", FirstName: "Ada", LastName: "Lovelace", AccountBalance: 0 },
        ClientServices: [],
        ClientContracts: [],
        ClientMemberships: [],
        ClientArrivals: [],
      },
    });
    const result = await getClientCompleteInfoTool("c-2", client, emptyCache());

    expect(result.services).toEqual([]);
    expect(result.contracts).toEqual([]);
    expect(result.memberships).toEqual([]);
    expect(result.arrivals).toEqual([]);
    expect(result.client?.accountBalance).toBe(0);
    expect(client.gets).toHaveLength(1);
  });

  it("returns no client when the response carries none, and empty collections when the keys are absent", async () => {
    const client = new RoutedClient({ "/client/clientcompleteinfo": {} });
    const result = await getClientCompleteInfoTool("c-1", client, emptyCache());

    expect(result).toEqual({ client: undefined, services: [], contracts: [], memberships: [], arrivals: [] });
  });
});
