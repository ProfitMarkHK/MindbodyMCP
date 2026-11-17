# Quick Setup Guide

## 1. Install Dependencies

```bash
cd /path/to/MindbodyMCP
bun install
```

Bun is the runtime; if you only have Node.js, see [Using Node.js](../README.md#using-nodejs-optional).

## 2. Configure Environment

Create a `.env` file in the project root:

```bash
copy .env.example .env
```

Then edit `.env` with your Mindbody credentials.

## 3. Test the Connection

Run the test script to verify everything works:

```bash
bun run test:tool
```

This will attempt to fetch Alexia Bauer's schedule. If successful, you'll see her classes listed.

## 4. Configure Claude Desktop

Edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mindbody": {
      "command": "bun",
      "args": ["run", "/path/to/MindbodyMCP/src/index.ts"],
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
