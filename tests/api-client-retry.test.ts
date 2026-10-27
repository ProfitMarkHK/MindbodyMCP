/**
 * Retry eligibility of `MindbodyApiClient.request` (src/api/client.ts).
 *
 * GETs are replayed on a lost response or a 5xx. A POST is never replayed: the
 * server may have applied it already (a checkout, a cancellation that emails the
 * client), Mindbody's v6 spec defines no idempotency key, and the caller has to
 * reconcile instead. Runs against loopback servers only; no Mindbody site is
 * contacted and no credentials are used.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { MindbodyApiClient } from "../src/api/client.js";
import { mindbodyAuth } from "../src/api/auth.js";

const SAVED_ENV = {
  MINDBODY_API_KEY: process.env.MINDBODY_API_KEY,
};
const savedGetAuthHeaders = mindbodyAuth.getAuthHeaders;

beforeAll(() => {
  // Auth is stubbed out: these cases test retries, not token issuing, and no token request is made.
  process.env.MINDBODY_API_KEY = "stub";
  mindbodyAuth.getAuthHeaders = async () => ({ "Api-Key": "stub" });
});

afterAll(() => {
  mindbodyAuth.getAuthHeaders = savedGetAuthHeaders;
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const servers: Array<{ stop(): void } | TcpServer> = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    if ("stop" in server) server.stop();
    else server.close();
  }
});

/** An HTTP server that answers the n-th request (1-based) with `respond(n)`. */
function httpServer(respond: (hit: number) => Response) {
  const state = { hits: 0 };
  const server = Bun.serve({ port: 0, fetch: () => respond(++state.hits) });
  servers.push(server);
  return { state, url: `http://127.0.0.1:${server.port}` };
}

/** A TCP server that accepts a request, reads it, then drops the socket: the response is lost. */
async function droppingServer() {
  const state = { hits: 0 };
  const server = createTcpServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", () => {
      state.hits += 1;
      socket.destroy();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { state, url: `http://127.0.0.1:${port}` };
}

const json = (status: number, body: unknown) => Response.json(body, { status });
const client = (apiUrl: string) => new MindbodyApiClient({ apiUrl, retryDelayMs: 1 });

describe("MindbodyApiClient.request — GET retry is unchanged", () => {
  it("retries a 5xx and returns the first good answer", async () => {
    const { state, url } = httpServer((hit) => (hit < 3 ? json(503, {}) : json(200, { ok: hit })));
    expect(await client(url).get("/x")).toEqual({ ok: 3 });
    expect(state.hits).toBe(3);
  });

  it("gives up after the first attempt plus 3 retries, with the plain API error", async () => {
    const { state, url } = httpServer(() => json(502, {}));
    await expect(client(url).get("/x")).rejects.toThrow(/^API Error: 502/);
    expect(state.hits).toBe(4);
  });

  it("retries a lost response", async () => {
    const { state, url } = await droppingServer();
    await expect(client(url).get("/x")).rejects.toThrow(/^Network Error/);
    expect(state.hits).toBe(4);
  });

  it("does not retry a 4xx", async () => {
    const { state, url } = httpServer(() => json(404, { Error: { Message: "nope", Code: "NotFound" } }));
    await expect(client(url).get("/x")).rejects.toThrow("Mindbody API Error: nope (Code: NotFound)");
    expect(state.hits).toBe(1);
  });
});

describe("MindbodyApiClient.request — a POST is never blindly replayed", () => {
  it("does not replay a POST the server applied before it returned 500", async () => {
    const applied: unknown[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        applied.push(await req.json());
        return json(500, { Error: { Message: "boom after commit", Code: "ServerError" } });
      },
    });
    servers.push(server);

    const error = await client(`http://127.0.0.1:${server.port}`)
      .post("/sale/checkoutshoppingcart", { ClientId: "1" })
      .catch((e: Error) => e);

    expect(applied).toEqual([{ ClientId: "1" }]);
    expect((error as Error).message).toMatch(
      /^Mindbody API Error: boom after commit \(Code: ServerError\)\. The POST \/sale\/checkoutshoppingcart was NOT retried/
    );
    expect((error as Error).message).toMatch(/no idempotency key/);
    expect((error as Error).message).toMatch(/Reconcile before retrying/);
  });

  it("does not replay a POST whose response was lost", async () => {
    const { state, url } = await droppingServer();
    await expect(client(url).post("/appointment/updateappointment", {})).rejects.toThrow(/^Network Error.*NOT retried/);
    expect(state.hits).toBe(1);
  });

  it("reports a 4xx on a POST as before, without the reconcile advice", async () => {
    const { state, url } = httpServer(() => json(400, { Error: { Message: "bad", Code: "InvalidClient" } }));
    const error = await client(url).post("/client/addclient", {}).catch((e: Error) => e);
    expect((error as Error).message).toBe("Mindbody API Error: bad (Code: InvalidClient)");
    expect(state.hits).toBe(1);
  });

  it("still re-authenticates and replays once on a 401 (nothing was applied)", async () => {
    const { state, url } = httpServer((hit) => (hit === 1 ? json(401, {}) : json(200, { done: true })));
    expect(await client(url).post("/class/addclienttoclass", {})).toEqual({ done: true });
    expect(state.hits).toBe(2);
  });
});
