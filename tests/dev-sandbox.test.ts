/**
 * Sandbox launcher mapping (scripts/dev-sandbox.ts).
 *
 * The launcher gets its credentials from 1Password (via `op run`), never from a file. It must
 * reach only the sandbox: it always uses site -99, refuses an incoming MINDBODY_SITE_ID that
 * names another site (the signature of production references left in the shell), and refuses
 * to start without credentials.
 */
import { describe, expect, it } from "bun:test";
import { sandboxEnv } from "../scripts/dev-sandbox.js";
import { STUB_FIXTURES } from "./support/mindbody-stub.js";

const CREDENTIALS = {
  MINDBODY_API_KEY: STUB_FIXTURES.apiKey,
  MINDBODY_SOURCE_NAME: STUB_FIXTURES.sourceName,
  MINDBODY_SOURCE_PASSWORD: STUB_FIXTURES.sourcePassword,
};

describe("sandboxEnv", () => {
  it("maps the credentials and pins the site to the sandbox", () => {
    expect(sandboxEnv(CREDENTIALS)).toEqual({
      MINDBODY_API_KEY: STUB_FIXTURES.apiKey,
      MINDBODY_SITE_ID: "-99",
      MINDBODY_SOURCE_NAME: STUB_FIXTURES.sourceName,
      MINDBODY_SOURCE_PASSWORD: STUB_FIXTURES.sourcePassword,
      MINDBODY_API_URL: "https://api.mindbodyonline.com/public/v6",
    });
  });

  it("refuses a live site ID instead of silently pinning the sandbox", () => {
    expect(() => sandboxEnv({ ...CREDENTIALS, MINDBODY_SITE_ID: "123456" })).toThrow(
      /not the sandbox \(-99\)/,
    );
  });

  it("accepts an explicit sandbox site ID and an absent one", () => {
    expect(sandboxEnv({ ...CREDENTIALS, MINDBODY_SITE_ID: "-99" }).MINDBODY_SITE_ID).toBe("-99");
    expect(sandboxEnv(CREDENTIALS).MINDBODY_SITE_ID).toBe("-99");
  });

  it("refuses to start without sandbox credentials", () => {
    expect(() => sandboxEnv({ MINDBODY_API_KEY: STUB_FIXTURES.apiKey })).toThrow(/MINDBODY_SOURCE_NAME/);
  });
});
