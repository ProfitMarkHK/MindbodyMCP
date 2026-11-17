# Hosting on Railway (shared studio key, scale to zero)

One Railway service runs the server over Streamable HTTP (`/mcp`). Everyone who
connects acts as the studio's one Mindbody login. Access is gated only by
Cloudflare Access (Google Workspace sign-in); the server verifies the JWT Access
forwards and refuses to start without `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD`.
There are no bearer tokens or other credentials.

The SSE transport is not removed: it remains available for self-hosted
deployments (see the README and `docs/SSE_DEPLOYMENT.md`). This document covers
only the HTTP transport and Railway.

## Why it costs almost nothing idle

- **Serverless (App Sleeping).** `railway.json` sets `deploy.sleepApplication`. Railway
  treats a service as idle when it sends no outbound packets for about 5 minutes
  and sleeps it; the next request wakes it. The first request after a sleep can
  return a 502 or be slow, so a client may need to retry once.
- **Anything the service sends counts as outbound traffic, including 401s and
  `/health` replies to scanners.** Railway does not measure inbound requests, but
  its responses are outbound. A publicly reachable `*.up.railway.app` origin can
  therefore be kept awake by internet scanners. Serve only the Cloudflare-proxied
  hostname and remove the Railway-generated domain (below). Then Cloudflare Access
  answers unauthenticated traffic at its edge and only authenticated requests wake
  the service.
- The HTTP transport is stateless: no sessions, no outbound calls while idle, no
  heartbeat. Do not add telemetry or a keep-alive, or the service never sleeps.
  (The 5-minute cache sweep timer sends no packets and does not matter.)
- Static outbound IPs keep a service awake; leave that feature off.
- Sleep or restart loses only in-memory caches and the Mindbody user token, which
  are re-fetched on demand.
- **Deploys and restarts drain.** On SIGTERM the server stops accepting new
  connections and lets in-flight requests (a checkout, a booking) finish for up to
  25 s before cutting them. `railway.json` sets `drainingSeconds: 30` to match.
  Keep it above 25.

## Deploy

1. New Railway project from this repo (it builds `Dockerfile`; Railway injects `PORT`,
   which wins over `MCP_PORT`).
2. Variables: `MINDBODY_API_KEY`, `MINDBODY_SITE_ID`, `MINDBODY_SOURCE_NAME`,
   `MINDBODY_SOURCE_PASSWORD`, plus the Cloudflare variables below. Start on the
   `-99` sandbox. Do not import `.env.example` wholesale.
3. `/health` is the healthcheck path.
4. Pricing map: attach a volume at e.g. `/data`, set `MINDBODY_PRICING_MAP_DIR=/data`,
   and set `RAILWAY_RUN_UID=0` (the image runs as non-root). Run one replica.
   Whether a volume works with Serverless is not confirmed; test a sleep/wake cycle.

## Cloudflare Access with Google Workspace

Cloudflare does sign-in and the MCP OAuth flow; the server only verifies the
`Cf-Access-Jwt-Assertion` JWT (RS256, issuer, AUD and expiry checked) in
`src/httpServer.ts`.

1. Put a hostname on Cloudflare (proxied/orange cloud) and add it as a custom
   domain on the Railway service.
2. Zero Trust: add Google as a login method (Google Workspace OAuth client).
3. Create a self-hosted Access application for that hostname. Policy: allow emails
   ending in `@yourdomain`. Enable **Managed OAuth** under Advanced settings, so
   MCP clients get a standard OAuth flow instead of a browser redirect. For
   headless tools that cannot do OAuth, add an Access **service token** and a
   "Service Auth" policy; the server accepts those JWTs too (logged by their
   `common_name`).
4. Copy the application's AUD tag. Set on Railway:
   `CF_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com`, `CF_ACCESS_AUD=<tag>`,
   `MCP_ALLOWED_HOSTS=<your hostname>`.
5. **Remove the Railway-generated `*.up.railway.app` domain.** Until then the origin
   is reachable directly (it still returns 401 without a valid JWT, but it can keep
   the service awake, and `MCP_ALLOWED_HOSTS` turns such requests into 403).
6. Connect a client to `https://<hostname>/mcp`.

Not verified: that claude.ai connectors complete Access's Managed OAuth flow
(Cloudflare documents it for AI agents and CLIs generally), and the exact claims in
service-token JWTs. Test both before rolling out. Cloudflare's proxy times out
requests after roughly 100 s (HTTP 524), which a very large `getSales` range could hit.

## Local use

```bash
MCP_ALLOW_UNAUTHENTICATED=true bun run src/index.ts --transport http
```

This binds 127.0.0.1 only, rejects requests with a non-loopback Host header, and
cannot be combined with the Cloudflare variables. It acts as whatever Mindbody
credentials are in the environment, so do not use it with production credentials
on a shared machine.

## Limits

- Everyone has the same Mindbody permissions, including checkout and cancel, and
  Mindbody records show the one shared login, not the person. Per-user identity
  and attribution is a separate investigation.
- Revoke a person's access in Cloudflare Access (policy or session).
