/**
 * Inbound authentication for the SSE transport (issue #40).
 *
 * The SSE transport runs every tool with the server's own Mindbody credentials,
 * so whoever can reach the port acts as the operator. A shared bearer token,
 * `MCP_AUTH_TOKEN`, gates every request except `GET /health` and CORS
 * preflight. Off loopback the token is mandatory: the server refuses to start
 * without one.
 *
 * The token is never logged, echoed in an error or returned in a response.
 */
import { timingSafeEqual } from 'node:crypto';
import type http from 'node:http';

/** Bind addresses that only accept connections from this machine. */
const LOOPBACK_BIND_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackBindHost(host: string): boolean {
  return LOOPBACK_BIND_HOSTS.has(host.trim().toLowerCase());
}

/**
 * Decide the SSE auth token for a bind host, failing closed off loopback.
 *
 * @returns the token, or `undefined` when auth is off (loopback only).
 * @throws when `host` is not loopback and the token is unset or blank.
 */
export function resolveSseAuthToken(
  host: string,
  rawToken: string | undefined,
  warn: (message: string) => void = console.error,
): string | undefined {
  const token = rawToken?.trim();
  if (token) {
    return token;
  }
  if (!isLoopbackBindHost(host)) {
    throw new Error(
      `Refusing to start the SSE transport on ${host} without MCP_AUTH_TOKEN. ` +
      'Set MCP_AUTH_TOKEN to a long random secret (clients send it as "Authorization: Bearer <token>"), ' +
      'or bind to 127.0.0.1 with --host / MCP_HOST.',
    );
  }
  warn(
    `WARNING: MCP_AUTH_TOKEN is not set. SSE clients are not authenticated; ` +
    `this is allowed only because the server is bound to loopback (${host}).`,
  );
  return undefined;
}

/**
 * True when the `Authorization` header carries `Bearer <expected>`.
 * Constant-time: the lengths are compared first, then `timingSafeEqual`.
 */
export function hasValidBearerToken(
  authorization: string | undefined,
  expected: string,
): boolean {
  if (!authorization) {
    return false;
  }
  // Linear parse, no regex: the header is attacker-controlled (CodeQL
  // js/polynomial-redos flagged a backtracking pattern here).
  const value = authorization.trim();
  const scheme = 'bearer';
  if (value.length <= scheme.length || value.slice(0, scheme.length).toLowerCase() !== scheme) {
    return false;
  }
  const separator = value[scheme.length];
  if (separator !== ' ' && separator !== '\t') {
    return false;
  }
  const credential = value.slice(scheme.length + 1).trim();
  if (!credential) {
    return false;
  }
  const presented = Buffer.from(credential, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  if (presented.length !== wanted.length) {
    return false;
  }
  return timingSafeEqual(presented, wanted);
}

/** Requests that stay open without a token: CORS preflight and the health probe. */
function isExemptFromAuth(req: http.IncomingMessage): boolean {
  return req.method === 'OPTIONS' || (req.method === 'GET' && req.url === '/health');
}

type RequestListener = (req: http.IncomingMessage, res: http.ServerResponse) => unknown;

/**
 * Wrap the SSE request listener so every non-exempt request must carry the
 * bearer token. A rejected request gets `401` with `WWW-Authenticate: Bearer`
 * before `next` runs, so no session is created, no body is read and the
 * DNS-rebinding guard inside `next` is never consulted.
 *
 * With `token` undefined (loopback without a token) `next` is returned as is.
 */
export function withBearerAuth(token: string | undefined, next: RequestListener): RequestListener {
  if (token === undefined) {
    return next;
  }
  return (req, res) => {
    if (!isExemptFromAuth(req) && !hasValidBearerToken(req.headers.authorization, token)) {
      res.writeHead(401, {
        'Content-Type': 'text/plain',
        'WWW-Authenticate': 'Bearer',
      });
      res.end('Unauthorized');
      return;
    }
    return next(req, res);
  };
}
