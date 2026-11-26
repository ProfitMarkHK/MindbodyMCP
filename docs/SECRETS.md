# Secrets and local 1Password tooling

There are two different secrets in play, and they must not be confused:

- The **1Password service account token (SAT)** starts with `ops_`. It authorizes the
  `op` CLI on this machine. It is never a Mindbody token and never an environment
  variable for the server.
- The **Mindbody credentials** (`MINDBODY_API_KEY`, `MINDBODY_SITE_ID`,
  `MINDBODY_SOURCE_NAME`, `MINDBODY_SOURCE_PASSWORD`) live in 1Password items.
  They are passed to the server by `op run`, which resolves `op://` pointers from
  a ref file at launch.

The SAT stays in the operating system's credential store. The ref files contain
only pointers, never values, and are safe to back up. These scripts are
**local-only**: nothing here publishes to a platform or calls Mindbody.

## Install the SAT

Store the SAT in the OS credential store for one profile at a time:

```bash
bun run scripts/op-sat.ts install sandbox   # or: prod
```

- **macOS: run the install command in an interactive terminal; piping a SAT is
  rejected.** `security -w` prompts on the terminal; the child process inherits
  stdio so the prompt reaches the real tty. Piped stdin is not used because
  `security -w` does not read a piped SAT, and a closed pipe can silently store an
  empty password. The `-w` flag is last and has no argument, so the SAT never
  appears in argv or process listings.
- **Windows and Linux: the SAT MUST be piped; a TTY install is rejected.** Pipe
  the output of your one-time `op service-account create` command straight into
  the installer. There is no interactive prompt on these platforms, so running
  the install command in a terminal without a pipe fails before any store
  command runs.
- On Linux, `secret-tool store --label ... service mindbody-op-sat account <profile>`
  is used when `secret-tool` is installed **and** `DBUS_SESSION_BUS_ADDRESS` is
  set. Otherwise the script falls back to a mode-600 file at
  `~/.config/mindbody-op-sat/<profile>` in a mode-0700 directory. The fallback
  still requires a piped SAT; there is no interactive prompt.
- On Windows, the token is written from stdin to
  `%LOCALAPPDATA%\mindbody-op-sat\<profile>.bin`, protected with DPAPI
  (`DataProtectionScope.CurrentUser`) and given a restrictive ACL where `icacls`
  is available. The PowerShell command receives the path through an environment
  variable, not an argument.

`read` prints the bare SAT to stdout and nothing else (no prefix, no logging):

```bash
bun run scripts/op-sat.ts read sandbox
```

`doctor` prints statuses only — `sat_shape`, `op_whoami_service_account`,
`op_vault_exact` — and never prints a value. It checks that the SAT has the
`ops_` shape, that `op whoami` reports `SERVICE_ACCOUNT`, and that
`op vault list --format=json` shows exactly the expected vault:

```bash
bun run scripts/op-sat.ts doctor prod
```

Expected vaults: `MindbodyMCP Prod` for `prod`, `MindbodyMCP Sandbox` for
`sandbox`. Expected OS-store accounts: `mindbody-prod` and `mindbody-sandbox`.

## Ref files

Copy the templates and replace the vault and item placeholders with your real
vault and item names (placeholders are deliberately left in the committed
examples):

```bash
mkdir -p ~/.config/mindbody
cp config/op-refs/prod.env.example ~/.config/mindbody/prod.env
cp config/op-refs/sandbox.env.example ~/.config/mindbody/sandbox.env
chmod 600 ~/.config/mindbody/*.env
```

```
MINDBODY_API_KEY=op://<vault>/<prod-item-name>/API_KEY
MINDBODY_SITE_ID=op://<vault>/<prod-item-name>/SITE_ID
MINDBODY_SOURCE_NAME=op://<vault>/<prod-item-name>/SOURCE_NAME
MINDBODY_SOURCE_PASSWORD=op://<vault>/<prod-item-name>/SOURCE_PASSWORD
```

The sandbox template uses `op://<vault>/<sandbox-item>/<FIELD>` placeholders
and omits `MINDBODY_SITE_ID`: `scripts/dev-sandbox.ts` pins the site to `-99`
regardless of the environment. Set `MINDBODY_OP_REF_FILE=/path/to/refs.env` to
override the default path if you keep ref files elsewhere.

## MCP client configuration

The launcher reads the SAT, puts it in the child process environment only, checks
the ref file, then runs `op run --env-file=<path> -- bun run <entry>` with
inherited stdio. No credential is printed.

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mindbody-sandbox": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/MindbodyMCP/scripts/mcp-launch.ts", "sandbox"]
    }
  }
}
```

OpenCode V2 (`command` is an array, server names live under `mcp.servers`, and
`environment` uses `{env:NAME}` substitution — not `$NAME`):

```json
{
  "mcp": {
    "servers": {
      "mindbody-prod": {
        "type": "local",
        "command": ["bun", "run", "/absolute/path/to/MindbodyMCP/scripts/mcp-launch.ts", "prod"],
        "cwd": "/absolute/path/to/MindbodyMCP",
        "environment": {
          "MINDBODY_OP_REF_FILE": "{env:MINDBODY_OP_REF_FILE}"
        }
      }
    }
  }
}
```

The launcher pins its child's cwd to the repository root itself, so MCP hosts
that ignore `cwd` still work.

Equivalent shell commands: `bun run launch:sandbox` and `bun run launch:prod`.
The older `dev`, `dev:sse`, `start:*` and `node:*` scripts remain available; they
still expect `op://` references exported directly in the shell environment.

## Production: no `op` in production

Hosted deployments must contain **zero secret-fetch logic**. Railway service
variables or Azure Key Vault references inject plain `MINDBODY_*` variables;
`src/index.ts` reads `process.env` and never branches on platform. The Docker
image copies only `src` and `tsconfig.json`, so neither `op` nor these scripts
are shipped.

```bash
MCP_TRANSPORT=http MCP_PORT=3000 bun run start:platform
```

`start:platform` is plain `bun run src/index.ts`, with no `op` wrapper. Set the
transport and port through your platform's variable UI.

`scripts/seed-platform-secrets.ts` is a **local admin/rotation tool only**; it
is never part of the runtime image. It resolves the four `MINDBODY_*` pointers
with `op read --no-newline <ref>` using the SAT and prints variable names only:

```bash
RAILWAY_SERVICE=mindbody-mcp bun run scripts/seed-platform-secrets.ts railway prod
AZURE_KEYVAULT=my-vault bun run scripts/seed-platform-secrets.ts azure production
```

- Railway: `railway variable set <KEY> --stdin -s <service> -e <env> --skip-deploys`;
  the value goes to stdin. `RAILWAY_SERVICE` is required. The second CLI argument
  is the Railway environment name.
- Azure: values go to mode-600 temp files removed in `finally`, then
  `az keyvault secret set --vault-name <vault> --name <secret-name> --file <tmp>`.
  `AZURE_KEYVAULT` is required; secret names default to `<environment>-<key-name>`
  and can be prefixed with `AZURE_SECRET_PREFIX`.
- The CLI environment name selects the ref-file profile: `prod`/`production` →
  `prod`, `sandbox` → `sandbox`. Set `MINDBODY_OP_PROFILE` explicitly for any
  other name.

## Rotation

1. Create a new 1Password service account token and reinstall it in the OS store
   (`bun run scripts/op-sat.ts install <profile>`), then run `doctor`.
2. Rotate the Mindbody fields in the 1Password items. Their vault, item and
   field names are unchanged, so the ref files need no edits.
3. Re-run the seed tool for each hosted environment so Railway service variables
   or Azure Key Vault secrets pick up the new values. Restart the deployments.
4. Revoke the old SAT.

A `doctor` failure is fail-closed: no command prints a token, and an empty or
malformed SAT is never used as an authorized `op` session.
