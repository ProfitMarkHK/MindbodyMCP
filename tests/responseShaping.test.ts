/**
 * Response shaping for getClassesTool and getTeacherScheduleTool (issue #3).
 *
 * Each test injects a SpecValidatingClient serving a fixture and asserts on the
 * shaped output only. No network. Teacher-name matching is covered separately
 * (tests/teacherSchedule.test.ts); this file covers what the tools compute from
 * the classes once they are fetched.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { SpecValidatingClient } from "./spec-validating-client.js";
import { getClassesTool } from "../src/tools/classManagement.js";
import { getTeacherScheduleTool } from "../src/tools/teacherSchedule.js";
import { SimpleCache } from "../src/cache/index.js";
import { getDateOnly } from "../src/utils/dates.js";

const spec = JSON.parse(readFileSync(resolve(__dirname, "../docs/openapi.json"), "utf-8"));

const makeClient = (fixture: unknown) => new SpecValidatingClient(spec, fixture);
const emptyCache = () => new SimpleCache(5);

function cls(overrides: Record<string, unknown>) {
  return {
    Id: 1,
    ClassScheduleId: 7001,
    ClassDescription: { Name: "Vinyasa Flow", Description: "A dynamic class" },
    Staff: { Id: 301, Name: "Jane Doe", FirstName: "Jane", LastName: "Doe" },
    StartDateTime: "2025-06-02T09:00:00",
    EndDateTime: "2025-06-02T10:00:00",
    Location: { Id: 1, Name: "Main Studio" },
    MaxCapacity: 20,
    TotalBooked: 5,
    IsWaitlistAvailable: false,
    IsCanceled: false,
    Substitute: false,
    ...overrides,
  };
}

// ── getClassesTool ───────────────────────────────────────────────────────────

const multiClassFixture = {
  Classes: [
    cls({ Id: 1, MaxCapacity: 20, TotalBooked: 5 }),
    cls({
      Id: 2,
      ClassDescription: { Name: "Hatha", Description: "Gentle" },
      Location: { Id: 2, Name: "Downtown" },
      MaxCapacity: 12,
      TotalBooked: 12,
    }),
    cls({
      Id: 3,
      ClassDescription: { Name: "Hatha", Description: "Gentle" },
      // No Name: the instructor falls back to "FirstName LastName".
      Staff: { Id: 302, FirstName: "Sam", LastName: "Lee" },
      MaxCapacity: 15,
      TotalBooked: 3,
    }),
    // Cancelled: listed, but excluded from every summary.
    cls({
      Id: 4,
      Staff: { Id: 302, Name: "Sam Lee", FirstName: "Sam", LastName: "Lee" },
      Location: { Id: 2, Name: "Downtown" },
      MaxCapacity: 30,
      TotalBooked: 0,
      IsCanceled: true,
    }),
  ],
};

function getClasses(fixture: unknown) {
  return getClassesTool(
    "2025-06-01", "2025-06-07", undefined, undefined, undefined,
    makeClient(fixture), emptyCache()
  );
}

describe("getClassesTool — spotsAvailable", () => {
  it("is MaxCapacity minus TotalBooked, with totalSpots = MaxCapacity", async () => {
    const { classes } = await getClasses(multiClassFixture);
    expect(classes.map((c) => [c.id, c.spotsAvailable, c.totalSpots])).toEqual([
      [1, 15, 20],
      [2, 0, 12],
      [3, 12, 15],
      [4, 30, 30],
    ]);
  });
});

describe("getClassesTool — summary", () => {
  it("aggregates non-cancelled classes by instructor, location and class type", async () => {
    const { summary } = await getClasses(multiClassFixture);
    expect(summary.totalClasses).toBe(3);
    expect(summary.byInstructor).toEqual({ "Jane Doe": 2, "Sam Lee": 1 });
    expect(summary.byLocation).toEqual({ "Main Studio": 2, Downtown: 1 });
    expect(summary.byClassType).toEqual({ "Vinyasa Flow": 1, Hatha: 2 });
  });

  it("sums totalAvailableSpots over non-cancelled classes only", async () => {
    const { summary } = await getClasses(multiClassFixture);
    // 15 + 0 + 12; the cancelled class's 30 open spots do not count.
    expect(summary.totalAvailableSpots).toBe(27);
  });

  it("reports zeros and empty maps for no classes", async () => {
    const { classes, summary } = await getClasses({ Classes: [] });
    expect(classes).toEqual([]);
    expect(summary).toEqual({
      totalClasses: 0,
      totalAvailableSpots: 0,
      byInstructor: {},
      byLocation: {},
      byClassType: {},
    });
  });
});

// ── getTeacherScheduleTool ───────────────────────────────────────────────────

const teacher = { Id: 301, Name: "Jane Doe", FirstName: "Jane", LastName: "Doe", Email: "jane@example.invalid" };

// Deliberately out of order across three dates, as the API may return them.
const scheduleFixture = {
  StaffMembers: [teacher],
  Classes: [
    cls({ Id: 11, StartDateTime: "2025-06-03T18:00:00", EndDateTime: "2025-06-03T19:15:00" }),
    cls({ Id: 12, StartDateTime: "2025-06-02T17:30:00", EndDateTime: "2025-06-02T18:30:00", Substitute: true }),
    cls({ Id: 13, StartDateTime: "2025-06-03T07:00:00", EndDateTime: "2025-06-03T07:45:00" }),
    cls({ Id: 14, StartDateTime: "2025-06-02T06:15:00", EndDateTime: "2025-06-02T07:45:00" }),
    cls({ Id: 15, StartDateTime: "2025-06-04T12:00:00", EndDateTime: "2025-06-04T12:30:00" }),
    cls({ Id: 16, StartDateTime: "2025-06-03T12:00:00", EndDateTime: "2025-06-03T13:00:00" }),
  ],
};

function getSchedule(fixture: unknown) {
  return getTeacherScheduleTool(
    "Jane Doe", "2025-06-01", "2025-06-07",
    makeClient(fixture), emptyCache(), emptyCache()
  );
}

describe("getTeacherScheduleTool — grouping by date and ordering", () => {
  it("returns classes date by date, each date's classes in start-time order", async () => {
    const { classes } = await getSchedule(scheduleFixture);
    expect(classes.map((c) => c.id)).toEqual([14, 12, 13, 16, 11, 15]);

    // Each date forms one contiguous run, in date order.
    const runs: string[] = [];
    for (const c of classes) {
      const date = getDateOnly(c.startTime);
      if (runs[runs.length - 1] !== date) runs.push(date);
    }
    expect(runs).toEqual(["2025-06-02", "2025-06-03", "2025-06-04"]);
  });

  it("counts non-cancelled classes per weekday in summary.byDay", async () => {
    const fixture = {
      ...scheduleFixture,
      Classes: [
        ...scheduleFixture.Classes,
        cls({ Id: 17, StartDateTime: "2025-06-04T15:00:00", EndDateTime: "2025-06-04T16:00:00", IsCanceled: true }),
      ],
    };
    const { summary, totalClasses } = await getSchedule(fixture);
    // 2025-06-02 is a Monday.
    expect(summary.byDay).toEqual({ Monday: 2, Tuesday: 3, Wednesday: 1 });
    expect(totalClasses).toBe(6);
  });
});

describe("getTeacherScheduleTool — duration", () => {
  it("is the class length in whole minutes", async () => {
    const { classes } = await getSchedule(scheduleFixture);
    const byId = Object.fromEntries(classes.map((c) => [c.id, c.duration]));
    expect(byId).toEqual({ 11: 75, 12: 60, 13: 45, 14: 90, 15: 30, 16: 60 });
  });

  describe("does not depend on the host timezone", () => {
    const originalTz = process.env.TZ;
    afterEach(() => {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    });

    // Mindbody times are site-local wall time. 2026-03-08 02:00 does not exist
    // in America/New_York, so parsing in the host zone made this 120-minute
    // class read as 60 minutes on a New York host.
    it.each(["UTC", "America/New_York", "Asia/Hong_Kong"])("host TZ %s", async (tz) => {
      process.env.TZ = tz;
      const { classes } = await getSchedule({
        StaffMembers: [teacher],
        Classes: [cls({ Id: 21, StartDateTime: "2026-03-08T01:30:00", EndDateTime: "2026-03-08T03:30:00" })],
      });
      expect(classes[0].duration).toBe(120);
    });
  });
});

describe("getTeacherScheduleTool — substitute flag", () => {
  it("sets substitute from Class.Substitute on each class", async () => {
    const { classes } = await getSchedule(scheduleFixture);
    const subs = classes.filter((c) => c.substitute).map((c) => c.id);
    expect(subs).toEqual([12]);
    expect(classes.every((c) => typeof c.substitute === "boolean")).toBe(true);
  });
});
