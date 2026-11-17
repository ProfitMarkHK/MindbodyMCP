/**
 * HTTP routing for the SSE transport (issues #40, #42).
 *
 * `GET /sse` opens a stream. The SDK's `SSEServerTransport` then tells the
 * client, in its `endpoint` event, to POST messages to `/sse?sessionId=<uuid>`.
 * Every open stream is kept in a session map so each POST reaches the transport
 * (and the per-connection `Server`) that owns that session, and nothing else.
 *
 * Kept out of `src/index.ts` so tests can run the real routing in-process on an
 * ephemeral port: `src/index.ts` starts a server as soon as it is imported.
 */
import type http from 'node:http';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { withBearerAuth } from './sseAuth.js';

export interface DnsRebindingSettings {
  enableDnsRebindingProtection: boolean;
  allowedHosts: string[];
  allowedOrigins: string[];
}

// Hosts that are always safe for local development. Note these are compared as
// full `Host` header values, so they are listed with and without the default
// port because the SDK does an exact string match on the header.
const LOCAL_DEV_HOSTS = [
  'localhost',
  'localhost:3000',
  '127.0.0.1',
  '127.0.0.1:3000',
  '[::1]',
  '[::1]:3000',
];

/**
 * Enforce DNS rebinding protection at the HTTP layer, for both the `GET /sse`
 * that opens a stream and the `POST /sse?sessionId=` that carries a message.
 *
 * The SDK's own `validateRequestHeaders()` runs only inside
 * `SSEServerTransport.handlePostMessage()`, so it never covers the GET. This
 * check runs before any header is written (a committed SSE response can no
 * longer become a 403) and before a POST is dispatched.
 *
 * Semantics deliberately mirror the SDK exactly (see validateRequestHeaders in
 * SDK 1.32.1): Host is compared by exact string match against the allowlist, and
 * Origin is only checked when an origin allowlist is configured.
 *
 * @returns an error string when the request must be rejected, else undefined.
 */
export function checkDnsRebinding(
  req: http.IncomingMessage,
  settings: DnsRebindingSettings,
): string | undefined {
  if (!settings.enableDnsRebindingProtection) {
    return undefined;
  }

  if (settings.allowedHosts.length > 0) {
    const hostHeader = req.headers.host;
    if (!hostHeader || !settings.allowedHosts.includes(hostHeader)) {
      return `Invalid Host header: ${hostHeader}`;
    }
  }

  if (settings.allowedOrigins.length > 0) {
    const originHeader = req.headers.origin;
    if (originHeader && !settings.allowedOrigins.includes(originHeader)) {
      return `Invalid Origin header: ${originHeader}`;
    }
  }

  return undefined;
}

/**
 * Resolve DNS rebinding protection settings for the SSE transport.
 *
 * Security posture: protection is ON by default.
 *
 * Evidence from SDK 1.32.1 (`dist/esm/server/sse.js`, validateRequestHeaders):
 *   - if `enableDnsRebindingProtection` is falsy, validation is skipped entirely;
 *   - the Host header is only checked when `allowedHosts` is non-empty;
 *   - the Origin header is only checked when `allowedOrigins` is non-empty.
 *
 * So enabling protection with an empty allowlist is a no-op (it does not reject
 * everything), and enabling it with a localhost allowlist keeps local dev
 * working. We therefore default `allowedHosts` to loopback names rather than
 * leaving it undefined.
 */
export function resolveDnsRebindingSettings(
  port: number,
  env: NodeJS.ProcessEnv = process.env,
): DnsRebindingSettings {
  // Opt-out escape hatch. Anything other than an explicit falsy value keeps
  // protection enabled.
  const rawOptOut = env.MCP_DNS_REBINDING_PROTECTION?.trim().toLowerCase();
  const enabled = rawOptOut !== 'false' && rawOptOut !== '0' && rawOptOut !== 'no' && rawOptOut !== 'off';

  const parseList = (value: string | undefined): string[] | undefined => {
    const items = value
      ?.split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return items && items.length > 0 ? items : undefined;
  };

  const configuredHosts = parseList(env.MCP_ALLOWED_HOSTS);

  // When the operator has not set an explicit allowlist, fall back to loopback
  // plus the port we are actually listening on, so a non-default MCP_PORT in
  // local development still works with zero configuration.
  const allowedHosts = configuredHosts ?? [
    ...LOCAL_DEV_HOSTS,
    `localhost:${port}`,
    `127.0.0.1:${port}`,
    `[::1]:${port}`,
  ];

  return {
    enableDnsRebindingProtection: enabled,
    allowedHosts: enabled ? allowedHosts : [],
    // Origins are only checked when explicitly configured; the SSE endpoint is
    // normally driven by native MCP clients that send no Origin header at all.
    allowedOrigins: parseList(env.MCP_ALLOWED_ORIGINS) ?? [],
  };
}

export interface SseSession {
  transport: SSEServerTransport;
  server: Server;
}

export interface SseRequestHandlerOptions {
  /** Builds a fresh MCP Server per connection (GHSA-345p-7cg4-v4c7). */
  createMcpServer: () => Server;
  /** Bearer token every non-exempt request must carry; `undefined` turns auth off. */
  authToken: string | undefined;
  dnsRebinding: DnsRebindingSettings;
  corsOrigin: string;
  /** Written to `/health` and `/info`. */
  serverName: string;
  serverVersion: string;
  log?: (message: string) => void;
}

export interface SseRequestHandler {
  listener: (req: http.IncomingMessage, res: http.ServerResponse) => unknown;
  /** Open sessions by `sessionId`. An entry is removed when its stream closes. */
  sessions: Map<string, SseSession>;
  /** Close every open session (graceful shutdown). */
  closeAll: () => Promise<void>;
}

const SSE_PATH = '/sse';

/**
 * Build the request listener for the SSE HTTP server.
 *
 * Order for every request: bearer auth (`withBearerAuth`), then routing. The
 * message POST is authenticated exactly like the stream, so knowing a live
 * `sessionId` is not enough to drive a session.
 */
export function createSseRequestHandler(options: SseRequestHandlerOptions): SseRequestHandler {
  const { createMcpServer, authToken, dnsRebinding, corsOrigin, serverName, serverVersion } = options;
  const log = options.log ?? console.error;
  const sessions = new Map<string, SseSession>();

  const setCorsHeaders = (res: http.ServerResponse) => {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-ID');
  };

  const sendText = (res: http.ServerResponse, status: number, text: string) => {
    res.writeHead(status, { 'Content-Type': 'text/plain' });
    res.end(text);
  };

  const openStream = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    // DNS rebinding protection. Must run before any header is written,
    // otherwise the response is already committed and we cannot send a 403.
    const rebindingError = checkDnsRebinding(req, dnsRebinding);
    if (rebindingError) {
      log(`Rejected SSE connection: ${rebindingError}`);
      sendText(res, 403, rebindingError);
      return;
    }

    // These must be set via setHeader (not writeHead) because the SDK's
    // SSEServerTransport.start() issues its own res.writeHead(200, ...) when
    // connect() runs. Calling writeHead here first throws
    // ERR_HTTP_HEADERS_SENT and kills the SSE endpoint. setHeader values are
    // merged into that writeHead, with the SDK's own Content-Type winning.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    setCorsHeaders(res);
    res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering

    const transport = new SSEServerTransport(SSE_PATH, res, {
      enableDnsRebindingProtection: dnsRebinding.enableDnsRebindingProtection,
      allowedHosts: dnsRebinding.allowedHosts,
      allowedOrigins: dnsRebinding.allowedOrigins,
    });
    const server = createMcpServer();
    const { sessionId } = transport;

    // Registered before connect(): connect() writes the endpoint event, and a
    // client may POST as soon as it reads it.
    sessions.set(sessionId, { transport, server });
    res.on('close', () => {
      sessions.delete(sessionId);
      void server.close().catch(() => undefined);
    });

    await server.connect(transport);
  };

  const postMessage = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => {
    setCorsHeaders(res);

    const rebindingError = checkDnsRebinding(req, dnsRebinding);
    if (rebindingError) {
      log(`Rejected SSE message: ${rebindingError}`);
      sendText(res, 403, rebindingError);
      return;
    }

    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
      sendText(res, 400, 'Missing sessionId');
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      sendText(res, 404, 'Unknown or closed session');
      return;
    }

    try {
      // Answers 202 and delivers the JSON-RPC response on this session's stream.
      await session.transport.handlePostMessage(req, res);
    } catch (error) {
      // handlePostMessage has already answered (500) when it throws.
      log(`SSE message for session ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) sendText(res, 500, 'Internal Server Error');
    }
  };

  const route = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    // Handle OPTIONS preflight requests
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Request-ID',
        'Access-Control-Max-Age': '86400',
      });
      res.end();
      return;
    }

    // Exact match: `withBearerAuth` exempts exactly `GET /health`.
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin });
      res.end(JSON.stringify({
        status: 'healthy',
        server: 'mindbody-mcp',
        version: serverVersion,
        transport: 'sse',
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    if (req.url === '/info' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin });
      res.end(JSON.stringify({
        name: serverName,
        version: serverVersion,
        description: 'Comprehensive MCP server for Mindbody API',
        capabilities: { tools: true, resources: false, prompts: false },
        transport: { type: 'sse', endpoint: SSE_PATH, cors: true },
      }));
      return;
    }

    // Route /sse on the pathname: the message POST carries ?sessionId=.
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === SSE_PATH && req.method === 'GET') {
      await openStream(req, res);
      return;
    }
    if (url.pathname === SSE_PATH && req.method === 'POST') {
      await postMessage(req, res, url);
      return;
    }

    sendText(res, 404, 'Not Found');
  };

  const closeAll = async () => {
    const open = [...sessions.values()];
    sessions.clear();
    for (const { server } of open) {
      try {
        await server.close();
      } catch {
        // Connection already torn down; nothing to do.
      }
    }
  };

  return { listener: withBearerAuth(authToken, route), sessions, closeAll };
}
