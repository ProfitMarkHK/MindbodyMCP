/**
 * Configuration and skip/fail policy for the opt-in LIVE end-to-end tier.
 *
 * This tier talks to a real Mindbody environment. It is deliberately kept out of
 * the default `bun test` run (see `mindbody-live.e2e.ts` for the naming rule) and
 * is only executed when someone asks for it by path.
 *
 * ── Credential namespace ────────────────────────────────────────────────────
 * Credentials are read ONLY from `MINDBODY_TEST_*`. This module never reads
 * `MINDBODY_API_KEY` / `MINDBODY_SITE_ID` / `MINDBODY_SOURCE_*`, even though the
 * repo's own `.env` sets them and `bunfig.toml`'s `dotenv = true` has already
 * loaded them into `process.env` by the time this runs.
 *
 * The reason is not tidiness. The repo's `.env` points at a REAL business site,
 * not the sandbox. If the live tier inherited those values it would create
 * clients and appointments inside somebody's production account, and it would do
 * so on the first `bun test` run anybody made. A separate namespace makes that
 * failure impossible rather than merely unlikely.
 *
 * ── Skip vs fail ────────────────────────────────────────────────────────────
 * There are exactly TWO automatic skips, and they are both statements about this
 * machine rather than about the code under test:
 *
 *   1. `SKIP_LIVE_E2E` is set — someone explicitly opted out.
 *   2. No `MINDBODY_TEST_*` credentials are configured.
 *
 * Everything else fails. A SiteId that is not the sandbox refuses to run. A 403
 * (for example the sandbox's IP allow-list), a 404, a 5xx, or any unexpected
 * payload is a failure. A gate that goes quietly green because the thing it
 * meant to check never ran is worse than no gate, so this module returns
 * `refuse` — not `skip` — when the configuration would point the tier at a
 * non-sandbox site.
 */

/** The only SiteId this tier will ever write to without an explicit override. */
export const SANDBOX_SITE_ID = '-99';

export const DEFAULT_API_URL = 'https://api.mindbodyonline.com/public/v6';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** Values recognised as "on" for the opt-in flags. Anything else is off. */
export function isTruthyFlag(value: string | undefined): boolean {
  return value !== undefined && TRUTHY.has(value.trim().toLowerCase());
}

/** A present, non-blank environment value, or undefined. */
function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

export interface LiveConfig {
  /** Resolved SiteId. Always the sandbox unless a human changed it. */
  siteId: string;
  /** Base URL including the `/public/v6` suffix, as `src/api/client.ts` expects. */
  apiUrl: string;
  apiKey: string;
  sourceName: string;
  sourcePassword: string;
}

export type LiveDecision =
  | { kind: 'run'; config: LiveConfig }
  | { kind: 'skip'; reason: string }
  | { kind: 'refuse'; reason: string };

/**
 * Decide whether the live tier can run, from the environment alone.
 *
 * Pure: it reads `process.env` through an injectable parameter and performs no
 * I/O, so the decision is reproducible and testable without a network.
 */
export function resolveLiveTier(env: NodeJS.ProcessEnv = process.env): LiveDecision {
  // 1. Explicit opt-out. Checked first so it also silences the credential and
  //    SiteId diagnostics — someone who turned the tier off does not want a
  //    lecture about their environment.
  if (isTruthyFlag(readEnv(env, 'SKIP_LIVE_E2E'))) {
    return {
      kind: 'skip',
      reason: 'SKIP_LIVE_E2E is set; the live tier was explicitly disabled.',
    };
  }

  // 2. Credentials. Variable NAMES are safe to name in a message; their values
  //    are never read into any string that could be printed.
  const apiKey = readEnv(env, 'MINDBODY_TEST_API_KEY');
  const sourceName = readEnv(env, 'MINDBODY_TEST_SOURCE_NAME');
  const sourcePassword = readEnv(env, 'MINDBODY_TEST_SOURCE_PASSWORD');

  const missing: string[] = [];
  if (!apiKey) missing.push('MINDBODY_TEST_API_KEY');
  if (!sourceName) missing.push('MINDBODY_TEST_SOURCE_NAME');
  if (!sourcePassword) missing.push('MINDBODY_TEST_SOURCE_PASSWORD');

  if (missing.length > 0) {
    return {
      kind: 'skip',
      reason:
        `No live Mindbody credentials configured (missing: ${missing.join(', ')}). ` +
        'Set them to run this tier against the sandbox; see tests/live/README.md. ' +
        'The MINDBODY_* variables in the repo .env are deliberately NOT used.',
    };
  }

  // 3. SiteId guard. Read only from MINDBODY_TEST_SITE_ID, defaulting to the
  //    sandbox. A resolved value that is not `-99` means a human pointed this at
  //    a live business, and it refuses rather than defaulting or asking.
  const siteId = readEnv(env, 'MINDBODY_TEST_SITE_ID') ?? SANDBOX_SITE_ID;
  if (siteId !== SANDBOX_SITE_ID) {
    return {
      kind: 'refuse',
      reason:
        `MINDBODY_TEST_SITE_ID is "${siteId}", which is not the Mindbody sandbox (${SANDBOX_SITE_ID}). ` +
        'This tier creates and modifies records, so it will not run against a live business site. ' +
        `Unset MINDBODY_TEST_SITE_ID to use the sandbox, or set it to ${SANDBOX_SITE_ID}. ` +
        'This is a refusal, not a skip: it is a configuration error, not a missing environment.',
    };
  }

  return {
    kind: 'run',
    config: {
      siteId,
      apiUrl: readEnv(env, 'MINDBODY_TEST_API_URL') ?? DEFAULT_API_URL,
      apiKey: apiKey as string,
      sourceName: sourceName as string,
      sourcePassword: sourcePassword as string,
    },
  };
}

/**
 * Build the environment for the spawned MCP server subprocess.
 *
 * Constructed from scratch rather than spread from `process.env`: the test
 * process holds the developer's real `MINDBODY_*` credentials (via
 * `bunfig.toml`'s `dotenv = true`) and inheriting them into a child that writes
 * to a live API is the exact accident this module exists to prevent. The
 * subprocess's cwd is an empty scratch directory, so the repo `.env` is neither
 * read nor reachable from there either.
 *
 * Proxy settings are the one deliberate exception: unlike the hermetic suite,
 * which pins them to a dead port on purpose, this tier has to reach the real
 * internet and may legitimately need a corporate proxy to do it.
 */
export function buildLiveChildEnv(
  config: LiveConfig,
  scratchDir: string,
  parentEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: parentEnv.PATH ?? '/usr/bin:/bin',
    HOME: scratchDir,
    TMPDIR: scratchDir,
    NODE_ENV: 'test',
    MINDBODY_API_URL: config.apiUrl,
    MINDBODY_API_KEY: config.apiKey,
    MINDBODY_SITE_ID: config.siteId,
    MINDBODY_SOURCE_NAME: config.sourceName,
    MINDBODY_SOURCE_PASSWORD: config.sourcePassword,
  };

  for (const key of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
  ]) {
    const value = parentEnv[key];
    if (value !== undefined && value !== '') {
      env[key] = value;
    }
  }

  return env;
}