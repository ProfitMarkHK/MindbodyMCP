import { fetchAllPages, type IMindbodyClient } from '../api/client.js';

/**
 * Production Mindbody refuses `GET /client/clients` with more than 20 `ClientIds`
 * ("ClientIds should not be more than 20", Code: InvalidParameter, seen 2026-11-11).
 * The spec documents no cap; this is observed behaviour.
 */
export const MAX_CLIENT_IDS_PER_REQUEST = 20;

/**
 * `GET /client/clients`, every page, with `ClientIds` split into chunks of at most
 * `MAX_CLIENT_IDS_PER_REQUEST`. Chunks run one after another (rate limit); any
 * failing chunk fails the whole call. Rows are de-duplicated by `Id`, first seen
 * wins, and `totalResults` is the merged row count.
 *
 * With no ids (undefined or empty) it is exactly one paged read of `params`.
 */
export async function fetchClientsByIds<T extends { Id?: unknown }>(
  client: IMindbodyClient,
  params: Record<string, unknown>,
  clientIds?: string[]
): Promise<{ items: T[]; totalResults: number }> {
  if (!clientIds || clientIds.length === 0) {
    return fetchAllPages<T>(client, '/client/clients', { ...params, ClientIds: clientIds }, 'Clients');
  }

  const ids = [...new Set(clientIds)];
  const rows = new Map<string, T>();
  for (let i = 0; i < ids.length; i += MAX_CLIENT_IDS_PER_REQUEST) {
    const { items } = await fetchAllPages<T>(
      client,
      '/client/clients',
      { ...params, ClientIds: ids.slice(i, i + MAX_CLIENT_IDS_PER_REQUEST) },
      'Clients'
    );
    for (const row of items) {
      const key = String(row?.Id);
      if (!rows.has(key)) rows.set(key, row);
    }
  }
  const items = [...rows.values()];
  return { items, totalResults: items.length };
}
