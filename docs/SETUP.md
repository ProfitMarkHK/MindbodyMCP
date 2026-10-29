# Setup Guide

This guide will walk you through setting up the Mindbody MCP Server from scratch.

## Prerequisites

Before you begin, ensure you have:

- Windows 10/11, macOS, or Linux
- Administrator access (for installing Bun)
- Mindbody API credentials
- Claude Desktop installed
- Git (for cloning the repository)

## Step 1: Install Bun

Bun is our recommended runtime for optimal performance.

### Windows

Open PowerShell as Administrator and run:

```powershell
# Install Bun
irm bun.sh/install.ps1 | iex

# Verify installation
bun --version
```

### macOS/Linux

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Verify installation
bun --version
```

### Alternative: Use Node.js

If you prefer Node.js:

```bash
# Ensure Node.js 18+ is installed
node --version

# Switch to Node.js configuration
./switch.bat node  # Windows
# or
cp package.node.json package.json  # macOS/Linux
```

## Step 2: Clone the Repository

```bash
# Clone the repository
git clone https://github.com/yourusername/mindbody-mcp.git
cd mindbody-mcp

# Install dependencies
bun install
```

## Step 3: Configure Environment

### Create Environment File

```bash
# Copy the example file
cp .env.example .env

# Edit with your preferred editor
# Windows: notepad .env
# macOS/Linux: nano .env
```

### Required Environment Variables

Edit `.env` with your Mindbody credentials:

```env
# Get these from Mindbody Partner Portal
MINDBODY_API_KEY=your_actual_api_key_here
MINDBODY_SITE_ID=-99  # Use -99 for sandbox, or your production site ID

# Source credentials (create in Partner Portal)
MINDBODY_SOURCE_NAME=YourSourceName
MINDBODY_SOURCE_PASSWORD=YourSourcePassword

# Optional settings
MINDBODY_API_URL=https://api.mindbodyonline.com/public/v6
CACHE_TTL_MINUTES=5
RATE_LIMIT_BUFFER=100
```

### Getting Mindbody Credentials

1. **Sign up for Mindbody Developer Account**
   - Go to [developers.mindbodyonline.com](https://developers.mindbodyonline.com)
   - Create a developer account
   - Access the Partner Portal

2. **Create an App**
   - In Partner Portal, create a new app
   - Note your API Key

3. **Create Source Credentials**
   - In your app settings, create source credentials
   - These are different from your developer login
   - Save the username and password

4. **Get Site ID**
   - For testing: Use `-99` (sandbox)
   - For production: Get from your Mindbody business account

## Step 4: Test the Installation

### Run the Test Tool

```bash
# Test the connection and tool
bun run test:tool

# You should see output like:
# Testing Mindbody MCP Server...
# Test 1: Getting schedule for "Alexia Bauer"...
# Results:
# Teacher: Alexia Bauer (ID: 100000123)
# ...
```

### Common Test Issues

| Error | Solution |
|-------|----------|
| "Missing required environment variable" | Check your `.env` file has all 4 required variables |
| "401 Unauthorized" | Verify your API credentials are correct |
| "Teacher not found" | Normal for sandbox - try a different name or check your site |
| "Connection refused" | Check internet connection and firewall settings |

## Step 5: Configure Claude Desktop

### Find Configuration File

**Windows:**
```
%APPDATA%\Claude\claude_desktop_config.json
```

**macOS:**
```
~/Library/Application Support/Claude/claude_desktop_config.json
```

**Linux:**
```
~/.config/Claude/claude_desktop_config.json
```

### Edit Configuration

Add the Mindbody MCP server to your configuration:

```json
{
  "mcpServers": {
    "mindbody": {
      "command": "bun",
      "args": ["run", "C:\\full\\path\\to\\mindbody-mcp\\src\\index.ts"],
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

**Important Notes:**
- Use full absolute paths
- On Windows, use double backslashes (`\\`)
- Include all 4 required environment variables
- Save the file with valid JSON

### Restart Claude Desktop

After saving the configuration:

1. Completely quit Claude Desktop
2. Start Claude Desktop again
3. Look for "mindbody" in the MCP servers list

## Step 5b: Configure Claude Code

Claude Code registers the server with `claude mcp add`. Register two instances: one for the sandbox and one for production. Both use user scope, so they are available in every project.

Requirements: `claude` on your PATH and Bun installed (Step 1). `bun run --cwd` runs each command from the repo folder, so it works from any directory.

### Sandbox instance (`mindbody-sandbox`)

The sandbox instance pulls its API key and Source credentials from a 1Password item of its own, separate from production. Its item's `MINDBODY_SITE_ID` is `-99`. Mindbody does not issue per-environment keys, so the sandbox item may hold the same key as production. `scripts/dev-sandbox.ts` always uses site `-99` and ignores any other `MINDBODY_SITE_ID`, so this instance cannot reach a live site. No `.env` file is read.

```bash
claude mcp add mindbody-sandbox --scope user -e MINDBODY_API_KEY=op://<vault>/<item>/<api-key-field> -e MINDBODY_SOURCE_NAME=op://<vault>/<item>/<source-name-field> -e MINDBODY_SOURCE_PASSWORD=op://<vault>/<item>/<source-password-field> -- op run -- bun run --cwd E:/MindbodyMCP scripts/dev-sandbox.ts
```

Replace `E:/MindbodyMCP` with your clone's path. Point the references at your sandbox item, not the production one.

### Production instance (`mindbody-prod`)

The production instance pulls its four required values from 1Password at launch, the same way `bun run dev` does. No production secret is stored in the repo, in an env file, or in the Claude config. The Claude config holds only `op://` references, which name a 1Password item and field but not its value. No `.env` file is needed.

1. Install the 1Password CLI (`op`) and turn on its desktop app integration (see [1Password setup](../README.md#1password-setup)).
2. Register the instance, replacing `<vault>`, `<item>` and the field names with your item's references (`op item get <item> --format json` lists its field IDs and labels):

   ```bash
   claude mcp add mindbody-prod --scope user -e MINDBODY_API_KEY=op://<vault>/<item>/<api-key-field> -e MINDBODY_SITE_ID=op://<vault>/<item>/<site-id-field> -e MINDBODY_SOURCE_NAME=op://<vault>/<item>/<source-name-field> -e MINDBODY_SOURCE_PASSWORD=op://<vault>/<item>/<source-password-field> -- op run -- bun run --cwd E:/MindbodyMCP src/index.ts
   ```

Each launch of the production instance triggers a 1Password approval through the desktop app. The instance uses live credentials, so it can book, cancel and charge for real.

### Check both instances

```bash
claude mcp list
```

Both should show `✔ Connected`. If `mindbody-prod` shows `✘ Failed to connect`, a reference is probably wrong or 1Password has not approved the launch. Run `op read "op://<vault>/<item>/<field>"` for each reference to check it resolves.

## Step 6: Verify Integration

### Test in Claude

Try these commands in Claude:

```
"Using the mindbody tool, get Alexia Bauer's schedule for this week"

"Show me what classes John Smith is teaching tomorrow"

"List Sarah Johnson's yoga classes for next Monday"
```

### Check MCP Connection

In Claude Desktop:
1. Click the tools icon
2. Look for "mindbody" in the connected servers
3. Click on it to see available tools

## Troubleshooting

### MCP Server Not Showing in Claude

1. **Check JSON syntax**
   ```bash
   # Validate your config file
   python -m json.tool "%APPDATA%\Claude\claude_desktop_config.json"
   ```

2. **Verify paths**
   - Ensure the path to `index.ts` is absolute
   - Check file exists at that location

3. **Check logs**
   - Windows: `%APPDATA%\Claude\logs\`
   - macOS: `~/Library/Logs/Claude/`

### Authentication Errors

1. **Verify credentials in `.env`**
   ```bash
   # Test directly
   bun run test:tool
   ```

2. **Check API key permissions**
   - Log into Partner Portal
   - Verify API key is active
   - Check rate limits haven't been exceeded

### Performance Issues

1. **Use performance benchmark**
   ```bash
   bun run benchmark
   ```

2. **Check cache is working**
   - Second identical request should be faster
   - Look for cache-related output in logs

3. **Consider switching to Bun**
   ```bash
   ./switch.bat bun
   bun install
   ```

## Next Steps

1. **Explore the API**
   - Read [API documentation](./API.md)
   - Try different queries
   - Understand the response format

2. **Customize for your needs**
   - Adjust cache TTL
   - Add error handling
   - Create new tools

3. **Contribute**
   - Report issues
   - Submit pull requests
   - Share your tools

## Getting Help

- **GitHub Issues**: Report bugs or request features
- **Discord**: Join our community (link in README)
- **Email**: support@example.com

Happy coding! 🎉
