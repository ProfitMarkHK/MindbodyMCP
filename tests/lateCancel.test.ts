import { describe, expect, it } from "bun:test";
import {
  LATE_CANCEL_RULES_ENV,
  LATE_CANCEL_WINDOW_ENV,
  LATE_CANCEL_WINDOW_UNKNOWN,
  classLateCancelContext,
  lateCancelConfig,
  lateCancelConfigRefusal,
  lateCancelRefusalFor,
  lateCancelWindowRefusal,
  resolveLateCancelWindow,
  type LateCancelConfig,
} from "../src/utils/lateCancel.js";

const HOUR_MS = 3_600_000;
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const ISSUE_RULES = JSON.stringify([{ serviceId: 10, hours: 2 }, { programId: 3, hours: 24 }]);

function configOf(env: Record<string, string>): LateCancelConfig {
  const loaded = lateCancelConfig(env);
  if (!("config" in loaded)) throw new Error(loaded.error);
  return loaded.config;
}

describe("late-cancel windows: no rules configured (unchanged behaviour)", () => {
  it("allows inside and refuses outside the default window with the original text, byte for byte", () => {
    const config = configOf({ [LATE_CANCEL_WINDOW_ENV]: "24" });
    expect(config).toEqual({ rules: [], defaultHours: 24 });
    expect(lateCancelConfigRefusal({ config })).toBeNull();
    expect(lateCancelRefusalFor({ serviceId: 10 }, config, NOW + 10 * HOUR_MS, NOW)).toBeNull();
    expect(lateCancelRefusalFor({}, config, NOW + 30 * HOUR_MS, NOW)).toBe(
      "late cancel refused: it starts more than 24 hour(s) from now, outside the site's late-cancel window; cancel without lateCancel"
    );
    // The two-argument form callers used before rules existed gives the same text.
    expect(lateCancelWindowRefusal(NOW + 30 * HOUR_MS, NOW, 24)).toBe(lateCancelRefusalFor({}, config, NOW + 30 * HOUR_MS, NOW));
  });

  it("treats an empty rules variable as no rules", () => {
    expect(configOf({ [LATE_CANCEL_WINDOW_ENV]: "24", [LATE_CANCEL_RULES_ENV]: "  " })).toEqual({ rules: [], defaultHours: 24 });
  });

  it("refuses before any lookup with the original message when neither variable is set", () => {
    expect(lateCancelConfigRefusal(lateCancelConfig({}))).toBe(LATE_CANCEL_WINDOW_UNKNOWN);
  });
});

describe("late-cancel windows: rules", () => {
  const config = configOf({ [LATE_CANCEL_WINDOW_ENV]: "24", [LATE_CANCEL_RULES_ENV]: ISSUE_RULES });

  it("refuses ServiceId 10 at 10 hours out as outside its 2-hour window, naming the rule", () => {
    const refusal = lateCancelRefusalFor({ serviceId: 10, programId: 3 }, config, NOW + 10 * HOUR_MS, NOW);
    expect(refusal).toContain("more than 2 hour(s)");
    expect(refusal).toContain(`${LATE_CANCEL_RULES_ENV}[0] (serviceId 10)`);
  });

  it("allows ProgramId 3 at 10 hours out under its 24-hour rule", () => {
    expect(lateCancelRefusalFor({ serviceId: 11, programId: 3 }, config, NOW + 10 * HOUR_MS, NOW)).toBeNull();
    expect(resolveLateCancelWindow({ serviceId: 11, programId: 3 }, config)).toEqual({
      window: { hours: 24, source: `${LATE_CANCEL_RULES_ENV}[1] (programId 3)` },
    });
  });

  it("falls back to the default window when no rule matches", () => {
    expect(resolveLateCancelWindow({ serviceId: 11, programId: 4 }, config)).toEqual({
      window: { hours: 24, source: LATE_CANCEL_WINDOW_ENV },
    });
  });

  it("refuses a booking that matches no rule when there is no default, naming the variables", () => {
    const noDefault = configOf({ [LATE_CANCEL_RULES_ENV]: ISSUE_RULES });
    expect(lateCancelConfigRefusal({ config: noDefault })).toBeNull();
    const resolved = resolveLateCancelWindow({ serviceId: 11, programId: 4 }, noDefault);
    expect("refusal" in resolved && resolved.unmatched).toBe(true);
    const refusal = (resolved as { refusal: string }).refusal;
    expect(refusal).toContain(LATE_CANCEL_WINDOW_ENV);
    expect(refusal).toContain(LATE_CANCEL_RULES_ENV);
  });

  it("refuses when an earlier rule needs an id the booking did not reveal, rather than skipping it", () => {
    const resolved = resolveLateCancelWindow({ programId: 3 }, config);
    expect(resolved).toEqual({
      refusal: expect.stringContaining(`cannot tell whether ${LATE_CANCEL_RULES_ENV}[0] (serviceId 10) applies`),
    });
  });

  it("skips a rule whose known id differs even when its other id is unknown", () => {
    const both = configOf({
      [LATE_CANCEL_WINDOW_ENV]: "24",
      [LATE_CANCEL_RULES_ENV]: JSON.stringify([{ serviceId: 10, programId: 3, hours: 2 }]),
    });
    expect(resolveLateCancelWindow({ programId: 4 }, both)).toEqual({ window: { hours: 24, source: LATE_CANCEL_WINDOW_ENV } });
  });

  it("needs every id a rule names, and first match wins", () => {
    const ordered = configOf({
      [LATE_CANCEL_RULES_ENV]: JSON.stringify([
        { programId: 3, sessionTypeId: 7, hours: 1 },
        { programId: 3, hours: 12 },
        { programId: 3, hours: 99 },
      ]),
    });
    expect(resolveLateCancelWindow({ programId: 3, sessionTypeId: 8 }, ordered)).toEqual({
      window: { hours: 12, source: `${LATE_CANCEL_RULES_ENV}[1] (programId 3)` },
    });
    expect(resolveLateCancelWindow({ programId: 3, sessionTypeId: 7 }, ordered)).toEqual({
      window: { hours: 1, source: `${LATE_CANCEL_RULES_ENV}[0] (programId 3, sessionTypeId 7)` },
    });
  });
});

describe("late-cancel windows: invalid rules fail closed, naming the entry", () => {
  const cases: Array<[string, string, string]> = [
    ["invalid JSON", "[{serviceId: 10, hours: 2}]", "not valid JSON"],
    ["not an array", '{"serviceId":10,"hours":2}', "must be a JSON array"],
    ["a non-object entry", "[5]", "rule 0 5 is not an object"],
    ["negative hours", '[{"programId":3,"hours":24},{"serviceId":10,"hours":-2}]', 'rule 1 {"serviceId":10,"hours":-2} needs "hours"'],
    ["zero hours", '[{"serviceId":10,"hours":0}]', 'needs "hours"'],
    ["string hours", '[{"serviceId":10,"hours":"2"}]', 'needs "hours"'],
    ["a non-numeric id", '[{"serviceId":"ten","hours":2}]', 'rule 0 {"serviceId":"ten","hours":2} needs "serviceId" as a positive integer'],
    ["a fractional id", '[{"programId":3.5,"hours":2}]', 'needs "programId"'],
    ["a misspelt key", '[{"serviceID":10,"hours":2}]', 'unknown key "serviceID"'],
    ["no id at all", '[{"hours":2}]', "names no serviceId, programId, sessionTypeId"],
  ];
  for (const [name, raw, fragment] of cases) {
    it(`refuses every lateCancel for ${name}, even with a default set`, () => {
      const loaded = lateCancelConfig({ [LATE_CANCEL_WINDOW_ENV]: "24", [LATE_CANCEL_RULES_ENV]: raw });
      expect("error" in loaded).toBe(true);
      const refusal = lateCancelConfigRefusal(loaded)!;
      expect(refusal).toContain(LATE_CANCEL_RULES_ENV);
      expect(refusal).toContain(fragment);
    });
  }
});

describe("classLateCancelContext", () => {
  it("reads program and session type from the class and the pricing option (ProductId, not ServiceId) from the visit", () => {
    const cls = { ClassDescription: { Program: { Id: 3 }, SessionType: { Id: 7 } } };
    expect(classLateCancelContext(cls, { ServiceId: 9001, ProductId: 10 })).toEqual({ serviceId: 10, programId: 3, sessionTypeId: 7 });
    expect(classLateCancelContext(cls)).toEqual({ serviceId: undefined, programId: 3, sessionTypeId: 7 });
    expect(classLateCancelContext({}, { ProductId: 0 })).toEqual({ serviceId: undefined, programId: undefined, sessionTypeId: undefined });
  });
});
