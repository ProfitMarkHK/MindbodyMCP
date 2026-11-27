#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Start a loopback Streamable HTTP MCP sidecar, resolving credentials from 1Password
  at launch.

.DESCRIPTION
  Runs:
    op run --env-file <refs> -- bun --watch run <entry> --transport http \
        --port <port> --host 127.0.0.1

  <entry> is scripts/dev-sandbox.ts for sandbox, which pins the site to -99 and refuses a
  conflicting MINDBODY_SITE_ID; and src/index.ts for prod.

  Manual use only. Nothing here runs at logon, by design: the 1Password unlock
  prompt needs a human, and the sidecar only needs to exist while you are working
  against Mindbody.

  The refs file holds `op://` pointers only, never secret values. It is gitignored.

  Why a sidecar instead of stdio: a client that spawns `op run` itself dies 60s
  after a locked vault with `error initializing client: authorization timeout`,
  with nothing on screen to explain it. Starting it here moves the failure into a
  terminal you can see, and decouples the secret-holding process from the client.

  Background mode assumes the 1Password desktop app integration is enabled, so the
  unlock prompt is a GUI dialog. If your CLI falls back to a console password
  prompt, that prompt would be invisible: use the default foreground mode instead.

.PARAMETER Profile
  sandbox (default) or prod. prod connects to the LIVE Mindbody site.

.PARAMETER Port
  Loopback port to bind. Default 3000.

.PARAMETER Background
  Detach, then poll /health until the server answers. Default is foreground, where
  Ctrl-C stops it.

.PARAMETER Stop
  Terminate a running sidecar. Kills the whole process tree, because `bun --watch`
  will otherwise respawn a listener you just killed.

.EXAMPLE
  ./scripts/mcp-sidecar.ps1

.EXAMPLE
  ./scripts/mcp-sidecar.ps1 -Profile prod -Background

.EXAMPLE
  ./scripts/mcp-sidecar.ps1 -Stop
#>
[CmdletBinding()]
param(
  [ValidateSet('sandbox', 'prod')]
  [string]$Profile = 'sandbox',
  [int]$Port = 3000,
  [switch]$Background,
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }
# Sandbox goes through dev-sandbox.ts, which forces MINDBODY_SITE_ID=-99 in code, so a
# wrong SITE_ID in the sandbox refs or 1Password item cannot reach a live site.
if ($Profile -eq 'prod') {
  $entry = Join-Path $root 'src\index.ts'
  $refs = Join-Path $root '.env.op-refs.prod'
} else {
  $entry = Join-Path $root 'scripts\dev-sandbox.ts'
  $refs = Join-Path $root '.env.op-refs'
}

$stateDir = Join-Path $env:LOCALAPPDATA 'mindbody-mcp'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$pidFile = Join-Path $stateDir "sidecar-$Profile.pid"
$logOut = Join-Path $stateDir "sidecar-$Profile.log"
$logErr = Join-Path $stateDir "sidecar-$Profile.err.log"

$healthUrl = "http://127.0.0.1:$Port/health"
$mcpUrl = "http://127.0.0.1:$Port/mcp"

function Fail {
  param([string[]]$Lines)
  foreach ($line in $Lines) { [Console]::Error.WriteLine($line) }
  exit 1
}

function Test-Health {
  try {
    $r = Invoke-WebRequest -Uri $healthUrl -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
    return ($r.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Get-PortOwners {
  $owners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
  return @($owners)
}

function Stop-Tree {
  param([int]$ProcessId)
  # /T is required: `bun --watch` forks the real listener, so killing only the
  # listener makes the watcher start a new one.
  & taskkill.exe /T /F /PID $ProcessId 2>&1 | Out-Null
}

# ---------------------------------------------------------------- -Stop
if ($Stop) {
  $targets = New-Object System.Collections.Generic.List[int]
  if (Test-Path $pidFile) {
    $raw = (Get-Content $pidFile -Raw).Trim()
    if ($raw -match '^\d+$') { $targets.Add([int]$raw) }
  }
  foreach ($owner in Get-PortOwners) { if (-not $targets.Contains($owner)) { $targets.Add($owner) } }

  if ($targets.Count -eq 0) {
    Write-Host "Nothing listening on 127.0.0.1:$Port and no pid file at $pidFile."
    exit 0
  }

  foreach ($target in $targets) { Stop-Tree -ProcessId $target }
  Remove-Item $pidFile -ErrorAction SilentlyContinue
  Write-Host "Stopped sidecar (pid $($targets -join ', ')) on port $Port."
  exit 0
}

# ---------------------------------------------------------- pre-flight
if (Test-Health) {
  Write-Host "Already running and healthy."
  Write-Host "  MCP:    $mcpUrl"
  Write-Host "  health: $healthUrl"
  Write-Host "  stop:   $($MyInvocation.MyCommand.Path) -Stop"
  exit 0
}

$stale = Get-PortOwners
if ($stale.Count -gt 0) {
  Fail @(
    "Port $Port is held by pid $($stale -join ', ') but /health does not answer.",
    "Stop it first: $($MyInvocation.MyCommand.Path) -Stop"
  )
}

if (-not (Test-Path $refs)) {
  Fail @(
    "Missing refs file: $refs",
    '',
    'It must contain only op:// pointers, one per line, e.g.',
    '  MINDBODY_API_KEY=op://<vault>/<item>/MINDBODY_API_KEY',
    '',
    'and must be gitignored. See .env.op-refs for the sandbox template.'
  )
}

foreach ($tool in 'op', 'bun') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    Fail @("'$tool' is not on PATH.")
  }
}

if ($Profile -eq 'prod') {
  Write-Host "PROFILE: prod - this connects to the LIVE Mindbody site." -ForegroundColor Yellow
}

$env:MCP_ALLOW_UNAUTHENTICATED = 'true'

$argLine = 'run --env-file "{0}" -- bun --watch run "{1}" --transport http --port {2} --host 127.0.0.1' -f `
  $refs, $entry, $Port

# ------------------------------------------------------------ foreground
if (-not $Background) {
  Write-Host "Starting sidecar (foreground). Unlock 1Password when prompted."
  Write-Host "  MCP:    $mcpUrl"
  Write-Host "  health: $healthUrl"
  Write-Host "  stop:   Ctrl-C, or $($MyInvocation.MyCommand.Path) -Stop"
  Write-Host ''
  & op run --env-file $refs -- bun --watch run $entry --transport http --port $Port --host 127.0.0.1
  exit $LASTEXITCODE
}

# ------------------------------------------------------------ background
Write-Host "Starting sidecar in the background. Unlock 1Password when prompted."

$proc = Start-Process -FilePath 'op' -ArgumentList $argLine -WorkingDirectory $root -PassThru `
  -WindowStyle Hidden -RedirectStandardOutput $logOut -RedirectStandardError $logErr

$proc.Id | Set-Content -Path $pidFile -Encoding ascii

# 90s: the CLI gives up on a locked vault after 60s, so allow a little beyond it
# for a human to answer the prompt.
$deadline = (Get-Date).AddSeconds(90)
$healthy = $false
while ((Get-Date) -lt $deadline) {
  if ($proc.HasExited) { break }
  if (Test-Health) { $healthy = $true; break }
  Start-Sleep -Milliseconds 500
}

if (-not $healthy) {
  Write-Host ''
  [Console]::Error.WriteLine('Sidecar did not become healthy within 90s.')
  if (Test-Path $logErr) {
    Write-Host '--- last stderr lines ---'
    Get-Content $logErr -Tail 15 | ForEach-Object { [Console]::Error.WriteLine($_) }
  }
  # Clean up rather than leaving a zombie holding the port, which would then trip
  # the pre-flight guard on the next run.
  Stop-Tree -ProcessId $proc.Id
  Remove-Item $pidFile -ErrorAction SilentlyContinue
  [Console]::Error.WriteLine("Cleaned up pid $($proc.Id).")
  exit 1
}

Write-Host ''
Write-Host 'Sidecar is up.'
Write-Host "  MCP:    $mcpUrl"
Write-Host "  health: $healthUrl"
Write-Host "  pid:    $($proc.Id)  (recorded in $pidFile)"
Write-Host "  logs:   $logOut"
Write-Host "          $logErr"
Write-Host "  stop:   $($MyInvocation.MyCommand.Path) -Stop"
Write-Host ''
Write-Host 'Client config (stdio-only clients):'
Write-Host '  { "mcpServers": { "mindbody": { "command": "npx",'
Write-Host ('      "args": ["-y", "mcp-remote", "' + $mcpUrl + '"] } } }')
