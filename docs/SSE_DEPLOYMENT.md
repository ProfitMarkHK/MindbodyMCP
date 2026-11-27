# SSE (Server-Sent Events) Deployment Guide

This guide covers deploying the Mindbody MCP Server with SSE transport for production environments.

## Overview

The Mindbody MCP Server supports two transport mechanisms:
- **STDIO** (default): For local development and CLI integration
- **SSE**: For production deployment and web-based clients

## Client authentication

The SSE transport runs every tool with the server's own Mindbody credentials, so it authenticates inbound clients with a shared bearer token, `MCP_AUTH_TOKEN`.

- Every request except `GET /health` and CORS preflight (`OPTIONS`) must send `Authorization: Bearer <MCP_AUTH_TOKEN>`. Anything else gets `401` with `WWW-Authenticate: Bearer`, before a session is created and before the DNS-rebinding check.
- **Required off loopback.** If the server binds to anything other than `127.0.0.1`, `::1` or `localhost`, and `MCP_AUTH_TOKEN` is unset or empty, it exits non-zero before listening. There is no opt-out. For an open endpoint, bind to loopback behind your own proxy.
- On loopback, an unset token is allowed for local development, and the server prints one warning.
- The token is compared in constant time and never logged or returned.

Generate a token and keep it in the environment file or secret store, never in a unit file or the repository:

```bash
openssl rand -hex 32
```

Changing the token needs a restart.

## Quick Start

### Local Development with SSE

The `start:sse` scripts read production credentials through 1Password, so set that up first ([1Password setup](../README.md#1password-setup)). The environment-variable form below goes through the same `op`-wrapped script.

```bash
# Using Bun (recommended)
bun run start:sse

# Using Node.js
npm run node:start:sse

# With custom port
bun run src/index.ts --transport sse --port 8080

# Using environment variables
MCP_TRANSPORT=sse MCP_PORT=3000 bun run start

# Loopback only, no token (local development; prints a warning)
bun run src/index.ts --transport sse --host 127.0.0.1
```

### Docker Deployment

The container runs `bun src/index.ts` directly (Bun executes the TypeScript source; there is no build step), so the `op`-wrapped scripts and 1Password setup do not apply here. Pass the `MINDBODY_*` values as shown below.

```bash
# Build the image
docker build -t mindbody-mcp:latest .

# Run with SSE transport
docker run -d \
  --name mindbody-mcp-sse \
  -p 3000:3000 \
  -e MCP_TRANSPORT=sse \
  -e MCP_AUTH_TOKEN=your_token \
  -e MINDBODY_API_KEY=your_key \
  -e MINDBODY_SITE_ID=your_site_id \
  -e MINDBODY_SOURCE_NAME=your_source \
  -e MINDBODY_SOURCE_PASSWORD=your_password \
  mindbody-mcp:latest

# Using docker-compose
docker-compose up -d
```

## Configuration Options

### Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `MCP_TRANSPORT` | Transport type (`stdio` or `sse`) | `stdio` | No |
| `MCP_PORT` | SSE server port | `3000` | No |
| `MCP_HOST` | SSE server host | `0.0.0.0` | No |
| `MCP_AUTH_TOKEN` | Bearer token clients must send | - | **Yes**, unless `MCP_HOST` is `127.0.0.1`, `::1` or `localhost` |
| `MCP_CORS_ORIGIN` | Value of `Access-Control-Allow-Origin`: one origin or `*` | `*` | No |
| `MCP_ALLOWED_HOSTS` | Comma-separated `Host` header values the server accepts | loopback names, with and without the port | **Yes** when remote clients connect |
| `MCP_ALLOWED_ORIGINS` | Comma-separated `Origin` header values the server accepts | unset (Origin not checked) | No |
| `MCP_DNS_REBINDING_PROTECTION` | `false`, `0`, `no` or `off` turns the Host/Origin check off | on | No |
| `MCP_SSL_CERT` | Path to SSL certificate | - | No |
| `MCP_SSL_KEY` | Path to SSL private key | - | No |

### Command-Line Arguments

```bash
# Basic SSE server
bun run src/index.ts --transport sse

# With custom port and host
bun run src/index.ts --transport sse --port 8080 --host 127.0.0.1

# With SSL/TLS
bun run src/index.ts \
  --transport sse \
  --ssl-cert /path/to/cert.pem \
  --ssl-key /path/to/key.pem
```

## Production Deployment

### 1. Systemd Service (Linux): not supported

This repository has no systemd setup that supplies credentials without writing
them to a plain-text file, and that is not allowed (see
[SECRETS.md](SECRETS.md)). Do not deploy with
`deploy/mindbody-mcp-sse.service`. Use a platform with built-in secrets
management, such as [Railway](RAILWAY.md) or Kubernetes (below).

### 2. Nginx Reverse Proxy

```bash
# Copy nginx configuration
sudo cp deploy/nginx.conf /etc/nginx/sites-available/mindbody-mcp
sudo ln -s /etc/nginx/sites-available/mindbody-mcp /etc/nginx/sites-enabled/

# Update server_name and SSL paths in the config
sudo nano /etc/nginx/sites-available/mindbody-mcp

# Test configuration
sudo nginx -t

# Reload nginx
sudo systemctl reload nginx
```

### 3. Kubernetes Deployment

```bash
# Create namespace and deploy
kubectl apply -f deploy/k8s-deployment.yaml

# Fill the secret with real values and MCP_AUTH_TOKEN. A Kubernetes Secret is
# the platform's built-in secrets management. It is encrypted at rest only if
# the cluster is configured for that, so turn encryption at rest on first.
kubectl edit secret mindbody-mcp-secrets -n mindbody-mcp

# Check deployment
kubectl get pods -n mindbody-mcp
kubectl get svc -n mindbody-mcp
kubectl get ingress -n mindbody-mcp

# View logs
kubectl logs -f deployment/mindbody-mcp-sse -n mindbody-mcp
```

### 4. Docker Compose

```bash
# Compose reads the variables from the environment it is started in. On a
# deployed host, inject them with that host's secret mechanism. On a development
# machine, keep op:// references (never values) for the four MINDBODY_* variables
# and MCP_AUTH_TOKEN in a gitignored .env.op-refs.compose file.
# (docker-compose refuses to start the service without MCP_AUTH_TOKEN)
nano .env.op-refs.compose

# Start services. op resolves the references into compose's environment.
op run --env-file .env.op-refs.compose -- docker-compose up -d

# View logs
docker-compose logs -f

# Scale horizontally
docker-compose up -d --scale mindbody-mcp-sse=3
```

## SSE Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/sse` | GET | Opens the event stream (token required). The first event, `endpoint`, carries the message URL: `/sse?sessionId=<uuid>` |
| `/sse?sessionId=<uuid>` | POST | One JSON-RPC message for that session (token required). `202` when accepted; the response arrives on that session's stream |
| `/health` | GET | Health check endpoint (no token) |
| `/info` | GET | Server information and capabilities (token required) |
| `/metrics` | GET | Prometheus metrics (optional) |

### How messages are routed

Each `GET /sse` gets its own MCP server instance and a fresh `sessionId`. The server keeps open sessions in memory, keyed by `sessionId`, and removes one when its stream closes. A message POST goes through the same bearer check and the same DNS-rebinding check as the stream, then:

| Request | Result |
|---------|--------|
| `POST /sse?sessionId=<live id>` | `202`; the JSON-RPC response is sent on that session's stream only |
| `POST /sse` with no `sessionId` | `400` |
| `POST /sse?sessionId=<unknown or closed id>` | `404` |
| `Host` (or a configured `Origin`) not on the allowlist | `403`; the message is not dispatched |
| No or wrong bearer token | `401` |

Sessions live in one process's memory, so behind a load balancer with several replicas (for example `docker-compose --scale`), every request for a session must reach the replica that opened its stream: use sticky sessions, or run one replica.

## Client Connection

### JavaScript/TypeScript Client

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

// Create SSE transport. requestInit.headers is sent on the stream request
// and on every message POST.
const transport = new SSEClientTransport(
  new URL('https://mcp.yourdomain.com/sse'),
  {
    requestInit: {
      headers: { Authorization: `Bearer ${process.env.MCP_AUTH_TOKEN}` },
    },
  }
);

// Create MCP client
const client = new Client({
  name: 'my-client',
  version: '1.0.0',
}, {
  capabilities: {}
});

// Connect to server
await client.connect(transport);

// Use the client
const result = await client.callTool(
  'getClasses',
  { startDate: '2024-01-01', endDate: '2024-01-07' }
);
```

### Testing SSE Connection

```bash
# Health check
curl https://mcp.yourdomain.com/health

# Server info
curl -H "Authorization: Bearer $MCP_AUTH_TOKEN" https://mcp.yourdomain.com/info

# Test SSE stream (will keep connection open)
curl -N -H "Accept: text/event-stream" \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  https://mcp.yourdomain.com/sse

# Without the token: expect 401
curl -i https://mcp.yourdomain.com/sse
```

## Security Considerations

### SSL/TLS Configuration

1. **Generate SSL certificates**:
```bash
# Self-signed (development)
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes

# Let's Encrypt (production)
certbot certonly --standalone -d mcp.yourdomain.com
```

2. **Configure server**:
```bash
MCP_SSL_CERT=/path/to/cert.pem
MCP_SSL_KEY=/path/to/key.pem
```

### Host, Origin and CORS

Three settings shape which browsers and hosts can reach the SSE endpoints. They sit beside the bearer token, not in place of it.

**Order of checks.** Every request except `GET /health` and `OPTIONS` is checked for the bearer token first, so a request without it gets `401` whatever its Host. Only an authenticated request reaches the DNS-rebinding check on `GET /sse` and `POST /sse?sessionId=`, which answers `403` on a mismatch.

**`MCP_ALLOWED_HOSTS` (DNS-rebinding protection).** On by default. The `Host` header must match an entry exactly, port included. Unset, the list is `localhost`, `127.0.0.1` and `[::1]`, each bare, with `:3000` and with the listening port, so local development needs no setting. Behind a public hostname, set it to the `Host` your clients send, or every remote request is refused with `403`. The server prints a warning at startup when it binds off loopback with this unset.

```bash
MCP_ALLOWED_HOSTS=mcp.yourdomain.com,mcp.yourdomain.com:443
```

**`MCP_ALLOWED_ORIGINS`.** Unset, `Origin` is not checked; native MCP clients send none. Set, a request that carries an `Origin` must match an entry exactly. A request without `Origin` still passes, so this restricts browsers only.

```bash
MCP_ALLOWED_ORIGINS=https://app.yourdomain.com
```

**`MCP_CORS_ORIGIN`.** Sent verbatim as `Access-Control-Allow-Origin` on every response, so it takes one origin or `*`, never a list. It only tells browsers which page may read the responses; it does not refuse anything on the server. Pair it with `MCP_ALLOWED_ORIGINS` to enforce the same origin.

```bash
# Development (any origin may read responses)
MCP_CORS_ORIGIN=*

# Production (one browser origin)
MCP_CORS_ORIGIN=https://app.yourdomain.com
```

**No credentials mode.** The server never sends `Access-Control-Allow-Credentials`. Authentication is the `Authorization: Bearer` header, which a browser sends without credentials mode, and the server reads no cookies. A browser client must therefore send the token explicitly; it is not attached by the browser.

**`MCP_DNS_REBINDING_PROTECTION=false`** turns off the Host and Origin checks. Use it only behind a proxy that already pins the Host; the bearer token still applies.

### Network Security

1. **Firewall rules**:
```bash
# Allow only HTTPS traffic
sudo ufw allow 443/tcp
sudo ufw deny 3000/tcp  # Block direct access to SSE port
```

2. **Rate limiting** (configured in nginx.conf):
- 10 requests per second per IP
- Maximum 10 concurrent connections per IP

## Monitoring

### Health Checks

```bash
# Simple health check
while true; do
  curl -s https://mcp.yourdomain.com/health | jq .
  sleep 30
done
```

### Logging

```bash
# View Docker logs
docker logs -f mindbody-mcp-sse

# View Kubernetes logs
kubectl logs -f deployment/mindbody-mcp-sse -n mindbody-mcp
```

### Metrics

The server exposes Prometheus-compatible metrics at `/metrics` endpoint (when enabled).

## Troubleshooting

### Common Issues

1. **Connection refused**:
   - Check if server is running: `docker ps` or `kubectl get pods -n mindbody-mcp`
   - Verify port is not blocked: `sudo netstat -tlnp | grep 3000`
   - Check firewall rules: `sudo ufw status`

2. **CORS errors**:
   - Set `MCP_CORS_ORIGIN` to the client's origin (one origin or `*`)
   - A `403 Invalid Host header` means `MCP_ALLOWED_HOSTS` lacks the Host the client sends; `403 Invalid Origin header` means `MCP_ALLOWED_ORIGINS` lacks its Origin
   - Ensure nginx is properly forwarding headers

3. **SSL certificate errors**:
   - Verify certificate paths are correct
   - Check certificate validity: `openssl x509 -in cert.pem -text -noout`
   - Ensure certificate matches domain name

4. **SSE connection drops**:
   - Check nginx timeout settings
   - Verify keep-alive is properly configured
   - Monitor server resources (CPU, memory)

5. **Server exits with "Refusing to start the SSE transport ... without MCP_AUTH_TOKEN"**:
   - The server binds off loopback and has no token. Set `MCP_AUTH_TOKEN`, or bind to `127.0.0.1`.

6. **Client gets `401 Unauthorized`**:
   - The client sends no token, the wrong token, or a scheme other than `Bearer`. Send `Authorization: Bearer <MCP_AUTH_TOKEN>`.

### Debug Mode

```bash
# Enable verbose logging
NODE_ENV=development MCP_LOG_LEVEL=debug bun run start:sse
```

## Performance Tuning

### Server Configuration

```bash
# Increase file descriptor limits
ulimit -n 65536

# Optimize TCP settings (Linux)
sudo sysctl -w net.core.somaxconn=1024
sudo sysctl -w net.ipv4.tcp_tw_reuse=1
```

### Horizontal Scaling

```yaml
# Kubernetes HPA will auto-scale based on CPU/memory
kubectl autoscale deployment mindbody-mcp-sse \
  --min=2 --max=10 --cpu-percent=70
```

### Load Balancing

The nginx configuration includes upstream load balancing with health checks and automatic failover.

## Backup and Recovery

### Configuration Backup

```bash
# Backup configuration
tar -czf mcp-config-backup.tar.gz \
  .env \
  deploy/ \
  docker-compose.yml

# Backup Kubernetes configs
kubectl get all -n mindbody-mcp -o yaml > k8s-backup.yaml
```

### Disaster Recovery

1. Keep configuration in version control
2. Use Kubernetes ConfigMaps/Secrets for configuration
3. Implement automated backups of environment files
4. Document all customizations and deployments

## Support

For issues or questions:
1. Check server logs for error messages
2. Verify all environment variables are set correctly
3. Test with `curl` to isolate client vs server issues
4. Review the [main documentation](../README.md)
5. Open an issue on GitHub with debug logs