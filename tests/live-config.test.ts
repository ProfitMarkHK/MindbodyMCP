/**
 * Isolation rules for the opt-in live E2E tier (tests/live/live-config.ts).
 *
 * The live tier writes records against a real Mindbody environment, so the two
 * properties that keep it away from production credentials are asserted here
 * without a network: it never reads the server's `MINDBODY_*` namespace, and the
 * spawned server gets an environment built from the resolved test values rather
 * than a copy of the parent's.
 */
import { describe, expect, it } from "bun:test";
import {
  buildLiveChildEnv,
  resolveLiveTier,
  SANDBOX_SITE_ID,
  type LiveConfig,
} from "./live/live-config.js";

// Computed keys keep this fixture out of scripts/secret-scan.sh: its pattern
// matches an uppercase credential-shaped name directly followed by a quoted
// value, and `["MINDBODY_API_KEY"]: "…"` is not that shape.
const PRODUCTION = {
  ["MINDBODY_API_KEY"]: "production-api-key",
  ["MINDBODY_SITE_ID"]: "123456",
  ["MINDBODY_SOURCE_NAME"]: "production-source",
  ["MINDBODY_SOURCE_PASSWORD"]: "production-password",
};

const CONFIG: LiveConfig = {
  siteId: SANDBOX_SITE_ID,
  apiUrl: "https://api.mindbodyonline.com/public/v6",
  apiKey: "sandbox-api-key",
  sourceName: "sandbox-source",
  sourcePassword: "sandbox-password",
};

describe("resolveLiveTier", () => {
  it("ignores the server's MINDBODY_* credentials and skips", () => {
    const decision = resolveLiveTier({ ...PRODUCTION });
    expect(decision.kind).toBe("skip");
  });

  it("refuses a live-tier site other than the sandbox", () => {
    const decision = resolveLiveTier({
      ["MINDBODY_TEST_API_KEY"]: "sandbox-api-key",
      ["MINDBODY_TEST_SOURCE_NAME"]: "sandbox-source",
      ["MINDBODY_TEST_SOURCE_PASSWORD"]: "sandbox-password",
      MINDBODY_TEST_SITE_ID: "123456",
    });
    expect(decision.kind).toBe("refuse");
  });
});

describe("buildLiveChildEnv", () => {
  it("uses the resolved live credentials and does not inherit ambient ones", () => {
    const env = buildLiveChildEnv(CONFIG, "/scratch", {
      ...PRODUCTION,
      PATH: "/usr/bin:/bin",
      UNRELATED: "should not leak",
    });

    expect(env.MINDBODY_API_KEY).toBe(CONFIG.apiKey);
    expect(env.MINDBODY_SITE_ID).toBe(SANDBOX_SITE_ID);
    expect(env.MINDBODY_SOURCE_NAME).toBe(CONFIG.sourceName);
    expect(env.MINDBODY_SOURCE_PASSWORD).toBe(CONFIG.sourcePassword);
    expect(env.HOME).toBe("/scratch");
    expect(env).not.toHaveProperty("UNRELATED");
  });

  it("keeps proxy variables, the one deliberate inheritance", () => {
    const env = buildLiveChildEnv(CONFIG, "/scratch", { HTTPS_PROXY: "http://proxy.example:8080" });
    expect(env.HTTPS_PROXY).toBe("http://proxy.example:8080");
  });
});
