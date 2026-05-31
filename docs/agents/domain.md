# Domain Documentation

This project uses a **single-context** layout for domain docs and architectural decisions.

## Structure

```
repo/
├── CONTEXT.md              # Domain language, terminology, constraints
└── docs/adr/               # Architectural decision records
    ├── 0001-chosen-runtime.md
    ├── 0002-mcp-architecture.md
    └── ...
```

## CONTEXT.md

A living document that describes:
- **What this project is** — purpose, domain, users
- **Key concepts** — terms of art unique to this domain
- **Constraints** — technical, business, or regulatory limits
- **Dependencies** — what this project relies on
- **Non-goals** — what this project explicitly doesn't do

Skills like `improve-codebase-architecture`, `diagnose`, and `tdd` read `CONTEXT.md` to:
- Understand domain language so they use correct terminology
- Learn constraints before suggesting changes
- Identify non-goals before proposing features

**Example:**

```markdown
# Mindbody MCP Server - Domain Context

## What We Are
A Model Context Protocol server bridging AI assistants to the Mindbody API for fitness studio management.

## Key Concepts
- **MCP**: Model Context Protocol — bidirectional communication between Claude and tools
- **Studio**: A fitness/wellness venue (yoga, pilates, gym, etc.)
- **Mindbody API v6**: REST API for studio operations (classes, clients, sales, appointments)
- **Tool**: An MCP-exposed function that Claude can call

## Constraints
- Mindbody API rate limit: 2000 requests/hour per site
- OAuth token lifecycle: tokens refresh before expiry
- Single-instance design: in-memory cache, no horizontal scaling
- No persistent storage: cache clears on restart

## Non-Goals
- Multi-site orchestration (future enhancement)
- Real-time webhooks (use polling for now)
- Advanced analytics (focus on operational data)
```

## docs/adr/

Numbered markdown files (0001, 0002, …) recording **why** architectural decisions were made:

- **0001-chosen-runtime.md** — Why Bun instead of Node.js
- **0002-mcp-architecture.md** — Why the layered tool/api/cache structure
- etc.

Skills read these to understand the *reasoning* behind current architecture before suggesting changes.

## Updating These Files

Edit `CONTEXT.md` and `docs/adr/*.md` directly as the project evolves. Skills will read the latest version on each run.
