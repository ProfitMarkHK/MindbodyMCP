import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccessJwtVerifier, createHttpServer, gracefulClose, trackConnections, type HttpServerOptions } from '../src/httpServer';

const TEAM = 'studio.cloudflareaccess.com';
const AUD = 'aud-tag-123';

function createStubServer(): Server {
  const server = new Server({ name: 'stub', version: '0.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
  return server;
}

async function listen(opts: Partial<HttpServerOptions>) {
  const server = createHttpServer({ createServer: createStubServer, port: 0, host: '127.0.0.1', ...opts });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base, stop: () => { server.closeAllConnections(); server.close(); } };
}

const jsonRpc = (method: string) => JSON.stringify({ jsonrpc: '2.0', id: 1, method });
const mcpHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

describe('Cloudflare Access JWT', () => {
  let verify: ReturnType<typeof createAccessJwtVerifier>;
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  let rs384Key: CryptoKey;
  let sign: (claims?: Record<string, unknown>, o?: { aud?: string; iss?: string; key?: CryptoKey; exp?: string | null; alg?: string }) => Promise<string>;
  let svc: Awaited<ReturnType<typeof listen>>;

  beforeAll(async () => {
    ({ publicKey, privateKey } = await generateKeyPair('RS256'));
    const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'k256' };
    // A trusted RS384 key too, so the only reason an RS384 token fails is the algorithm allowlist.
    const pair384 = await generateKeyPair('RS384');
    rs384Key = pair384.privateKey;
    const jwk384 = { ...(await exportJWK(pair384.publicKey)), alg: 'RS384', kid: 'k384' };
    verify = createAccessJwtVerifier({ teamDomain: TEAM, aud: AUD, keys: createLocalJWKSet({ keys: [jwk, jwk384] }) });
    sign = (claims = { email: 'sam@studio.example' }, o = {}) => {
      const jwt = new SignJWT(claims)
        .setProtectedHeader({ alg: o.alg ?? 'RS256', kid: o.alg === 'RS384' ? 'k384' : 'k256' })
        .setIssuer(o.iss ?? `https://${TEAM}`)
        .setAudience(o.aud ?? AUD);
      if (o.exp !== null) jwt.setExpirationTime(o.exp ?? '5m');
      return jwt.sign(o.key ?? privateKey);
    };
    svc = await listen({ verifyAccessJwt: verify });
  });
  afterAll(() => svc.stop());

  it('returns the email for a valid token', async () => {
    expect(await verify(await sign())).toBe('sam@studio.example');
  });

  it('identifies a service token (empty sub, no email) by common_name, not as unauthenticated', async () => {
    expect(await verify(await sign({ common_name: 'ci-bot.access', sub: '' }))).toBe('ci-bot.access');
    expect(await verify(await sign({ sub: '' }))).toBe('cloudflare-access');
  });

  it('rejects wrong aud, issuer, signer, expired, missing exp, wrong alg and garbage', async () => {
    expect(await verify(await sign(undefined, { aud: 'other' }))).toBeUndefined();
    expect(await verify(await sign(undefined, { iss: 'https://evil.example' }))).toBeUndefined();
    expect(await verify(await sign(undefined, { key: (await generateKeyPair('RS256')).privateKey }))).toBeUndefined();
    expect(await verify(await sign(undefined, { exp: '-1m' }))).toBeUndefined();
    expect(await verify(await sign(undefined, { exp: null }))).toBeUndefined();
    expect(await verify(await sign(undefined, { alg: 'RS384', key: rs384Key }))).toBeUndefined();
    expect(await verify('garbage')).toBeUndefined();
    expect(await verify(undefined)).toBeUndefined();
  });

  it('gates /mcp on the Cf-Access-Jwt-Assertion header; a bearer token is not a credential', async () => {
    expect((await fetch(`${svc.base}/mcp`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${svc.base}/mcp`, { method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': 'garbage' } })).status).toBe(401);
    const bearer = await fetch(`${svc.base}/mcp`, {
      method: 'POST',
      headers: { ...mcpHeaders, Authorization: `Bearer ${await sign()}` },
      body: jsonRpc('tools/list'),
    });
    expect(bearer.status).toBe(401);
  });

  it('unauthenticated GET and DELETE are 401; authenticated ones are 405 with Allow: POST', async () => {
    expect((await fetch(`${svc.base}/mcp`)).status).toBe(401);
    const headers = { 'Cf-Access-Jwt-Assertion': await sign() };
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${svc.base}/mcp`, { method, headers });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
    expect((await fetch(`${svc.base}/sse`, { headers })).status).toBe(404);
  });

  it('serves /health without auth', async () => {
    expect((await fetch(`${svc.base}/health`)).status).toBe(200);
  });

  it('completes initialize, tools/list and tools/call for two concurrent clients', async () => {
    const connect = async (email: string) => {
      const client = new Client({ name: 't', version: '0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${svc.base}/mcp`), {
          requestInit: { headers: { 'Cf-Access-Jwt-Assertion': await sign({ email }) } },
        })
      );
      return client;
    };
    const [a, b] = await Promise.all([connect('a@studio.example'), connect('b@studio.example')]);
    const [listA, callB] = await Promise.all([a.listTools(), b.callTool({ name: 'ping', arguments: {} })]);
    expect(listA.tools[0].name).toBe('ping');
    expect((callB.content as Array<{ text: string }>)[0].text).toBe('pong');
    await Promise.all([a.close(), b.close()]);
  });

  it('rejects an oversized body with 413 and a malformed one without crashing', async () => {
    const headers = { ...mcpHeaders, 'Cf-Access-Jwt-Assertion': await sign() };
    const big = await fetch(`${svc.base}/mcp`, { method: 'POST', headers, body: 'x'.repeat(5 * 1024 * 1024) });
    expect(big.status).toBe(413);
    const bad = await fetch(`${svc.base}/mcp`, { method: 'POST', headers, body: '{not json' });
    expect(bad.status).toBeLessThan(500);
    expect((await fetch(`${svc.base}/health`)).status).toBe(200);
  });
});

describe('startup guards', () => {
  const noJwt = async () => 'x';

  it('refuses to be built with no auth, or with auth and the unauthenticated flag', () => {
    expect(() => createHttpServer({ createServer: createStubServer, port: 0, host: '127.0.0.1' })).toThrow(/no auth/);
    expect(() =>
      createHttpServer({ createServer: createStubServer, port: 0, host: '127.0.0.1', verifyAccessJwt: noJwt, allowUnauthenticated: true })
    ).toThrow(/cannot be combined/);
  });

  it('refuses unauthenticated mode on a non-loopback bind', () => {
    for (const host of ['0.0.0.0', '192.168.1.5', '::']) {
      expect(() => createHttpServer({ createServer: createStubServer, port: 0, host, allowUnauthenticated: true })).toThrow(/loopback/);
    }
    expect(() => createHttpServer({ createServer: createStubServer, port: 0, host: 'localhost', allowUnauthenticated: true })).not.toThrow();
  });
});

describe('unauthenticated (local) mode', () => {
  let svc: Awaited<ReturnType<typeof listen>>;
  beforeAll(async () => { svc = await listen({ allowUnauthenticated: true }); });
  afterAll(() => svc.stop());

  const rawPost = (host: string) =>
    new Promise<number>((resolve, reject) => {
      const url = new URL(`${svc.base}/mcp`);
      const req = http.request(
        { host: url.hostname, port: url.port, path: '/mcp', method: 'POST', headers: { ...mcpHeaders, Host: host } },
        (res) => { res.resume(); resolve(res.statusCode ?? 0); }
      );
      req.on('error', reject);
      req.end(jsonRpc('tools/list'));
    });

  it('serves a loopback Host and rejects any other Host (DNS rebinding)', async () => {
    expect(await rawPost(`localhost:${new URL(svc.base).port}`)).toBe(200);
    expect(await rawPost('127.0.0.1')).toBe(200);
    expect(await rawPost('attacker.example')).toBe(403);
    expect(await rawPost('attacker.example:3000')).toBe(403);
  });

  it('still answers /health for any Host', async () => {
    expect((await fetch(`${svc.base}/health`, { headers: { Host: 'attacker.example' } })).status).toBe(200);
  });
});

describe('MCP_ALLOWED_HOSTS', () => {
  it('rejects /mcp for other Hosts with 403 before auth, but not /health', async () => {
    const svc = await listen({ verifyAccessJwt: async () => undefined, allowedHosts: ['mcp.example.com'] });
    try {
      const status = (path: string, host: string) =>
        new Promise<number>((resolve, reject) => {
          const url = new URL(svc.base);
          const req = http.request({ host: url.hostname, port: url.port, path, method: path === '/mcp' ? 'POST' : 'GET', headers: { Host: host } }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          req.on('error', reject);
          req.end();
        });
      expect(await status('/mcp', 'foo.up.railway.app')).toBe(403);
      expect(await status('/mcp', 'mcp.example.com')).toBe(401);
      expect(await status('/health', 'foo.up.railway.app')).toBe(200);
    } finally {
      svc.stop();
    }
  });
});

describe('request failures', () => {
  it('returns a generic 500 and keeps serving when the server factory throws', async () => {
    const svc = await listen({
      allowUnauthenticated: true,
      createServer: () => { throw new Error('secret internal detail'); },
    });
    try {
      const res = await fetch(`${svc.base}/mcp`, { method: 'POST', headers: mcpHeaders, body: jsonRpc('tools/list') });
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain('secret internal detail');
      expect((await fetch(`${svc.base}/health`)).status).toBe(200);
    } finally {
      svc.stop();
    }
  });
});

describe('gracefulClose', () => {
  it('lets an in-flight request finish, then closes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const server = http.createServer(async (_req, res) => {
      await gate;
      res.end('done');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const inflight = fetch(`http://127.0.0.1:${port}/`, { keepalive: false });
    await new Promise((r) => setTimeout(r, 50));
    const closed = gracefulClose(server, 5000);
    await new Promise((r) => setTimeout(r, 50));
    release();
    expect(await (await inflight).text()).toBe('done');
    await closed;
    expect(server.listening).toBe(false);
  });

  it('cuts a request that outlives the grace period', async () => {
    const server = trackConnections(http.createServer(() => { /* never answers */ }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const inflight = fetch(`http://127.0.0.1:${port}/`).then(() => 'answered', () => 'cut');
    await new Promise((r) => setTimeout(r, 50));
    await gracefulClose(server, 200);
    expect(await inflight).toBe('cut');
  });
});
