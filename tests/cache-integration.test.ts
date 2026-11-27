/**
 * Integration tests for the cache layer inside the class tool functions
 * (issue #2): a real SimpleCache and a stub IMindbodyClient that counts calls.
 *
 * Every getClassesTool call passes explicit dates, so the tool never resolves
 * the site timezone and the only GETs are to /class/classes.
 *
 * Time is faked with bun:test's setSystemTime, which moves both Date.now()
 * (used by SimpleCache.set) and `new Date()` (used by SimpleCache.get).
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import type { AxiosRequestConfig } from 'axios';
import type { IMindbodyClient } from '../src/api/client.js';
import { SimpleCache } from '../src/cache/index.js';
import {
  addClientToClassTool,
  getClassDescriptionsTool,
  getClassesTool,
  removeClientFromClassTool,
} from '../src/tools/classManagement.js';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const MINUTE = 60 * 1000;
const START = '2026-01-05';
const END = '2026-01-11';

const classRow = {
  Id: 501,
  ClassDescription: { Name: 'Vinyasa Flow', Description: '' },
  Staff: { Name: 'Jane Doe' },
  StartDateTime: '2026-01-05T09:00:00',
  EndDateTime: '2026-01-05T10:00:00',
  Location: { Id: 1, Name: 'Main Studio' },
  MaxCapacity: 20,
  TotalBooked: 5,
  IsWaitlistAvailable: false,
  IsCanceled: false,
  Substitute: false,
};

/** Counts every GET and POST; answers each GET with one page of one row. */
class CountingClient implements IMindbodyClient {
  readonly gets: Array<{ url: string; params: Record<string, unknown> }> = [];
  readonly posts: string[] = [];
  failPosts = false;

  async request<T>(): Promise<T> {
    throw new Error('request() is not used by these tools');
  }

  async get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    this.gets.push({ url, params: { ...config?.params } });
    const listKey = url === '/class/classdescriptions' ? 'ClassDescriptions' : 'Classes';
    const row = listKey === 'Classes' ? classRow : { Id: 10, Name: 'Hot Yoga' };
    return { [listKey]: [row], PaginationResponse: { TotalResults: 1 } } as T;
  }

  async post<T>(url: string): Promise<T> {
    this.posts.push(url);
    if (this.failPosts) throw new Error('upstream refused');
    return { Visit: { Id: 9001, ClassId: 501, ClientId: 'c1' } } as T;
  }

  getsTo(url: string): number {
    return this.gets.filter((g) => g.url === url).length;
  }
}

const classesGets = (client: CountingClient) => client.getsTo('/class/classes');

const readClasses = (
  client: CountingClient,
  cache: SimpleCache,
  filters: { locationIds?: number[]; staffIds?: number[]; classDescriptionIds?: number[] } = {}
) =>
  getClassesTool(START, END, filters.locationIds, filters.classDescriptionIds, filters.staffIds, client, cache);

describe('cache integration: getClassesTool', () => {
  let client: CountingClient;
  let cache: SimpleCache;

  beforeEach(() => {
    setSystemTime(T0);
    client = new CountingClient();
    cache = new SimpleCache(5);
  });

  afterEach(() => {
    setSystemTime(); // restore the real clock
  });

  test('identical arguments twice: one client.get, same result', async () => {
    const first = await readClasses(client, cache, { locationIds: [1], staffIds: [7] });
    const second = await readClasses(client, cache, { locationIds: [1], staffIds: [7] });

    expect(classesGets(client)).toBe(1);
    expect(client.gets).toHaveLength(1);
    expect(second).toEqual(first);
  });

  test('each unique filter combination gets its own client.get, and each is then cached', async () => {
    const combos = [
      {},
      { locationIds: [1] },
      { locationIds: [2] },
      { locationIds: [1, 2] },
      { staffIds: [7] },
      { staffIds: [8] },
      { locationIds: [1], staffIds: [7] },
      { classDescriptionIds: [10] },
    ];

    for (const combo of combos) await readClasses(client, cache, combo);
    expect(classesGets(client)).toBe(combos.length);

    // The filters reached the API: each request carried its own combination.
    const sent = client.gets.map((g) => [g.params.LocationIds, g.params.StaffIds, g.params.ClassDescriptionIds]);
    expect(sent).toEqual(combos.map((c) => [c.locationIds, c.staffIds, c.classDescriptionIds]));

    // A second pass over the same combinations is served entirely from cache.
    for (const combo of combos) await readClasses(client, cache, combo);
    expect(classesGets(client)).toBe(combos.length);
  });

  test('different date ranges are separate cache entries', async () => {
    await getClassesTool(START, END, undefined, undefined, undefined, client, cache);
    await getClassesTool(START, '2026-01-12', undefined, undefined, undefined, client, cache);
    expect(classesGets(client)).toBe(2);
  });

  test('addClientToClass invalidates the class read: next getClasses calls the API', async () => {
    await readClasses(client, cache, { locationIds: [1] });
    expect(classesGets(client)).toBe(1);

    const booked = await addClientToClassTool('c1', 501, false, false, undefined, client, cache);
    expect(booked.success).toBe(true);
    expect(client.posts).toEqual(['/class/addclienttoclass']);

    await readClasses(client, cache, { locationIds: [1] });
    expect(classesGets(client)).toBe(2);
  });

  test('addClientToClass dry run leaves the cached class read in place', async () => {
    await readClasses(client, cache, { locationIds: [1] });
    expect(classesGets(client)).toBe(1);

    const dryRun = await addClientToClassTool('c1', 501, false, false, true, client, cache);
    expect(dryRun).toMatchObject({ success: true, dryRun: true });
    expect('visitId' in dryRun).toBe(false);
    expect(client.posts).toEqual(['/class/addclienttoclass']);

    await readClasses(client, cache, { locationIds: [1] });
    expect(classesGets(client)).toBe(1); // nothing was saved, so the cache still stands
  });

  test('removeClientFromClass invalidates the class read: next getClasses calls the API', async () => {
    await readClasses(client, cache, { locationIds: [1] });
    expect(classesGets(client)).toBe(1);

    const cancelled = await removeClientFromClassTool('c1', 501, false, client, cache);
    expect(cancelled.success).toBe(true);
    expect(client.posts).toEqual(['/class/removeclientfromclass']);

    await readClasses(client, cache, { locationIds: [1] });
    expect(classesGets(client)).toBe(2);
  });

  test('a write invalidates every cached filter combination, not just one', async () => {
    await readClasses(client, cache, { locationIds: [1] });
    await readClasses(client, cache, { staffIds: [7] });
    expect(classesGets(client)).toBe(2);

    await addClientToClassTool('c1', 501, false, false, undefined, client, cache);

    await readClasses(client, cache, { locationIds: [1] });
    await readClasses(client, cache, { staffIds: [7] });
    expect(classesGets(client)).toBe(4);
  });

  test('a failed write leaves the cache in place', async () => {
    await readClasses(client, cache);
    client.failPosts = true;

    const booked = await addClientToClassTool('c1', 501, false, false, undefined, client, cache);
    const cancelled = await removeClientFromClassTool('c1', 501, false, client, cache);
    expect(booked.success).toBe(false);
    expect(cancelled.success).toBe(false);

    await readClasses(client, cache);
    expect(classesGets(client)).toBe(1);
  });

  test('a hit just inside the 5-minute TTL; a fresh client.get once it has expired', async () => {
    await readClasses(client, cache);

    setSystemTime(new Date(T0.getTime() + 5 * MINUTE)); // expiresAt is not yet < now
    await readClasses(client, cache);
    expect(classesGets(client)).toBe(1);

    setSystemTime(new Date(T0.getTime() + 5 * MINUTE + 1));
    await readClasses(client, cache);
    expect(classesGets(client)).toBe(2);

    // The refetch re-populated the cache with a fresh TTL.
    await readClasses(client, cache);
    expect(classesGets(client)).toBe(2);
  });
});

describe('cache integration: getClassDescriptionsTool (60-minute TTL override)', () => {
  afterEach(() => {
    setSystemTime();
  });

  test('outlives the 5-minute cache default and expires after 60 minutes', async () => {
    setSystemTime(T0);
    const client = new CountingClient();
    const cache = new SimpleCache(5);
    const descriptionGets = () => client.getsTo('/class/classdescriptions');

    await getClassDescriptionsTool(client, cache);
    await getClassDescriptionsTool(client, cache);
    expect(descriptionGets()).toBe(1);

    setSystemTime(new Date(T0.getTime() + 30 * MINUTE));
    await getClassDescriptionsTool(client, cache);
    expect(descriptionGets()).toBe(1);

    setSystemTime(new Date(T0.getTime() + 60 * MINUTE + 1));
    await getClassDescriptionsTool(client, cache);
    expect(descriptionGets()).toBe(2);
  });
});
