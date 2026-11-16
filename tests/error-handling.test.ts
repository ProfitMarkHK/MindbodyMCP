/**
 * Error handling from the HTTP layer up to the MCP caller (issue #5).
 *
 * Two layers, both hermetic (loopback only, no credentials, no Mindbody site):
 *
 *   1. Tool layer, in process. `getTeacherScheduleTool` gets a real
 *      `MindbodyApiClient` (the `IMindbodyClient` it is injected with) pointed at
 *      a loopback server that fails on demand. A hand-written mock client would
 *      skip the retry, which lives in `MindbodyApiClient.request`, so the fault is
 *      injected one level lower, at HTTP. Auth headers are stubbed.
 *   2. MCP layer. `src/index.ts` runs `main()` on import, so it is spawned over
 *      STDIO against the shared Mindbody stub, as the E2E suite does, and the
 *      `CallToolResult` the caller receives is asserted.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MindbodyApiClient } from '../src/api/client.js';
import { mindbodyAuth } from '../src/api/auth.js';
import { SimpleCache } from '../src/cache/index.js';
import { getTeacherScheduleTool } from '../src/tools/teacherSchedule.js';
import { MindbodyStub, buildStubEnv } from './support/mindbody-stub.js';

const ADA = { Id: 42, Name: 'Ada Lovelace', FirstName: 'Ada', LastName: 'Lovelace', Email: 'ada@example.invalid' };
const ADA_CLASS = {
  Id: 9001,
  StartDateTime: '2026-03-02T09:00:00',
  EndDateTime: '2026-03-02T10:00:00',
  ClassDescription: { Name: 'Vinyasa Flow' },
  Location: { Name: 'Main Studio' },
  Substitute: false,
  IsCanceled: false,
  MaxCapacity: 20,
  TotalBooked: 5,
};

/** Signs of a raw Axios error or a stack trace leaking to the caller. */
function expectUserFriendly(message: string) {
  expect(message).not.toMatch(/AxiosError|ECONNREFUSED|ERR_BAD_RESPONSE/);
  expect(message).not.toMatch(/\n\s+at /);
  expect(message).not.toContain('Request failed with status code');
}

// ── Layer 1: tool + real API client over loopback HTTP ──────────────────────

describe('getTeacherScheduleTool error handling (in process)', () => {
  const savedGetAuthHeaders = mindbodyAuth.getAuthHeaders;
  const servers: Array<{ stop(): void }> = [];

  beforeAll(() => {
    mindbodyAuth.getAuthHeaders = async () => ({ 'Api-Key': 'stub' });
  });
  afterAll(() => {
    mindbodyAuth.getAuthHeaders = savedGetAuthHeaders;
  });
  afterEach(() => {
    for (const server of servers.splice(0)) server.stop();
  });

  /** Loopback API: `staff(hit)` answers the n-th GET /staff/staff; classes always answer ADA_CLASS. */
  function api(staff: (hit: number) => Response) {
    const hits = { staff: 0, classes: 0 };
    // Bind loopback explicitly: a wildcard bind can lose 127.0.0.1:<port> to
    // another local process holding that exact address.
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === '/staff/staff') return staff(++hits.staff);
        if (path === '/class/classes') {
          hits.classes += 1;
          return Response.json({ PaginationResponse: { TotalResults: 1 }, Classes: [ADA_CLASS] });
        }
        return Response.json({ Error: { Message: `unexpected ${path}` } }, { status: 500 });
      },
    });
    servers.push(server);
    const client = new MindbodyApiClient({ apiUrl: `http://127.0.0.1:${server.port}`, retryDelayMs: 1 });
    return { hits, client };
  }

  const run = (client: MindbodyApiClient, name = 'Ada Lovelace') =>
    getTeacherScheduleTool(name, '2026-03-02', '2026-03-08', client, new SimpleCache(), new SimpleCache());

  const staffList = (members: unknown[]) =>
    Response.json({ PaginationResponse: { TotalResults: members.length }, StaffMembers: members });

  it('a persistent 5xx exhausts the retries and surfaces a readable error', async () => {
    const { hits, client } = api(() => new Response('upstream down', { status: 503, statusText: 'Service Unavailable' }));

    const error = await run(client).then(
      () => { throw new Error('expected the tool to fail'); },
      (e: unknown) => e as Error
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('API Error: 503 - Service Unavailable');
    expectUserFriendly(error.message);
    // First attempt plus maxRetries (3); the class lookup is never reached.
    expect(hits.staff).toBe(4);
    expect(hits.classes).toBe(0);
  });

  it('a 5xx carrying a Mindbody error body surfaces that message, not the Axios one', async () => {
    const { client } = api(() =>
      Response.json({ Error: { Message: 'Internal failure', Code: 'InternalError' } }, { status: 500 })
    );
    await expect(run(client)).rejects.toThrow('Mindbody API Error: Internal failure (Code: InternalError)');
  });

  it('an empty staff list yields "Teacher not found", not a crash', async () => {
    const { hits, client } = api(() => staffList([]));
    await expect(run(client, 'Nobody Here')).rejects.toThrow(
      'Teacher "Nobody Here" not found. Please check the spelling and try again.'
    );
    expect(hits.staff).toBe(1);
    expect(hits.classes).toBe(0);
  });

  it('a staff list without the teacher yields "Teacher not found"', async () => {
    const { client } = api(() => staffList([ADA]));
    await expect(run(client, 'Grace Hopper')).rejects.toThrow('Teacher "Grace Hopper" not found');
  });

  it('a 404 on the staff lookup is a readable error and is not retried', async () => {
    // A 404 means the endpoint is missing, not that the teacher is: reporting
    // "Teacher not found" here would hide a misconfigured MINDBODY_API_URL.
    const { hits, client } = api(() => new Response('', { status: 404, statusText: 'Not Found' }));
    const error = await run(client).catch((e: Error) => e);
    expect((error as Error).message).toBe('API Error: 404 - Not Found');
    expectUserFriendly((error as Error).message);
    expect(hits.staff).toBe(1);
  });

  it('a 5xx on the first call and success on the second returns the schedule', async () => {
    const { hits, client } = api((hit) =>
      hit === 1 ? new Response('', { status: 502, statusText: 'Bad Gateway' }) : staffList([ADA])
    );

    const schedule = await run(client);

    expect(hits.staff).toBe(2);
    expect(schedule.teacher).toEqual({ id: 42, name: 'Ada Lovelace', email: 'ada@example.invalid' });
    expect(schedule.classes).toHaveLength(1);
    expect(schedule.classes[0]).toMatchObject({ id: 9001, name: 'Vinyasa Flow', spotsAvailable: 15 });
  });
});

// ── Layer 2: what the MCP caller receives ───────────────────────────────────

describe('tool errors as the MCP caller sees them', () => {
  const STAFF_PATH = '/public/v6/staff/staff';
  let stub: MindbodyStub;
  let scratchDir: string;
  let client: Client;

  beforeAll(async () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'mindbody-mcp-errors-'));
    stub = await MindbodyStub.start();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['run', resolve(__dirname, '../src/index.ts')],
      cwd: scratchDir,
      env: buildStubEnv({ apiUrl: stub.apiUrl, scratchDir }),
      stderr: 'pipe',
    });
    client = new Client({ name: 'error-handling-test', version: '0.0.0' });
    await client.connect(transport);
  });

  afterAll(async () => {
    try {
      await client?.close();
    } finally {
      await stub?.close();
      if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  afterEach(() => stub.clearFaults());

  const textOf = (result: Awaited<ReturnType<Client['callTool']>>) =>
    (result.content as Array<{ type: string; text: string }>).map((part) => part.text).join('\n');

  it('a persistent 5xx comes back as an isError result with a readable message', async () => {
    stub.setFault('GET', STAFF_PATH, { status: 503, body: { Message: 'down' } });
    stub.resetLog();

    const result = await client.callTool({
      name: 'getTeacherSchedule',
      arguments: { teacherName: 'Ada Lovelace', startDate: '2026-03-02', endDate: '2026-03-08' },
    });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toBe('Error: API Error: 503 - Service Unavailable');
    expectUserFriendly(text);
    // The real retry schedule ran: first attempt plus three retries.
    expect(stub.countTo(STAFF_PATH, 'GET')).toBe(4);
  }, 20_000);

  it('an unknown teacher comes back as an isError "not found" result, not a protocol error', async () => {
    const result = await client.callTool({
      name: 'getTeacherSchedule',
      arguments: { teacherName: 'Nobody Here', startDate: '2026-03-02', endDate: '2026-03-08' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      'Error: Teacher "Nobody Here" not found. Please check the spelling and try again.'
    );
  });

  it('the same server answers normally once the fault clears', async () => {
    const result = await client.callTool({
      name: 'getTeacherSchedule',
      arguments: { teacherName: 'Ada Lovelace', startDate: '2026-03-02', endDate: '2026-03-08' },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result)).teacher.name).toBe('Ada Lovelace');
  });
});
