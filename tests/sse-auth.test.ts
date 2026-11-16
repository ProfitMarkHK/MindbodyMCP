/**
 * Inbound bearer auth for the SSE transport (issue #40).
 *
 * Two layers:
 *   - in-process: `src/sseAuth.ts` directly, including a spy on the wrapped
 *     request listener, which proves a rejected request never reaches the
 *     routes (and so never reaches the SSE transport);
 *   - subprocess: the real `src/index.ts` started with `--transport sse` on a
 *     free loopback port, driven over raw HTTP so the Host header can be set.
 *
 * The subprocess gets a clean-room env (`buildStubEnv`) pointing Mindbody at a
 * dead port, and runs in an empty scratch dir so the repo `.env` is never read.
 * No test here talks to Mindbody.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  hasValidBearerToken,
  isLoopbackBindHost,
  resolveSseAuthToken,
  withBearerAuth,
} from '../src/sseAuth.js';
import { buildStubEnv } from './support/mindbody-stub.js';

const SERVER_ENTRY = resolve(__dirname, '../src/index.ts');
const BUN_BINARY = process.execPath;
// Random per run (and so not a literal the secret scan would flag), distinctive
// enough that a leak into any output is unambiguous.
const TOKEN = `tok-${randomBytes(16).toString('hex')}`;
const WRONG_SAME_LENGTH = `tok-${'0'.repeat(TOKEN.length - 4)}`;
const WRONG_OTHER_LENGTH = 'short';

// ---------------------------------------------------------------------------
// helpers

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * One HTTP request over node:http (no proxy, Host header settable). A
 * `text/event-stream` response is read until the `endpoint` event arrives or
 * `streamMs` passes, then the connection is dropped.
 */
function request(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string; streamMs?: number },
): Promise<HttpResult> {
  return new Promise((done, fail) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path, headers: options.headers },
      (res) => {
        let body = '';
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          res.destroy();
          done({ status: res.statusCode ?? 0, headers: res.headers, body });
        };
        const timer = setTimeout(finish, options.streamMs ?? 2_000);
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          if (/event: endpoint\ndata: [^\n]+\n/.test(body)) finish();
        });
        res.on('end', finish);
        res.on('error', finish);
      },
    );
    req.on('error', fail);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = net.createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => done(port));
    });
  });
}

function portIsClosed(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); done(false); });
    socket.once('error', () => done(true));
  });
}

interface SpawnedServer {
  proc: ReturnType<typeof Bun.spawn>;
  stdout: () => string;
  stderr: () => string;
  /** Resolves once stderr contains `pattern`, or rejects at `timeoutMs`. */
  waitFor: (pattern: string, timeoutMs?: number) => Promise<void>;
  stop: () => Promise<void>;
}

let scratchDir: string;

function spawnServer(args: string[], extraEnv: Record<string, string>): SpawnedServer {
  const env = { ...buildStubEnv({ apiUrl: 'http://127.0.0.1:1/public/v6', scratchDir }), ...extraEnv };
  const proc = Bun.spawn([BUN_BINARY, 'run', SERVER_ENTRY, ...args], {
    cwd: scratchDir,
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let out = '';
  let err = '';
  const pump = async (stream: ReadableStream<Uint8Array>, sink: (text: string) => void) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) sink(decoder.decode(chunk, { stream: true }));
  };
  void pump(proc.stdout as ReadableStream<Uint8Array>, (t) => { out += t; });
  void pump(proc.stderr as ReadableStream<Uint8Array>, (t) => { err += t; });

  return {
    proc,
    stdout: () => out,
    stderr: () => err,
    waitFor: async (pattern, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!err.includes(pattern)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for "${pattern}"; stderr:\n${err}`);
        if (proc.exitCode !== null) throw new Error(`server exited (${proc.exitCode}) before "${pattern}"; stderr:\n${err}`);
        await Bun.sleep(25);
      }
    },
    stop: async () => {
      if (proc.exitCode === null) proc.kill();
      await proc.exited;
    },
  };
}

function sessionIdFrom(body: string): string | undefined {
  return /data: \/sse\?sessionId=([0-9a-f-]+)/.exec(body)?.[1];
}

beforeAll(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'sse-auth-'));
});

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// in-process

describe('hasValidBearerToken', () => {
  it('accepts the exact token with the Bearer scheme, case-insensitively', () => {
    expect(hasValidBearerToken(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(hasValidBearerToken(`bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it('rejects a missing header, another scheme and a bare token', () => {
    expect(hasValidBearerToken(undefined, TOKEN)).toBe(false);
    expect(hasValidBearerToken('', TOKEN)).toBe(false);
    expect(hasValidBearerToken(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(hasValidBearerToken(TOKEN, TOKEN)).toBe(false);
    expect(hasValidBearerToken('Bearer ', TOKEN)).toBe(false);
  });

  it('parses a long whitespace-padded header in linear time', () => {
    const padding = '\t'.repeat(200_000);
    const started = performance.now();
    expect(hasValidBearerToken(`bearer${padding}x`, TOKEN)).toBe(false);
    expect(hasValidBearerToken(`bearer${padding}`, TOKEN)).toBe(false);
    expect(hasValidBearerToken(`Bearer${padding}${TOKEN}${padding}`, TOKEN)).toBe(true);
    expect(hasValidBearerToken(`Bearer ${' '.repeat(200_000)}${TOKEN}`, TOKEN)).toBe(true);
    // The regex this replaced backtracked quadratically: ~200 ms on a failing
    // match of 20,000 tabs, so seconds at this size.
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('rejects a scheme that only starts with Bearer', () => {
    expect(hasValidBearerToken(`Bearerx ${TOKEN}`, TOKEN)).toBe(false);
    expect(hasValidBearerToken(`Bearer${TOKEN}`, TOKEN)).toBe(false);
  });

  it('rejects a wrong token of the same length and of another length without throwing', () => {
    expect(WRONG_SAME_LENGTH.length).toBe(TOKEN.length);
    expect(() => hasValidBearerToken(`Bearer ${WRONG_SAME_LENGTH}`, TOKEN)).not.toThrow();
    expect(hasValidBearerToken(`Bearer ${WRONG_SAME_LENGTH}`, TOKEN)).toBe(false);
    expect(() => hasValidBearerToken(`Bearer ${WRONG_OTHER_LENGTH}`, TOKEN)).not.toThrow();
    expect(hasValidBearerToken(`Bearer ${WRONG_OTHER_LENGTH}`, TOKEN)).toBe(false);
    // Same character count, different byte length: the length check must use bytes.
    expect(hasValidBearerToken(`Bearer ${'é'.repeat(TOKEN.length)}`, TOKEN)).toBe(false);
  });
});

describe('resolveSseAuthToken', () => {
  it.each(['0.0.0.0', '::', '192.168.1.10', 'mcp.example.com'])('refuses %s without a token, naming MCP_AUTH_TOKEN', (host) => {
    for (const raw of [undefined, '', '   ']) {
      expect(() => resolveSseAuthToken(host, raw, () => {})).toThrow(/MCP_AUTH_TOKEN/);
    }
  });

  it('returns the trimmed token off loopback, with no warning', () => {
    const warn = mock(() => {});
    expect(resolveSseAuthToken('0.0.0.0', `  ${TOKEN}\n`, warn)).toBe(TOKEN);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['127.0.0.1', '::1', 'localhost'])('allows %s without a token and warns once', (host) => {
    expect(isLoopbackBindHost(host)).toBe(true);
    const warn = mock((_message: string) => {});
    expect(resolveSseAuthToken(host, undefined, warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('MCP_AUTH_TOKEN');
  });
});

describe('withBearerAuth (spy on the wrapped listener)', () => {
  let server: http.Server;
  let port: number;
  const next = mock((req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(299);
    res.end(`reached ${req.method} ${req.url}`);
  });

  beforeAll(async () => {
    server = http.createServer(withBearerAuth(TOKEN, next));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    port = (server.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  it('refuses POST /sse?sessionId=… with no or a wrong token before the listener runs', async () => {
    next.mockClear();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    for (const headers of [
      {},
      { Authorization: `Bearer ${WRONG_SAME_LENGTH}` },
      { Authorization: `Bearer ${WRONG_OTHER_LENGTH}` },
      { Authorization: `Basic ${TOKEN}` },
    ]) {
      const res = await request(port, {
        method: 'POST',
        path: '/sse?sessionId=00000000-0000-0000-0000-000000000000',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(res.body).not.toContain(TOKEN);
    }
    expect(next).not.toHaveBeenCalled();
  });

  it('passes the correct token, OPTIONS and GET /health through to the listener', async () => {
    next.mockClear();
    expect((await request(port, { path: '/sse', headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(299);
    expect((await request(port, { method: 'OPTIONS', path: '/sse' })).status).toBe(299);
    expect((await request(port, { path: '/health' })).status).toBe(299);
    expect(next).toHaveBeenCalledTimes(3);
  });

  it('guards /info and /health under another method or a query string', async () => {
    next.mockClear();
    expect((await request(port, { path: '/info' })).status).toBe(401);
    expect((await request(port, { method: 'POST', path: '/health' })).status).toBe(401);
    expect((await request(port, { path: '/health?x=1' })).status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns the listener unchanged when no token is configured', () => {
    expect(withBearerAuth(undefined, next)).toBe(next);
  });
});

// ---------------------------------------------------------------------------
// subprocess: the real server

describe('SSE server off loopback without a token', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['blank', '   '],
  ])('exits non-zero before listening when MCP_AUTH_TOKEN is %s', async (_label, token) => {
    const port = await freePort();
    const env: Record<string, string> = {};
    if (token !== undefined) env.MCP_AUTH_TOKEN = token;
    const server = spawnServer(['--transport', 'sse', '--host', '0.0.0.0', '--port', String(port)], env);
    const exitCode = await server.proc.exited;
    await Bun.sleep(50); // let the stderr pump drain

    expect(exitCode).not.toBe(0);
    expect(server.stderr()).toContain('MCP_AUTH_TOKEN');
    expect(server.stderr()).not.toContain('listening on');
    expect(await portIsClosed(port)).toBe(true);
  }, 20_000);
});

describe('SSE server with MCP_AUTH_TOKEN set', () => {
  let server: SpawnedServer;
  let port: number;
  const bodies: string[] = [];
  const auth = { Authorization: `Bearer ${TOKEN}` };
  const call = async (options: Parameters<typeof request>[1]) => {
    const res = await request(port, options);
    bodies.push(res.body);
    return res;
  };

  beforeAll(async () => {
    port = await freePort();
    server = spawnServer(['--transport', 'sse', '--host', '127.0.0.1', '--port', String(port)], { MCP_AUTH_TOKEN: TOKEN });
    await server.waitFor('listening on');
  }, 20_000);

  afterAll(async () => {
    await server.stop();
  });

  it('GET /sse without a token, with another scheme or with a wrong token gets 401 and no session', async () => {
    for (const headers of [
      {},
      { Authorization: `Basic ${TOKEN}` },
      { Authorization: `Bearer ${WRONG_SAME_LENGTH}` },
      { Authorization: `Bearer ${WRONG_OTHER_LENGTH}` },
    ]) {
      const res = await call({ path: '/sse', headers });
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(res.body).not.toContain('event: endpoint');
      expect(res.body).not.toContain('sessionId');
    }
  });

  it('GET /sse with the correct token gets 200 and an endpoint event', async () => {
    const res = await call({ path: '/sse', headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('event: endpoint');
    expect(sessionIdFrom(res.body)).toBeDefined();
  });

  it('POST /sse?sessionId=<real id> without or with a wrong token gets 401, not 404', async () => {
    const stream = await call({ path: '/sse', headers: auth });
    const sessionId = sessionIdFrom(stream.body);
    expect(sessionId).toBeDefined();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    for (const headers of [{}, { Authorization: `Bearer ${WRONG_SAME_LENGTH}` }, { Authorization: `Bearer ${WRONG_OTHER_LENGTH}` }]) {
      const res = await call({
        method: 'POST',
        path: `/sse?sessionId=${sessionId}`,
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
    }
  });

  it('GET /health is open; OPTIONS /sse is 204 with no stream', async () => {
    const health = await call({ path: '/health' });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body).status).toBe('healthy');

    const preflight = await call({ method: 'OPTIONS', path: '/sse' });
    expect(preflight.status).toBe(204);
    expect(preflight.body).toBe('');
    expect(preflight.headers['content-type']).toBeUndefined();
  });

  it('/info needs the token', async () => {
    expect((await call({ path: '/info' })).status).toBe(401);
    const info = await call({ path: '/info', headers: auth });
    expect(info.status).toBe(200);
  });

  it('a request failing the DNS-rebinding Host check with no token gets 401, not 403', async () => {
    const unauthenticated = await call({ path: '/sse', headers: { Host: 'evil.example' } });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body).not.toContain('Host');
    // Control: the same Host with the token is what the guard rejects.
    const authenticated = await call({ path: '/sse', headers: { ...auth, Host: 'evil.example' } });
    expect(authenticated.status).toBe(403);
  });

  it('never prints or returns the token', async () => {
    await Bun.sleep(50);
    expect(server.stdout()).not.toContain(TOKEN);
    expect(server.stderr()).not.toContain(TOKEN);
    for (const body of bodies) expect(body).not.toContain(TOKEN);
    expect(bodies.length).toBeGreaterThan(10);
  });
});

describe('SSE server on loopback without a token', () => {
  it('starts, accepts GET /sse without credentials and warns exactly once', async () => {
    const port = await freePort();
    const server = spawnServer(['--transport', 'sse', '--host', '127.0.0.1', '--port', String(port)], {});
    try {
      await server.waitFor('listening on');
      const res = await request(port, { path: '/sse' });
      expect(res.status).toBe(200);
      expect(res.body).toContain('event: endpoint');
      const warnings = server.stderr().split('\n').filter((line) => line.includes('MCP_AUTH_TOKEN'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('WARNING');
    } finally {
      await server.stop();
    }
  }, 20_000);
});

describe('STDIO transport', () => {
  it('needs no token and prints no auth warning', async () => {
    const server = spawnServer([], {});
    try {
      await server.waitFor('started (STDIO)');
      expect(server.stderr()).not.toContain('MCP_AUTH_TOKEN');
      expect(server.stderr()).not.toContain('WARNING');
    } finally {
      await server.stop();
    }
  }, 20_000);
});
