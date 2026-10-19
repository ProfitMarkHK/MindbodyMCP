#!/usr/bin/env bash
#
# live-e2e.sh — supply Mindbody sandbox credentials to the LIVE E2E tier,
# securely, from a terminal only.
#
# ── Why this wrapper exists ────────────────────────────────────────────────
# tests/live/mindbody-live.e2e.ts reads three secrets from `MINDBODY_TEST_*`.
# The repo's own `.env` holds a real business site and must never be reused for
# that (see tests/live/README.md), so the credentials have to come from
# somewhere else. The project's secrets protocol is explicit: the OWNER enters
# every secret, by hand, through a reviewed script that prompts with no echo,
# and agents never pass secrets in command-line arguments or through any channel
# that logs output. This script is that wrapper.
#
# ── What it guarantees ─────────────────────────────────────────────────────
#   1. Every value is read with `read -r -s` (no terminal echo), or taken from an
#      already-exported environment variable without prompting at all.
#   2. No secret value is EVER printed. Not truncated, not length-prefixed, not
#      masked-with-a-prefix, not base64'd. Only variable NAMES and the words
#      "set"/"not set" reach the terminal.
#   3. Values reach `bun` through this shell's exported environment only. They
#      are never passed as command-line arguments, so they cannot appear in
#      `ps` output, in a process listing, or in shell history.
#   4. An EXIT trap unsets them, so Ctrl-C or a failed run does not leave them
#      in the shell. (They are not in the caller's shell to begin with unless
#      the caller exported them there, in which case the caller owns them.)
#   5. Nothing is written inside the repository. `--save` writes at most one
#      file, at mode 600, to a path OUTSIDE the repo, and is refused outright if
#      that path resolves inside the repo. The repo's `.env` is never a target.
#
# ── Usage ──────────────────────────────────────────────────────────────────
#   scripts/live-e2e.sh              # prompt for whatever is missing, run, exit
#   scripts/live-e2e.sh --save       # same, and remember them outside the repo
#
#   # fully non-interactive, for CI or an agent that already holds the values:
#   MINDBODY_TEST_API_KEY=... MINDBODY_TEST_SOURCE_NAME=... \
#   MINDBODY_TEST_SOURCE_PASSWORD=... scripts/live-e2e.sh
#
# Exit codes: the live tier's own exit code (0 pass, non-0 fail), or 2 for a
# wrapper-level refusal (non-interactive with values missing, bad flags).

# No `set -e`: every failure here is handled explicitly so the secrets are unset
# on the way out. `set -u` and `pipefail` are on because nothing needs `set -e`
# semantics and `-u` is what catches a typo'd variable name before it silently
# expands to nothing.
set -uo pipefail

readonly SCRIPT_NAME="${0##*/}"

# The three secrets the live tier needs. NAMES only — never values.
readonly SECRET_VARS=(
  MINDBODY_TEST_API_KEY
  MINDBODY_TEST_SOURCE_NAME
  MINDBODY_TEST_SOURCE_PASSWORD
)

# The live tier's file, relative to the repo root, and the default SiteId.
readonly LIVE_TIER_PATH='./tests/live/mindbody-live.e2e.ts'

# Stand-in written in place of a value this wrapper cannot represent in its
# dotenv file (one containing a single quote or a newline). It is deliberately
# not a real value: reading it back is treated as "not saved", so the owner is
# prompted again instead of the tier failing on a placeholder credential.
readonly UNSAVED_MARKER='UNSAVED_CONTAINS_UNSUPPORTED_CHARACTERS'

# Where `--save` writes. Deliberately OUTSIDE the repository, under the user's
# own config directory. Overridable, but the override is validated below and
# refused if it lands inside the repo.
PERSIST_FILE="${MINDBODY_LIVE_E2E_CREDENTIAL_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/mindbody-live-e2e.env}"

want_save=0
want_load=1

# Set by load_persisted_value(). Holds a secret only between being read and being
# exported; unset immediately afterwards.
LOADED_VALUE=''

# Whether this script has turned terminal echo off and not yet restored it. The
# EXIT trap restores it, so Ctrl-C at a prompt cannot leave the terminal echoing
# everything the owner types afterwards.
terminal_echo_disabled=0

REPO_ROOT=''

# ── Output helpers ─────────────────────────────────────────────────────────
# Everything informational goes to stderr, so stdout stays clean for the test
# runner's own output. None of these ever receives a secret value.

note() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  local message="$1" code="${2:-2}"
  printf '%s: %s\n' "$SCRIPT_NAME" "$message" >&2
  exit "$code"
}

usage() {
  cat <<EOF
Usage: $SCRIPT_NAME [--save] [--no-load]

Supplies sandbox credentials to the LIVE E2E tier and runs it. Reads
$LIVE_TIER_PATH and exits with that tier's exit code.

  --save         After entering any missing values, write them to
                 ${PERSIST_FILE}
                 (mode 600, outside this repository) so later runs do not
                 prompt. Without this flag nothing is written anywhere.
  --no-load      Ignore any previously --save'd file for this run and prompt
                 again. (An already-exported environment variable still wins.)
                 This enables checkoutShoppingCart and purchaseContract, which
                 commit real, irreversible sale and contract records. Off by
                 default.
  -h, --help     This message.

Environment variables already set are used as-is and never re-prompted, so this
script is safe to call non-interactively. Variable NAMES are safe to mention;
their VALUES are never printed by this script, and never appear in the
arguments of any command it runs.
EOF
}

# ── Cleanup ────────────────────────────────────────────────────────────────

# Unset the secrets on every exit path, including Ctrl-C and SIGTERM. `$?` is
# captured first because the first command in a trap handler overwrites it.
# Invoked indirectly, by name, from `trap cleanup EXIT` below.
# shellcheck disable=SC2329
cleanup() {
  local status=$?
  local name
  for name in "${SECRET_VARS[@]}"; do
    unset "$name"
  done
  unset LOADED_VALUE
  restore_terminal_echo
  return "$status"
}

# Put the terminal back the way it was found. Safe to call when echo was never
# turned off, and safe to call twice.
restore_terminal_echo() {
  if [[ $terminal_echo_disabled -eq 1 ]]; then
    stty echo 2>/dev/null || true
    terminal_echo_disabled=0
  fi
}

# INT/TERM re-enter through `exit`, which fires the EXIT trap above, so there is
# exactly one place that unsets the secrets.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ── Argument parsing ───────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --save) want_save=1 ;;
    --no-load) want_load=0 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf '%s: unknown option: %s\n' "$SCRIPT_NAME" "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

# ── Locate the repo, and refuse to persist anything inside it ───────────────

if ! REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"; then
  die 'cannot resolve the repository root from this script'"'"'s location.' 1
fi

# `PERSIST_FILE` may be relative; resolve it against $HOME so the containment
# check below is meaningful, then reject anything inside the repository.
if [[ "$PERSIST_FILE" != /* ]]; then
  PERSIST_FILE="${HOME}/${PERSIST_FILE}"
fi
case "$PERSIST_FILE" in
  "$REPO_ROOT" | "$REPO_ROOT"/*)
    die "refusing to write credentials inside the repository ($PERSIST_FILE). The repo's own .env holds a production site and this script will not touch it."
    ;;
esac
if [[ "${PERSIST_FILE##*/}" == '.env' ]]; then
  die "refusing to use a file literally named .env ($PERSIST_FILE) as a credentials store."
fi

# ── Credential resolution ──────────────────────────────────────────────────

# A present, non-blank environment value, or empty.
current_value() {
  local name="$1"
  local value="${!name-}"
  [[ -n "${value//[[:space:]]/}" ]] || return 1
  printf '%s' "$value"
}

# Read one NAME=value line out of the --save'd file into LOADED_VALUE.
#
# Read with `read`, never `eval` and never `source`, so a tampered or
# hand-edited file cannot execute anything. The file this script writes quotes
# values in single quotes and refuses any value containing a single quote, so
# stripping one matching pair of quotes is a complete unquote.
load_persisted_value() {
  local name="$1" line='' raw='' found=1

  [[ -r "$PERSIST_FILE" ]] || return 1

  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$name="* ]]; then
      raw="${line#*=}"
      found=0
      break
    fi
  done <"$PERSIST_FILE"

  [[ $found -eq 0 ]] || return 1
  raw="${raw%$'\r'}"

  if [[ "$raw" == \'*\' && ${#raw} -ge 2 ]]; then
    raw="${raw:1:${#raw}-2}"
  fi
  [[ -n "$raw" ]] || return 1
  # A marker means the value was never savable. Treat it as absent.
  [[ "$raw" == "$UNSAVED_MARKER" ]] && return 1

  LOADED_VALUE="$raw"
  return 0
}

# Prompt for one secret with terminal echo disabled, then export it into this
# shell's environment.
#
# `export "NAME=value"` is a shell builtin: it writes the variable into this
# shell, not into a child process's argv, so the value cannot surface in `ps`
# output or in history. Only the NAME is ever printed back.
prompt_for_secret() {
  local name="$1" label="$2" value=''

  printf '%s' "$label" >&2

  # `read -s` asks the terminal not to echo. `stty -echo` is belt and braces for
  # the cases where that silently fails — a pty whose termios the shell cannot
  # change still echoes the whole value, which is the one thing that must never
  # happen. If `stty` cannot do it either, the script is still correct; the value
  # is simply not protected by this line.
  if stty -echo 2>/dev/null; then
    terminal_echo_disabled=1
  fi

  if ! IFS= read -r -s value; then
    restore_terminal_echo
    printf '\n' >&2
    die "no value entered for $name (input stream closed)."
  fi
  restore_terminal_echo
  printf '\n' >&2

  if [[ -z "${value//[[:space:]]/}" ]]; then
    die "$name cannot be blank."
  fi

  export "${name}=${value}"
  unset value
  printf '%s: set\n' "$name" >&2
}

# Persist the three secrets, mode 600, outside the repository.
#
# Opt-in only: without --save this function is never called. Single quotes make
# every value safe to read back verbatim; a value containing a single quote or a
# newline cannot be represented, so it is reported as not saved rather than
# written out in a form this script could not later parse.
persist_credentials() {
  local dir tmp name value rc=0 unsaved=0

  dir="$(dirname -- "$PERSIST_FILE")"
  if [[ ! -d "$dir" ]]; then
    if ! mkdir -p -- "$dir"; then
      warn "could not create $dir; credentials will NOT be saved."
      return 1
    fi
    # No `--` guard on chmod: BSD chmod does not accept one, and PERSIST_FILE is
    # always absolute by this point, so it cannot be mistaken for an option.
    chmod 700 "$dir" || warn "could not tighten permissions on $dir."
  fi

  # umask applies to everything created below, including the mktemp file.
  local old_umask
  old_umask="$(umask)"
  umask 077
  tmp="$(mktemp "${PERSIST_FILE}.XXXXXX")" || {
    umask "$old_umask"
    warn "could not create a temporary file next to $PERSIST_FILE; credentials will NOT be saved."
    return 1
  }

  {
    printf '%s\n' '# Mindbody LIVE E2E tier credentials — sandbox SiteId only.'
    printf '%s\n' '# Written by scripts/live-e2e.sh --save. Mode 600, outside the repo.'
    printf '%s\n' '# Never commit this file. Delete it when the sandbox access is not needed.'
    for name in "${SECRET_VARS[@]}"; do
      value="${!name-}"
      if [[ -z "$value" ]]; then
        printf '%s=\n' "$name"
      elif [[ "$value" == *"'"* || "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
        # A marker, not the value. `load_persisted_value` treats it as absent,
        # so the next run prompts rather than sending this placeholder as a
        # credential and failing the tier for the wrong reason.
        printf '%s=%s\n' "$name" "$UNSAVED_MARKER"
        unsaved=$((unsaved + 1))
      else
        printf "%s='%s'\n" "$name" "$value"
      fi
    done
  } >"$tmp" || rc=1

  unset value
  chmod 600 "$tmp" || rc=1

  if [[ $rc -ne 0 ]]; then
    rm -f -- "$tmp"
    umask "$old_umask"
    warn "could not write the credentials file; credentials were NOT saved."
    return 1
  fi

  mv -f -- "$tmp" "$PERSIST_FILE" || {
    rm -f -- "$tmp"
    umask "$old_umask"
    warn "could not move the credentials file into place at $PERSIST_FILE."
    return 1
  }
  umask "$old_umask"

  if [[ $unsaved -gt 0 ]]; then
    warn "$unsaved value(s) contained a single quote or a newline, which this wrapper will not write into a file it has to read back. They were NOT saved and will be asked for again next run."
  fi

  return 0
}

# ── Resolve, prompt if needed ──────────────────────────────────────────────

note "Mindbody LIVE E2E tier — credential wrapper"
note "  repository: $REPO_ROOT"
note "  persist to: $PERSIST_FILE (outside the repository; only written with --save)"
note ""

if [[ $want_load -eq 1 && -e "$PERSIST_FILE" ]]; then
  note "Found previously saved credentials at $PERSIST_FILE; using them for any value not already in the environment."
fi

missing=()
for name in "${SECRET_VARS[@]}"; do
  if current_value "$name" >/dev/null; then
    printf '%s: set (from environment)\n' "$name" >&2
    continue
  fi

  if [[ $want_load -eq 1 ]] && load_persisted_value "$name"; then
    export "${name}=${LOADED_VALUE}"
    unset LOADED_VALUE
    printf '%s: set (from saved file)\n' "$name" >&2
    continue
  fi

  missing+=("$name")
done

if [[ ${#missing[@]} -gt 0 ]]; then
  # Fail closed rather than hang: with no terminal to read from, an unset `read`
  # would spin or block forever in some callers.
  if [[ ! -t 0 ]]; then
    die "cannot prompt for ${#missing[@]} missing value(s) (${missing[*]}) because stdin is not a terminal. Set them in the environment instead — e.g.
  MINDBODY_TEST_API_KEY=... MINDBODY_TEST_SOURCE_NAME=... MINDBODY_TEST_SOURCE_PASSWORD=... $SCRIPT_NAME"
  fi

  note ""
  note "The following values are needed. Input is not echoed. Nothing is typed into a file"
  note "unless you pass --save, and even then it goes outside this repository."
  note ""
  for name in "${missing[@]}"; do
    case "$name" in
      MINDBODY_TEST_API_KEY) label='Mindbody sandbox API key: ' ;;
      MINDBODY_TEST_SOURCE_NAME) label='Mindbody sandbox Source name (the user-token identity): ' ;;
      MINDBODY_TEST_SOURCE_PASSWORD) label='Mindbody sandbox Source password: ' ;;
      *) label="$name: " ;;
    esac
    prompt_for_secret "$name" "$label"
  done
  unset missing
fi

if [[ $want_save -eq 1 ]]; then
  note ""
  if persist_credentials; then
    note "Saved to $PERSIST_FILE (mode 600). Nothing in this repository was written."
  else
    warn "credentials were not saved; you will be prompted again next run."
  fi
fi

# ── Run the live tier ──────────────────────────────────────────────────────

if [[ "${MINDBODY_TEST_SITE_ID:--99}" == '-99' ]]; then
  site_line='  site id:    -99 (Mindbody sandbox)'
else
  site_line="  site id:    ${MINDBODY_TEST_SITE_ID} (the live tier REFUSES any site but -99)"
fi

note ""
note "Running: bun test $LIVE_TIER_PATH"
note "$site_line"
note "Secret values are passed to bun through this shell's environment only."
note ""

cd -- "$REPO_ROOT" || die "cannot enter $REPO_ROOT" 1

# No secret appears in argv here, or anywhere else: the child inherits them from
# the exported environment. The tier's exit code is this script's exit code.
bun test "$LIVE_TIER_PATH"
status=$?

note ""
if [[ $status -eq 0 ]]; then
  note "Live tier PASSED (exit 0). Note: a passing run with loud mid-run skips is"
  note "reported above under 'LIVE SKIP' — read those lines before trusting a green."
else
  note "Live tier FAILED (exit $status). Credentials were present and the tier reached"
  note "the API; this is a real failure, not a skip."
fi

exit "$status"
