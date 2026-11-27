# 🧘 Mindbody MCP Server

[![CI](https://github.com/ProfitMarkHK/MindbodyMCP/actions/workflows/ci.yml/badge.svg)](https://github.com/ProfitMarkHK/MindbodyMCP/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-v1.17.2-blue)](https://github.com/modelcontextprotocol/sdk)

A comprehensive Model Context Protocol (MCP) server that provides AI assistants with complete access to the Mindbody API for fitness and wellness studio management. Perfect for yoga studios, pilates studios, gyms, and wellness centers.

## ✨ Features

- **50 Tools** covering every aspect of studio operations
- **Complete Class Management** - View schedules, book clients, manage waitlists, substitute teachers
- **Client Management** - Add/update clients, track visits, memberships, and balances
- **Sales & Commerce** - Process payments, sell packages, memberships, and retail products
- **Staff Management** - View schedules, manage appointments, track availability
- **Multi-Location Support** - Manage multiple studio locations seamlessly
- **High Performance** - Built on Bun runtime with intelligent caching
- **Type-Safe** - Full TypeScript support with comprehensive types
- **Multiple Transports** - STDIO for local development, SSE for self-hosted production, Streamable HTTP for managed hosting

## 🚀 Quick Start

This project is not published to npm under its own name yet. Install it from GitHub.

### Install from GitHub

```bash
# Using bunx
bunx github:ProfitMarkHK/MindbodyMCP

# Or clone and run locally
git clone https://github.com/ProfitMarkHK/MindbodyMCP.git
cd MindbodyMCP
bun install
bun run start
```

The server runs on [Bun](https://bun.sh), which executes the TypeScript source directly: there is no build step. The package's `bin` points at `src/index.ts` (with a `bun` shebang), so `npx` also needs Bun installed. Node.js is supported as an option; see [Using Node.js](#using-nodejs-optional).

## 📋 Prerequisites

- Bun 1.0+ (Node.js 20+ works as an option; see [Using Node.js](#using-nodejs-optional))
- Mindbody API credentials (API Key, Site ID, Source credentials)
- 1Password CLI (`op`) to run this repo's server scripts; see [1Password setup](#1password-setup)
- Claude Desktop or any MCP-compatible client

## ⚙️ Configuration

### 1. Get Mindbody API Credentials

1. Sign up for a [Mindbody Developer Account](https://developers.mindbodyonline.com)
2. Create a new app to get your API credentials
3. Note your Site ID (use -99 for sandbox testing)

### 2. Set Environment Variables

For local MCP use, prefer the SAT launcher with file-based `op://` references;
it needs no secret file. See [Secrets and local 1Password tooling](docs/SECRETS.md).
Hosted production needs no secret file either: the platform injects plain
variables.

The `.env` steps below are the legacy path for running the published server, a
Docker image, or a checkout where you supply the credentials yourself. In this
repository the `dev` and `start` scripts read the same four variables from
1Password at launch, so no `.env` is needed — see
[1Password setup](#1password-setup). The opt-in live E2E tier uses the separate
`MINDBODY_TEST_*` namespace. Never commit a filled-in `.env`.

Create a `.env` file in your project root:

```bash
# Copy the example file
cp .env.example .env

# Edit with your credentials
MINDBODY_API_KEY=your_api_key_here
MINDBODY_SITE_ID=-99  # Your site ID
MINDBODY_SOURCE_NAME=your_source_name
MINDBODY_SOURCE_PASSWORD=your_source_password

# Optional settings
MINDBODY_API_URL=https://api.mindbodyonline.com/public/v6
# MINDBODY_SITE_TIMEZONE=America/Los_Angeles  # Fallback only; normally read from the API
# MINDBODY_PRICING_MAP_DIR=/path/outside/repo  # Holds pricing.<siteId>.json (staff titles, session-type services). Unset disables the checkout resolver
# MINDBODY_LATE_CANCEL_WINDOW_HOURS=24  # lateCancel is refused unless this is set; then only within N hours of the start
# MINDBODY_LATE_CANCEL_WINDOW_RULES='[{"serviceId":10,"hours":2},{"programId":3,"hours":24}]'  # Optional per-service windows, first match wins, falling back to the default
CACHE_TTL_MINUTES=5
MCP_SERVER_NAME=mindbody-mcp
MCP_SERVER_VERSION=2.0.0
```

### Dates and timezones

Mindbody takes and returns every date and time as the studio's local time with no UTC offset (for example `2026-10-18T08:00:00`). Send dates and times the same way. The server reads the site's IANA timezone from Mindbody's site record (`GET /site/sites`, cached for 60 minutes), so "today" in default date ranges is the studio's calendar date, not your machine's. `cancelAppointments` compares start times in that zone and refuses to write if the zone cannot be resolved. `MINDBODY_SITE_TIMEZONE` is a fallback for a reachable site record with no usable zone; leave it unset otherwise. It is never used when the site lookup fails (for example a multi-site key with no `MINDBODY_SITE_ID`), and if it disagrees with the record's zone, `cancelAppointments` and `cancelEnrollmentVisits` refuse to write. If `MINDBODY_SITE_ID` is unset or blank, no `SiteId` header is sent.

### 3. Configure Claude Desktop

Add to your Claude Desktop configuration:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mindbody": {
      "command": "bunx",
      "args": ["github:ProfitMarkHK/MindbodyMCP"],
      "env": {
        "MINDBODY_API_KEY": "your_api_key",
        "MINDBODY_SITE_ID": "-99",
        "MINDBODY_SOURCE_NAME": "your_source_name",
        "MINDBODY_SOURCE_PASSWORD": "your_source_password"
      }
    }
  }
}
```

Or run a local clone:

```json
{
  "mcpServers": {
    "mindbody": {
      "command": "bunx",
      "args": ["github:ProfitMarkHK/MindbodyMCP"],
      "env": {
        "MINDBODY_API_KEY": "your_api_key",
        "MINDBODY_SITE_ID": "-99",
        "MINDBODY_SOURCE_NAME": "your_source_name",
        "MINDBODY_SOURCE_PASSWORD": "your_source_password"
      }
    }
  }
}
```

## 🛠️ Available Tools

The server provides 52 tools across 6 categories:

### 📅 Class Management
- `getClasses` - View all classes with filters
- `getClassDescriptions` - List class types
- `getClassSchedules` - View recurring schedules
- `addClientToClass` - Book clients into classes. `test: true` is a dry run (result has `dryRun: true` and no `visitId`); observed on `-99`
- `removeClientFromClass` - Cancel bookings. Optional `sendEmail` (default `false`) asks Mindbody to email the client, as `cancelAppointments` and `cancelEnrollmentVisits` do
- `getWaitlistEntries` - Manage waitlists. **At least one of `classScheduleIds`, `classIds` or `clientIds` is required**: the API rejects a request with none of them. Entries carry no queue position — the endpoint has no such field
- `substituteClassTeacher` - Handle substitutions. Takes the **incoming** teacher's staff id as `substituteTeacherId`; the original teacher is implied by the class. The response shape is unverified against the sandbox (the endpoint has no `Test` flag)
- `getClassVisits` - Attendance and sign-in status for a class. Returns client ids, not client names: the endpoint returns no client object

### 👥 Client Management
- `getClients` - Search and retrieve clients
- `addClient` - Register new clients
- `updateClient` - Update client information
- `getClientVisits` - View attendance history
- `getClientSchedule` - A client's bookings as flat rows, each with a `kind` (`waitlist`, `appointment`, `enrollment` or `class`) and the ids the cancel tools take. Read-only; it does not decide whether a cancellation would be late. Default window: today through 30 days ahead
- `getClientMemberships` - Check active memberships
- `addClientArrival` - Check-in clients
- `getClientAccountBalances` - View account balances
- `getClientContracts` - View contracts
- `getClientFormulaNotes` - Read a client's formula notes, by client and/or appointment (read-only)
- `getClientPurchases` - A client's purchase history with prices (read-only): price, amount paid, discount, tax, account-payment flag, and the sale's items and payments. Default window: the last 365 days through today in the site timezone; `saleId` reads one sale back
- `getClientCompleteInfo` - A client's whole wallet in one call: account balance, services, contracts, memberships and arrivals. Optional sandbox-verified parameters: `requiredClientData` (subset of collections), `showActiveOnly` (services that can pay now), `startDate` (include expired purchase history)

### 💰 Sales & Commerce
- `getServices` - View available services. `priority` is the string "High"/"Medium"/"Low" and `taxIncludedAmount` is a money amount, because that is what the API defines
- `resolveCheckoutService` - At checkout, the single-visit service for a stylist's title and a session type, checked against the live catalogue. Needs the local pricing map (see below); any status other than `resolved` means stop and ask
- `getPricingMap` - The local staff title and session-type map, with live staff names. Flags mapped staff no longer on the staff list
- `setStylistTier` - Set or clear one staff member's title. Ungated until RBAC lands
- `getSessionTypePricingOptions` - Single-visit services for a session type, with a suggested title from each service name
- `setSessionTypeService` - Set or clear the service a title books for a session type. The service must be offered for that session type
- `getPackages` - List class packages. A package has no price of its own: `classCount` and `price` are summed from the services it contains
- `getProducts` - Browse retail products. Categories are exposed as ids; the API returns no category names
- `getContracts` - View membership options. **`locationId` is required** — the API answers HTTP 400 without it
- `getCustomPaymentMethods` - List the site's custom payment methods with their ids (needed for a `Custom` payment)
- `getSales` - Read-only sales history (default: month to date, site-local) with a per-sales-rep summary of retail product sales (tips excluded); `productsOnly`, `salesRepIds`, `clientIds` filters; `matchAppointments` adds a best-effort same-day appointment-staff match
- `checkoutShoppingCart` - Process purchases; a `Custom` payment needs `metadata.id` from `getCustomPaymentMethods`; an item can pay for existing appointments via `appointmentIds` (each must belong to `clientId`, or nothing is charged); `test: true` is a dry run that records no sale and, because Mindbody does not check payments in test mode, checks that the payments sum to the cart total itself. `item.metadata` takes only `id` (or `amount` for a `Tip`); other keys are dropped. An item can carry a non-negative `discountAmount` and `appointmentBookingRequests` to book and pay in one call. There is no per-sale price override: the API sells at the catalogue price, so a sale at another price (such as a 0-priced, hourly-billed option) must be made in the Mindbody web app ([details](docs/API.md#no-per-sale-price-override))
- `purchaseContract` - Sell memberships; needs `useAccountCredit: true` to be accepted, and has no dry run — it always creates a real contract with an AutoPay schedule

### 🏢 Site & Locations
- `getSites` - Get business information for the configured site. Optional `siteId`. With a multi-site API key and no default or explicit site, it returns `availableSites` instead of guessing
- `getLocations` - List all locations
- `getPrograms` - View programs offered
- `getResources` - Manage resources. Only the documented filters are sent (`locationIds`, `programIds`, `resourceIds`, `scheduleTypes`, `includeInactive`); the endpoint has no session-type or date filter
- `getSessionTypes` - List session types
- `getStaff` - View all staff members. `sessionTypeId` and `locationId` are **single** ids — the API has no plural form — and only narrow when `startDateTime` is also given
- `getTeacherSchedule` - Teacher schedules
- `getActivationCode` - Get the site activation code

### 📆 Appointments
- `getStaffAppointments` - View appointments; filter by staff (optional), location, date range, appointment IDs or a single client. Session-type and location **names** are resolved from the cached site catalogue; the client name, email and phone are not returned by this endpoint, so only `clientId` is available
- `addAppointment` - Book appointments. Returns `sessionTypeId`/`locationId` rather than names — the response carries ids, not objects. `test: true` is a dry run (result has `dryRun: true` and no `appointment`; refused with `sendEmail` or `applyPayment`). Observed on `-99` (E-6)
- `updateAppointment` - Reschedule (new `startDateTime`), change staff, notes or session type (`sessionTypeId`, on Booked, Confirmed or Arrived appointments only), or apply an `execute` status: confirm, unconfirm, arrive, unarrive, complete. `test: true` is a dry run (sent as `Test`, same guards, result has `dryRun: true`). It cannot cancel. Requires `clientId`: ownership, status and timing are verified before anything is written (see [CLAUDE.md](CLAUDE.md#updateappointment)).
- `cancelAppointments` - Cancel 1 to 3 future appointments for one client, with guards (below). `test: true` is a dry run (result has `dryRun: true` and an empty `cancelled` list; refused with `lateCancel` or `sendEmail`). Observed on `-99` (E-7)
- `cancelClientBooking` - Cancel one booking (appointment, enrollment session or drop-in class) found by `classId`, `appointmentId`, `visitId` or `startDateTime`, choosing late or normal from `MINDBODY_LATE_CANCEL_WINDOW_HOURS`. The write goes through the guarded tool for the booking's kind, is never retried, and returns a receipt with the exact request body. `observeBalance: true` adds `impact`: the paying service's remaining count and the account balance, read before and after, reported as observed, never as a fee
- `getBookableItems` - Find available slots
- `getActiveSessionTimes` - List the active session start times per session type (the business-hours increments a session can start on). This is not bookable availability; use `getBookableItems` for that. The endpoint documents no day-of-week filter, so there is no `days` parameter
- `getScheduleItems` - View schedules. Returns three lists — `appointments`, `availabilities` and `unavailabilities` — because the API keeps them separate

**Cancelling appointments:** `cancelAppointments` takes a `clientId`, 1 to 3 `appointmentIds` (no duplicates), and optional `lateCancel` and `sendEmail` (both default to false). `lateCancel: true` is refused unless a late-cancel window applies (the Mindbody API does not expose the site's late-cancel windows), and then only for appointments starting within that many hours. The window is the first matching rule in `MINDBODY_LATE_CANCEL_WINDOW_RULES` (per service, program or session type), else `MINDBODY_LATE_CANCEL_WINDOW_HOURS`; see "Late-cancel windows" in [CLAUDE.md](CLAUDE.md). Before anything is cancelled, every appointment must belong to that client, start in the future, and not already be Cancelled, LateCancelled, Completed, NoShow or Arrived. If any appointment fails a check, none are cancelled and the response's `rejected` list gives the reasons. `test: true` sends the spec-defined `Test` flag with `Execute: cancel`: every guard still runs, Mindbody validates the cancellation, nothing is saved, and the result carries `dryRun: true` with an empty `cancelled` list. A dry run is refused with `lateCancel` or `sendEmail`, which would forfeit a service or email a client if `Test` were ignored. The full parameter reference is in [CLAUDE.md](CLAUDE.md).

### 🎓 Enrollments
- `getEnrollments` - List courses/workshops/series (class schedules whose program is an Enrollment program); the `id` is what `addClientToEnrollment` takes
- `addClientToEnrollment` - Book one client into one enrollment: the whole thing, from a date on (`enrollDateForward`), or selected sessions (`enrollOpenDates`)
- `getClientEnrollments` - A client's enrollments with their sessions, grouped by enrollment. Visits are resolved to classes and kept only when the class belongs to an Enrollment program, so drop-ins and appointments are excluded. Default window: today through 365 days ahead
- `cancelEnrollmentVisits` - Cancel up to 3 future enrollment sessions for one client by visit ID, with ownership, future-only and status guards; all-or-nothing. There is no move operation: cancel, then add again. Details in [CLAUDE.md](CLAUDE.md)

## 💬 Example Usage in Claude

Once configured, you can ask Claude:

```
"Show me today's yoga classes"
"Book Sarah Johnson into the 6pm Vinyasa class"
"Who's on the waitlist for tomorrow's Hot Yoga?"
"Add a new client named Jennifer Wilson"
"What's Michael's attendance this month?"
"Process a 10-class package purchase for Amy"
"Find a substitute for Maria's Thursday class"
```

## 🏗️ Development

### Local Development

```bash
# Clone the repository
git clone https://github.com/ProfitMarkHK/MindbodyMCP.git
cd MindbodyMCP

# Install dependencies
bun install

# If you cloned with --no-scripts, install the pre-commit quality gate by hand:
git config core.hooksPath .githooks

# Run in development mode
bun run dev

# Run tests
bun test

# Type-check and compile to dist/ (not needed to run; used for the Node.js option and npm releases)
bun run build
```

### Using Node.js (optional)

Bun is the default runtime, and installing does not build `dist/`. To run on Node.js instead, compile once and run the output:

```bash
npm install
npm run node:build        # tsc -> dist/
node dist/index.js        # add --transport sse|http for the hosted transports
```

`npm run node:start`, `node:start:sse`, `node:start:http` and `node:dev*` (via `tsx`, no build) wrap these with the 1Password CLI like the Bun scripts. Node 18 to 22 is built and smoke-tested in CI.

### 1Password setup

The `dev`, `dev:sse`, `dev:http`, `start`, `start:sse`, `start:http`, `start:prod` and `node:*` server scripts launch through the 1Password CLI. They read the Mindbody credentials from 1Password at launch, so no secret or env file is stored in this repository. **These scripts use production credentials.** The build, test and lint scripts don't read credentials.

1. Install the 1Password CLI (`op`) and turn on its desktop app integration.
2. Set four environment variables in your shell to references to your item's fields, not the values. Use your own vault and item:

```bash
MINDBODY_API_KEY=op://<vault>/<item>/<api-key-field>
MINDBODY_SITE_ID=op://<vault>/<item>/<site-id-field>
MINDBODY_SOURCE_NAME=op://<vault>/<item>/<source-name-field>
MINDBODY_SOURCE_PASSWORD=op://<vault>/<item>/<source-password-field>
```

3. Run the script as usual, for example `bun run dev`. `op run` resolves each reference and passes it to the server as an environment variable.

`bun run dev:sandbox` (and `dev:sandbox:sse`) uses the same four variables, so point them at your sandbox item for that run. The script pins the site to `-99` and refuses to start if `MINDBODY_SITE_ID` names any other site, which is what happens when the production references are still in the shell. Production and sandbox use separate 1Password items, clearly named for the site they serve (for example `Mindbody Production` and `Mindbody Sandbox`). See [docs/SETUP.md](docs/SETUP.md) Step 5b for the Claude Code instances.

For a launcher that keeps the 1Password **service account token (SAT)** in the OS credential store and reads `op://` refs from a file, use `bun run launch:sandbox` / `bun run launch:prod`. Hosted deployments use `bun run start:platform` with plain injected `MINDBODY_*` variables — no `op` in production. Full setup, MCP client config and rotation: [docs/SECRETS.md](docs/SECRETS.md).

### Project Structure

```
MindbodyMCP/
├── src/
│   ├── index.ts           # Main server entry point
│   ├── api/               # API client and auth
│   ├── tools/             # Tool implementations
│   ├── types/             # TypeScript types
│   ├── cache/             # Caching layer
│   └── utils/             # Utility functions
├── tests/                 # Test files
├── .github/workflows/     # CI/CD pipelines
└── CLAUDE.md             # Detailed documentation
```

## 🌐 Remote Deployment (SSE and Streamable HTTP)

The server supports two remote transports: SSE (Server-Sent Events) for self-hosted deployment, and Streamable HTTP for managed hosting such as Railway. Both are additions to the default STDIO transport; neither replaces the other.

### SSE transport

**Client authentication.** Every SSE tool call runs with the server's Mindbody credentials, so the SSE transport requires a shared bearer token, `MCP_AUTH_TOKEN`. Clients send `Authorization: Bearer <token>` on every request except `GET /health`; anything else gets `401`. When the server binds to anything other than `127.0.0.1`, `::1` or `localhost` (the default host is `0.0.0.0`), it refuses to start without the token. On loopback the token may be left unset for local development, with a warning. STDIO needs no token.

```bash
export MCP_AUTH_TOKEN="$(openssl rand -hex 32)"
```

#### Quick Start with SSE

The `start:sse` script reads production credentials through 1Password; see [1Password setup](#1password-setup).

```bash
# Start with SSE transport
bun run start:sse

# Or with environment variable
MCP_TRANSPORT=sse bun start

# With custom port
bun run src/index.ts --transport sse --port 8080
```

#### Docker Deployment

```bash
# Using Docker Compose
docker-compose up -d

# Or manually (the image defaults to --transport http, so name the transport)
docker build -t mindbody-mcp .
docker run -d -p 3000:3000 -e MCP_AUTH_TOKEN mindbody-mcp --transport sse
```

#### Production Configuration

Configure via environment variables:
- `MCP_TRANSPORT=sse` - Enable SSE transport
- `MCP_AUTH_TOKEN` - Bearer token clients must send. Required unless `MCP_HOST` is loopback
- `MCP_PORT=3000` - Server port
- `MCP_HOST=0.0.0.0` - Server host
- `MCP_ALLOWED_HOSTS=mcp.yourdomain.com` - Comma-separated `Host` values accepted (DNS-rebinding protection, on by default). Unset means loopback only, so set it whenever remote clients connect
- `MCP_ALLOWED_ORIGINS=https://app.yourdomain.com` - Comma-separated `Origin` values accepted. Unset means Origin is not checked; requests without an Origin always pass
- `MCP_CORS_ORIGIN=https://app.yourdomain.com` - Sent as `Access-Control-Allow-Origin`: one origin or `*` (default). Tells browsers who may read responses; refuses nothing on the server
- `MCP_DNS_REBINDING_PROTECTION=false` - Turns the Host/Origin check off (opt-out; the bearer token still applies)
- `MCP_SSL_CERT=/path/to/cert.pem` - SSL certificate (optional)
- `MCP_SSL_KEY=/path/to/key.pem` - SSL private key (optional)

The bearer token is checked first: a request without it gets `401` before the Host/Origin check, which answers `403`. The server sends no `Access-Control-Allow-Credentials` header, because it authenticates with the `Authorization` header and reads no cookies. See [Host, Origin and CORS](docs/SSE_DEPLOYMENT.md#host-origin-and-cors).

#### SSE Endpoints

- `/health` - Health check endpoint (no token needed)
- `/info` - Server information (token required)
- `/sse` - SSE event stream for MCP communication (token required)

For detailed deployment instructions, see [SSE Deployment Guide](docs/SSE_DEPLOYMENT.md).

### Streamable HTTP transport

For managed hosting, `--transport http` serves the SDK's stateless Streamable HTTP transport at `/mcp` plus `/health`. Being stateless it has no session to route and sends nothing while idle, which is what lets a host scale the service to zero.

**Authentication is a Cloudflare Access JWT, not a bearer token.** Every client acts as the studio's one Mindbody login, so the server refuses to start without `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD`; Cloudflare performs the Google Workspace sign-in and the MCP OAuth flow, and the server verifies the forwarded `Cf-Access-Jwt-Assertion` header (RS256, issuer, audience and expiry). `MCP_ALLOW_UNAUTHENTICATED=true` serves unauthenticated on a loopback host only.

```bash
# Local, unauthenticated, loopback only
MCP_ALLOW_UNAUTHENTICATED=true bun run src/index.ts --transport http

# Local, authenticated through Cloudflare Access
bun run dev:http
```

Deploying to Railway — including the cost model, the Access setup and the parts that were not verified — is documented in [docs/RAILWAY.md](docs/RAILWAY.md).

## 🧪 Testing

```bash
# Run all tests
bun test

# Test SSE connection (pass the server's token if it has one)
MCP_AUTH_TOKEN=... bun run test:sse

# Test specific tool
bun run test:tool

# Run benchmarks
bun run benchmark

# Type checking
bun run typecheck

# Which docs/openapi.json paths the tools call, grouped by API tag (offline)
bun run spec:coverage
```

`spec:coverage` is informational and exits 0; pass `-- --min <percent>` (or set `SPEC_COVERAGE_MIN`) to make it exit 1 below that share of spec paths. See [docs/quality-gates.md](docs/quality-gates.md).

### Quality gates

```bash
bun run check   # every automated gate: tests, typecheck, builds, secret scan
```

The same script runs as a pre-commit hook. `bun install` installs it
automatically (`prepare` sets `git config core.hooksPath .githooks`); if you
cloned with `--no-scripts`, run that command by hand. Every commit then runs the
full suite (~13s warm), including `scripts/secret-scan.sh`, which blocks a commit
that introduces a credential-shaped string and never prints a matched value.
Full checklist: [docs/quality-gates.md](docs/quality-gates.md).

## 📦 Publishing

The release workflow (`.github/workflows/release.yml`) publishes `@profitmarkhk/mindbody-mcp` to npm and GitHub Packages and pushes `ghcr.io/profitmarkhk/mindbody-mcp`. No release has been cut under this name yet.

## 🔒 Security

- API credentials are stored securely via environment variables
- OAuth 2.0 authentication with automatic token refresh
- No credentials are logged or exposed
- Regular security audits via GitHub Actions

## ⚡ Performance

- **Bun Runtime**: 4x faster startup than Node.js
- **Intelligent Caching**: 5-minute cache for dynamic data, 60-minute for static
- **Automatic Retry**: Exponential backoff for failed GET requests; writes (POST) are never retried blindly
- **Rate Limiting**: Respects Mindbody's 2000 requests/hour limit

### Pagination

Every Mindbody GET that accepts `Limit`/`Offset` in the API spec is read through `fetchAllPages` (`src/api/client.ts`). It asks for 200 rows per page (`DEFAULT_PAGE_SIZE`), advances `Offset` by the rows actually received, and, when the server reports `TotalResults`, keeps going until that many rows are collected. It never returns a silently truncated list: it throws after 100 pages (`MAX_PAGES`), or when the server ignores `Offset` and repeats a page.

Quality gate 13 (`tests/pagination-gate.test.ts`, run by `bun run check`) enforces this statically. A paginated endpoint called with a single GET, a path the spec does not define, or a call the scanner cannot resolve to a literal path fails the build. There is no allowlist. See [docs/quality-gates.md](docs/quality-gates.md).

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [Mindbody API](https://developers.mindbodyonline.com) for providing comprehensive fitness studio APIs
- [Anthropic MCP SDK](https://github.com/modelcontextprotocol/sdk) for the Model Context Protocol
- [Bun](https://bun.sh) for the blazing fast JavaScript runtime
- [vespo92/MindbodyMCP](https://github.com/vespo92/MindbodyMCP), the project this one was forked from and has since diverged from

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/ProfitMarkHK/MindbodyMCP/issues)
- **Security reports**: see [SECURITY.md](SECURITY.md)

## 🚀 Roadmap

- [ ] Webhook support for real-time updates
- [ ] Advanced reporting and analytics tools
- [ ] Multi-site synchronization
- [ ] AI-powered recommendations
- [ ] Mobile app integration
- [ ] GraphQL API layer

---

<div align="center">
  Made with ❤️ for yoga studios and wellness centers worldwide
</div>