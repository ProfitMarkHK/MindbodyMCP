import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { SpecValidatingClient } from "./spec-validating-client.js";
import { findTeacherByName } from "../src/tools/teacherSchedule.js";
import { SimpleCache } from "../src/cache/index.js";

const spec = JSON.parse(
  readFileSync(resolve(__dirname, "../docs/openapi.json"), "utf-8")
);

function staff(Id: number, FirstName: string, LastName: string, Name = `${FirstName} ${LastName}`) {
  return { Id, FirstName, LastName, Name };
}

/** Match `name` against this staff list, with a fresh cache so no earlier test leaks in. */
function match(name: string, staffMembers: ReturnType<typeof staff>[]) {
  const client = new SpecValidatingClient(spec, { StaffMembers: staffMembers });
  return findTeacherByName(name, client, new SimpleCache(5));
}

describe("findTeacherByName (issue #4)", () => {
  it("matches a full name to the right staff member", async () => {
    const result = await match("Maria Garcia", [
      staff(1, "Alexia", "Bauer"),
      staff(2, "Maria", "Garcia"),
      staff(3, "Sam", "Lee"),
    ]);
    expect(result?.Id).toBe(2);
  });

  it("matches case-insensitively", async () => {
    // A single-name teacher: Mindbody's Name is just "Alexia".
    const result = await match("ALEXIA", [
      staff(1, "Maria", "Garcia"),
      staff(2, "Alexia", "", "Alexia"),
    ]);
    expect(result?.Id).toBe(2);
  });

  it("matches FirstName + LastName when Name differs", async () => {
    const result = await match("maria garcia", [
      staff(1, "Maria", "Garcia", "Maria G."),
    ]);
    expect(result?.Id).toBe(1);
  });

  it("does not resolve an ambiguous first name to either staff member", async () => {
    const result = await match("Maria", [
      staff(1, "Maria", "Garcia"),
      staff(2, "Maria", "Lopez"),
    ]);
    expect(result).toBeNull();
  });

  it("does not resolve a first name to a staff member whose full name is longer", async () => {
    const result = await match("Maria", [staff(1, "Maria", "Garcia")]);
    expect(result).toBeNull();
  });

  it("returns null when no staff member matches", async () => {
    const result = await match("Nobody Here", [
      staff(1, "Maria", "Garcia"),
      staff(2, "Alexia", "Bauer"),
    ]);
    expect(result).toBeNull();
  });

  it("picks the exact match among similar names", async () => {
    const similar = [
      staff(1, "Mariah", "Garcia"),
      staff(2, "Maria", "Garcia-Lopez"),
      staff(3, "Maria", "Garcia"),
      staff(4, "Maria", "Garcias"),
    ];
    expect((await match("Maria Garcia", similar))?.Id).toBe(3);
    expect((await match("Mariah Garcia", similar))?.Id).toBe(1);
    expect((await match("Maria Garcia-Lopez", similar))?.Id).toBe(2);
  });
});
