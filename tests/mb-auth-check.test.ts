import { describe, expect, it } from 'bun:test';
import axios, { type AxiosAdapter, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import type { IMindbodyClient } from '../src/api/client.ts';
import { parseArgs, runProbe } from '../scripts/mb-auth-check.ts';

type Reply = { status: number; data?: unknown };

/** A fake Mindbody answering raw HTTP by `METHOD path`. Records each call so a test can see what ran. */
function fakeMindbody(replies: Record<string, Reply>) {
  const calls: string[] = [];
  const adapter: AxiosAdapter = async (config) => {
    const key = `${(config.method ?? 'get').toUpperCase()} ${config.url ?? ''}`;
    calls.push(key);
    const reply = replies[key] ?? { status: 404, data: { Error: { Message: `no reply for ${key}` } } };
    return { data: reply.data ?? {}, status: reply.status, statusText: '', headers: {}, config, request: {} } as AxiosResponse;
  };
  const http = axios.create({ baseURL: 'https://example.invalid/public/v6', adapter, validateStatus: () => true });
  return { http, calls };
}

/** The server's client stand-in: `/client/clients` answers with the rows given, and records each search. */
function fakeServerClient(rows: Array<{ Id: number }>) {
  const searches: Array<{ url: string; params: unknown }> = [];
  const client: IMindbodyClient = {
    request: async () => {
      throw new Error('not used by the probe');
    },
    post: async () => {
      throw new Error('not used by the probe');
    },
    get: async <T>(url: string, config?: AxiosRequestConfig): Promise<T> => {
      searches.push({ url, params: config?.params });
      return { Clients: rows, PaginationResponse: { TotalResults: rows.length } } as T;
    },
  };
  return { client, searches };
}

const env = {
  MINDBODY_API_KEY: 'k-test',
  MINDBODY_SITE_ID: '-99',
  MINDBODY_SOURCE_NAME: 'source-user',
  MINDBODY_SOURCE_PASSWORD: 'pw-test',
};

const allGood: Record<string, Reply> = {
  'GET /site/activationcode': { status: 200, data: { ActivationCode: 'ac-test' } },
  'POST /usertoken/issue': { status: 200, data: { AccessToken: 'tk-test' } },
  'GET /client/clientcompleteinfo': { status: 200, data: { Client: { Id: 42, FirstName: 'Ada', LastName: 'Lovelace' } } },
};

describe('mb-auth-check probe', () => {
  it('passes every step, and prints no credential, token or client name', async () => {
    const { http, calls } = fakeMindbody(allGood);
    const { client, searches } = fakeServerClient([{ Id: 42 }]);
    const lines: string[] = [];
    const code = await runProbe({ env, clientId: '42', http, client, out: (line) => lines.push(line) });

    expect(code).toBe(0);
    expect(calls).toEqual(['GET /site/activationcode', 'POST /usertoken/issue', 'GET /client/clientcompleteinfo']);
    expect(searches).toHaveLength(1);
    expect(searches[0]?.url).toBe('/client/clients');
    const searchParams = searches[0]?.params as { SearchText?: string } | undefined;
    expect(searchParams?.SearchText).toBe('Ada Lovelace');
    expect(lines.filter((line) => line.startsWith('ok'))).toHaveLength(5);
    const text = lines.join('\n');
    for (const secret of ['k-test', 'pw-test', 'tk-test', 'ac-test', 'Lovelace']) {
      expect(text).not.toContain(secret);
    }
  });

  it('blames the API key, not the source user, when step 2 is refused', async () => {
    const { http } = fakeMindbody({
      ...allGood,
      'GET /site/activationcode': { status: 401, data: { Error: { Code: 'Unauthorized', Message: 'Invalid Api-Key' } } },
      'POST /usertoken/issue': { status: 401, data: { Error: { Message: 'Invalid Api-Key' } } },
    });
    const lines: string[] = [];
    const code = await runProbe({ env, clientId: '42', http, client: fakeServerClient([]).client, out: (line) => lines.push(line) });

    expect(code).toBe(1);
    expect(lines).toContain('FAIL  GET /site/activationcode -> 401 Unauthorized: Invalid Api-Key');
    expect(lines.join('\n')).not.toContain('MINDBODY_SOURCE_NAME or MINDBODY_SOURCE_PASSWORD');
  });

  it('names the source credentials when step 3 is refused and the API key is fine', async () => {
    const { http, calls } = fakeMindbody({
      ...allGood,
      'POST /usertoken/issue': { status: 401, data: { Error: { Message: 'Invalid username or password' } } },
    });
    const lines: string[] = [];
    const code = await runProbe({ env, clientId: '42', http, client: fakeServerClient([{ Id: 42 }]).client, out: (line) => lines.push(line) });

    expect(code).toBe(1);
    expect(lines).toContain('FAIL  POST /usertoken/issue -> 401 Invalid username or password');
    expect(lines.join('\n')).toContain('MINDBODY_SOURCE_NAME or MINDBODY_SOURCE_PASSWORD');
    expect(calls).not.toContain('GET /client/clientcompleteinfo');
  });

  it('refuses a token that is accepted but does not unlock the client data', async () => {
    const { http } = fakeMindbody(allGood);
    const { client } = fakeServerClient([]);
    const lines: string[] = [];
    const code = await runProbe({ env, clientId: '42', http, client, out: (line) => lines.push(line) });

    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('token accepted, client data not visible');
  });

  it('exits 2, not 1, when the client ID is not a client on this site', async () => {
    const { http } = fakeMindbody({
      ...allGood,
      'GET /client/clientcompleteinfo': { status: 400, data: { Error: { Code: 'ClientNotFound', Message: 'Client does not exist.' } } },
    });
    const { client, searches } = fakeServerClient([{ Id: 42 }]);
    const lines: string[] = [];
    const code = await runProbe({ env, clientId: '999', http, client, out: (line) => lines.push(line) });

    expect(code).toBe(2);
    expect(searches).toHaveLength(0);
    expect(lines.join('\n')).toContain('client 999 is not on this site');
    expect(lines.join('\n')).not.toContain('auth is broken');
  });

  it('exits 2 and says the client steps were not run when no --client-id is given', async () => {
    const { http, calls } = fakeMindbody(allGood);
    const lines: string[] = [];
    const code = await runProbe({ env, http, client: fakeServerClient([]).client, out: (line) => lines.push(line) });

    expect(code).toBe(2);
    expect(calls).not.toContain('GET /client/clientcompleteinfo');
    expect(lines.join('\n')).toContain('pass --client-id');
  });

  it('fails before any request when a credential variable is missing', async () => {
    const { http, calls } = fakeMindbody(allGood);
    const lines: string[] = [];
    const partial = { ...env, MINDBODY_SOURCE_PASSWORD: undefined };
    const code = await runProbe({ env: partial, clientId: '42', http, client: fakeServerClient([]).client, out: (line) => lines.push(line) });

    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(lines.join('\n')).toContain('MINDBODY_SOURCE_PASSWORD');
  });
});

describe('mb-auth-check arguments', () => {
  it('accepts --client-id with a space or an equals sign', () => {
    expect(parseArgs(['--client-id', '42'])).toEqual({ clientId: '42' });
    expect(parseArgs(['--client-id=42'])).toEqual({ clientId: '42' });
    expect(parseArgs([])).toEqual({ clientId: undefined });
  });

  it('refuses a non-numeric client ID and unknown arguments', () => {
    expect(parseArgs(['--client-id', 'abc'])).toHaveProperty('error');
    expect(parseArgs(['--client-id'])).toHaveProperty('error');
    expect(parseArgs(['--bogus'])).toHaveProperty('error');
  });
});
