#!/usr/bin/env bun
/**
 * Probe Mindbody auth in one command: which of the four credentials is wrong?
 *
 *   1. are the four variables set?                 (names only, never values)
 *   2. GET  /site/activationcode                   is the API key valid for this SiteId?
 *   3. POST /usertoken/issue                       do the source credentials authenticate?
 *   4. with --client-id:
 *      a. GET /client/clientcompleteinfo           is that client on this site? (API key only)
 *      b. GET /client/clients, searched by the     does the token unlock client data? Read
 *         client's name, through the server's      through the server's own request path.
 *         own request path
 *
 * Step 4b is the one that matters. Without a staff usertoken Mindbody answers a client-list read
 * with zero rows and no error, so a token that was issued but not attached looks like an empty
 * site (AGENTS.md, defect class 4). A read by client ID is no test: Mindbody returns the record
 * with or without a token (probed on the sandbox), so only the list is used.
 *
 * Steps 2 and 3 set their own headers, so each credential is tested on its own. Step 4b uses the
 * server's client, the one every tool uses, so a pass means the server's path can read client data.
 * The client's name is read in step 4a only to form the search. It is never printed.
 *
 * Exit codes: 0 all steps pass; 1 a credential or the token read failed; 2 a usage problem: no
 * --client-id, or that client is not on this site.
 *
 * Read-only: two GETs, one token issue, one client record, one client search. Run it through the
 * wrappers under 1Password:
 *   op run --env-file .env.op-refs -- ./scripts/mb-auth-check.sh --client-id 12345
 *   op run --env-file .env.op-refs -- pwsh -NoProfile -File ./scripts/mb-auth-check.ps1 --client-id 12345
 */
import axios, { type AxiosInstance } from 'axios';
import { fetchAllPages, mindbodyClient, type IMindbodyClient } from '../src/api/client.js';

const REQUIRED = ['MINDBODY_API_KEY', 'MINDBODY_SITE_ID', 'MINDBODY_SOURCE_NAME', 'MINDBODY_SOURCE_PASSWORD'] as const;

export const USAGE = 'usage: mb-auth-check [--client-id <numeric client ID>]';

export interface ProbeOptions {
  env: Record<string, string | undefined>;
  /** A client on the site, for step 4. Omitted, step 4 is not run. */
  clientId?: string;
  /** Raw HTTP for steps 2 to 4a, each with its own headers. Tests inject one. */
  http?: AxiosInstance;
  /** The server's client, for step 4b. Tests inject one; by default it is the server's own client. */
  client?: IMindbodyClient;
  /** Output sink, one line per call. Defaults to stdout. */
  out?: (line: string) => void;
}

export type ParsedArgs = { clientId?: string } | { error: string };

/** One answer from Mindbody, or a transport failure (no answer) reported as status 0. */
interface Answer {
  status: number;
  data: unknown;
}

/** Mindbody's own words for a failed call, as `Code: Message`, when its body has an `Error` object. */
function mindbodyDetail(data: unknown): string {
  const error = (data as { Error?: { Code?: unknown; Message?: unknown } } | null | undefined)?.Error;
  if (!error) return '';
  const code = error.Code === undefined ? '' : String(error.Code);
  const message = typeof error.Message === 'string' ? error.Message : '';
  return [code, message].filter(Boolean).join(': ');
}

function describe(answer: Answer): string {
  const detail = answer.status === 0 ? String(answer.data) : mindbodyDetail(answer.data);
  return [answer.status === 0 ? 'no response' : String(answer.status), detail].filter(Boolean).join(' ');
}

/** Runs one request and returns its answer. A refusal is an answer to report, never an exception. */
async function send(run: () => Promise<{ status: number; data: unknown }>): Promise<Answer> {
  try {
    const response = await run();
    return { status: response.status, data: response.data };
  } catch (error: unknown) {
    if (axios.isAxiosError(error) && error.response) {
      return { status: error.response.status, data: error.response.data };
    }
    return { status: 0, data: error instanceof Error ? error.message : String(error) };
  }
}

/** Runs the steps in order and returns the exit code. Each step prints one line. */
export async function runProbe(options: ProbeOptions): Promise<number> {
  const { env } = options;
  const out = options.out ?? ((line: string) => console.log(line));
  const pass = (text: string) => out(`ok    ${text}`);
  const fail = (text: string, hint?: string) => {
    out(`FAIL  ${text}`);
    if (hint) out(`      ${hint}`);
  };

  // 1. Credentials present. Names only: a value is never printed.
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) {
    fail(
      `missing environment variables: ${missing.join(' ')}`,
      'run through 1Password: op run --env-file .env.op-refs -- ./scripts/mb-auth-check.sh'
    );
    return 1;
  }
  pass(`all four variables are set (${REQUIRED.join(', ')})`);

  const apiKey = env.MINDBODY_API_KEY!;
  const siteId = env.MINDBODY_SITE_ID!;
  const http =
    options.http ??
    axios.create({
      baseURL: (env.MINDBODY_API_URL || 'https://api.mindbodyonline.com/public/v6').replace(/\/+$/, ''),
      timeout: 30_000,
      validateStatus: () => true, // a Mindbody refusal is an answer to report, not an exception
    });
  const keyHeaders = { 'Api-Key': apiKey, SiteId: siteId, Accept: 'application/json' };
  let failed = false;
  let notRun = false; // a usage problem: step 4 could not be run as asked
  let notOnSite = false; // the client ID is not a client on this site

  // 2. API key and SiteId.
  const site = await send(() => http.get('/site/activationcode', { headers: keyHeaders }));
  if (site.status === 200) {
    pass('GET /site/activationcode -> 200 (API key and SiteId are valid)');
  } else {
    failed = true;
    fail(
      `GET /site/activationcode -> ${describe(site)}`,
      'check MINDBODY_API_KEY and MINDBODY_SITE_ID and, on the sandbox, the key IP allow-list.'
    );
  }

  // 3. Source credentials -> staff usertoken.
  const issued = await send(() =>
    http.post(
      '/usertoken/issue',
      { Username: env.MINDBODY_SOURCE_NAME, Password: env.MINDBODY_SOURCE_PASSWORD },
      { headers: { ...keyHeaders, 'Content-Type': 'application/json' } }
    )
  );
  const token = issued.status === 200 ? (issued.data as { AccessToken?: unknown } | null)?.AccessToken : undefined;
  const tokenIssued = typeof token === 'string' && token.length > 0;
  if (tokenIssued) {
    pass('POST /usertoken/issue -> 200 (source credentials authenticate)');
  } else {
    failed = true;
    const reason = issued.status === 200 ? '200 with no AccessToken in the answer' : describe(issued);
    fail(
      `POST /usertoken/issue -> ${reason}`,
      site.status === 200
        ? 'the API key is fine, so this is MINDBODY_SOURCE_NAME or MINDBODY_SOURCE_PASSWORD. Fix the 1Password item, then restart the sidecar: the values are read at launch.'
        : undefined
    );
  }

  // 4. The client. Both reads need --client-id; without it, or without a token, they are not run.
  if (!options.clientId) {
    notRun = true;
    out('skip  client steps: not run, pass --client-id <id> (a client on this site)');
  } else if (!tokenIssued) {
    notRun = true;
    out('skip  client steps: not run, no token from step 3');
  } else {
    const clientId = options.clientId;

    // 4a. The record, with the API key only. It proves the client exists, not that the token works.
    const record = await send(() =>
      http.get('/client/clientcompleteinfo', { params: { ClientId: clientId }, headers: keyHeaders })
    );
    const client = (record.data as { Client?: { Id?: unknown; FirstName?: unknown; LastName?: unknown } } | null)
      ?.Client;
    const isThisClient = record.status === 200 && client !== undefined && String(client.Id) === clientId;

    if (!isThisClient && (record.status === 400 || record.status === 200)) {
      notOnSite = true;
      out(`skip  client ${clientId} is not on this site: ${describe(record)}`);
    } else if (!isThisClient) {
      failed = true;
      fail(`GET /client/clientcompleteinfo -> ${describe(record)}`);
    } else {
      pass(`GET /client/clientcompleteinfo -> client ${clientId} exists on this site`);

      // 4b. The search, through the server's own request path. Only a pass proves the token unlocks client data.
      const name = [client?.FirstName, client?.LastName]
        .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
        .join(' ');
      if (name === '') {
        notRun = true;
        out(`skip  client ${clientId} has no name to search by: the token read was not run`);
      } else {
        try {
          const { items } = await fetchAllPages<{ Id?: unknown }>(
            options.client ?? mindbodyClient,
            '/client/clients',
            { SearchText: name },
            'Clients'
          );
          if (items.some((row) => String(row?.Id) === clientId)) {
            pass(`GET /client/clients (searched for client ${clientId}) -> found: the token unlocks client data`);
          } else {
            failed = true;
            fail(
              `GET /client/clients (searched for client ${clientId}) -> ${items.length} row(s), client ${clientId} not among them: token accepted, client data not visible`,
              'check that the source user is staff on this site in the SiteId header. A token issued without staff access answers this way.'
            );
          }
        } catch (error: unknown) {
          failed = true;
          fail(`GET /client/clients (searched for client ${clientId}) -> ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  out('');
  if (failed) {
    out('Verdict: auth is broken. Correcting 1Password alone changes nothing for a running sidecar: restart it.');
    return 1;
  }
  if (notOnSite) {
    out(`Verdict: credentials 1 to 3 work; --client-id ${options.clientId} is not a client on this site. Re-run with one that is.`);
    return 2;
  }
  if (notRun) {
    out('Verdict: credentials 1 to 3 work; the client steps were not run. Re-run with --client-id <id>.');
    return 2;
  }
  out('Verdict: all four credentials work. If a running server still fails, it is holding older values: restart it.');
  return 0;
}

/** Parses the command line: only `--client-id <numeric ID>` (or `=`) is accepted. */
export function parseArgs(argv: string[]): ParsedArgs {
  let clientId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--client-id' || arg.startsWith('--client-id=')) {
      const value = arg.includes('=') ? arg.slice('--client-id='.length) : argv[++i];
      if (value === undefined || !/^\d+$/.test(value)) {
        return { error: `--client-id needs a numeric Mindbody client ID, got "${value ?? ''}"` };
      }
      clientId = value;
    } else {
      return { error: `unknown argument: ${arg}` };
    }
  }
  return { clientId };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(USAGE);
    process.exit(0);
  }
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    console.error(parsed.error);
    console.error(USAGE);
    process.exit(2);
  }
  process.exit(await runProbe({ env: process.env, clientId: parsed.clientId }));
}
