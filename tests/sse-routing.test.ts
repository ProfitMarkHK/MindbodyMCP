/**
 * SSE message routing (issue #42): a message POSTed to `/sse?sessionId=<id>`
 * must reach the transport that owns that session, and only that one.
 *
 * Two layers:
 *   - in-process: `createSseRequestHandler` (`src/sseServer.ts`) on an
 *     ephemeral loopback port with a small MCP Server per connection, driven
 *     by the SDK's `SSEClientTransport` and by raw HTTP (so streams can be read
 *     event by event and the Host header set);
 *   - subprocess: the real `src/index.ts` with `--transport sse`, pointed at the
 *     local Mindbody stub, so `tools/list` can be compared with STDIO mode and
 *     one real tool call runs end to end.
 *
 * Both layers run with and without `MCP_AUTH_TOKEN`. No test here talks to
 * Mindbody or depends on a pre-started server.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createSseRequestHandler, resolveDnsRebindingSettings, type SseRequestHandler } from '../src/sseServer.js';
import { MindbodyStub, buildStubEnv } from './support/mindbody-stub.js';

const SERVER_ENTRY = resolve(__dirname, '../src/index.ts');
const BUN_BINARY = process.execPath;
// Random per run, so not a literal the secret scan would flag.
const TOKEN = `tok-${randomBytes(16).toString('hex')}`;

// ---------------------------------------------------------------------------
// helpers

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = net.createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => done(port));
    });
  });
}

function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

interface PostResult {
  status: number;
  body: string;
  ms: number;
}

/** One POST over node:http; resolves when the response ends. */
function post(
  port: number,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<PostResult> {
  const started = Date.now();
  return new Promise((done, fail) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        headers: { 'Content-Type': 'application/json', ...options.headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => done({ status: res.statusCode ?? 0, body, ms: Date.now() - started }));
      },
    );
    req.on('error', fail);
    req.end(JSON.stringify(options.body ?? { jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  });
}

interface RawStream {
  sessionId: string;
  /** Every `message` event's parsed JSON-RPC payload, in arrival order. */
  messages: Array<Record<string, any>>; // Record<string, any>: JSON-RPC read untyped
  waitForMessage: (id: number, timeoutMs?: number) => Promise<Record<string, any>>;
  close: () => Promise<void>;
}

/** Open `GET /sse` and read it event by event until closed. */
function openRawStream(port: number, headers: Record<string, string> = {}): Promise<RawStream> {
  return new Promise((done, fail) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/sse', headers }, (res) => {
      if (res.statusCode !== 200) {
        fail(new Error(`GET /sse answered ${res.statusCode}`));
        res.resume();
        return;
      }
      let buffer = '';
      let resolved = false;
      const messages: RawStream['messages'] = [];
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1] ?? '';
          if (event === 'endpoint' && !resolved) {
            resolved = true;
            const sessionId = /sessionId=([0-9a-f-]+)/.exec(data)?.[1];
            if (!sessionId) {
              fail(new Error(`no sessionId in endpoint event: ${data}`));
              return;
            }
            done({
              sessionId,
              messages,
              waitForMessage: async (id, timeoutMs = 2_000) => {
                const deadline = Date.now() + timeoutMs;
                for (;;) {
                  const found = messages.find((message) => message.id === id);
                  if (found) return found;
                  if (Date.now() > deadline) throw new Error(`no message with id ${id} on stream ${sessionId}`);
                  await Bun.sleep(10);
                }
              },
              close: () =>
                new Promise((closed) => {
                  res.once('close', () => closed());
                  req.destroy();
                }),
            });
          } else if (event === 'message') {
            messages.push(JSON.parse(data));
          }
        }
      });
    });
    req.on('error', (error) => {
      // A destroyed stream errors after it resolved; that is the normal close.
      if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') fail(error);
    });
    req.end();
  });
}

function sseClient(port: number, token: string | undefined) {
  const transport = new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`), {
    requestInit: { headers: authHeaders(token) },
  });
  const client = new Client({ name: 'sse-routing-test', version: '1.0.0' }, { capabilities: {} });
  return { client, transport };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await Bun.sleep(10);
  }
}

// ---------------------------------------------------------------------------
// in-process

interface InProcessServer {
  port: number;
  handler: SseRequestHandler;
  /** How many tools/call requests reached any Server built by the factory. */
  toolCalls: () => number;
  stop: () => Promise<void>;
}

async function startInProcess(token: string | undefined): Promise<InProcessServer> {
  let toolCalls = 0;
  const createMcpServer = () => {
    const server = new Server({ name: 'routing-stub', version: '0.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'echo', description: 'Echo the text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      toolCalls += 1;
      return { content: [{ type: 'text', text: String(request.params.arguments?.text ?? '') }] };
    });
    return server;
  };

  const httpServer = http.createServer();
  await new Promise<void>((done) => httpServer.listen(0, '127.0.0.1', done));
  const { port } = httpServer.address() as net.AddressInfo;

  const handler = createSseRequestHandler({
    createMcpServer,
    authToken: token,
    dnsRebinding: resolveDnsRebindingSettings(port, {}),
    corsOrigin: '*',
    serverName: 'routing-stub',
    serverVersion: '0.0.0',
    log: () => undefined,
  });
  httpServer.on('request', handler.listener);

  return {
    port,
    handler,
    toolCalls: () => toolCalls,
    stop: async () => {
      await handler.closeAll();
      httpServer.closeAllConnections();
      await new Promise<void>((done) => httpServer.close(() => done()));
    },
  };
}

for (const token of [TOKEN, undefined]) {
  const label = token ? 'with MCP_AUTH_TOKEN' : 'without a token (loopback)';
  const auth = authHeaders(token);

  describe(`SSE routing in-process, ${label}`, () => {
    let server: InProcessServer;

    beforeAll(async () => {
      server = await startInProcess(token);
    });

    afterAll(async () => {
      await server.stop();
    });

    it('an SDK SSE client completes initialize, tools/list and a tool call', async () => {
      const { client, transport } = sseClient(server.port, token);
      await client.connect(transport);
      try {
        expect(client.getServerVersion()?.name).toBe('routing-stub');
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name)).toEqual(['echo']);
        const result = await client.callTool({ name: 'echo', arguments: { text: 'round trip' } });
        expect(result.content).toEqual([{ type: 'text', text: 'round trip' }]);
      } finally {
        await client.close();
      }
    });

    it('POST /sse?sessionId=<live id> answers 202 and the response arrives on that stream', async () => {
      const stream = await openRawStream(server.port, auth);
      try {
        const res = await post(server.port, `/sse?sessionId=${stream.sessionId}`, {
          headers: auth,
          body: { jsonrpc: '2.0', id: 7, method: 'tools/list' },
        });
        expect(res.status).toBe(202);
        const message = await stream.waitForMessage(7);
        expect(message.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['echo']);
      } finally {
        await stream.close();
      }
    });

    it('with two clients connected, a message for A is answered only on A', async () => {
      const a = await openRawStream(server.port, auth);
      const b = await openRawStream(server.port, auth);
      try {
        expect(a.sessionId).not.toBe(b.sessionId);
        const res = await post(server.port, `/sse?sessionId=${a.sessionId}`, {
          headers: auth,
          body: { jsonrpc: '2.0', id: 11, method: 'tools/list' },
        });
        expect(res.status).toBe(202);
        await a.waitForMessage(11);
        // Give a misrouted response every chance to arrive before asserting.
        await Bun.sleep(150);
        expect(b.messages).toEqual([]);
      } finally {
        await a.close();
        await b.close();
      }
    });

    it('POST /sse with no sessionId answers 400 within 1s', async () => {
      const res = await post(server.port, '/sse', { headers: auth });
      expect(res.status).toBe(400);
      expect(res.ms).toBeLessThan(1_000);
    });

    it('POST /sse?sessionId=<unknown> answers 404', async () => {
      const res = await post(server.port, `/sse?sessionId=${randomUUID()}`, { headers: auth });
      expect(res.status).toBe(404);
    });

    it('a closed session answers 404 and is gone from the session map', async () => {
      const stream = await openRawStream(server.port, auth);
      expect(server.handler.sessions.has(stream.sessionId)).toBe(true);
      await stream.close();
      await waitUntil(() => !server.handler.sessions.has(stream.sessionId));
      const res = await post(server.port, `/sse?sessionId=${stream.sessionId}`, { headers: auth });
      expect(res.status).toBe(404);
    });

    it('a POST failing the DNS-rebinding Host check answers 403 and is not dispatched', async () => {
      const stream = await openRawStream(server.port, auth);
      try {
        const before = server.toolCalls();
        const res = await post(server.port, `/sse?sessionId=${stream.sessionId}`, {
          headers: { ...auth, Host: 'evil.example' },
          body: { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'echo', arguments: { text: 'x' } } },
        });
        expect(res.status).toBe(403);
        await Bun.sleep(150);
        expect(server.toolCalls()).toBe(before);
        expect(stream.messages).toEqual([]);
      } finally {
        await stream.close();
      }
    });

    if (token) {
      it('a POST for a live session without the token answers 401 and is not dispatched', async () => {
        const stream = await openRawStream(server.port, auth);
        try {
          const before = server.toolCalls();
          const res = await post(server.port, `/sse?sessionId=${stream.sessionId}`, {
            body: { jsonrpc: '2.0', id: 17, method: 'tools/call', params: { name: 'echo', arguments: { text: 'x' } } },
          });
          expect(res.status).toBe(401);
          await Bun.sleep(150);
          expect(server.toolCalls()).toBe(before);
          expect(stream.messages).toEqual([]);
        } finally {
          await stream.close();
        }
      });

      it('an SDK client without the token cannot connect', async () => {
        const { client, transport } = sseClient(server.port, undefined);
        await expect(client.connect(transport)).rejects.toThrow(/401/);
        expect(server.handler.sessions.size).toBe(0);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// subprocess: the real server

describe('SSE round trip against the real server and the Mindbody stub', () => {
  let stub: MindbodyStub;
  let scratchDir: string;
  let env: Record<string, string>;
  let stdioToolNames: string[];

  beforeAll(async () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'sse-routing-'));
    stub = await MindbodyStub.start();
    env = buildStubEnv({ apiUrl: stub.apiUrl, scratchDir });

    // Reference tool list: STDIO mode, same env.
    const stdio = new StdioClientTransport({ command: BUN_BINARY, args: ['run', SERVER_ENTRY], env, cwd: scratchDir, stderr: 'ignore' });
    const client = new Client({ name: 'sse-routing-stdio', version: '1.0.0' }, { capabilities: {} });
    await client.connect(stdio);
    try {
      stdioToolNames = (await client.listTools()).tools.map((tool) => tool.name);
    } finally {
      await client.close();
    }
  }, 20_000);

  afterAll(async () => {
    await stub?.close();
    rmSync(scratchDir, { recursive: true, force: true });
  });

  for (const token of [TOKEN, undefined]) {
    it(`${token ? 'with' : 'without'} MCP_AUTH_TOKEN: initialize, tools/list matching STDIO, and getLocations`, async () => {
      const port = await freePort();
      const proc = Bun.spawn(
        [BUN_BINARY, 'run', SERVER_ENTRY, '--transport', 'sse', '--host', '127.0.0.1', '--port', String(port)],
        { cwd: scratchDir, env: token ? { ...env, MCP_AUTH_TOKEN: token } : env, stdout: 'ignore', stderr: 'pipe' },
      );
      let stderr = '';
      void (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) stderr += decoder.decode(chunk, { stream: true });
      })();
      try {
        const deadline = Date.now() + 10_000;
        while (!stderr.includes('listening on')) {
          if (Date.now() > deadline || proc.exitCode !== null) throw new Error(`server did not start; stderr:\n${stderr}`);
          await Bun.sleep(25);
        }

        if (token) {
          const anonymous = sseClient(port, undefined);
          await expect(anonymous.client.connect(anonymous.transport)).rejects.toThrow(/401/);
        }

        const { client, transport } = sseClient(port, token);
        await client.connect(transport);
        try {
          expect(client.getServerVersion()?.name).toBe('mindbody-mcp');
          const sseToolNames = (await client.listTools()).tools.map((tool) => tool.name);
          expect(sseToolNames.length).toBeGreaterThan(0);
          expect(sseToolNames).toEqual(stdioToolNames);

          const result = await client.callTool({ name: 'getLocations', arguments: {} });
          expect(result.isError).toBeFalsy();
          const text = (result.content as Array<{ type: string; text: string }>)[0].text;
          expect(JSON.parse(text).locations[0].name).toBe('E2E Main Studio');
        } finally {
          await client.close();
        }
        expect(stderr).not.toContain(TOKEN);
      } finally {
        proc.kill();
        await proc.exited;
      }
    }, 30_000);
  }
});
