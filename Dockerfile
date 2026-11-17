# Bun runs the TypeScript source directly, so there is no build stage.
FROM oven/bun:1-alpine

WORKDIR /app

# Production dependencies only; --ignore-scripts skips `prepare` (tsc, git hooks).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

COPY src ./src
COPY tsconfig.json ./

# Railway injects PORT. If you attach a volume (MINDBODY_PRICING_MAP_DIR) and
# keep this non-root user, set RAILWAY_RUN_UID=0 so the volume is writable.
USER bun
EXPOSE 3000

# Serve Streamable HTTP by default. The transport flag beats MCP_TRANSPORT, so
# overriding it means passing an argument: `docker run ... --transport sse`.
# Auth comes from CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD; without them the server
# refuses to start (MCP_ALLOW_UNAUTHENTICATED=true works on loopback only).
ENTRYPOINT ["bun", "src/index.ts"]
CMD ["--transport", "http"]
