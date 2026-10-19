import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mindbodyAuth } from "../src/api/auth.js";

describe("mindbodyAuth.getHeaders — SiteId", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.MINDBODY_SITE_ID;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.MINDBODY_SITE_ID;
    else process.env.MINDBODY_SITE_ID = saved;
  });

  it("sends the configured site id", () => {
    process.env.MINDBODY_SITE_ID = " -99 ";
    expect(mindbodyAuth.getHeaders().SiteId).toBe("-99");
  });

  for (const [label, value] of [["unset", undefined], ["empty", ""], ["blank", "   "]] as const) {
    it(`omits the SiteId header when MINDBODY_SITE_ID is ${label} (never the string "undefined")`, () => {
      if (value === undefined) delete process.env.MINDBODY_SITE_ID;
      else process.env.MINDBODY_SITE_ID = value;
      const headers = mindbodyAuth.getHeaders();
      expect("SiteId" in headers).toBe(false);
      expect(Object.values(headers)).not.toContain("undefined");
    });
  }
});
