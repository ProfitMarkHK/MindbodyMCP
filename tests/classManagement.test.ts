import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { SpecValidatingClient, SpecValidationError } from "./spec-validating-client.js";
import {
  getClassesTool,
  getClassDescriptionsTool,
  getClassSchedulesTool,
  getClassVisitsTool,
  getWaitlistEntriesTool,
  addClientToClassTool,
  substituteClassTeacherTool,
} from "../src/tools/classManagement.js";
import { SimpleCache } from "../src/cache/index.js";

const spec = JSON.parse(
  readFileSync(resolve(__dirname, "../docs/openapi.json"), "utf-8")
);

function makeClient(fixture: unknown) {
  return new SpecValidatingClient(spec, fixture);
}

function emptyCache() {
  return new SimpleCache(5);
}

// ── Spec-shaped fixtures ─────────────────────────────────────────────────────
// Every field below is a field docs/openapi.json actually defines on the model
// in question; no phantom keys. Catalogue keys are present so the id→name
// lookups in src/tools/lookups.ts resolve.

// C-6: `Class.Substitute`, never `IsSubstitute`.
const classFixture = {
  Classes: [
    {
      Id: 1,
      ClassScheduleId: 7001,
      ClassDescription: { Name: "Vinyasa Flow", Description: "A dynamic class" },
      Staff: { Name: "Jane Doe", FirstName: "Jane", LastName: "Doe" },
      StartDateTime: "2025-06-01T09:00:00",
      EndDateTime: "2025-06-01T10:00:00",
      Location: { Id: 1, Name: "Main Studio" },
      MaxCapacity: 20,
      TotalBooked: 5,
      IsWaitlistAvailable: true,
      IsCanceled: false,
      Substitute: true,
    },
  ],
};

// C-7: `ClassDescription.ImageURL`, never `ImageUrl`.
const classDescriptionFixture = {
  ClassDescriptions: [
    {
      Id: 10,
      Name: "Hot Yoga",
      Description: "Heated room",
      ImageURL: "https://example.invalid/hot.png",
      Prereq: "None",
      Level: { Name: "All Levels" },
    },
  ],
};

// C-8: `AddClientToClassResponse` has only `Visit`.
const addClientToClassFixture = {
  Visit: { Id: 9001, ClassId: 1, ClientId: "c1", ServiceId: null },
};

// C-9: the real `WaitlistEntry` shape — nested `Client` and `ClassSchedule`,
// `RequestDateTime`/`EnrollmentDateForward`, and no position field.
const waitlistFixture = {
  WaitlistEntries: [
    {
      Id: 8001,
      ClassId: 1,
      ClassDate: "2025-06-01T09:00:00",
      ClassSchedule: { Id: 7001, ClassDescription: { Name: "Vinyasa Flow" } },
      Client: { Id: "c1", FirstName: "Bob", LastName: "Smith" },
      EnrollmentDateForward: "2025-05-01T00:00:00",
      RequestDateTime: "2025-05-02T00:00:00",
      VisitRefNo: 0,
      Web: false,
    },
  ],
};

// C-11: `SubstituteTeacherClass` has `Staff` and a boolean `Substitute`; no
// `SubstituteTeacher` object.
const substituteFixture = {
  Class: {
    Id: 1,
    ClassDescription: { Name: "Vinyasa Flow" },
    Staff: { Id: 301, Name: "Sam Replacement", FirstName: "Sam", LastName: "Replacement" },
    Substitute: true,
    StartDateTime: "2025-06-01T09:00:00",
  },
};

// C-12: seven `Day*` booleans and `IsAvailable`.
const classScheduleFixture = {
  ClassSchedules: [
    {
      Id: 5,
      ClassDescription: { Name: "Pilates" },
      Staff: { Name: "Alice" },
      Location: { Name: "Downtown" },
      DaySunday: false,
      DayMonday: true,
      DayTuesday: false,
      DayWednesday: false,
      DayThursday: false,
      DayFriday: false,
      DaySaturday: true,
      IsAvailable: true,
      StartTime: "08:00",
      EndTime: "09:00",
      StartDate: "2025-01-01",
      EndDate: null,
    },
  ],
};

// C-13: a `Visit` carries ids only. `Locations` backs the name lookup.
const classVisitsFixture = {
  Locations: [{ Id: 1, Name: "Uptown" }],
  Class: {
    Id: 42,
    ClassDescription: { Name: "Barre" },
    Staff: { DisplayName: "Sarah" },
    StartDateTime: "2025-06-01T10:00:00",
    EndDateTime: "2025-06-01T11:00:00",
    Location: { Id: 1, Name: "Uptown" },
    Visits: [
      {
        Id: 100,
        ClassId: 42,
        ClientId: "c1",
        ClientUniqueId: 55,
        LocationId: 1,
        StaffId: 301,
        ServiceId: 4001,
        ServiceName: "Drop-in",
        StartDateTime: "2025-06-01T10:00:00",
        EndDateTime: "2025-06-01T11:00:00",
        SignedIn: true,
        WebSignup: false,
        MakeUp: false,
        LateCancelled: false,
      },
    ],
  },
};

// ── C-6: getClasses ──────────────────────────────────────────────────────────

describe("getClassesTool — C-6 Substitute field", () => {
  it("maps Class.Substitute onto `substitute`, not `isSubstitute`", async () => {
    const result = await getClassesTool(
      "2025-06-01", "2025-06-07", undefined, undefined, undefined,
      makeClient(classFixture), emptyCache()
    );
    expect(result.classes).toHaveLength(1);
    expect(result.classes[0].substitute).toBe(true);
    expect("isSubstitute" in result.classes[0]).toBe(false);
  });

  it("reads false when Substitute is false", async () => {
    const result = await getClassesTool(
      "2025-06-01", "2025-06-07", undefined, undefined, undefined,
      makeClient({ Classes: [{ ...classFixture.Classes[0], Substitute: false }] }),
      emptyCache()
    );
    expect(result.classes[0].substitute).toBe(false);
  });

  it("passes validation with valid parameters", async () => {
    const client = makeClient(classFixture);
    const result = await getClassesTool(
      "2025-06-01", "2025-06-07", undefined, undefined, undefined,
      client, emptyCache()
    );
    expect(result.classes[0].name).toBe("Vinyasa Flow");
  });

  it("rejects an unrecognised query parameter at the client boundary", async () => {
    await expect(
      makeClient(classFixture).get("/class/classes", { params: { BogusParam: "oops" } })
    ).rejects.toThrow(SpecValidationError);
  });
});

// ── C-7: getClassDescriptions ────────────────────────────────────────────────

describe("getClassDescriptionsTool — C-7 ImageURL field", () => {
  it("reads ImageURL (not ImageUrl) into imageUrl", async () => {
    const result = await getClassDescriptionsTool(makeClient(classDescriptionFixture), emptyCache());
    expect(result.classTypes).toHaveLength(1);
    expect(result.classTypes[0].imageUrl).toBe("https://example.invalid/hot.png");
  });
});

// ── C-8: addClientToClass ────────────────────────────────────────────────────

describe("addClientToClassTool — C-8 response carries only Visit", () => {
  it("returns visitId and serviceId and drops the phantom payment fields", async () => {
    const result = await addClientToClassTool(
      "c1", 1, false, false, makeClient(addClientToClassFixture), emptyCache()
    );
    expect(result.success).toBe(true);
    expect(result.visitId).toBe(9001);
    // `ServiceId: null` on the Visit is the "no service was charged" signal; the
    // tool normalises null to undefined so the field is simply absent.
    expect(result.serviceId).toBeUndefined();
    expect("requiresPayment" in result).toBe(false);
    expect("amountDue" in result).toBe(false);
  });

  it("reports serviceId when the visit carries one", async () => {
    const result = await addClientToClassTool(
      "c1", 1, false, false,
      makeClient({ Visit: { ...addClientToClassFixture.Visit, ServiceId: 4001 } }),
      emptyCache()
    );
    expect(result.serviceId).toBe(4001);
  });

  it("reports success:false when the endpoint throws", async () => {
    const throwing = {
      post: async () => { throw new Error("class full"); },
    } as any;
    const result = await addClientToClassTool("c1", 1, false, false, throwing, emptyCache());
    expect(result.success).toBe(false);
    expect(result.message).toBe("class full");
  });
});

// ── C-9 and C-10: getWaitlistEntries ─────────────────────────────────────────

describe("getWaitlistEntriesTool — C-9 nested shape, C-10 filter required", () => {
  it("maps the nested ClassSchedule/Client shape onto className/clientId/clientName", async () => {
    const result = await getWaitlistEntriesTool([7001], undefined, undefined, makeClient(waitlistFixture));
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];
    expect(entry.id).toBe(8001);
    expect(entry.className).toBe("Vinyasa Flow");
    expect(entry.clientId).toBe("c1");
    expect(entry.clientName).toBe("Bob Smith");
    expect(entry.requestDatetime).toBe("2025-05-02T00:00:00");
    expect(entry.enrollmentDateForward).toBe("2025-05-01T00:00:00");
    expect(entry.classDate).toBe("2025-06-01T09:00:00");
  });

  it("drops the phantom position field", async () => {
    const result = await getWaitlistEntriesTool([7001], undefined, undefined, makeClient(waitlistFixture));
    expect("position" in result.entries[0]).toBe(false);
  });

  it("refuses a call with no filter rather than sending one the endpoint rejects", async () => {
    await expect(getWaitlistEntriesTool(undefined, undefined, undefined, makeClient(waitlistFixture)))
      .rejects.toThrow(/at least one filter/);
  });

  it("refuses empty-array filters too", async () => {
    await expect(getWaitlistEntriesTool([], [], [], makeClient(waitlistFixture)))
      .rejects.toThrow(/at least one filter/);
  });

  it("accepts any single filter", async () => {
    const byClass = await getWaitlistEntriesTool(undefined, [1], undefined, makeClient(waitlistFixture));
    expect(byClass.entries).toHaveLength(1);
    const byClient = await getWaitlistEntriesTool(undefined, undefined, ["c1"], makeClient(waitlistFixture));
    expect(byClient.entries).toHaveLength(1);
  });
});

// ── C-11: substituteClassTeacher ─────────────────────────────────────────────

describe("substituteClassTeacherTool — C-11 request body and response shape", () => {
  it("maps Staff and the Substitute boolean; no SubstituteTeacher object", async () => {
    const result = await substituteClassTeacherTool(1, 301, makeClient(substituteFixture), emptyCache());
    expect(result.success).toBe(true);
    expect(result.updatedClass?.teacherName).toBe("Sam Replacement");
    expect(result.updatedClass?.substitute).toBe(true);
    expect("substituteTeacher" in (result.updatedClass ?? {})).toBe(false);
    expect("originalTeacher" in (result.updatedClass ?? {})).toBe(false);
  });
});

// ── C-12: getClassSchedules ──────────────────────────────────────────────────

describe("getClassSchedulesTool — C-12 day flags and IsAvailable", () => {
  it("builds days[] from the seven booleans and maps IsAvailable", async () => {
    const result = await getClassSchedulesTool([1], undefined, undefined, undefined, makeClient(classScheduleFixture));
    expect(result.schedules).toHaveLength(1);
    expect(result.schedules[0].days).toEqual(["Monday", "Saturday"]);
    expect(result.schedules[0].isAvailable).toBe(true);
    expect(result.schedules[0].className).toBe("Pilates");
  });

  it("drops the phantom dayOfWeek/isActive fields", async () => {
    const result = await getClassSchedulesTool(undefined, undefined, undefined, undefined, makeClient(classScheduleFixture));
    expect("dayOfWeek" in result.schedules[0]).toBe(false);
    expect("isActive" in result.schedules[0]).toBe(false);
  });

  it("sends only spec-defined query parameters", async () => {
    await expect(
      makeClient(classScheduleFixture).get("/class/classschedules", { params: { ClassDescriptionIds: [10] } })
    ).rejects.toThrow(SpecValidationError);
    // The documented SessionTypeIds form passes.
    await expect(
      makeClient(classScheduleFixture).get("/class/classschedules", { params: { SessionTypeIds: [10], Limit: 200, Offset: 0 } })
    ).resolves.toBeDefined();
  });
});

// ── C-13: getClassVisits ─────────────────────────────────────────────────────

describe("getClassVisitsTool — C-13 ids only, no client object", () => {
  it("returns client ids, resolves locationName, and drops name fields", async () => {
    const result = await getClassVisitsTool(42, undefined, makeClient(classVisitsFixture), emptyCache());
    expect(result.totalVisits).toBe(1);
    const visit = result.visits[0];
    expect(visit.clientId).toBe("c1");
    expect(visit.clientUniqueId).toBe(55);
    expect(visit.staffId).toBe(301);
    expect(visit.serviceId).toBe(4001);
    expect(visit.locationName).toBe("Uptown");
    expect("clientFirstName" in visit).toBe(false);
    expect("clientLastName" in visit).toBe(false);
    expect("clientEmail" in visit).toBe(false);
    expect("clientPhone" in visit).toBe(false);
  });

  it("leaves locationName undefined when the location is not in the catalogue", async () => {
    const fixture = {
      ...classVisitsFixture,
      Locations: [],
      Class: {
        ...classVisitsFixture.Class,
        Visits: [{ ...classVisitsFixture.Class.Visits[0], LocationId: 999 }],
      },
    };
    const result = await getClassVisitsTool(42, undefined, makeClient(fixture), emptyCache());
    expect(result.visits[0].locationId).toBe(999);
    expect(result.visits[0].locationName).toBeUndefined();
    expect(result.visits[0].locationName).not.toBe("");
  });

  it("still counts signed-in visits in the summary", async () => {
    const result = await getClassVisitsTool(42, undefined, makeClient(classVisitsFixture), emptyCache());
    expect(result.summary.totalSignedIn).toBe(1);
    expect(result.summary.totalNotSignedIn).toBe(0);
    expect(result.summary.totalLateCancels).toBe(0);
  });
});