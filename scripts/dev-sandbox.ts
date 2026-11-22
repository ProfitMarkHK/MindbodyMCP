#!/usr/bin/env bun
// Starts the server against the Mindbody sandbox. The API key and Source credentials come
// from 1Password: the Claude Code entry and the dev:sandbox scripts run this under `op run`,
// which resolves the op:// references into the environment. No .env file is read. The site is
// always the sandbox (-99). An incoming MINDBODY_SITE_ID naming any other site is refused:
// that is the signature of the production item's references still being in the shell, and
// pinning -99 over it would send production Source credentials to the sandbox while hiding
// the mix-up behind an authentication failure.
export const SANDBOX_SITE_ID = '-99';
const DEFAULT_API_URL = 'https://api.mindbodyonline.com/public/v6';

/** Builds the client's environment for the sandbox from the 1Password-resolved credentials. */
export function sandboxEnv(source: Record<string, string | undefined>): Record<string, string> {
  const required = ['MINDBODY_API_KEY', 'MINDBODY_SOURCE_NAME', 'MINDBODY_SOURCE_PASSWORD'];
  const missing = required.filter((key) => !source[key]);
  if (missing.length > 0) {
    throw new Error(`Missing ${missing.join(', ')}; refusing to start without sandbox credentials`);
  }

  const requestedSiteId = source.MINDBODY_SITE_ID?.trim();
  if (requestedSiteId && requestedSiteId !== SANDBOX_SITE_ID) {
    throw new Error(
      `MINDBODY_SITE_ID is "${requestedSiteId}", not the sandbox (${SANDBOX_SITE_ID}); ` +
        'point the op:// references at the sandbox 1Password item, or unset MINDBODY_SITE_ID'
    );
  }

  return {
    MINDBODY_API_KEY: source.MINDBODY_API_KEY!,
    MINDBODY_SITE_ID: SANDBOX_SITE_ID,
    MINDBODY_SOURCE_NAME: source.MINDBODY_SOURCE_NAME!,
    MINDBODY_SOURCE_PASSWORD: source.MINDBODY_SOURCE_PASSWORD!,
    MINDBODY_API_URL: source.MINDBODY_API_URL || DEFAULT_API_URL,
  };
}

if (import.meta.main) {
  Object.assign(process.env, sandboxEnv(process.env));
  await import('../src/index.ts');
}
