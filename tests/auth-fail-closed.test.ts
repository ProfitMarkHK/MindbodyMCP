/**
 * Fail-closed user token (src/api/auth.ts, src/api/client.ts).
 *
 * A Mindbody call must never go out with the API key alone: the answer differs
 * from the user's own data set. These tests stub the token endpoint at the axios
 * layer, so no request leaves the process and no real credentials are used.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import axios from "axios";
import { mindbodyAuth, MindbodyAuthError } from "../src/api/auth.js";
import { MindbodyApiClient } from "../src/api/client.js";
import { STUB_FIXTURES } from "./support/mindbody-stub.js";

const SAVED_ENV = {
  MINDBODY_API_KEY: process.env.MINDBODY_API_KEY,
  MINDBODY_SITE_ID: process.env.MINDBODY_SITE_ID,
  MINDBODY_SOURCE_NAME: process.env.MINDBODY_SOURCE_NAME,
  MINDBODY_SOURCE_PASSWORD: process.env.MINDBODY_SOURCE_PASSWORD,
};

beforeAll(() => {
  process.env.MINDBODY_API_KEY = STUB_FIXTURES.apiKey;
  process.env.MINDBODY_SITE_ID = "1";
});

afterAll(() => {
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const issueSpy = () => spyOn(axios, "post");

function refuseIssue(status: number, message: string) {
  return async () => {
    const error = Object.assign(new Error("Request failed"), {
      isAxiosError: true,
      response: { status, data: { Error: { Message: message } } },
    });
    throw error;
  };
}

describe("user token fail-close", () => {
  let post: ReturnType<typeof issueSpy>;

  beforeEach(() => {
    mindbodyAuth.resetTokenState();
    process.env.MINDBODY_SOURCE_NAME = STUB_FIXTURES.sourceName;
    process.env.MINDBODY_SOURCE_PASSWORD = STUB_FIXTURES.sourcePassword;
    post = issueSpy();
  });

  afterEach(() => {
    post.mockRestore();
  });

  it("throws without issuing a request when source credentials are missing", async () => {
    delete process.env.MINDBODY_SOURCE_NAME;
    delete process.env.MINDBODY_SOURCE_PASSWORD;

    await expect(mindbodyAuth.getAuthHeaders()).rejects.toBeInstanceOf(MindbodyAuthError);
    expect(post).not.toHaveBeenCalled();
  });

  it("sends the bearer token when one is issued", async () => {
    post.mockResolvedValue({ data: { AccessToken: "tok-1", Expires: new Date(Date.now() + 3_600_000).toISOString() } });

    const headers = await mindbodyAuth.getAuthHeaders();

    expect(headers.Authorization).toBe("Bearer tok-1");
    expect(headers["Api-Key"]).toBe(STUB_FIXTURES.apiKey);
  });

  it("throws, with Mindbody's message, when the issue is refused", async () => {
    post.mockImplementation(refuseIssue(403, "Stub refused to issue a token"));

    const error = await mindbodyAuth.getAuthHeaders().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MindbodyAuthError);
    expect((error as Error).message).toContain("user token request failed (403)");
    expect((error as Error).message).toContain("Stub refused to issue a token");
  });

  it("tries again on the next call after a refusal", async () => {
    post
      .mockImplementationOnce(refuseIssue(503, "busy"))
      .mockResolvedValueOnce({ data: { AccessToken: "tok-2", Expires: new Date(Date.now() + 3_600_000).toISOString() } });

    await expect(mindbodyAuth.getUserToken()).rejects.toBeInstanceOf(MindbodyAuthError);
    await expect(mindbodyAuth.getUserToken()).resolves.toBe("tok-2");
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("shares one issue request among concurrent callers", async () => {
    post.mockResolvedValue({ data: { AccessToken: "tok-3", Expires: new Date(Date.now() + 3_600_000).toISOString() } });

    const tokens = await Promise.all([1, 2, 3].map(() => mindbodyAuth.getUserToken()));

    expect(tokens).toEqual(["tok-3", "tok-3", "tok-3"]);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("issues again once the cached token has expired", async () => {
    post
      .mockResolvedValueOnce({ data: { AccessToken: "old", Expires: new Date(Date.now() - 1_000).toISOString() } })
      .mockResolvedValueOnce({ data: { AccessToken: "new", Expires: new Date(Date.now() + 3_600_000).toISOString() } });

    await mindbodyAuth.getUserToken();
    await expect(mindbodyAuth.getUserToken()).resolves.toBe("new");
    expect(post).toHaveBeenCalledTimes(2);
  });
});

describe("auth failures through the API client", () => {
  let post: ReturnType<typeof issueSpy>;

  beforeEach(() => {
    mindbodyAuth.resetTokenState();
    process.env.MINDBODY_SOURCE_NAME = STUB_FIXTURES.sourceName;
    process.env.MINDBODY_SOURCE_PASSWORD = STUB_FIXTURES.sourcePassword;
    post = issueSpy();
    post.mockImplementation(refuseIssue(403, "Stub refused to issue a token"));
  });

  afterEach(() => {
    post.mockRestore();
  });

  it("does not retry a GET after an auth failure, and surfaces the auth error unwrapped", async () => {
    const client = new MindbodyApiClient({ apiUrl: "http://127.0.0.1:1", retryDelayMs: 1 });

    const error = await client.get("/client/clients").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MindbodyAuthError);
    expect((error as Error).message).toContain("user token request failed (403)");
    expect((error as Error).message).not.toContain("Network Error");
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("does not claim a POST may have been applied when no request was sent", async () => {
    const client = new MindbodyApiClient({ apiUrl: "http://127.0.0.1:1", retryDelayMs: 1 });

    const error = await client.post("/appointment/addappointment", {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MindbodyAuthError);
    expect((error as Error).message).not.toContain("NOT retried");
    expect(post).toHaveBeenCalledTimes(1);
  });
});
