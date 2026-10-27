#!/usr/bin/env bun
// Starts the server against the Mindbody sandbox. The dev scripts inject production
// credentials through 1Password, so this one maps the MINDBODY_TEST_* values from .env
// onto the names the client reads, overriding anything already in the shell.
import { readFileSync } from 'fs';
import dotenv from 'dotenv';

export const SANDBOX_SITE_ID = '-99';
const DEFAULT_API_URL = 'https://api.mindbodyonline.com/public/v6';

/** Maps MINDBODY_TEST_* values to the names the client reads. Ignores any MINDBODY_* key. */
export function sandboxEnv(test: Record<string, string | undefined>): Record<string, string> {
  const required = ['MINDBODY_TEST_API_KEY', 'MINDBODY_TEST_SOURCE_NAME', 'MINDBODY_TEST_SOURCE_PASSWORD'];
  const missing = required.filter((key) => !test[key]);
  if (missing.length > 0) {
    throw new Error(`Missing ${missing.join(', ')} in .env; refusing to start without sandbox credentials`);
  }

  const siteId = test.MINDBODY_TEST_SITE_ID || SANDBOX_SITE_ID;
  if (siteId !== SANDBOX_SITE_ID) {
    throw new Error(`MINDBODY_TEST_SITE_ID is "${siteId}", not the sandbox (${SANDBOX_SITE_ID}); refusing to start`);
  }

  return {
    MINDBODY_API_KEY: test.MINDBODY_TEST_API_KEY!,
    MINDBODY_SITE_ID: siteId,
    MINDBODY_SOURCE_NAME: test.MINDBODY_TEST_SOURCE_NAME!,
    MINDBODY_SOURCE_PASSWORD: test.MINDBODY_TEST_SOURCE_PASSWORD!,
    MINDBODY_API_URL: test.MINDBODY_TEST_API_URL || DEFAULT_API_URL,
  };
}

if (import.meta.main) {
  Object.assign(process.env, sandboxEnv(dotenv.parse(readFileSync('.env'))));
  await import('../src/index.ts');
}
