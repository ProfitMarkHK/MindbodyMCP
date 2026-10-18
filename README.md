# 🧘 Mindbody MCP Server

[![npm version](https://badge.fury.io/js/%40vespo92%2Fmindbody-mcp.svg)](https://www.npmjs.com/package/@vespo92/mindbody-mcp)
[![CI](https://github.com/vespo92/MindbodyMCP/actions/workflows/ci.yml/badge.svg)](https://github.com/vespo92/MindbodyMCP/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-v1.17.2-blue)](https://github.com/modelcontextprotocol/sdk)

A comprehensive Model Context Protocol (MCP) server that provides AI assistants with complete access to the Mindbody API for fitness and wellness studio management. Perfect for yoga studios, pilates studios, gyms, and wellness centers.

## ✨ Features

- **41 Tools** covering every aspect of studio operations
- **Complete Class Management** - View schedules, book clients, manage waitlists, substitute teachers
- **Client Management** - Add/update clients, track visits, memberships, and balances
- **Sales & Commerce** - Process payments, sell packages, memberships, and retail products
- **Staff Management** - View schedules, manage appointments, track availability
- **Multi-Location Support** - Manage multiple studio locations seamlessly
- **High Performance** - Built on Bun runtime with intelligent caching
- **Type-Safe** - Full TypeScript support with comprehensive types
- **Dual Transport Support** - STDIO for local development, SSE for production deployment

## 🚀 Quick Start

### Installation with npx (Node.js)

```bash
# Run directly without installation
npx @vespo92/mindbody-mcp

# Or install globally
npm install -g @vespo92/mindbody-mcp
```

### Installation with bunx (Bun - 4x faster)

```bash
# Run directly without installation  
bunx @vespo92/mindbody-mcp

# Or install globally with Bun
bun install -g @vespo92/mindbody-mcp
```

### Install from GitHub

```bash
# Using npx
npx github:vespo92/MindbodyMCP

# Using bunx (recommended for performance)
bunx github:vespo92/MindbodyMCP

# Or clone and run locally
git clone https://github.com/vespo92/MindbodyMCP.git
cd MindbodyMCP
bun install # or npm install
bun run start # or npm start
```

## 📋 Prerequisites

- Node.js 18+ or Bun 1.0+
- Mindbody API credentials (API Key, Site ID, Source credentials)
- Claude Desktop or any MCP-compatible client

## ⚙️ Configuration

### 1. Get Mindbody API Credentials

1. Sign up for a [Mindbody Developer Account](https://developers.mindbodyonline.com)
2. Create a new app to get your API credentials
3. Note your Site ID (use -99 for sandbox testing)

### 2. Set Environment Variables

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
CACHE_TTL_MINUTES=5
MCP_SERVER_NAME=mindbody-mcp
MCP_SERVER_VERSION=2.0.0
```

### Dates and timezones

Mindbody takes and returns every date and time as the studio's local time with no UTC offset (for example `2026-10-18T08:00:00`). Send dates and times the same way. The server reads the site's IANA timezone from Mindbody's site record (`GET /site/sites`, cached for 60 minutes), so "today" in default date ranges is the studio's calendar date, not your machine's. `cancelAppointments` compares start times in that zone and refuses to write if the zone cannot be resolved. `MINDBODY_SITE_TIMEZONE` is a fallback for a site record with no usable zone; leave it unset otherwise.

### 3. Configure Claude Desktop

Add to your Claude Desktop configuration:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mindbody": {
      "command": "bunx",
      "args": ["@vespo92/mindbody-mcp"],
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

Or use the GitHub repository directly:

```json
{
  "mcpServers": {
    "mindbody": {
      "command": "bunx",
      "args": ["github:vespo92/MindbodyMCP"],
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

The server provides 41 tools across 6 categories:

### 📅 Class Management
- `getClasses` - View all classes with filters
- `getClassDescriptions` - List class types
- `getClassSchedules` - View recurring schedules
- `addClientToClass` - Book clients into classes
- `removeClientFromClass` - Cancel bookings
- `getWaitlistEntries` - Manage waitlists. **At least one of `classScheduleIds`, `classIds` or `clientIds` is required**: the API rejects a request with none of them. Entries carry no queue position — the endpoint has no such field
- `substituteClassTeacher` - Handle substitutions. Takes the **incoming** teacher's staff id as `substituteTeacherId`; the original teacher is implied by the class. The response shape is unverified against the sandbox (the endpoint has no `Test` flag)
- `getClassVisits` - Attendance and sign-in status for a class. Returns client ids, not client names: the endpoint returns no client object

### 👥 Client Management
- `getClients` - Search and retrieve clients
- `addClient` - Register new clients
- `updateClient` - Update client information
- `getClientVisits` - View attendance history
- `getClientMemberships` - Check active memberships
- `addClientArrival` - Check-in clients
- `getClientAccountBalances` - View account balances
- `getClientContracts` - View contracts

### 💰 Sales & Commerce
- `getServices` - View available services. `priority` is the string "High"/"Medium"/"Low" and `taxIncludedAmount` is a money amount, because that is what the API defines
- `getPackages` - List class packages. A package has no price of its own: `classCount` and `price` are summed from the services it contains
- `getProducts` - Browse retail products. Categories are exposed as ids; the API returns no category names
- `getContracts` - View membership options. **`locationId` is required** — the API answers HTTP 400 without it
- `checkoutShoppingCart` - Process purchases; an item can pay for existing appointments via `appointmentIds`
- `purchaseContract` - Sell memberships. **No dry run:** this always creates a real contract with an AutoPay schedule

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
- `addAppointment` - Book appointments. Returns `sessionTypeId`/`locationId` rather than names — the response carries ids, not objects
- `updateAppointment` - Reschedule (new `startDateTime`), change staff or notes, or apply an `execute` status: confirm, unconfirm, arrive, unarrive, complete. It cannot cancel. Requires `clientId`: ownership, status and timing are verified before anything is written (see [CLAUDE.md](CLAUDE.md#updateappointment)).
- `cancelAppointments` - Cancel 1 to 3 future appointments for one client, with guards (below)
- `getBookableItems` - Find available slots
- `getActiveSessionTimes` - List the active session start times per session type (the business-hours increments a session can start on). This is not bookable availability; use `getBookableItems` for that. The endpoint documents no day-of-week filter, so there is no `days` parameter
- `getScheduleItems` - View schedules. Returns three lists — `appointments`, `availabilities` and `unavailabilities` — because the API keeps them separate

**Cancelling appointments:** `cancelAppointments` takes a `clientId`, 1 to 3 `appointmentIds` (no duplicates), and optional `lateCancel` and `sendEmail` (both default to false). Before anything is cancelled, every appointment must belong to that client, start in the future, and not already be Cancelled, LateCancelled, Completed or NoShow. If any appointment fails a check, none are cancelled and the response's `rejected` list gives the reasons. The full parameter reference is in [CLAUDE.md](CLAUDE.md).

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
git clone https://github.com/vespo92/MindbodyMCP.git
cd MindbodyMCP

# Install dependencies
bun install  # or npm install

# If you cloned with --no-scripts, install the pre-commit quality gate by hand:
git config core.hooksPath .githooks

# Run in development mode
bun run dev  # or npm run dev

# Run tests
bun test  # or npm test

# Build for production
bun run build  # or npm run build
```

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

## 🌐 SSE Deployment (Production)

The server supports SSE (Server-Sent Events) transport for production deployment, enabling web-based clients and remote access.

### Quick Start with SSE

```bash
# Start with SSE transport
bun run start:sse

# Or with environment variable
MCP_TRANSPORT=sse bun start

# With custom port
bun run src/index.ts --transport sse --port 8080
```

### Docker Deployment

```bash
# Using Docker Compose
docker-compose up -d

# Or manually
docker build -t mindbody-mcp .
docker run -d -p 3000:3000 -e MCP_TRANSPORT=sse mindbody-mcp
```

### Production Configuration

Configure via environment variables:
- `MCP_TRANSPORT=sse` - Enable SSE transport
- `MCP_PORT=3000` - Server port
- `MCP_HOST=0.0.0.0` - Server host
- `MCP_CORS_ORIGIN=https://yourdomain.com` - CORS configuration
- `MCP_SSL_CERT=/path/to/cert.pem` - SSL certificate (optional)
- `MCP_SSL_KEY=/path/to/key.pem` - SSL private key (optional)

### Endpoints

- `/health` - Health check endpoint
- `/info` - Server information
- `/sse` - SSE event stream for MCP communication

For detailed deployment instructions, see [SSE Deployment Guide](docs/SSE_DEPLOYMENT.md).

## 🧪 Testing

```bash
# Run all tests
bun test

# Test SSE connection
bun run test:sse

# Test specific tool
bun run test:tool

# Run benchmarks
bun run benchmark

# Type checking
bun run typecheck
```

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

The package is available on:
- **npm**: [@vespo92/mindbody-mcp](https://www.npmjs.com/package/@vespo92/mindbody-mcp)
- **GitHub Packages**: [vespo92/MindbodyMCP](https://github.com/vespo92/MindbodyMCP/packages)

## 🔒 Security

- API credentials are stored securely via environment variables
- OAuth 2.0 authentication with automatic token refresh
- No credentials are logged or exposed
- Regular security audits via GitHub Actions

## ⚡ Performance

- **Bun Runtime**: 4x faster startup than Node.js
- **Intelligent Caching**: 5-minute cache for dynamic data, 60-minute for static
- **Automatic Retry**: Exponential backoff for failed requests
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

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/vespo92/MindbodyMCP/issues)
- **Discussions**: [GitHub Discussions](https://github.com/vespo92/MindbodyMCP/discussions)
- **Email**: vinnie@vespo92.com

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