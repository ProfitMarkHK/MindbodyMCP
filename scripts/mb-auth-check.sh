#!/usr/bin/env bash
#
# Probe Mindbody auth in one command: which of the four credentials is wrong?
#
# The probe is scripts/mb-auth-check.ts, run with bun. Its network calls live in that
# TypeScript file so the gate can scan them (docs/quality-gates.md, rule 6); this wrapper
# only passes its arguments through. Read the .ts file for what each step checks.
#
# Usage (1Password supplies the four variables):
#   op run --env-file .env.op-refs -- ./scripts/mb-auth-check.sh --client-id 12345
#   op run --env-file .env.op-refs.prod -- ./scripts/mb-auth-check.sh --client-id 12345
#
# Without --client-id the first three steps run and the exit code is 2.
# Needs bun on PATH. On Windows use Git Bash, not WSL: WSL does not inherit the
# environment that `op run` builds.

set -eu

here="$(cd "$(dirname "$0")" && pwd)"
exec bun run "$here/mb-auth-check.ts" "$@"
