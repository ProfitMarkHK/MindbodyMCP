/**
 * Sandbox launcher mapping (scripts/dev-sandbox.ts).
 *
 * The launcher must reach only the sandbox: it maps MINDBODY_TEST_* values, ignores
 * any MINDBODY_* key, and refuses to start for a non-sandbox site or missing credentials.
 */
import { describe, expect, it } from "bun:test";
import { sandboxEnv } from "../scripts/dev-sandbox.js";
import { STUB_FIXTURES } from "./support/mindbody-stub.js";

const TEST_VALUES = {
  MINDBODY_TEST_API_KEY: STUB_FIXTURES.apiKey,
  MINDBODY_TEST_SOURCE_NAME: STUB_FIXTURES.sourceName,
  MINDBODY_TEST_SOURCE_PASSWORD: STUB_FIXTURES.sourcePassword,
};

describe("sandboxEnv", () => {
  it("maps MINDBODY_TEST_* and ignores a naked MINDBODY_* key", () => {
    const env = sandboxEnv({ ...TEST_VALUES, MINDBODY_API_KEY: "unused", MINDBODY_SITE_ID: "123456" });

    expect(env).toEqual({
      MINDBODY_API_KEY: STUB_FIXTURES.apiKey,
      MINDBODY_SITE_ID: "-99",
      MINDBODY_SOURCE_NAME: STUB_FIXTURES.sourceName,
      MINDBODY_SOURCE_PASSWORD: STUB_FIXTURES.sourcePassword,
      MINDBODY_API_URL: "https://api.mindbodyonline.com/public/v6",
    });
  });

  it("refuses a non-sandbox site", () => {
    expect(() => sandboxEnv({ ...TEST_VALUES, MINDBODY_TEST_SITE_ID: "123456" })).toThrow(/refusing to start/);
  });

  it("refuses to start without sandbox credentials", () => {
    expect(() => sandboxEnv({ MINDBODY_TEST_API_KEY: STUB_FIXTURES.apiKey })).toThrow(/MINDBODY_TEST_SOURCE_NAME/);
  });
});
