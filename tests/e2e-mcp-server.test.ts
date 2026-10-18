/**
 * End-to-end acceptance tests for the MCP server.
 *
 * Unlike `tests/classManagement.test.ts` — which imports a tool function and
 * injects a fake client, and therefore proves nothing about transport wiring —
 * every test here drives the *real* server the way a real MCP client does:
 *
 *   1. `src/index.ts` is spawned as a genuine subprocess over STDIO.
 *   2. The `@modelcontextprotocol/sdk` client speaks real MCP JSON-RPC to it:
 *      `initialize`, `tools/list`, `tools/call`.
 *   3. The subprocess is pointed at a local stub Mindbody API via
 *      `MINDBODY_API_URL`, so no request can reach api.mindbodyonline.com.
 *
 * The subprocess runs with a clean-room environment (no inheritance from the
 * test process, which holds the developer's real credentials) and with its
 * working directory set to an empty scratch dir, so the repo's `.env` is neither
 * read nor reachable.
 *
 * Domain coverage is deliberately scoped away from class writes and resource
 * reservations. What it does cover is read *and* write across four domains —
 * clients, orders, appointments, and the service catalogue those writes depend
 * on — the class, staff and site-catalogue reads, plus the OAuth user-token
 * state machine in `src/api/auth.ts`, which is otherwise unreachable from any
 * other test.
 *
 * Pagination is exercised end to end: the stub caps /class/classes at 3 rows and
 * /staff/staff at 1 row per page (while echoing the asked Limit), so the
 * `pagination — …` cases prove the server issues several GETs with an advancing
 * Offset and returns the full set rather than page one.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import {
  CANCELLATION_FIXTURES,
  ENROLLMENT_FIXTURES,
  MindbodyStub,
  STUB_CLASSES,
  STUB_FIXTURES,
  STUB_PAGE_CAPS,
  buildStubEnv,
} from './support/mindbody-stub.js';
import { addDays } from '../src/utils/dates.js';
import { siteDateString } from '../src/utils/siteTime.js';

const SERVER_ENTRY = resolve(__dirname, '../src/index.ts');
const AUTH_HARNESS_ENTRY = resolve(__dirname, './support/auth-harness.ts');
const BUN_BINARY = process.execPath;

const OAUTH_ISSUE_PATH = '/public/v6/usertoken/issue';
const CLIENTS_PATH = '/public/v6/client/clients';
const CLIENT_VISITS_PATH = '/public/v6/client/clientvisits';
const STAFF_APPOINTMENTS_PATH = '/public/v6/appointment/staffappointments';
const UPDATE_APPOINTMENT_PATH = '/public/v6/appointment/updateappointment';
const SITE_SITES_PATH = '/public/v6/site/sites';
const CLASSES_PATH = '/public/v6/class/classes';
const STAFF_PATH = '/public/v6/staff/staff';
const CLIENT_SCHEDULE_PATH = '/public/v6/client/clientschedule';

/** A cancellation fixture by id; throws if the stub does not define it. */
function cancellationFixture(id: number): Record<string, unknown> {
  const found = CANCELLATION_FIXTURES.appointments.find((appointment) => appointment.Id === id);
  if (!found) throw new Error(`No cancellation fixture with id ${id}`);
  return found;
}

/**
 * The exact tool set `src/index.ts` advertises in its `ListToolsRequest` handler.
 * Asserting the names — not just the count — is what makes this a registration
 * test rather than a smoke test: renaming or dropping a tool fails here.
 */
const EXPECTED_TOOL_NAMES = [
  'getTeacherSchedule',
  'getStaff',
  'getClasses',
  'getClassDescriptions',
  'getClassSchedules',
  'addClientToClass',
  'removeClientFromClass',
  'getWaitlistEntries',
  'substituteClassTeacher',
  'getClassVisits',
  'getClients',
  'addClient',
  'updateClient',
  'getClientVisits',
  'getClientMemberships',
  'addClientArrival',
  'getClientAccountBalances',
  'getClientContracts',
  'getServices',
  'getPackages',
  'getProducts',
  'getContracts',
  'checkoutShoppingCart',
  'purchaseContract',
  'getSites',
  'getLocations',
  'getPrograms',
  'getResources',
  'getSessionTypes',
  'getActivationCode',
  'getStaffAppointments',
  'addAppointment',
  'updateAppointment',
  'cancelAppointments',
  'getBookableItems',
  'getActiveSessionTimes',
  'getScheduleItems',
  'getEnrollments',
  'addClientToEnrollment',
  'getClientEnrollments',
  'cancelEnrollmentVisits',
] as const;

/**
 * A structural validator for the subset of JSON Schema the MCP SDK accepts for a
 * tool `inputSchema`. This is the automated replacement for the `validate-mcp`
 * CI step: every advertised schema must parse, describe an object, and declare
 * its required fields inside `properties`.
 */
const jsonSchemaNode: z.ZodTypeAny = z.lazy(() =>
  z
    .object({
      type: z
        .union([
          z.enum(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']),
          z.array(z.string()),
        ])
        .optional(),
      description: z.string().optional(),
      enum: z.array(z.unknown()).optional(),
      properties: z.record(z.string(), jsonSchemaNode).optional(),
      items: jsonSchemaNode.optional(),
      required: z.array(z.string()).optional(),
    })
    .passthrough()
);

interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** A spawned MCP server plus the stderr it produced, for one isolated case. */
interface ScopedServer {
  client: Client;
  transport: StdioClientTransport;
  stderrText: () => string;
  stop: () => Promise<void>;
}

let stub: MindbodyStub;
let scratchDir: string;
let childEnv: Record<string, string>;
let transport: StdioClientTransport;
let client: Client;
let serverStderr: string[] = [];
let e2eTestCount = 0;
let e2eFailureCount = 0;

/**
 * `it`, wrapped so the suite can report its own outcome.
 *
 * scripts/check-gates.sh runs this suite as part of `bun test` and derives Gate 2
 * from that single run rather than spawning the server subprocess suite twice.
 * The sentinel below is how it knows the suite ran at all — a plain grep for the
 * file name would find nothing on a green run, because bun only prints a file
 * header when a test in it fails.
 */
function itE2E(name: string, fn: () => unknown, timeout?: number) {
  e2eTestCount += 1;
  return it(
    name,
    async () => {
      try {
        await fn();
      } catch (error) {
        e2eFailureCount += 1;
        throw error;
      }
    },
    timeout
  );
}

const GATE2_SENTINEL = 'GATE2_E2E_RESULT';

/** Parse the single text content block an MCP tool result is expected to carry. */
function resultJson(result: { content?: unknown }): any {
  const content = result.content as Array<{ type: string; text?: string }>;
  expect(Array.isArray(content)).toBe(true);
  expect(content[0]?.type).toBe('text');
  return JSON.parse(content[0]?.text ?? '');
}

function resultText(result: { content?: unknown }): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((block) => block.text ?? '').join('');
}

/**
 * Tear a connection down promptly.
 *
 * `StdioClientTransport.close()` ends the child's stdin and waits for it to exit,
 * racing a 2-second timeout before sending SIGTERM. The server does not exit on
 * stdin EOF in STDIO mode, so every close would otherwise cost a full 2 seconds.
 * Signalling first makes teardown immediate and guarantees no orphaned process.
 */
async function shutdownConnection(closingClient: Client, closingTransport: StdioClientTransport) {
  const pid = closingTransport.pid;
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
  await closingClient.close();
}

/**
 * Spawn an extra, isolated MCP server for one case.
 *
 * The OAuth cases each need their own server *and* their own stub: `MindbodyAuth`
 * is a module-level singleton holding `tokenFailed`, the cached token and its
 * expiry, so nothing about one scenario may be observable from the next. Each
 * server gets a clean-room env pointing at a fresh loopback stub.
 */
async function startScopedServer(
  env: Record<string, string>,
  cwd: string
): Promise<ScopedServer> {
  const scopedTransport = new StdioClientTransport({
    command: BUN_BINARY,
    args: ['run', SERVER_ENTRY],
    cwd,
    env,
    stderr: 'pipe',
  });

  const chunks: string[] = [];
  scopedTransport.stderr?.on('data', (chunk: Buffer | string) => chunks.push(chunk.toString()));

  const scopedClient = new Client({ name: 'e2e-scoped-client', version: '0.0.0' });
  await scopedClient.connect(scopedTransport);

  return {
    client: scopedClient,
    transport: scopedTransport,
    stderrText: () => chunks.join(''),
    stop: () => shutdownConnection(scopedClient, scopedTransport),
  };
}

/** Every logged request that is not a token issue. */
function apiRequestsOf(target: MindbodyStub) {
  return target.requests.filter((request) => request.path !== OAUTH_ISSUE_PATH);
}

beforeAll(async () => {
  // Empty scratch dir used as the subprocess cwd and HOME. Because it holds no
  // `.env`, both `dotenv.config()` in src/index.ts and bun's own loader find
  // nothing, and module resolution still walks up to the repo's node_modules.
  scratchDir = mkdtempSync(join(tmpdir(), 'mindbody-mcp-e2e-'));

  stub = await MindbodyStub.start();
  childEnv = buildStubEnv({ apiUrl: stub.apiUrl, scratchDir });

  transport = new StdioClientTransport({
    command: BUN_BINARY,
    args: ['run', SERVER_ENTRY],
    cwd: scratchDir,
    env: childEnv,
    stderr: 'pipe',
  });

  const stderrStream = transport.stderr;
  if (stderrStream) {
    stderrStream.on('data', (chunk: Buffer | string) => {
      serverStderr.push(chunk.toString());
    });
  }

  client = new Client({ name: 'e2e-test-client', version: '0.0.0' });
  await client.connect(transport);
});

afterAll(async () => {
  try {
    await shutdownConnection(client, transport);
  } catch {
    // The transport may already be gone if a test killed it deliberately.
  }
  try {
    await stub?.close();
  } finally {
    if (scratchDir) {
      rmSync(scratchDir, { recursive: true, force: true });
    }
    // Emitted last, and always, so the gate runner can tell "the acceptance suite
    // ran and passed" from "the acceptance suite never ran". A failure inside
    // beforeAll means this line is absent, which the runner treats as a failure.
    // Format is consumed by scripts/check-gates.sh — keep the two in step.
    console.log(`${GATE2_SENTINEL} tests=${e2eTestCount} failures=${e2eFailureCount}`);
  }
});

describe('hermeticity', () => {
  itE2E('spawns the server with a clean-room env that contains no inherited credentials', () => {
    // The exhaustive key list is the assertion: nothing but PATH is inherited,
    // so no credential the test process holds can reach the child.
    expect(Object.keys(childEnv).sort()).toEqual([
      'HOME',
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'MINDBODY_API_KEY',
      'MINDBODY_API_URL',
      'MINDBODY_SITE_ID',
      'MINDBODY_SOURCE_NAME',
      'MINDBODY_SOURCE_PASSWORD',
      'NODE_ENV',
      'NO_PROXY',
      'PATH',
      'TMPDIR',
    ]);

    // Every Mindbody value the child can see is a hard-coded fake from the stub.
    expect(childEnv.MINDBODY_API_KEY).toBe(STUB_FIXTURES.apiKey);
    expect(childEnv.MINDBODY_SITE_ID).toBe(STUB_FIXTURES.siteId);
    expect(childEnv.MINDBODY_SOURCE_NAME).toBe(STUB_FIXTURES.sourceName);
    expect(childEnv.MINDBODY_SOURCE_PASSWORD).toBe(STUB_FIXTURES.sourcePassword);

    for (const key of Object.keys(process.env).filter((k) => k.startsWith('MINDBODY_'))) {
      const childValue = childEnv[key];
      if (childValue === undefined) continue;
      expect([
        STUB_FIXTURES.apiKey,
        STUB_FIXTURES.siteId,
        STUB_FIXTURES.sourceName,
        STUB_FIXTURES.sourcePassword,
        stub.apiUrl,
      ]).toContain(childValue);
    }
  });

  itE2E('runs the server from a cwd with no .env file in it', () => {
    expect(existsSync(join(scratchDir, '.env'))).toBe(false);
    expect(readdirSync(scratchDir).filter((entry) => entry.startsWith('.env'))).toEqual([]);
  });

  itE2E('points the server at the loopback stub', () => {
    expect(childEnv.MINDBODY_API_URL).toBe(stub.apiUrl);
    expect(stub.origin.startsWith('http://127.0.0.1:')).toBe(true);
  });
});

describe('handshake', () => {
  itE2E('reports its identity after initialize', () => {
    // Reaching this point means `initialize` returned a protocol version the SDK
    // supports and a schema-valid serverInfo, or `connect()` would have thrown.
    expect(client.getServerVersion()).toEqual({ name: 'mindbody-mcp', version: '2.0.0' });
  });

  itE2E('negotiates an explicitly requested protocol version', async () => {
    // A second, short-lived connection: asking for an older supported version
    // proves the server echoes the negotiated version back rather than blindly
    // stamping its own.
    const negotiated = '2024-11-05';
    const other = new Client({ name: 'e2e-version-probe', version: '0.0.0' });
    const otherTransport = new StdioClientTransport({
      command: BUN_BINARY,
      args: ['run', SERVER_ENTRY],
      cwd: scratchDir,
      env: childEnv,
      stderr: 'pipe',
    });
    try {
      await other.connect(otherTransport, { protocolVersion: negotiated });
      // The SDK re-validates the server's answer, so surviving here is the check.
      expect(other.getServerVersion()?.name).toBe('mindbody-mcp');
      expect(other.getServerCapabilities()).toMatchObject({ tools: {} });
    } finally {
      await shutdownConnection(other, otherTransport);
    }
  });

  itE2E('announces tool capability and writes diagnostics to stderr, not stdout', () => {
    expect(client.getServerCapabilities()).toHaveProperty('tools');
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    expect(serverStderr.join('')).toContain('Mindbody MCP Server v2.0 started (STDIO)');
  });
});

describe('tools/list', () => {
  itE2E('advertises exactly the expected tool set', async () => {
    const { tools } = await client.listTools();
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toHaveLength(EXPECTED_TOOL_NAMES.length);
    expect(tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  itE2E('gives every tool a unique, well-formed name and a non-empty description', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-zA-Z][a-zA-Z0-9_]*$/);
      expect(typeof tool.description).toBe('string');
      expect(tool.description!.trim().length).toBeGreaterThan(0);
    }
  });

  itE2E('declares a schema that is a valid JSON Schema object for every tool', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools as ToolDescriptor[]) {
      expect(tool.inputSchema).toBeDefined();
      // Parsing is the validity check: an unrecognised or malformed shape throws.
      const parsed = jsonSchemaNode.safeParse(tool.inputSchema);
      if (!parsed.success) {
        throw new Error(
          `${tool.name}: invalid inputSchema — ${parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ')}`
        );
      }
      expect(tool.inputSchema.type).toBe('object');
      const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties;
      expect(properties).toBeTypeOf('object');
    }
  });

  itE2E('declares every required field inside properties, and types every property', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools as ToolDescriptor[]) {
      const schema = tool.inputSchema as {
        properties?: Record<string, { type?: unknown }>;
        required?: string[];
      };
      const properties = schema.properties ?? {};

      for (const required of schema.required ?? []) {
        expect(
          Object.keys(properties),
          `${tool.name} requires "${required}" but does not declare it in properties`
        ).toContain(required);
      }

      for (const [name, definition] of Object.entries(properties)) {
        expect(definition.type, `${tool.name}.${name} has no type`).toBeDefined();
      }
    }
  });
});

describe('OAuth user token — issue, attach, cache', () => {
  itE2E('acquires the user token from the stub and sends it on every API call', async () => {
    // Baseline rather than an absolute count, so the assertion does not depend
    // on which describes ran before this one.
    const tokenRequestsBefore = stub.tokenRequests.length;
    stub.resetLog();

    // `getClientVisits` is not cached by the server, so each of the three calls
    // below is guaranteed to produce an outbound HTTP request.
    for (const clientId of ['e2e-oauth-a', 'e2e-oauth-b', 'e2e-oauth-c']) {
      const result = await client.callTool({
        name: 'getClientVisits',
        arguments: { clientId, startDate: '2026-03-01', endDate: '2026-03-04' },
      });
      expect(result.isError).toBeFalsy();
    }

    // auth.ts honours MINDBODY_API_URL too, not just the API client: the token
    // came from the stub, and it was fetched exactly once for three API calls
    // (auth caches it until it is within 60s of expiry).
    expect(stub.tokenRequests.length - tokenRequestsBefore).toBe(1);
    const [tokenRequest] = stub.tokenRequests.slice(tokenRequestsBefore);
    expect(tokenRequest.path).toBe(OAUTH_ISSUE_PATH);
    expect(tokenRequest.headers['api-key']).toBe(STUB_FIXTURES.apiKey);
    expect(tokenRequest.headers.siteid).toBe(STUB_FIXTURES.siteId);
    expect(tokenRequest.body).toEqual({
      Username: STUB_FIXTURES.sourceName,
      Password: STUB_FIXTURES.sourcePassword,
    });

    // The token it issued rides on every API request that followed, alongside the
    // API-key headers that are always present.
    //
    // Six requests, not three: `getClientVisits` resolves each visit's location
    // and instructor by reading the `/site/locations` and `/staff/staff`
    // catalogues, because a `Visit` carries only `LocationId`/`StaffId`. The staff
    // catalogue costs two requests rather than one because the stub caps that
    // route at one row per page. The claim under test is that the token reaches
    // every one of them.
    const apiRequests = apiRequestsOf(stub);
    expect(apiRequests).toHaveLength(6);
    for (const request of apiRequests) {
      expect(request.headers.authorization).toBe(`Bearer ${STUB_FIXTURES.accessToken}`);
      expect(request.headers['api-key']).toBe(STUB_FIXTURES.apiKey);
      expect(request.headers.siteid).toBe(STUB_FIXTURES.siteId);
    }
  });
});

describe('OAuth user token — expiry skew (60s)', () => {
  let skewStub: MindbodyStub;
  let skewServer: ScopedServer;

  beforeAll(async () => {
    skewStub = await MindbodyStub.start();
    // An expiry 30 seconds out: comfortably in the future, but inside the 60s
    // `auth.ts` subtracts, so the cached token is born expired. Each attempt
    // yields a different token, so a reused cache entry would be visible.
    skewStub.setTokenResponder((attempt) => ({
      status: 200,
      body: {
        TokenType: 'Bearer',
        AccessToken: `${STUB_FIXTURES.accessToken}-${attempt}`,
        Expires: new Date(Date.now() + 30_000).toISOString(),
      },
    }));
    skewServer = await startScopedServer(
      buildStubEnv({ apiUrl: skewStub.apiUrl, scratchDir }),
      scratchDir
    );
  });

  afterAll(async () => {
    try {
      await skewServer?.stop();
    } finally {
      await skewStub?.close();
    }
  });

  itE2E('discards a token inside the 60s skew window and issues a fresh one per call', async () => {
    const before = skewStub.tokenRequests.length;
    skewStub.resetLog();

    for (const clientId of ['skew-1', 'skew-2', 'skew-3']) {
      const result = await skewServer.client.callTool({
        name: 'getClientVisits',
        arguments: { clientId, startDate: '2026-03-01', endDate: '2026-03-04' },
      });
      expect(result.isError).toBeFalsy();
    }

    // One issue per API call — the cached token is never reused. (With an expiry
    // beyond the skew, the sibling test below sees 1 issue for the same calls.)
    //
    // Six issues, matching the six API requests below: `getClientVisits` also
    // reads the `/site/locations` and `/staff/staff` catalogues to resolve the
    // ids a Visit carries, and a token this close to expiry is re-issued for every
    // one of them. The claim under test — never reuse a token inside the skew —
    // holds for all six.
    expect(skewStub.tokenRequests.length - before).toBe(6);

    // Six requests for three tool calls: the two catalogue reads `getClientVisits`
    // needs to turn `LocationId`/`StaffId` into names, plus the staff catalogue's
    // second page (the stub caps that route at one row per page).
    const apiRequests = apiRequestsOf(skewStub);
    expect(apiRequests).toHaveLength(6);
    // Every API call carries a token, and no token is ever used twice: the
    // six requests take the six freshly issued tokens in order.
    expect(apiRequests.map((request) => request.headers.authorization)).toEqual([
      `Bearer ${STUB_FIXTURES.accessToken}-1`,
      `Bearer ${STUB_FIXTURES.accessToken}-2`,
      `Bearer ${STUB_FIXTURES.accessToken}-3`,
      `Bearer ${STUB_FIXTURES.accessToken}-4`,
      `Bearer ${STUB_FIXTURES.accessToken}-5`,
      `Bearer ${STUB_FIXTURES.accessToken}-6`,
    ]);

    // Every re-issue still authenticates with the API key and the same body.
    for (const tokenRequest of skewStub.tokenRequests.slice(before)) {
      expect(tokenRequest.path).toBe(OAUTH_ISSUE_PATH);
      expect(tokenRequest.headers['api-key']).toBe(STUB_FIXTURES.apiKey);
      expect(tokenRequest.headers.siteid).toBe(STUB_FIXTURES.siteId);
      expect(tokenRequest.body).toEqual({
        Username: STUB_FIXTURES.sourceName,
        Password: STUB_FIXTURES.sourcePassword,
      });
    }
  }, 20_000);
});

describe('OAuth user token — 23-hour fallback when Expires is absent', () => {
  let fallbackStub: MindbodyStub;
  let fallbackServer: ScopedServer;

  beforeAll(async () => {
    fallbackStub = await MindbodyStub.start();
    // No `Expires` field at all: auth.ts must fall back to Date.now() + 23h.
    fallbackStub.setTokenResponder((attempt) => ({
      status: 200,
      body: {
        TokenType: 'Bearer',
        AccessToken: `${STUB_FIXTURES.accessToken}-${attempt}`,
      },
    }));
    fallbackServer = await startScopedServer(
      buildStubEnv({ apiUrl: fallbackStub.apiUrl, scratchDir }),
      scratchDir
    );
  });

  afterAll(async () => {
    try {
      await fallbackServer?.stop();
    } finally {
      await fallbackStub?.close();
    }
  });

  itE2E('still issues a token, uses it, and caches it rather than re-issuing', async () => {
    const before = fallbackStub.tokenRequests.length;
    fallbackStub.resetLog();

    for (const clientId of ['fallback-1', 'fallback-2', 'fallback-3']) {
      const result = await fallbackServer.client.callTool({
        name: 'getClientVisits',
        arguments: { clientId, startDate: '2026-03-01', endDate: '2026-03-04' },
      });
      expect(result.isError).toBeFalsy();
    }

    // A fallback expiry of zero (or of "now") would force a re-issue per call.
    // One issue across three calls is what "23 hours" looks like from out here.
    expect(fallbackStub.tokenRequests.length - before).toBe(1);

    const apiRequests = apiRequestsOf(fallbackStub);
    expect(apiRequests).toHaveLength(6);
    for (const request of apiRequests) {
      expect(request.headers.authorization).toBe(`Bearer ${STUB_FIXTURES.accessToken}-1`);
    }
  }, 20_000);
});

describe('OAuth user token — failure fallback', () => {
  let failedStub: MindbodyStub;
  let failedServer: ScopedServer;

  beforeAll(async () => {
    failedStub = await MindbodyStub.start();
    // Every issue attempt is refused. 403 is not retried by the API client's
    // shouldRetry(), and the token fetch has no retry of its own, so the count
    // below is exact and fast.
    failedStub.setTokenResponder(() => ({
      status: 403,
      body: { Error: { Code: 'AccessDenied', Message: 'Stub refused to issue a token' } },
    }));
    failedServer = await startScopedServer(
      buildStubEnv({ apiUrl: failedStub.apiUrl, scratchDir }),
      scratchDir
    );
  });

  afterAll(async () => {
    try {
      await failedServer?.stop();
    } finally {
      await failedStub?.close();
    }
  });

  itE2E('falls back to API-key-only auth and never retries the issue', async () => {
    const before = failedStub.tokenRequests.length;
    failedStub.resetLog();

    for (const clientId of ['failed-1', 'failed-2', 'failed-3', 'failed-4', 'failed-5']) {
      const result = await failedServer.client.callTool({
        name: 'getClientVisits',
        arguments: { clientId, startDate: '2026-03-01', endDate: '2026-03-04' },
      });
      // (a) The tool still succeeds: no Authorization header is needed against
      //     the stub, so the degradation is invisible to the caller.
      expect(result.isError).toBeFalsy();
      expect(resultJson(result).totalVisits).toBe(2);
    }

    // (b) `tokenFailed` latches: exactly one issue attempt, ever.
    expect(failedStub.tokenRequests.length - before).toBe(1);

    const apiRequests = apiRequestsOf(failedStub);
    expect(apiRequests).toHaveLength(8);
    for (const request of apiRequests) {
      expect(request.headers['api-key']).toBe(STUB_FIXTURES.apiKey);
      expect(request.headers.siteid).toBe(STUB_FIXTURES.siteId);
      expect(request.headers.authorization).toBeUndefined();
    }

    // The degradation is also logged, with the upstream message, to stderr.
    const stderr = failedServer.stderrText();
    expect(stderr).toContain('User token acquisition failed (403)');
    expect(stderr).toContain('Stub refused to issue a token');
    expect(stderr).toContain('Falling back to API-key-only auth.');
  }, 20_000);
});

describe('OAuth user token — no source credentials', () => {
  itE2E('getUserToken short-circuits to null and never touches /usertoken/issue', async () => {
    // src/index.ts refuses to start without these two variables, so this branch of
    // auth.ts is only reachable through the real modules, driven in their own
    // process against the real stub. See the next test for the startup gate.
    const bareStub = await MindbodyStub.start();
    try {
      const env = buildStubEnv({
        apiUrl: bareStub.apiUrl,
        scratchDir,
        omit: ['MINDBODY_SOURCE_NAME', 'MINDBODY_SOURCE_PASSWORD'],
      });
      env.AUTH_HARNESS_CALLS = '3';
      expect(env.MINDBODY_SOURCE_NAME).toBeUndefined();
      expect(env.MINDBODY_SOURCE_PASSWORD).toBeUndefined();

      const proc = Bun.spawn([BUN_BINARY, 'run', AUTH_HARNESS_ENTRY], {
        cwd: scratchDir,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(stderr).toBe('');
      expect(exitCode).toBe(0);

      const line = stdout.split('\n').find((entry) => entry.startsWith('AUTH_HARNESS_RESULT'));
      expect(line).toBeDefined();
      const report = JSON.parse(line!.slice('AUTH_HARNESS_RESULT'.length).trim());

      expect(report.tokenBefore).toBeNull();
      expect(report.tokenAfter).toBeNull();
      expect(report.apiCalls).toBe(3);
      expect(report.apiOk).toBe(true);
      expect(report.firstClientId).toBe(STUB_FIXTURES.client.Id);

      // Zero issue requests, ever: the check is the first thing getUserToken does.
      expect(bareStub.tokenRequests).toHaveLength(0);

      // And the API calls still went out, authenticated by API key alone.
      const apiRequests = apiRequestsOf(bareStub);
      expect(apiRequests).toHaveLength(3);
      for (const request of apiRequests) {
        expect(request.headers['api-key']).toBe(STUB_FIXTURES.apiKey);
        expect(request.headers.siteid).toBe(STUB_FIXTURES.siteId);
        expect(request.headers.authorization).toBeUndefined();
      }
    } finally {
      await bareStub.close();
    }
  }, 20_000);

  itE2E('but the MCP server itself refuses to start without source credentials', async () => {
    // The operational counterpart to the test above: the short-circuit in
    // auth.ts is real, but src/index.ts's startup gate rejects the same missing
    // variables first, so the MCP server never reaches it. Asserted so the gap
    // is documented behaviour rather than an accident.
    const proc = Bun.spawn([BUN_BINARY, 'run', SERVER_ENTRY], {
      cwd: scratchDir,
      env: buildStubEnv({
        apiUrl: stub.apiUrl,
        scratchDir,
        omit: ['MINDBODY_SOURCE_NAME', 'MINDBODY_SOURCE_PASSWORD'],
      }),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Missing required environment variable: MINDBODY_SOURCE_NAME');
  }, 20_000);
});

describe('egress trap', () => {
  itE2E('any non-loopback destination is refused at the loopback proxy, in milliseconds', async () => {
    // The premise the whole suite rests on: HTTP(S) traffic goes through
    // HTTP_PROXY/HTTPS_PROXY unless NO_PROXY matches, and buildStubEnv points the
    // proxy at a closed loopback port. So a request to anything off-box dies at
    // the proxy instead of leaving the machine.
    //
    // Proven here rather than assumed. `192.0.2.1` is from RFC 5737's reserved
    // documentation range and is never routable, so nothing can be reached even
    // if the trap regressed — the test measures the trap, not the far end.
    //
    // With HTTP_PROXY/HTTPS_PROXY set, the same probe below completes in single-
    // digit milliseconds. With them removed it hangs for the full 5s abort
    // window, because the SYN goes nowhere. That contrast is the evidence.
    expect(new URL(childEnv.HTTPS_PROXY).hostname).toBe('127.0.0.1');
    expect(childEnv.NO_PROXY).toBe('127.0.0.1,localhost');

    // The trap port really is closed; if it were not, the assertion after it
    // would be vacuous.
    const trapRefused = await fetch(`http://${childEnv.HTTPS_PROXY}/canary`).then(
      () => false,
      () => true
    );
    expect(trapRefused).toBe(true);

    const startedAt = Date.now();
    const proc = Bun.spawn(
      [
        BUN_BINARY,
        '-e',
        "try { await fetch('https://192.0.2.1/'); console.log('RESOLVED'); } catch { console.log('BLOCKED'); }",
      ],
      { cwd: scratchDir, env: childEnv, stdout: 'pipe', stderr: 'pipe' }
    );
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('BLOCKED');
    // A refusal, not a timeout: a request that had actually left the box would
    // sit out the whole 5s abort window instead.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  }, 20_000);
});

describe('domain — clients (read and write)', () => {
  itE2E('getClients maps the search filter, client records and total', async () => {
    stub.resetLog();

    const result = await client.callTool({
      name: 'getClients',
      arguments: { searchText: 'Hopper' },
    });
    expect(result.isError).toBeFalsy();

    const payload = resultJson(result);
    expect(payload.totalClients).toBe(1);
    expect(payload.clients).toHaveLength(1);

    // Every field below comes from a differently-named Mindbody property
    // (`MobilePhone` -> `phone`, `State` -> `state`, `LiabilityRelease` ->
    // `liability`), so a mis-shaped fixture would yield undefined, not a pass.
    expect(payload.clients[0]).toMatchObject({
      id: STUB_FIXTURES.client.Id,
      firstName: 'Grace',
      lastName: 'Hopper',
      email: STUB_FIXTURES.client.Email,
      phone: STUB_FIXTURES.client.MobilePhone,
      birthDate: '1985-12-09',
      addressLine1: STUB_FIXTURES.client.AddressLine1,
      city: 'Arlington',
      state: 'VA',
      postalCode: '22201',
      country: 'US',
      isProspect: false,
      isOptedIn: true,
      createdDate: STUB_FIXTURES.client.CreationDate,
      status: 'Active',
      membershipIcon: 4,
    });
    expect(payload.clients[0].liability).toEqual({
      isReleased: true,
      agreedDate: '2024-01-15',
    });
    expect(payload.clients[0].emergencyContact).toEqual({
      name: 'Alan Turing',
      phone: '555-0199',
      relationship: 'Spouse',
    });

    const [request] = stub.requestsTo(CLIENTS_PATH, 'GET');
    expect(request.query.SearchText).toBe('Hopper');
    expect(request.query.Limit).toBe('200');
  });

  itE2E('getClients applies the prospect filter, which changes both the set and the total', async () => {
    stub.resetLog();

    const result = await client.callTool({ name: 'getClients', arguments: { isProspect: true } });
    expect(result.isError).toBeFalsy();

    const payload = resultJson(result);
    expect(payload.totalClients).toBe(1);
    expect(payload.clients).toHaveLength(1);
    // The prospect fixture has no LiabilityRelease, so the optional mapping must
    // be absent rather than a partially-populated object.
    expect(payload.clients[0]).toMatchObject({
      id: STUB_FIXTURES.prospectId,
      firstName: 'Alan',
      lastName: 'Turing',
      isProspect: true,
      isOptedIn: false,
      status: 'Lead',
      membershipIcon: 0,
    });
    expect(payload.clients[0].liability).toBeUndefined();
    expect(payload.clients[0].emergencyContact).toBeUndefined();

    const [request] = stub.requestsTo(CLIENTS_PATH, 'GET');
    expect(request.query.IsProspect).toBe('true');
    expect(request.query.SearchText).toBeUndefined();
  });

  itE2E('addClient POSTs the mapped body and returns the created client', async () => {
    stub.resetLog();

    const result = await client.callTool({
      name: 'addClient',
      arguments: {
        firstName: 'Katherine',
        lastName: 'Johnson',
        email: 'kj@example.invalid',
        mobilePhone: '555-0130',
        birthDate: '1990-08-26',
        addressLine1: '9 Orbit Road',
        city: 'Hampton',
        state: 'VA',
        postalCode: '23666',
        country: 'US',
        emergencyContactName: 'Mary Jackson',
        emergencyContactPhone: '555-0131',
        emergencyContactRelationship: 'Friend',
      },
    });
    expect(result.isError).toBeFalsy();

    const payload = resultJson(result);
    expect(payload).toEqual({
      success: true,
      client: {
        id: 'c-2001',
        firstName: 'Katherine',
        lastName: 'Johnson',
        email: 'kj@example.invalid',
      },
      message: 'Client successfully created',
    });

    // The write body reached the stub exactly as the tool built it. `sendAccountEmails`
    // was not supplied, so the tool's `= true` default must have been applied.
    const [post] = stub.requestsTo('/public/v6/client/addclient', 'POST');
    expect(post.body).toEqual({
      FirstName: 'Katherine',
      LastName: 'Johnson',
      Email: 'kj@example.invalid',
      MobilePhone: '555-0130',
      BirthDate: '1990-08-26',
      Birthday: '1990-08-26',
      AddressLine1: '9 Orbit Road',
      City: 'Hampton',
      State: 'VA',
      PostalCode: '23666',
      Country: 'US',
      EmergencyContactInfoName: 'Mary Jackson',
      EmergencyContactInfoPhone: '555-0131',
      EmergencyContactInfoRelationship: 'Friend',
      MobileNumber: '555-0130',
      ReferredBy: 'MindbodyMCP',
      SendAccountEmails: true,
      Street: '9 Orbit Road',
    });
    expect(post.headers['content-type']).toBe('application/json');
  });

  itE2E('updateClient sends only the changed fields and echoes the updated record', async () => {
    stub.resetLog();

    const result = await client.callTool({
      name: 'updateClient',
      arguments: {
        clientId: STUB_FIXTURES.clientId,
        updates: {
          firstName: 'Grace B',
          city: 'Arlington Falls',
          mobilePhone: '555-0115',
          sendAccountEmails: false,
        },
      },
    });
    expect(result.isError).toBeFalsy();

    const payload = resultJson(result);
    expect(payload).toEqual({
      success: true,
      client: {
        id: STUB_FIXTURES.clientId,
        firstName: 'Grace B',
        lastName: STUB_FIXTURES.client.LastName,
        email: STUB_FIXTURES.client.Email,
      },
      message: 'Client successfully updated',
    });

    const [post] = stub.requestsTo('/public/v6/client/updateclient', 'POST');
    // UpdateClientRequest nests the fields under `Client` (a flat body is refused
    // with `Client (Code: MissingRequiredFields)`), and `CrossRegionalUpdate` must
    // be an explicit `false`: its default of true is refused by a site outside a
    // region. `lastName` was not updated, so it must not appear: the tool maps
    // only the keys present in `updates`. `sendAccountEmails: false` must
    // survive, which is why the tool tests `!== undefined` rather than truthiness.
    expect(post.body).toEqual({
      Client: {
        Id: STUB_FIXTURES.clientId,
        FirstName: 'Grace B',
        MobilePhone: '555-0115',
        City: 'Arlington Falls',
        SendAccountEmails: false,
      },
      CrossRegionalUpdate: false,
    });
  });

  itE2E('getClientVisits returns both visits and separates attended from late-cancelled', async () => {
    stub.resetLog();

    const result = await client.callTool({
      name: 'getClientVisits',
      arguments: {
        clientId: STUB_FIXTURES.clientId,
        startDate: '2026-03-01',
        endDate: '2026-03-04',
      },
    });
    expect(result.isError).toBeFalsy();

    const payload = resultJson(result);
    expect(payload.totalVisits).toBe(2);
    expect(payload.visits[0]).toMatchObject({
      id: STUB_FIXTURES.visitAttended.Id,
      classId: 101,
      className: 'Vinyasa Flow',
      startTime: '2026-03-02T09:00:00',
      endTime: '2026-03-02T10:00:00',
      location: 'E2E Main Studio',
      instructor: 'Ada Lovelace',
      signedIn: true,
      webSignup: false,
      lateCancel: false,
      serviceId: 5,
      serviceName: 'Drop-in',
    });
    expect(payload.visits[1]).toMatchObject({
      id: STUB_FIXTURES.visitLateCancelled.Id,
      signedIn: false,
      webSignup: true,
      lateCancel: true,
      location: 'E2E Annex',
    });

    // The summary is computed by the tool from SignedIn/LateCancelled. Three
    // distinct counts, so a fixture with only one flag set cannot pass.
    expect(payload.summary.totalAttended).toBe(1);
    expect(payload.summary.totalLateCancels).toBe(1);
    expect(payload.summary.totalNoShows).toBe(0);
    // Only attended visits feed the roll-ups.
    expect(payload.summary.byLocation).toEqual({ 'E2E Main Studio': 1 });
    expect(payload.summary.byClassType).toEqual({ 'Vinyasa Flow': 1 });
    expect(payload.summary.byInstructor).toEqual({ 'Ada Lovelace': 1 });

    const [request] = stub.requestsTo(CLIENT_VISITS_PATH, 'GET');
    expect(request.query.ClientId).toBe(STUB_FIXTURES.clientId);
    expect(request.query.StartDate).toBe('2026-03-01');
    expect(request.query.EndDate).toBe('2026-03-04');
    expect(request.query.Limit).toBe('200');
  });

  itE2E('getClientAccountBalances returns the balance and each stored card', async () => {
    stub.resetLog();

    const result = await client.callTool({
      name: 'getClientAccountBalances',
      arguments: { clientId: STUB_FIXTURES.clientId },
    });
    expect(result.isError).toBeFalsy();

    // Note the negative: a truthiness bug (`balance || 0`) would turn -42.5 into 0.
    // One stored card, not a list: the API has no per-card balance to report.
    expect(resultJson(result)).toEqual({
      accountBalance: -42.5,
      creditCard: { cardType: 'Visa', lastFour: '4242' },
    });

    const [request] = stub.requestsTo('/public/v6/client/clientaccountbalances', 'GET');
    expect(request.query['ClientIds[]']).toBe(STUB_FIXTURES.clientId);
  });

  itE2E('addClientArrival POSTs the check-in and reports arrivalAdded', async () => {
    stub.resetLog();

    const result = await client.callTool({
      name: 'addClientArrival',
      arguments: { clientId: STUB_FIXTURES.clientId, locationId: 1 },
    });
    expect(result.isError).toBeFalsy();
    expect(resultJson(result)).toEqual({
      success: true,
      arrivalAdded: true,
      message: 'Client checked in successfully',
    });

    const posts = stub.requestsTo('/public/v6/client/addarrival', 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ ClientId: STUB_FIXTURES.clientId, LocationId: 1 });
  });
});

describe('domain — orders (read and write)', () => {
  itE2E('getPackages sums classCount and price from the bundled services', async () => {
    stub.resetLog();

    const result = await client.callTool({ name: 'getPackages', arguments: { locationId: 1 } });
    expect(result.isError).toBeFalsy();

    const payload = resultJson(result);
    expect(payload.totalPackages).toBe(1);
    // A `Package` has no Count/Price of its own: both are summed from Services[].
    expect(payload.packages[0]).toEqual({
      id: 601,
      name: 'Unlimited Month',
      discountPercentage: 0,
      classCount: 10,
      price: 149,
      sellOnline: true,
      services: [
        {
          id: 501,
          name: '10 Class Pack',
          count: 10,
          price: 149,
          onlinePrice: 149,
        },
      ],
      products: [{ id: 701, name: 'Cork Yoga Mat' }],
    });

    const [request] = stub.requestsTo('/public/v6/sale/packages', 'GET');
    expect(request.query.LocationId).toBe('1');
    expect(request.query.Limit).toBe('200');
  });

  itE2E('getProducts maps the descriptions, category ids and colour/size objects', async () => {
    stub.resetLog();

    const result = await client.callTool({
      name: 'getProducts',
      arguments: { searchText: 'mat' },
    });
    expect(result.isError).toBeFalsy();

    const payload = resultJson(result);
    // The total comes from PaginationResponse, not from the array length.
    expect(payload.totalProducts).toBe(1);
    expect(payload.products).toHaveLength(1);
    // Categories are ids, not names: the API returns no category names.
    expect(payload.products[0]).toEqual({
      id: 701,
      name: 'Cork Yoga Mat',
      price: 60,
      onlinePrice: 55,
      description: 'Natural cork, three-ply',
      longDescription: 'A three-ply natural cork mat, 4mm thick.',
      categoryId: 32,
      subCategoryId: 33,
      color: 'Natural',
      size: 'Standard',
      // The spec's TaxIncluded is the tax AMOUNT, not a flag.
      taxIncludedAmount: 0,
      taxRate: 0.07,
    });

    const [request] = stub.requestsTo('/public/v6/sale/products', 'GET');
    expect(request.query.SearchText).toBe('mat');
    expect(request.query.Limit).toBe('200');
  });

  itE2E('getContracts flattens the autopay schedule and the intro offer', async () => {
    stub.resetLog();

    // locationId is required: the endpoint answers 400 without it.
    const result = await client.callTool({
      name: 'getContracts',
      arguments: { locationId: 1, soldOnline: true },
    });
    expect(result.isError).toBeFalsy();

    const payload = resultJson(result);
    expect(payload.totalContracts).toBe(1);
    expect(payload.contracts[0]).toEqual({
      id: 801,
      name: 'Gold Unlimited',
      description: 'Gold tier membership',
      assignsMembershipId: 77,
      assignsMembershipName: 'Gold Membership',
      soldOnline: true,
      agreementTerms: 'Cancel with 30 days notice',
      // The spec's AutopaySchedule is {FrequencyType, FrequencyValue,
      // FrequencyTimeUnit}; the money lives on the contract, not on the schedule.
      autopaySchedule: {
        frequencyType: 'Monthly',
        frequencyValue: 1,
        frequencyTimeUnit: 'Month',
        recurringPaymentAmountTotal: 149,
      },
      // IntroOffer is a string, not an object.
      introOffer: 'NewAndReturningConsumer',
    });

    const [request] = stub.requestsTo('/public/v6/sale/contracts', 'GET');
    expect(request.query.SoldOnline).toBe('true');
    expect(request.query.LocationId).toBe('1');
    expect(request.query.Limit).toBe('200');
  });

  itE2E('checkoutShoppingCart builds the item and payment bodies and returns the cart', async () => {
    stub.resetLog();

    const result = await client.callTool({
      name: 'checkoutShoppingCart',
      arguments: {
        clientId: STUB_FIXTURES.clientId,
        items: [
          { item: { type: 'Service', metadata: { id: 501 } }, quantity: 1 },
          { item: { type: 'Product', metadata: { id: 701 } }, quantity: 2 },
        ],
        payments: [{ type: 'CreditCard', metadata: { amount: 260, lastFour: '4242' } }],
        promotionCode: 'E2E-SPRING',
        locationId: 1,
      },
    });
    expect(result.isError).toBeFalsy();

    const payload = resultJson(result);
    expect(payload.success).toBe(true);
    expect(payload.message).toBe('Checkout completed successfully');
    // `CartItem` carries {Item, DiscountAmount, Quantity, Id, VisitIds,
    // AppointmentIds, Appointments}: name and price live on `Item`, and there is no
    // server line tax, so `taxRate` is passed through raw rather than invented.
    expect(payload.shoppingCart).toEqual({
      id: 'cart-1',
      subTotal: 280,
      taxTotal: 0,
      discountTotal: 20,
      grandTotal: 260,
      // `price`/`name` come from `Item`; `total` is price × quantity − discount.
      // `appointments` is empty here because this cart reconciled nothing.
      items: [
        {
          id: 'ci-1',
          name: '10 Class Pack',
          price: 220,
          quantity: 1,
          discountAmount: 20,
          taxRate: 0,
          total: 200,
          appointments: [],
        },
        {
          id: 'ci-2',
          name: 'Cork Yoga Mat',
          price: 60,
          quantity: 1,
          discountAmount: 0,
          taxRate: 0,
          total: 60,
          appointments: [],
        },
      ],
    });
    expect(payload.appointments).toEqual([
      {
        id: 8002,
        status: 'Booked',
        startDateTime: '2026-03-05T10:00:00',
        endDateTime: '2026-03-05T11:00:00',
        notes: 'Booked via cart',
      },
    ]);

    // The write body is the interesting part: it proves the tool's camelCase ->
    // PascalCase item and payment mapping ran, not just that a POST happened.
    const [post] = stub.requestsTo('/public/v6/sale/checkoutshoppingcart', 'POST');
    expect(post.body).toEqual({
      ClientId: STUB_FIXTURES.clientId,
      Items: [
        { Quantity: 1, Item: { Type: 'Service', Metadata: { Id: 501 } } },
        { Quantity: 2, Item: { Type: 'Product', Metadata: { Id: 701 } } },
      ],
      Payments: [
        { Type: 'CreditCard', Metadata: { Amount: 260 } },
      ],
      // Not supplied by the caller, so both must fall back to the tool defaults.
      InStore: false,
      SendEmail: true,
      PromotionCode: 'E2E-SPRING',
      LocationId: 1,
    });
  });

  itE2E('purchaseContract sends FirstPaymentOccurs=StartDate by default and echoes the contract', async () => {
    stub.resetLog();

    const result = await client.callTool({
      name: 'purchaseContract',
      arguments: {
        clientId: STUB_FIXTURES.clientId,
        contractId: 801,
        startDate: '2026-04-01',
        clientSignature: 'Grace B',
      },
    });
    expect(result.isError).toBeFalsy();

    const payload = resultJson(result);
    expect(payload.success).toBe(true);
    expect(payload.message).toBe('Contract purchased successfully');
    // The spec's PurchaseContractResponse is FLAT: {ClientId, UniqueClientId,
    // LocationId, ContractId, ClientContractId, Totals, PaymentProcessingFailures}.
    // There is no nested ClientContract object, so reading one is what used to
    // make a committed purchase report `success: false`.
    expect(payload.clientContract).toEqual({
      id: 902,
      clientId: STUB_FIXTURES.clientId,
      contractId: 801,
      locationId: 1,
      subTotal: 149,
      tax: 0,
      total: 149,
    });

    const [post] = stub.requestsTo('/public/v6/sale/purchasecontract', 'POST');
    expect(post.body).toEqual({
      ClientId: STUB_FIXTURES.clientId,
      ContractId: 801,
      StartDate: '2026-04-01',
      // The caller omitted firstPaymentOccurs; the tool must default it.
      FirstPaymentOccurs: 'StartDate',
      ClientSignature: 'Grace B',
    });
  });

  itE2E('checkoutShoppingCart sends AppointmentIds and lists the reconciled appointment', async () => {
    stub.resetLog();
    const appointmentId = CANCELLATION_FIXTURES.futureBookedA;
    const fixture = cancellationFixture(appointmentId);

    const result = await client.callTool({
      name: 'checkoutShoppingCart',
      arguments: {
        clientId: CANCELLATION_FIXTURES.clientId,
        items: [
          { item: { type: 'Service', metadata: { id: 501 } }, quantity: 1, appointmentIds: [appointmentId] },
        ],
        payments: [{ type: 'Cash', metadata: { amount: 220 } }],
      },
    });
    expect(result.isError).toBeFalsy();

    const payload = resultJson(result);
    expect(payload.success).toBe(true);
    expect(payload.shoppingCart.items).toHaveLength(1);
    // The id is the cart item's own id; the item it buys is on `itemId`.
    expect(payload.shoppingCart.items[0].id).toBe('ci-1');
    expect(payload.shoppingCart.items[0].appointments).toEqual([appointmentId]);
    expect(payload.appointments).toEqual([
      {
        id: appointmentId,
        status: 'Booked',
        startDateTime: fixture.StartDateTime,
        endDateTime: fixture.EndDateTime,
      },
    ]);

    const [post] = stub.requestsTo('/public/v6/sale/checkoutshoppingcart', 'POST');
    expect(post.body).toEqual({
      ClientId: CANCELLATION_FIXTURES.clientId,
      Items: [
        { Quantity: 1, Item: { Type: 'Service', Metadata: { Id: 501 } }, AppointmentIds: [appointmentId] },
      ],
      Payments: [{ Type: 'Cash', Metadata: { Amount: 220 } }],
      InStore: false,
      SendEmail: true,
    });
  });
});

describe('domain — appointments (read and write)', () => {
  itE2E('getStaffAppointments flattens staff, session, location and client', async () => {
    stub.resetLog();

    const result = await client.callTool({
      name: 'getStaffAppointments',
      arguments: {
        staffIds: [42],
        locationIds: [1],
        startDate: '2026-03-05',
        endDate: '2026-03-06',
      },
    });
    expect(result.isError).toBeFalsy();

    const payload = resultJson(result);
    // totalAppointments is read from PaginationResponse.TotalResults.
    expect(payload.totalAppointments).toBe(1);
    expect(payload.appointments).toHaveLength(1);
    // An `Appointment` carries only `ClientId`: no client object, so there is no
    // clientName/Email/Phone to report. `confirmed` is derived from Status, because
    // there is no `Confirmed` field. `sessionTypeName` and `locationName` are
    // resolved from the /site/sessiontypes and /site/locations catalogues.
    expect(payload.appointments[0]).toEqual({
      id: 8001,
      status: 'Confirmed',
      staffId: 42,
      staffName: 'Ada Lovelace',
      sessionTypeId: 9,
      sessionTypeName: 'Personal Training',
      locationId: 1,
      locationName: 'E2E Main Studio',
      startDateTime: '2026-03-05T10:00:00',
      endDateTime: '2026-03-05T11:00:00',
      clientId: STUB_FIXTURES.clientId,
      notes: 'Bring a mat',
      staffRequested: true,
      providerId: 'prov-1',
      duration: 60,
      confirmed: true,
      firstAppointment: false,
    });

    const [request] = stub.requestsTo('/public/v6/appointment/staffappointments', 'GET');
    expect(request.query['StaffIds[]']).toBe('42');
    expect(request.query['LocationIds[]']).toBe('1');
    expect(request.query.StartDate).toBe('2026-03-05');
    expect(request.query.EndDate).toBe('2026-03-06');
    expect(request.query.Limit).toBe('200');
  });

  itE2E('getStaffAppointments defaults its date window to the site calendar date', async () => {
    stub.resetLog();
    // Bracket the call, so a site midnight passing mid-test cannot flake it.
    const before = siteDateString(new Date(), STUB_FIXTURES.siteTimeZone);
    const result = await client.callTool({
      name: 'getStaffAppointments',
      arguments: { staffIds: [42] },
    });
    const after = siteDateString(new Date(), STUB_FIXTURES.siteTimeZone);
    expect(result.isError).toBeFalsy();

    const [request] = stub.requestsTo(STAFF_APPOINTMENTS_PATH, 'GET');
    expect([before, after]).toContain(request.query.StartDate);
    const start = request.query.StartDate;
    expect(request.query.EndDate).toBe(addDays(start, 7));
  });

  itE2E('getBookableItems returns the bookable slot for the session type', async () => {
    stub.resetLog();

    const result = await client.callTool({
      name: 'getBookableItems',
      arguments: {
        sessionTypeIds: [9],
        locationIds: [1],
        startDate: '2026-03-08',
        endDate: '2026-03-09',
      },
    });
    expect(result.isError).toBeFalsy();

    const payload = resultJson(result);
    expect(payload.totalItems).toBe(1);
    expect(payload.bookableItems[0]).toEqual({
      scheduledItemId: 3001,
      staffId: 42,
      staffName: 'Ada Lovelace',
      sessionTypeId: 9,
      sessionTypeName: 'Personal Training',
      locationId: 1,
      locationName: 'E2E Main Studio',
      startDateTime: '2026-03-08T09:00:00',
      endDateTime: '2026-03-08T10:00:00',
      isAvailable: true,
      isSingleSessionBookable: true,
    });

    const [request] = stub.requestsTo('/public/v6/appointment/bookableitems', 'GET');
    expect(request.query['SessionTypeIds[]']).toBe('9');
    expect(request.query['LocationIds[]']).toBe('1');
    expect(request.query.StartDate).toBe('2026-03-08');
    expect(request.query.EndDate).toBe('2026-03-09');
    expect(request.query.Limit).toBe('200');
  });

  itE2E('getActiveSessionTimes returns the plain time strings, overall and per session type', async () => {
    stub.resetLog();

    const result = await client.callTool({
      name: 'getActiveSessionTimes',
      arguments: {
        scheduleType: 'Appointment',
        sessionTypeIds: [23, 9],
        startTime: '06:00:00',
        endTime: '08:00:00',
        days: ['Monday', 'Tuesday'],
      },
    });
    expect(result.isError).toBeFalsy();

    const payload = resultJson(result);
    expect(payload).toEqual({
      activeTimes: ['06:00:00', '06:30:00', '07:00:00', '07:30:00'],
      bySessionType: [
        { sessionTypeId: 23, activeTimes: ['06:00:00', '06:30:00', '07:00:00'] },
        { sessionTypeId: 9, activeTimes: ['07:00:00', '07:30:00'] },
      ],
      totalActiveTimes: 4,
    });

    const [request] = stub.requestsTo('/public/v6/appointment/activesessiontimes', 'GET');
    expect(request.query.ScheduleType).toBe('Appointment');
    expect(request.queryAll['SessionTypeIds[]']).toEqual(['23', '9']);
    expect(request.query.StartTime).toBe('06:00:00');
    expect(request.query.EndTime).toBe('08:00:00');
    // `Days` is not a parameter of this endpoint and the sandbox ignores an
    // unknown one silently, so the tool must not send it at all.
    expect(request.queryAll['Days[]']).toBeUndefined();
    expect(request.query.Days).toBeUndefined();
  });

  itE2E('addAppointment POSTs the booking and surfaces the response message', async () => {
    stub.resetLog();

    const result = await client.callTool({
      name: 'addAppointment',
      arguments: {
        clientId: STUB_FIXTURES.clientId,
        staffId: 42,
        locationId: 1,
        sessionTypeId: 9,
        startDateTime: '2026-03-06T09:00:00',
        notes: 'First session',
        sendEmail: true,
      },
    });
    expect(result.isError).toBeFalsy();

    const payload = resultJson(result);
    expect(payload.success).toBe(true);
    // The stub's own Message, not the tool's fallback default.
    expect(payload.message).toBe('Appointment created for Grace');
    expect(payload.appointment).toEqual({
      id: 8003,
      status: 'Booked',
      startDateTime: '2026-03-06T09:00:00',
      endDateTime: '2026-03-06T10:00:00',
      duration: 60,
      staffName: 'Ada Lovelace',
      // The booked Appointment carries SessionTypeId/LocationId, not the objects,
      // so the ids are returned rather than names the response never sent.
      sessionTypeId: 9,
      locationId: 1,
    });

    const [post] = stub.requestsTo('/public/v6/appointment/addappointment', 'POST');
    expect(post.body).toEqual({
      ClientId: STUB_FIXTURES.clientId,
      StaffId: 42,
      LocationId: 1,
      SessionTypeId: 9,
      StartDateTime: '2026-03-06T09:00:00',
      Notes: 'First session',
      SendEmail: true,
    });
  });

  itE2E('updateAppointment moves the appointment and reports the new status', async () => {
    stub.resetLog();
    const appointmentId = CANCELLATION_FIXTURES.futureBookedA;

    const result = await client.callTool({
      name: 'updateAppointment',
      arguments: {
        clientId: CANCELLATION_FIXTURES.clientId,
        appointmentId,
        staffId: 42,
        startDateTime: '2026-03-07T14:00:00',
        notes: 'Moved to afternoon',
      },
    });
    expect(result.isError).toBeFalsy();

    const payload = resultJson(result);
    expect(payload.success).toBe(true);
    expect(payload.rejected).toEqual([]);
    expect(payload.message).toBe('Appointment updated successfully');
    expect(payload.appointment).toMatchObject({
      id: appointmentId,
      startDateTime: '2026-03-07T14:00:00',
      staffName: 'Ada Lovelace',
    });

    // The ownership lookup happens before the write, and is scoped to this client.
    const lookups = stub.requestsTo(STAFF_APPOINTMENTS_PATH, 'GET');
    expect(lookups).toHaveLength(1);
    expect(lookups[0].query.ClientId).toBe(CANCELLATION_FIXTURES.clientId);

    const [post] = stub.requestsTo('/public/v6/appointment/updateappointment', 'POST');
    expect(post.body).toEqual({
      AppointmentId: appointmentId,
      StaffId: 42,
      StartDateTime: '2026-03-07T14:00:00',
      Notes: 'Moved to afternoon',
    });
  });

  itE2E("updateAppointment refuses another client's appointment and makes no write", async () => {
    stub.resetLog();
    const appointmentId = CANCELLATION_FIXTURES.otherClientFutureBooked;

    const result = await client.callTool({
      name: 'updateAppointment',
      arguments: {
        clientId: CANCELLATION_FIXTURES.clientId,
        appointmentId,
        notes: 'Overwritten',
        execute: 'complete',
      },
    });
    expect(result.isError).toBeFalsy();

    const payload = resultJson(result);
    expect(payload.success).toBe(false);
    expect(payload.rejected).toEqual([{ id: appointmentId, reason: 'not found for this client' }]);
    // The other client's id is never echoed back as a fact about them.
    expect(JSON.stringify(payload)).not.toContain(CANCELLATION_FIXTURES.otherClientId);
    expect(stub.requestsTo(UPDATE_APPOINTMENT_PATH, 'POST')).toHaveLength(0);
  });

  itE2E('updateAppointment with execute arrive sends Execute and reports Arrived', async () => {
    stub.resetLog();
    const appointmentId = CANCELLATION_FIXTURES.futureBookedC;

    const result = await client.callTool({
      name: 'updateAppointment',
      arguments: { clientId: CANCELLATION_FIXTURES.clientId, appointmentId, execute: 'arrive' },
    });
    expect(result.isError).toBeFalsy();

    const payload = resultJson(result);
    expect(payload.success).toBe(true);
    expect(payload.appointment.id).toBe(appointmentId);
    expect(payload.appointment.status).toBe('Arrived');

    const posts = stub.requestsTo(UPDATE_APPOINTMENT_PATH, 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ AppointmentId: appointmentId, Execute: 'arrive' });
  });

  itE2E('updateAppointment refuses execute cancel and makes no API call', async () => {
    stub.resetLog();

    const result = await client.callTool({
      name: 'updateAppointment',
      arguments: {
        clientId: CANCELLATION_FIXTURES.clientId,
        appointmentId: CANCELLATION_FIXTURES.futureBookedA,
        execute: 'cancel',
      },
    });
    expect(result.isError).toBeFalsy();

    const payload = resultJson(result);
    expect(payload.success).toBe(false);
    expect(payload.message).toContain('cancelAppointments');
    expect(apiRequestsOf(stub)).toHaveLength(0);
  });

  itE2E('cancelAppointments verifies, then cancels each appointment in turn', async () => {
    stub.resetLog();
    const ids = [CANCELLATION_FIXTURES.futureBookedA, CANCELLATION_FIXTURES.futureBookedB];

    const result = await client.callTool({
      name: 'cancelAppointments',
      arguments: { clientId: CANCELLATION_FIXTURES.clientId, appointmentIds: ids },
    });
    expect(result.isError).toBeFalsy();

    const payload = resultJson(result);
    expect(payload.success).toBe(true);
    expect(payload.rejected).toEqual([]);
    expect(payload.cancelled).toEqual(
      ids.map((id) => ({
        id,
        status: 'Cancelled',
        startDateTime: cancellationFixture(id).StartDateTime,
      }))
    );

    // The lookup is scoped to the one client and exactly the requested ids.
    const lookups = stub.requestsTo(STAFF_APPOINTMENTS_PATH, 'GET');
    expect(lookups).toHaveLength(1);
    expect(lookups[0].query.ClientId).toBe(CANCELLATION_FIXTURES.clientId);
    expect(lookups[0].queryAll['AppointmentIds[]']).toEqual(ids.map(String));
    expect(lookups[0].query.StaffIds).toBeUndefined();

    const posts = stub.requestsTo(UPDATE_APPOINTMENT_PATH, 'POST');
    expect(posts.map((post) => post.body)).toEqual(
      ids.map((id) => ({ AppointmentId: id, Execute: 'cancel', SendEmail: false }))
    );

    // The site timezone came from GET /site/sites before any cancellation was
    // written. The server caches the site record for 60 minutes, so the fetch
    // may belong to an earlier call; the session log survives resetLog().
    const session = stub.sessionRequests;
    const firstSiteFetch = session.findIndex(
      (request) => request.method === 'GET' && request.path === SITE_SITES_PATH
    );
    const firstCancelWrite = session.findIndex(
      (request) =>
        request.method === 'POST' &&
        request.path === UPDATE_APPOINTMENT_PATH &&
        ['cancel', 'latecancel'].includes(String((request.body as any)?.Execute))
    );
    expect(firstSiteFetch).toBeGreaterThanOrEqual(0);
    expect(firstCancelWrite).toBeGreaterThan(firstSiteFetch);
    // In this call, the lookup window starts on the SITE's date, not the host's.
    expect(lookups[0].query.StartDate).toBe(
      siteDateString(new Date(), STUB_FIXTURES.siteTimeZone)
    );
  });

  itE2E('cancelAppointments rejects a cross-client id and cancels nothing', async () => {
    stub.resetLog();
    const foreign = CANCELLATION_FIXTURES.otherClientFutureBooked;

    const result = await client.callTool({
      name: 'cancelAppointments',
      arguments: {
        clientId: CANCELLATION_FIXTURES.clientId,
        appointmentIds: [CANCELLATION_FIXTURES.futureBookedA, foreign],
      },
    });
    expect(result.isError).toBeFalsy();

    const payload = resultJson(result);
    expect(payload.success).toBe(false);
    expect(payload.cancelled).toEqual([]);
    expect(payload.rejected).toEqual([{ id: foreign, reason: 'not found for this client' }]);
    // The owning client is never disclosed.
    expect(resultText(result)).not.toContain(CANCELLATION_FIXTURES.otherClientId);
    expect(stub.countTo(UPDATE_APPOINTMENT_PATH, 'POST')).toBe(0);
  });

  itE2E('cancelAppointments rejects past and already-cancelled appointments with no writes', async () => {
    stub.resetLog();

    const result = await client.callTool({
      name: 'cancelAppointments',
      arguments: {
        clientId: CANCELLATION_FIXTURES.clientId,
        appointmentIds: [CANCELLATION_FIXTURES.past, CANCELLATION_FIXTURES.futureCancelled],
      },
    });
    const payload = resultJson(result);
    expect(payload.success).toBe(false);
    expect(payload.rejected).toEqual([
      // Three days back is outside the today-onwards lookup window.
      { id: CANCELLATION_FIXTURES.past, reason: 'not found for this client' },
      {
        id: CANCELLATION_FIXTURES.futureCancelled,
        reason: 'appointment status is Cancelled, which cannot be cancelled',
      },
    ]);
    expect(stub.countTo(UPDATE_APPOINTMENT_PATH, 'POST')).toBe(0);
  });

  itE2E('cancelAppointments rejects more than three ids before any request', async () => {
    stub.resetLog();

    const result = await client.callTool({
      name: 'cancelAppointments',
      arguments: { clientId: CANCELLATION_FIXTURES.clientId, appointmentIds: [9001, 9002, 9003, 9004] },
    });
    const payload = resultJson(result);
    expect(payload.success).toBe(false);
    expect(payload.rejected).toHaveLength(1);
    expect(payload.rejected[0].id).toBe(-1);
    expect(apiRequestsOf(stub)).toHaveLength(0);
  });
});

describe('pagination — multi-page walks through the real server', () => {
  itE2E('getClasses walks /class/classes across every capped page and returns the full set', async () => {
    stub.resetLog();

    const result = await client.callTool({
      name: 'getClasses',
      arguments: { startDate: '2026-03-09', endDate: '2026-03-15' },
    });
    expect(result.isError).toBeFalsy();

    // 7 classes at a page cap of 3: three GETs, Offset advancing by rows received.
    expect(STUB_CLASSES).toHaveLength(7);
    expect(STUB_PAGE_CAPS.classes).toBe(3);
    const requests = stub.requestsTo(CLASSES_PATH, 'GET');
    expect(requests.map((request) => request.query.Offset)).toEqual(['0', '3', '6']);
    expect(requests.map((request) => request.query.Limit)).toEqual(['200', '200', '200']);
    for (const request of requests) {
      expect(request.query.StartDateTime).toBe('2026-03-09T00:00:00');
      expect(request.query.EndDateTime).toBe('2026-03-15T23:59:59');
    }

    const payload = resultJson(result);
    expect(payload.classes.map((cls: any) => cls.id)).toEqual([101, 102, 103, 104, 105, 106, 107]);
    expect(payload.classes[3]).toMatchObject({
      id: 104,
      name: 'Vinyasa Flow',
      instructor: 'Charles Babbage',
      startTime: '2026-03-12T09:00:00',
      location: 'E2E Main Studio',
      spotsAvailable: 12,
      totalSpots: 20,
    });
    expect(payload.summary.totalClasses).toBe(7);
    expect(payload.summary.byInstructor).toEqual({ 'Ada Lovelace': 6, 'Charles Babbage': 1 });
    // Sum of (20 - (5 + i)) for i = 0..6 = 7 * 15 - 21. Only right if all three pages were read.
    expect(payload.summary.totalAvailableSpots).toBe(84);
  });

  itE2E('getTeacherSchedule finds a teacher on staff page two and reads every page of her classes', async () => {
    stub.resetLog();

    const result = await client.callTool({
      name: 'getTeacherSchedule',
      arguments: { teacherName: 'Ada Lovelace', startDate: '2026-03-09', endDate: '2026-03-15' },
    });
    expect(result.isError).toBeFalsy();

    // /staff/staff serves one row per page and Ada is the second row: a
    // page-one-only read would report "Teacher not found".
    const staffRequests = stub.requestsTo(STAFF_PATH, 'GET');
    expect(staffRequests.map((request) => request.query.Offset)).toEqual(['0', '1']);
    expect(staffRequests.map((request) => request.query.Limit)).toEqual(['200', '200']);

    // Ada teaches 6 of the 7 classes: two capped pages, filtered by her id.
    const classRequests = stub.requestsTo(CLASSES_PATH, 'GET');
    expect(classRequests.map((request) => request.query.Offset)).toEqual(['0', '3']);
    for (const request of classRequests) {
      expect(request.queryAll['StaffIds[]']).toEqual(['42']);
    }

    const payload = resultJson(result);
    expect(payload.teacher).toEqual({ id: 42, name: 'Ada Lovelace', email: 'ada@example.invalid' });
    expect(payload.totalClasses).toBe(6);
    expect(payload.classes.map((cls: any) => cls.id)).toEqual([101, 102, 103, 105, 106, 107]);
    expect(payload.classes[0]).toMatchObject({ duration: 60, location: 'E2E Main Studio' });
  });

  itE2E('getClassDescriptions reads /class/classdescriptions through the pager', async () => {
    stub.resetLog();

    const result = await client.callTool({ name: 'getClassDescriptions', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(resultJson(result)).toEqual({
      classTypes: [
        { id: 10, name: 'Vinyasa Flow', description: 'A dynamic class', imageUrl: 'https://example.invalid/v.png', prerequisites: 'None', level: 'All Levels' },
        { id: 11, name: 'Power Reformer', description: 'Reformer strength', prerequisites: 'Intro to Reformer', level: 'Intermediate' },
      ],
      totalTypes: 2,
    });

    const requests = stub.requestsTo('/public/v6/class/classdescriptions', 'GET');
    expect(requests).toHaveLength(1);
    expect(requests[0].query.Limit).toBe('200');
    expect(requests[0].query.Offset).toBe('0');
  });

  itE2E('getWaitlistEntries reads /class/waitlistentries through the pager', async () => {
    stub.resetLog();

    const result = await client.callTool({ name: 'getWaitlistEntries', arguments: { classIds: [101] } });
    expect(result.isError).toBeFalsy();
    const payload = resultJson(result);
    expect(payload.totalEntries).toBe(1);
    expect(payload.entries[0]).toMatchObject({ classId: 101, classDate: '2026-03-09T00:00:00' });

    const [request] = stub.requestsTo('/public/v6/class/waitlistentries', 'GET');
    expect(request.queryAll['ClassIds[]']).toEqual(['101']);
    expect(request.query.Limit).toBe('200');
    expect(request.query.Offset).toBe('0');
  });

  itE2E('getClassSchedules reads /class/classschedules through the pager', async () => {
    stub.resetLog();

    const result = await client.callTool({ name: 'getClassSchedules', arguments: { locationIds: [1] } });
    expect(result.isError).toBeFalsy();
    const payload = resultJson(result);
    expect(payload.totalSchedules).toBe(1);
    expect(payload.schedules[0]).toMatchObject({
      id: 301,
      className: 'Vinyasa Flow',
      instructor: 'Ada Lovelace',
      location: 'E2E Main Studio',
      startTime: '09:00:00',
      endTime: '10:00:00',
      startDate: '2026-01-05',
      endDate: '2026-12-28',
    });

    const [request] = stub.requestsTo('/public/v6/class/classschedules', 'GET');
    expect(request.queryAll['LocationIds[]']).toEqual(['1']);
    expect(request.query.Limit).toBe('200');
    expect(request.query.Offset).toBe('0');
  });

  itE2E('getLocations and getPrograms read the site catalogue through the pager', async () => {
    stub.resetLog();

    const locations = resultJson(await client.callTool({ name: 'getLocations', arguments: {} }));
    // Two rows: the main studio and the annex, which `getClientVisits` needs in
    // order to resolve a visit's LocationId to a name.
    expect(locations.totalLocations).toBe(2);
    expect(locations.locations[0]).toMatchObject({
      id: 1,
      name: 'E2E Main Studio',
      hasClasses: true,
      address: '1 Loopback Lane',
      city: 'Localhost',
      state: 'CA',
      postalCode: '90000',
      phone: '555-0100',
    });

    const programs = resultJson(await client.callTool({ name: 'getPrograms', arguments: { scheduleType: 'Class' } }));
    expect(programs).toEqual({
      programs: [{ id: 3, name: 'Yoga', scheduleType: 'Class', cancelOffset: 12, contentFormats: ['InPerson'] }],
      totalPrograms: 1,
    });

    for (const path of ['/public/v6/site/locations', '/public/v6/site/programs']) {
      const [request] = stub.requestsTo(path, 'GET');
      expect(request.query.Limit).toBe('200');
      expect(request.query.Offset).toBe('0');
    }
    expect(stub.requestsTo('/public/v6/site/programs', 'GET')[0].query.ScheduleType).toBe('Class');
  });

  itE2E('getClientMemberships reads /client/activeclientmemberships through the pager', async () => {
    stub.resetLog();

    const result = await client.callTool({
      name: 'getClientMemberships',
      arguments: { clientId: STUB_FIXTURES.clientId },
    });
    expect(result.isError).toBeFalsy();
    const payload = resultJson(result);
    expect(payload.totalMemberships).toBe(1);
    expect(payload.memberships[0]).toMatchObject({
      id: 6601,
      name: 'Gold Membership',
      remainingClasses: 8,
      activeDate: '2026-03-01T00:00:00',
      expirationDate: '2026-09-01T00:00:00',
      siteId: -99,
    });

    const [request] = stub.requestsTo('/public/v6/client/activeclientmemberships', 'GET');
    expect(request.query.ClientId).toBe(STUB_FIXTURES.clientId);
    expect(request.query.Limit).toBe('200');
    expect(request.query.Offset).toBe('0');
  });

  itE2E('getClientEnrollments resolves schedule visits to classes and keeps only Enrollment-program sessions', async () => {
    stub.resetLog();

    const today = siteDateString(new Date(), STUB_FIXTURES.siteTimeZone);
    const end = addDays(today, 30);
    const result = await client.callTool({
      name: 'getClientEnrollments',
      arguments: { clientId: STUB_FIXTURES.clientId, startDate: today, endDate: end },
    });
    expect(result.isError).toBeFalsy();

    const sessionAt = (index: number) => ENROLLMENT_FIXTURES.sessions[index].StartDateTime;
    // In the window: four booked visits (+3, +10, +17, +17 late-cancelled) and
    // the waitlisted one (+24). Left out: the past session, the appointment
    // visit, and the drop-in visit whose class (101) has no Enrollment program.
    expect(resultJson(result)).toEqual({
      enrollments: [
        {
          classScheduleId: ENROLLMENT_FIXTURES.classScheduleId,
          name: 'Six Week Boot Camp',
          programId: 10,
          programName: 'Boot Camp',
          staffId: 42,
          staffName: 'Ada Lovelace',
          locationId: 1,
          locationName: 'E2E Main Studio',
          sessions: [
            { visitId: ENROLLMENT_FIXTURES.futureVisitA, classId: 25202, startDateTime: sessionAt(1), endDateTime: ENROLLMENT_FIXTURES.sessions[1].EndDateTime, signedIn: false, lateCancelled: false, missed: false, makeUp: false, isWaitlisted: false },
            { visitId: ENROLLMENT_FIXTURES.futureVisitB, classId: 25203, startDateTime: sessionAt(2), endDateTime: ENROLLMENT_FIXTURES.sessions[2].EndDateTime, signedIn: false, lateCancelled: false, missed: false, makeUp: false, isWaitlisted: false },
            { visitId: ENROLLMENT_FIXTURES.futureVisitC, classId: 25204, startDateTime: sessionAt(3), endDateTime: ENROLLMENT_FIXTURES.sessions[3].EndDateTime, signedIn: false, lateCancelled: false, missed: false, makeUp: false, isWaitlisted: false },
            { visitId: ENROLLMENT_FIXTURES.lateCancelledVisit, classId: 25204, startDateTime: sessionAt(3), endDateTime: ENROLLMENT_FIXTURES.sessions[3].EndDateTime, signedIn: false, lateCancelled: true, missed: false, makeUp: false, isWaitlisted: false },
            { visitId: ENROLLMENT_FIXTURES.waitlistedVisit, classId: 25205, startDateTime: sessionAt(4), endDateTime: ENROLLMENT_FIXTURES.sessions[4].EndDateTime, signedIn: false, lateCancelled: false, missed: false, makeUp: false, isWaitlisted: true, waitlistEntryId: 5601 },
          ],
          totals: { sessions: 5, attended: 0, missed: 0, lateCancelled: 1, waitlisted: 1 },
        },
      ],
      totalEnrollments: 1,
      totalSessions: 5,
    });

    expect(stub.countTo('/public/v6/client/clientenrollments')).toBe(0);
    const [schedule] = stub.requestsTo(CLIENT_SCHEDULE_PATH, 'GET');
    expect(schedule.query).toMatchObject({
      ClientId: STUB_FIXTURES.clientId,
      StartDate: today,
      EndDate: end,
      IncludeWaitlistEntries: 'true',
      Limit: '200',
      Offset: '0',
    });
    const [classes] = stub.requestsTo('/public/v6/class/classes', 'GET');
    expect(classes.queryAll['ClassIds[]'].map(Number).sort()).toEqual([101, 25202, 25203, 25204, 25205]);
    expect(classes.query).toMatchObject({ StartDateTime: `${today}T00:00:00`, EndDateTime: `${end}T23:59:59`, Limit: '200', Offset: '0' });
  });
});

describe('domain — enrollments', () => {
  itE2E('getEnrollments maps GET /enrollment/enrollments ClassSchedule rows and sends only spec filters', async () => {
    stub.resetLog();
    const result = await client.callTool({
      name: 'getEnrollments',
      arguments: { programIds: [10], startDate: '2026-10-01', endDate: '2027-03-31' },
    });
    expect(result.isError).toBeFalsy();

    const payload = resultJson(result);
    expect(payload.totalEnrollments).toBe(1);
    expect(payload.enrollments[0]).toMatchObject({
      id: ENROLLMENT_FIXTURES.classScheduleId,
      name: 'Six Week Boot Camp',
      programId: 10,
      programName: 'Boot Camp',
      sessionTypeId: 208,
      staffId: 42,
      staffName: 'Ada Lovelace',
      locationId: 1,
      locationName: 'E2E Main Studio',
      days: ['Tuesday'],
      allowOpenEnrollment: true,
      allowDateForwardEnrollment: true,
      isAvailable: true,
      startDate: ENROLLMENT_FIXTURES.schedule.StartDate,
      endDate: ENROLLMENT_FIXTURES.schedule.EndDate,
    });
    // The fabricated capacity fields of the old mapping are gone.
    expect(payload.enrollments[0]).not.toHaveProperty('maxCapacity');

    const [request] = stub.requestsTo('/public/v6/enrollment/enrollments', 'GET');
    expect(request.queryAll['ProgramIds[]']).toEqual(['10']);
    expect(request.query).toMatchObject({ StartDate: '2026-10-01', EndDate: '2027-03-31', Limit: '200', Offset: '0' });
    expect(request.query).not.toHaveProperty('SemesterIds[]');
    expect(request.query).not.toHaveProperty('CourseIds[]');
  });

  itE2E('getEnrollments defaults to today through 365 days in the site zone', async () => {
    stub.resetLog();
    const result = await client.callTool({ name: 'getEnrollments', arguments: {} });
    expect(result.isError).toBeFalsy();
    const today = siteDateString(new Date(), STUB_FIXTURES.siteTimeZone);
    const [request] = stub.requestsTo('/public/v6/enrollment/enrollments', 'GET');
    expect(request.query).toMatchObject({ StartDate: today, EndDate: addDays(today, 365) });
  });

  itE2E('addClientToEnrollment posts the spec body (singular ClassScheduleId) and returns the sessions', async () => {
    stub.resetLog();
    const forward = ENROLLMENT_FIXTURES.sessions[2].StartDateTime;
    const result = await client.callTool({
      name: 'addClientToEnrollment',
      arguments: { clientId: CANCELLATION_FIXTURES.otherClientId, classScheduleId: ENROLLMENT_FIXTURES.classScheduleId, enrollDateForward: forward, test: true },
    });
    expect(result.isError).toBeFalsy();

    const payload = resultJson(result);
    expect(payload.success).toBe(true);
    expect(payload.classScheduleId).toBe(ENROLLMENT_FIXTURES.classScheduleId);
    expect(payload.name).toBe('Six Week Boot Camp');
    expect(payload.sessions.map((s: any) => s.classId)).toEqual([25203, 25204, 25205]);
    expect(payload.message).toContain('[test]');

    const [request] = stub.requestsTo('/public/v6/enrollment/addclienttoenrollment', 'POST');
    expect(request.body).toEqual({
      ClientId: CANCELLATION_FIXTURES.otherClientId,
      ClassScheduleId: ENROLLMENT_FIXTURES.classScheduleId,
      EnrollDateForward: forward,
      Waitlist: false,
      SendEmail: false,
      Test: true,
    });
    expect(request.body).not.toHaveProperty('ClassScheduleIds');
  });

  itE2E('addClientToEnrollment with enrollOpenDates books only the listed sessions', async () => {
    stub.resetLog();
    const dates = [ENROLLMENT_FIXTURES.sessions[1].StartDateTime, ENROLLMENT_FIXTURES.sessions[3].StartDateTime];
    const result = await client.callTool({
      name: 'addClientToEnrollment',
      arguments: { clientId: CANCELLATION_FIXTURES.otherClientId, classScheduleId: ENROLLMENT_FIXTURES.classScheduleId, enrollOpenDates: dates },
    });
    expect(result.isError).toBeFalsy();
    expect(resultJson(result).sessions.map((s: any) => s.startDateTime)).toEqual(dates);
    const [request] = stub.requestsTo('/public/v6/enrollment/addclienttoenrollment', 'POST');
    expect(request.body.EnrollOpen).toEqual(dates);
  });

  itE2E('addClientToEnrollment refuses to double-book a session the client already holds', async () => {
    stub.resetLog();
    const result = await client.callTool({
      name: 'addClientToEnrollment',
      arguments: { clientId: STUB_FIXTURES.clientId, classScheduleId: ENROLLMENT_FIXTURES.classScheduleId, enrollDateForward: ENROLLMENT_FIXTURES.sessions[2].StartDateTime },
    });
    expect(result.isError).toBeFalsy();
    const payload = resultJson(result);
    expect(payload.success).toBe(false);
    // Held from that date on: futureVisitB (+10) and futureVisitC (+17). The
    // late-cancelled and waitlisted rows are not seats.
    expect(payload.message).toContain(`visit ids ${ENROLLMENT_FIXTURES.futureVisitB}, ${ENROLLMENT_FIXTURES.futureVisitC}`);
    expect(stub.countTo('/public/v6/enrollment/addclienttoenrollment')).toBe(0);
    const [lookup] = stub.requestsTo('/public/v6/enrollment/enrollments', 'GET');
    expect(lookup.queryAll['ClassScheduleIds[]']).toEqual([String(ENROLLMENT_FIXTURES.classScheduleId)]);
  });

  itE2E('addClientToEnrollment reports an unknown enrollment as success: false', async () => {
    const result = await client.callTool({
      name: 'addClientToEnrollment',
      arguments: { clientId: STUB_FIXTURES.clientId, classScheduleId: 999999 },
    });
    expect(result.isError).toBeFalsy();
    const payload = resultJson(result);
    expect(payload.success).toBe(false);
    expect(payload.message).toContain('not found');
  });

  itE2E('cancelEnrollmentVisits cancels verified future sessions via POST /class/removeclientfromclass', async () => {
    stub.resetLog();
    const result = await client.callTool({
      name: 'cancelEnrollmentVisits',
      arguments: { clientId: STUB_FIXTURES.clientId, visitIds: [ENROLLMENT_FIXTURES.futureVisitA, ENROLLMENT_FIXTURES.futureVisitB] },
    });
    expect(result.isError).toBeFalsy();
    expect(resultJson(result)).toEqual({
      success: true,
      cancelled: [
        { visitId: ENROLLMENT_FIXTURES.futureVisitA, classId: 25202, classScheduleId: ENROLLMENT_FIXTURES.classScheduleId, startDateTime: ENROLLMENT_FIXTURES.sessions[1].StartDateTime },
        { visitId: ENROLLMENT_FIXTURES.futureVisitB, classId: 25203, classScheduleId: ENROLLMENT_FIXTURES.classScheduleId, startDateTime: ENROLLMENT_FIXTURES.sessions[2].StartDateTime },
      ],
      rejected: [],
      message: 'Cancelled 2 enrollment session(s).',
    });

    // Verification first: the client's schedule from site-today, then the classes.
    const today = siteDateString(new Date(), STUB_FIXTURES.siteTimeZone);
    const [schedule] = stub.requestsTo(CLIENT_SCHEDULE_PATH, 'GET');
    expect(schedule.query).toMatchObject({ ClientId: STUB_FIXTURES.clientId, StartDate: today, EndDate: addDays(today, 730), IncludeWaitlistEntries: 'true' });
    const [classes] = stub.requestsTo('/public/v6/class/classes', 'GET');
    expect(classes.queryAll['ClassIds[]'].map(Number).sort()).toEqual([25202, 25203]);

    const writes = stub.requestsTo('/public/v6/class/removeclientfromclass', 'POST');
    expect(writes.map((w) => w.body)).toEqual([
      { ClientId: STUB_FIXTURES.clientId, ClassId: 25202, VisitId: ENROLLMENT_FIXTURES.futureVisitA, LateCancel: false, SendEmail: false, Test: false },
      { ClientId: STUB_FIXTURES.clientId, ClassId: 25203, VisitId: ENROLLMENT_FIXTURES.futureVisitB, LateCancel: false, SendEmail: false, Test: false },
    ]);
    expect(stub.countTo('/public/v6/client/updateclientvisit')).toBe(0);
  });

  itE2E('cancelEnrollmentVisits is all-or-nothing: one bad visit and nothing is written', async () => {
    stub.resetLog();
    const result = await client.callTool({
      name: 'cancelEnrollmentVisits',
      arguments: {
        clientId: STUB_FIXTURES.clientId,
        visitIds: [ENROLLMENT_FIXTURES.futureVisitA, ENROLLMENT_FIXTURES.pastVisit, ENROLLMENT_FIXTURES.dropInVisit],
      },
    });
    expect(result.isError).toBeFalsy();
    const payload = resultJson(result);
    expect(payload.success).toBe(false);
    expect(payload.cancelled).toEqual([]);
    expect(payload.rejected).toEqual([
      { visitId: ENROLLMENT_FIXTURES.pastVisit, reason: 'not found for this client' },
      { visitId: ENROLLMENT_FIXTURES.dropInVisit, reason: 'visit is a drop-in class, not an enrollment session; use removeClientFromClass' },
    ]);
    expect(stub.countTo('/public/v6/class/removeclientfromclass')).toBe(0);
  });

  itE2E('cancelEnrollmentVisits rejects a waitlist entry, a late-cancelled visit and another client\'s visit', async () => {
    stub.resetLog();
    const mine = await client.callTool({
      name: 'cancelEnrollmentVisits',
      arguments: { clientId: STUB_FIXTURES.clientId, visitIds: [ENROLLMENT_FIXTURES.waitlistedVisit, ENROLLMENT_FIXTURES.lateCancelledVisit] },
    });
    expect(resultJson(mine).rejected.map((r: any) => r.visitId)).toEqual([ENROLLMENT_FIXTURES.waitlistedVisit, ENROLLMENT_FIXTURES.lateCancelledVisit]);

    const theirs = await client.callTool({
      name: 'cancelEnrollmentVisits',
      arguments: { clientId: CANCELLATION_FIXTURES.otherClientId, visitIds: [ENROLLMENT_FIXTURES.futureVisitA] },
    });
    expect(resultJson(theirs).rejected).toEqual([{ visitId: ENROLLMENT_FIXTURES.futureVisitA, reason: 'not found for this client' }]);
    expect(stub.countTo('/public/v6/class/removeclientfromclass')).toBe(0);
  });

  itE2E('cancelEnrollmentVisits refuses more than three ids before any request', async () => {
    stub.resetLog();
    const result = await client.callTool({
      name: 'cancelEnrollmentVisits',
      arguments: { clientId: STUB_FIXTURES.clientId, visitIds: [100002, 100003, 100004, 100005] },
    });
    expect(result.isError).toBeFalsy();
    const payload = resultJson(result);
    expect(payload.success).toBe(false);
    expect(payload.rejected[0].reason).toContain('at most 3');
    expect(stub.requests.filter((r) => !r.path.endsWith('/usertoken/issue'))).toHaveLength(0);
  });
});

describe('domain — site', () => {
  itE2E('getSites maps the site record, including its IANA TimeZone', async () => {
    const result = await client.callTool({ name: 'getSites', arguments: {} });
    expect(result.isError).toBeFalsy();

    const payload = resultJson(result);
    expect(payload.site).toEqual({
      id: -99,
      name: 'E2E Stub Studio',
      description: 'Stub site for end-to-end tests',
      logoUrl: 'https://example.invalid/logo.png',
      pageColor1: '#000000',
      pageColor2: '#111111',
      pageColor3: '#222222',
      pageColor4: '#333333',
      acceptsVisa: true,
      acceptsMasterCard: true,
      acceptsDiscover: false,
      acceptsAmex: true,
      contactEmail: 'studio@example.invalid',
      taxInclusivePrices: false,
      // The spec's field is CurrencyIsoCode (surfaced as `currency`), and Site has no
      // ESI and no TotalLocations: the count is derived from GET /site/locations.
      currency: 'USD',
      countryCode: 'US',
      timeZone: 'America/Los_Angeles',
      totalLocations: 2,
    });
  });
});

describe('domain — service definitions', () => {
  itE2E('getServices maps the catalogue record the cart and contract writes buy', async () => {
    stub.resetLog();

    const result = await client.callTool({
      name: 'getServices',
      arguments: { sessionTypeIds: [9], locationId: 1 },
    });
    expect(result.isError).toBeFalsy();

    const payload = resultJson(result);
    expect(payload.totalServices).toBe(1);
    expect(payload.services[0]).toEqual({
      id: 501,
      name: '10 Class Pack',
      price: 220,
      onlinePrice: 199,
      // TaxIncluded is the tax amount the spec documents, not a flag.
      taxIncludedAmount: 25,
      taxRate: 0.07,
      programId: 3,
      count: 10,
      expirationUnit: 'Months',
      expirationLength: 6,
      membershipId: 77,
      // "High" | "Medium" | "Low" — a string in the spec.
      priority: 'High',
      // No sessionTypeId and no prerequisite: a Service has neither field.
      // Session-type applicability is the `sessionTypeIds` request filter above.
    });

    const [request] = stub.requestsTo('/public/v6/sale/services', 'GET');
    expect(request.query['SessionTypeIds[]']).toBe('9');
    expect(request.query.LocationId).toBe('1');
    // The tool's `= false` default must reach the wire.
    expect(request.query.HideRelatedPrograms).toBe('false');
    expect(request.query.Limit).toBe('200');
  });

  itE2E('getSessionTypes maps DefaultTimeLength onto defaultDuration', async () => {
    stub.resetLog();

    const result = await client.callTool({
      name: 'getSessionTypes',
      arguments: { programIds: [3] },
    });
    expect(result.isError).toBeFalsy();

    const payload = resultJson(result);
    expect(payload.totalSessionTypes).toBe(1);
    // `defaultDuration` is the tool's rename of `DefaultTimeLength`. There is no
    // `DefaultTimeLengthType` on the spec's SessionType, so no `defaultDurationType`
    // is reported; `staffTimeLength` and `resourceRequired` are the real fields.
    expect(payload.sessionTypes[0]).toEqual({
      id: 9,
      name: 'Personal Training',
      defaultDuration: 60,
      staffTimeLength: 60,
      resourceRequired: false,
      numDeducted: 1,
      programId: 3,
      category: 'Appointment',
      categoryId: 11,
      subcategory: 'One to One',
      subcategoryId: 12,
      type: 'Appointment',
    });

    const [request] = stub.requestsTo('/public/v6/site/sessiontypes', 'GET');
    expect(request.query['ProgramIds[]']).toBe('3');
    expect(request.query.OnlineOnly).toBe('false');
    expect(request.query.Limit).toBe('200');
  });
});

describe('tools/call — error handling', () => {
  itE2E('returns a proper MCP error result for an unknown tool name, without crashing', async () => {
    const result = await client.callTool({
      name: 'thisToolDoesNotExist',
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe('Unknown tool: thisToolDoesNotExist');

    // The connection survives an unknown tool.
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(EXPECTED_TOOL_NAMES.length);
  });

  itE2E('returns a clean error result when a required argument is missing', async () => {
    const result = await client.callTool({
      // clientId is required by the schema and by the tool itself.
      name: 'getClientVisits',
      arguments: {},
    });
    expect(result.isError).toBe(true);

    const text = resultText(result);
    // Mindbody's error envelope is surfaced with both its message and code,
    // rather than a stack trace or a dead transport.
    expect(text).toContain('ClientId is required');
    expect(text).toContain('InvalidParameter');
  });

  itE2E('surfaces an upstream rejection as an error result and keeps serving', async () => {
    // Deliberately a 4xx: `shouldRetry` retries only network errors and 5xx, and
    // the 5xx backoff (1s + 2s + 4s) would make this suite too slow for a
    // pre-commit hook. Retry-on-5xx is therefore NOT covered here.
    stub.setFault('GET', CLIENTS_PATH, {
      status: 400,
      body: { Error: { Code: 'BadRequest', Message: 'stub rejected the request' } },
    });
    try {
      const result = await client.callTool({ name: 'getClients', arguments: {} });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain('stub rejected the request');
      expect(resultText(result)).toContain('BadRequest');

      // Recovered: the next request goes through normally.
      stub.clearFaults();
      const recovered = await client.callTool({
        name: 'getClients',
        arguments: { searchText: 'Hopper' },
      });
      expect(recovered.isError).toBeFalsy();
      expect(resultJson(recovered).totalClients).toBe(1);
    } finally {
      stub.clearFaults();
    }
  });

  itE2E('reports a write failure as success:false rather than an error result', async () => {
    // The client/sales tools swallow the axios error and report it in-band, so a
    // failed purchase must not read as a transport error.
    stub.setFault('POST', '/public/v6/sale/purchasecontract', {
      status: 400,
      body: { Error: { Code: 'BadRequest', Message: 'contract not purchasable' } },
    });
    try {
      const result = await client.callTool({
        name: 'purchaseContract',
        arguments: {
          clientId: STUB_FIXTURES.clientId,
          contractId: 801,
          startDate: '2026-04-01',
        },
      });
      expect(result.isError).toBeFalsy();
      const payload = resultJson(result);
      expect(payload.success).toBe(false);
      expect(payload.message).toContain('contract not purchasable');
      expect(payload.message).toContain('BadRequest');
      expect(payload.clientContract).toBeUndefined();
    } finally {
      stub.clearFaults();
    }
  });
});

describe('process health', () => {
  itE2E('is still alive and answering after every call above', async () => {
    expect(transport.pid).toBeGreaterThan(0);
    expect(() => process.kill(transport.pid!, 0)).not.toThrow();

    await client.ping();

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(EXPECTED_TOOL_NAMES.length);

    const result = await client.callTool({
      name: 'getClients',
      arguments: { searchText: 'Hopper' },
    });
    expect(result.isError).toBeFalsy();
    expect(resultJson(result).totalClients).toBe(1);
  });

  itE2E('sent Limit=200 and an Offset on every GET in the session (every stubbed GET is paginated)', () => {
    // Runtime counterpart of Gate 13: every GET route the stub serves is
    // paginated in docs/openapi.json, so every GET the server made must have
    // gone through fetchAllPages. A single-GET regression drops Offset.
    const gets = stub.sessionRequests.filter((request) => request.method === 'GET');
    expect(gets.length).toBeGreaterThan(20);
    const unpaged = gets
      .filter((request) => request.query.Limit !== '200' || !/^\d+$/.test(request.query.Offset ?? ''))
      .map((request) => `${request.path}?Limit=${request.query.Limit}&Offset=${request.query.Offset}`);
    expect(unpaged).toEqual([]);
  });

  itE2E('made every outbound request to the loopback stub, and no others', () => {
    expect(stub.requests.length).toBeGreaterThan(0);
    for (const request of stub.requests) {
      expect(request.host).toBe(`127.0.0.1:${stub.port}`);
    }

    // No request went to a path the stub does not implement, so none was aimed
    // at a real Mindbody endpoint. Combined with the child env pinning
    // HTTP(S)_PROXY to a closed loopback port with NO_PROXY=127.0.0.1, any
    // off-box egress would fail rather than succeed silently. The stub also 404s
    // anything unimplemented, so such a call could not have gone unnoticed.
    const implemented = new Set(stub.implementedPaths);
    expect(stub.requests.filter((request) => !implemented.has(request.path))).toEqual([]);
  });
});

describe('startup rejection', () => {
  const REQUIRED_VARS = [
    'MINDBODY_API_KEY',
    'MINDBODY_SITE_ID',
    'MINDBODY_SOURCE_NAME',
    'MINDBODY_SOURCE_PASSWORD',
  ];

  itE2E('exits non-zero when a required environment variable is missing', async () => {
    for (const variable of REQUIRED_VARS) {
      const env = buildStubEnv({
        apiUrl: stub.apiUrl,
        scratchDir,
        omitRequired: variable,
      });

      const proc = Bun.spawn([BUN_BINARY, 'run', SERVER_ENTRY], {
        cwd: scratchDir,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const [exitCode, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stderr).text(),
      ]);

      expect(exitCode, `${variable} omitted should exit non-zero`).toBe(1);
      expect(stderr).toContain(`Missing required environment variable: ${variable}`);
    }
  }, 30_000);
});
describe('multi-site API keys — getSites never guesses', () => {
  const secondSite = { ...STUB_FIXTURES.site, Id: -98, Name: 'Neighbour Studio', TimeZone: 'Asia/Hong_Kong' };

  itE2E('pins the /site/sites lookup to the configured MINDBODY_SITE_ID', async () => {
    stub.resetLog();
    const result = await client.callTool({ name: 'getSites', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(resultJson(result).site.id).toBe(-99);
    // The record may already be cached from an earlier test; the session log keeps every GET.
    const siteGets = stub.sessionRequests.filter((r) => r.path.endsWith('/public/v6/site/sites') && r.method === 'GET');
    expect(siteGets.length).toBeGreaterThan(0);
    for (const get of siteGets) {
      expect(get.queryAll['SiteIds[]']).toEqual(['-99']);
    }
  });

  itE2E('an explicit siteId reaches a second site and reports its own timezone', async () => {
    stub.sites = [STUB_FIXTURES.site, secondSite];
    try {
      const result = await client.callTool({ name: 'getSites', arguments: { siteId: '-98' } });
      expect(result.isError).toBeFalsy();
      const payload = resultJson(result);
      expect(payload.error).toBeUndefined();
      expect(payload.site).toMatchObject({ id: -98, name: 'Neighbour Studio', timeZone: 'Asia/Hong_Kong' });
    } finally {
      stub.sites = [STUB_FIXTURES.site];
    }
  });

  itE2E('a siteId the key cannot reach returns no site data, only the reachable list', async () => {
    stub.sites = [STUB_FIXTURES.site, secondSite];
    try {
      const result = await client.callTool({ name: 'getSites', arguments: { siteId: '-55' } });
      expect(result.isError).toBeFalsy();
      const payload = resultJson(result);
      expect(payload.site).toBeUndefined();
      expect(payload.error).toMatch(/returned no site|-55 is not among/);
      expect(payload.availableSites).toEqual([]);
    } finally {
      stub.sites = [STUB_FIXTURES.site];
    }
  });
});
