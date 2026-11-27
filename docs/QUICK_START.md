# Quick Setup Guide

## 1. Install Dependencies

```bash
cd /path/to/MindbodyMCP
bun install
```

Bun is the runtime; if you only have Node.js, see [Using Node.js](../README.md#using-nodejs-optional).

## 2. Configure Credentials

Point the four `MINDBODY_*` variables at your 1Password item as `op://` references, in your shell or in a gitignored references file. No env file is required, and one may hold references only, never a value. See [1Password setup](../README.md#1password-setup); [`.env.example`](../.env.example) lists the optional non-secret settings.

## 3. Test the Connection

Run the test script to verify everything works:

```bash
# add --env-file .env.op-refs if the references are in a file
op run -- bun run test:tool
```

This will attempt to fetch Alexia Bauer's schedule. If successful, you'll see her classes listed.

## 4. Configure Claude Desktop

Edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mindbody": {
      "command": "op",
      "args": ["run", "--", "bun", "run", "/path/to/MindbodyMCP/src/index.ts"],
      "env": {
        "MINDBODY_API_KEY": "op://<vault>/<item>/<api-key-field>",
        "MINDBODY_SITE_ID": "op://<vault>/<item>/<site-id-field>",
        "MINDBODY_SOURCE_NAME": "op://<vault>/<item>/<source-name-field>",
        "MINDBODY_SOURCE_PASSWORD": "op://<vault>/<item>/<source-password-field>"
      }
    }
  }
}
```

The `env` block holds `op://` references, not values; `op run` resolves them when the client starts the server. Replace `<vault>`, `<item>` and the field names with your own. A client started this way may have no terminal for the unlock prompt — see [docs/SETUP.md](SETUP.md) Step 5b for the service-account variant.

## 5. Restart Claude Desktop

After saving the config, restart Claude Desktop to load the MCP server.

## 6. Test in Claude

Try asking:
- "Using the mindbody tool, show me Alexia Bauer's schedule for this week"
- "What classes is Alexia teaching tomorrow?"
- "Get the schedule for [teacher name] from [date] to [date]"

## Troubleshooting

If the test script fails:
1. Check your `.env` file has all 4 required variables
2. Verify your API credentials are correct
3. Ensure the teacher name exists in your Mindbody site
4. Check the console for specific error messages

If Claude can't find the tool:
1. Make sure `bun` is on the PATH Claude Desktop uses (`bun --version`; there is no build step)
2. Verify the path in claude_desktop_config.json is correct
3. Check Claude's MCP logs for errors
4. Restart Claude Desktop completely
