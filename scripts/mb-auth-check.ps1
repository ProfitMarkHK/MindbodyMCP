#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Probe Mindbody auth in one command: which of the four credentials is wrong?

.DESCRIPTION
  The probe is scripts/mb-auth-check.ts, run with bun. Its network calls live in that
  TypeScript file so the gate can scan them (docs/quality-gates.md, rule 6); this wrapper
  only passes its arguments through. Read the .ts file for what each step checks.

  Without --client-id the first three steps run and the exit code is 2.

.EXAMPLE
  op run --env-file .env.op-refs -- pwsh -NoProfile -File ./scripts/mb-auth-check.ps1 --client-id 12345

.EXAMPLE
  op run --env-file .env.op-refs.prod -- pwsh -NoProfile -File ./scripts/mb-auth-check.ps1 --client-id 12345
#>

$probe = Join-Path $PSScriptRoot 'mb-auth-check.ts'
& bun run $probe @args
exit $LASTEXITCODE
