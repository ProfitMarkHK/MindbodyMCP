#!/usr/bin/env bun
/**
 * A tiny driver for `src/api/auth.ts`, spawned as its own process by
 * `tests/e2e-mcp-server.test.ts`.
 *
 * Why this exists instead of another MCP server subprocess: `src/index.ts` refuses
 * to start when `MINDBODY_SOURCE_NAME` / `MINDBODY_SOURCE_PASSWORD` are absent,
 * so the "no source credentials" branch of `getUserToken()` — return `null`
 * immediately, never call `/usertoken/issue`, fall back to API-key-only auth —
 * cannot be reached through the MCP server. This harness imports the *real*
 * `src/api/auth.ts` and `src/api/client.ts` with a clean-room environment, so
 * the branch is still executed end to end against the loopback stub.
 *
 * It prints one sentinel line on stdout:
 *
 *   AUTH_HARNESS_RESULT {"tokenBefore":null,...}
 *
 * Nothing here prints a credential: the report contains only whether a token was
 * present, never its value, plus the stub-visible client id.
 */

import { mindbodyAuth } from '../../src/api/auth.js';
import { mindbodyClient } from '../../src/api/client.js';

const SENTINEL = 'AUTH_HARNESS_RESULT';
const calls = Number(process.env.AUTH_HARNESS_CALLS ?? '3');

interface HarnessReport {
  /** `getUserToken()` before any API call. Serialised as a boolean. */
  tokenBefore: string | null;
  /** `getUserToken()` after the API calls. */
  tokenAfter: string | null;
  /** How many API requests were actually made through the real client. */
  apiCalls: number;
  /** Whether every API request returned data. */
  apiOk: boolean;
  /** A value read out of the response, proving the payload really arrived. */
  firstClientId: string | null;
  /** Present only when an API call threw. */
  error?: string;
}

async function main(): Promise<void> {
  const report: HarnessReport = {
    tokenBefore: await mindbodyAuth.getUserToken(),
    tokenAfter: null,
    apiCalls: 0,
    apiOk: true,
    firstClientId: null,
  };

  try {
    for (let index = 0; index < calls; index += 1) {
      // GET /client/clients is uncached in the server, so each iteration is a
      // distinct outbound request and each re-runs the auth header interceptor.
      const response = await mindbodyClient.get<any>('/client/clients', {
        params: { Limit: 1 },
      });
      report.apiCalls += 1;
      if (report.firstClientId === null) {
        report.firstClientId = response?.Clients?.[0]?.Id ?? null;
      }
    }
  } catch (error: unknown) {
    report.apiOk = false;
    report.error = error instanceof Error ? error.message : String(error);
  }

  report.tokenAfter = await mindbodyAuth.getUserToken();

  process.stdout.write(`${SENTINEL} ${JSON.stringify(report)}\n`);
}

await main();