/**
 * Concurrent requests share one user-token issue in the Next.js Mindbody client
 * (nextjs-app/src/lib/mindbody/client.ts). Runs against a loopback server only.
 */
import { describe, expect, it } from "bun:test";
import { MindbodyApiClient } from "../nextjs-app/src/lib/mindbody/client.js";
import { STUB_FIXTURES } from "./support/mindbody-stub.js";

describe("nextjs Mindbody client: user token dedupe", () => {
  it("issues one token for concurrent requests", async () => {
    const issues: string[] = [];
    const authHeaders: Array<string | null> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/usertoken/issue")) {
          issues.push(path);
          // Hold the response open so the callers overlap, as they would in practice.
          await Bun.sleep(50);
          return Response.json({ AccessToken: "shared-token", Expires: new Date(Date.now() + 3_600_000).toISOString() });
        }
        authHeaders.push(request.headers.get("authorization"));
        return Response.json({ ok: true });
      },
    });

    try {
      const client = new MindbodyApiClient({
        apiKey: STUB_FIXTURES.apiKey,
        siteId: STUB_FIXTURES.siteId,
        sourceName: STUB_FIXTURES.sourceName,
        sourcePassword: STUB_FIXTURES.sourcePassword,
        apiUrl: `http://127.0.0.1:${server.port}/public/v6`,
      });

      await Promise.all([1, 2, 3].map(() => client.get("/client/clients")));
      // Still inside the token's lifetime, so the cached token is reused.
      await client.get("/client/clients");

      expect(issues).toHaveLength(1);
      expect(authHeaders).toEqual(Array(4).fill("Bearer shared-token"));
    } finally {
      server.stop();
    }
  });
});
