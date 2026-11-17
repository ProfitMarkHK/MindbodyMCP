import http from 'node:http';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/**
 * Streamable HTTP transport for hosted use (Railway etc.), stateless: every POST
 * to /mcp gets its own Server and transport, so concurrent clients share nothing
 * and the process can restart or scale without a session map.
 *
 * Every client acts as the studio's one Mindbody login (shared studio key), so
 * access is gated by a Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`):
 * Cloudflare does the Google Workspace sign-in and the MCP OAuth flow at its edge
 * (Access "Managed OAuth"); this server only verifies the JWT it forwards. There
 * is deliberately no other credential type.
 */

export type AccessJwtVerifier = (jwt: string | undefined) => Promise<string | undefined>;

/**
 * Verifier for the JWT Cloudflare Access adds to requests it has authenticated.
 * `teamDomain` is `<team>.cloudflareaccess.com`; `aud` is the application's AUD tag.
 * Returns who the token is for (email, else the service token's `common_name`,
 * else `sub`) when valid, otherwise undefined. `keys` is injectable for tests; by
 * default Cloudflare's JWKS is fetched lazily and cached.
 */
export function createAccessJwtVerifier(opts: { teamDomain: string; aud: string; keys?: JWTVerifyGetKey }): AccessJwtVerifier {
  const issuer = `https://${opts.teamDomain}`;
  const keys = opts.keys ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  return async (jwt) => {
    if (!jwt) return undefined;
    try {
      const { payload } = await jwtVerify(jwt, keys, {
        issuer,
        audience: opts.aud,
        algorithms: ['RS256'],
        requiredClaims: ['exp'],
      });
      // `||`, not `??`: a service-token JWT has an empty `sub` and no email.
      return String(payload.email || payload.common_name || payload.sub || 'cloudflare-access');
    } catch (error) {
      // Log the reason (never the token) so a wrong AUD or team domain is diagnosable.
      console.error(`[mcp] Access JWT rejected: ${(error as { code?: string }).code ?? (error as Error).name}`);
      return undefined;
    }
  };
}

export interface HttpServerOptions {
  createServer: () => Server;
  port: number;
  host: string;
  /** Cloudflare Access JWT verifier (see createAccessJwtVerifier). */
  verifyAccessJwt?: AccessJwtVerifier;
  /**
   * Serve /mcp with no auth. Local use only: requires a loopback `host`, rejects
   * requests whose Host header is not loopback (DNS rebinding), and cannot be
   * combined with `verifyAccessJwt`.
   */
  allowUnauthenticated?: boolean;
  /** Exact Host header values to accept (JWT mode); unset accepts any, since the JWT is the gate. */
  allowedHosts?: string[];
  version?: string;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const hostnameOf = (hostHeader: string): string =>
  hostHeader.startsWith('[') ? hostHeader.slice(0, hostHeader.indexOf(']') + 1) : hostHeader.split(':')[0];

const json = (res: http.ServerResponse, status: number, body: unknown, headers: http.OutgoingHttpHeaders = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

export function createHttpServer(opts: HttpServerOptions): http.Server {
  const { verifyAccessJwt, allowUnauthenticated } = opts;
  if (verifyAccessJwt && allowUnauthenticated) {
    throw new Error('MCP_ALLOW_UNAUTHENTICATED cannot be combined with Cloudflare Access auth');
  }
  if (!verifyAccessJwt && !allowUnauthenticated) {
    throw new Error('Refusing to serve HTTP with no auth: set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD (or MCP_ALLOW_UNAUTHENTICATED=true with a loopback host for local use)');
  }
  if (allowUnauthenticated && !LOOPBACK_HOSTS.has(opts.host)) {
    throw new Error(`MCP_ALLOW_UNAUTHENTICATED requires binding to a loopback host (got ${opts.host}); it would expose the studio's Mindbody login`);
  }

  return trackConnections(http.createServer(async (req, res) => {
    const path = (req.url ?? '').split('?')[0];

    // Railway's healthcheck sends its own Host, so this stays unauthenticated and minimal.
    if (path === '/health' && req.method === 'GET') {
      return json(res, 200, { status: 'healthy', server: 'mindbody-mcp', version: opts.version, transport: 'http' });
    }

    const hostHeader = req.headers.host ?? '';
    if (allowUnauthenticated && !LOOPBACK_HOSTS.has(hostnameOf(hostHeader))) {
      return json(res, 403, { error: 'Invalid Host header' });
    }
    if (opts.allowedHosts?.length && !opts.allowedHosts.includes(hostHeader)) {
      return json(res, 403, { error: 'Invalid Host header' });
    }

    if (path !== '/mcp') return json(res, 404, { error: 'Not Found' });

    let who = 'anonymous';
    if (verifyAccessJwt) {
      const header = req.headers['cf-access-jwt-assertion'];
      const verified = await verifyAccessJwt(Array.isArray(header) ? header[0] : header);
      if (verified === undefined) return json(res, 401, { error: 'Unauthorized' });
      who = verified;
    }

    // Stateless mode has no server-initiated stream to open and no session to delete.
    if (req.method !== 'POST') {
      return json(res, 405, { error: 'Method Not Allowed' }, { Allow: 'POST' });
    }

    console.error(`[mcp] ${new Date().toISOString()} POST /mcp client=${who}`);
    let server: Server | undefined;
    let transport: StreamableHTTPServerTransport | undefined;
    res.on('close', () => {
      void transport?.close();
      void server?.close();
    });
    try {
      server = opts.createServer();
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error('[mcp] request failed:', error);
      if (!res.headersSent) {
        json(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  }));
}

const openSockets = new WeakMap<http.Server, Set<import('node:net').Socket>>();

/**
 * Record a server's open sockets so `gracefulClose` can destroy them. Bun's
 * `closeAllConnections()` does not cut a request whose handler has not answered
 * (Bun 1.4.0), so the grace-period cut must destroy the sockets itself.
 */
export function trackConnections(httpServer: http.Server): http.Server {
  const sockets = new Set<import('node:net').Socket>();
  openSockets.set(httpServer, sockets);
  httpServer.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return httpServer;
}

/**
 * Stop accepting connections and let in-flight requests finish, up to `timeoutMs`,
 * before cutting the rest. Dropping a write mid-flight (checkout, booking) can leave
 * Mindbody committed while the client sees a failure and retries, so a restart must
 * not do that to requests that finish within the grace period.
 */
export function gracefulClose(httpServer: http.Server, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      httpServer.closeAllConnections();
      for (const socket of openSockets.get(httpServer) ?? []) socket.destroy();
    }, timeoutMs);
    httpServer.close(() => {
      clearTimeout(timer);
      resolve();
    });
    httpServer.closeIdleConnections();
  });
}

/** Railway's `deploy.drainingSeconds` (railway.json) must be at least this. */
export const SHUTDOWN_GRACE_MS = 25_000;

export async function startHttpServer(opts: HttpServerOptions): Promise<http.Server> {
  const httpServer = createHttpServer(opts);
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port, opts.host, () => resolve());
  });
  console.error(`Mindbody MCP Server (HTTP) listening on ${opts.host}:${opts.port}`);
  console.error(`MCP endpoint: /mcp   Health check: /health   Auth: ${opts.verifyAccessJwt ? 'Cloudflare Access JWT' : 'NONE (loopback only)'}`);

  const shutdown = (signal: string) => {
    console.error(`Shutting down HTTP server (${signal}), draining in-flight requests...`);
    void gracefulClose(httpServer, SHUTDOWN_GRACE_MS).then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return httpServer;
}
