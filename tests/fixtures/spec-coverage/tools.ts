// Fixture for tests/spec-coverage.test.ts: tool functions and the helpers they reach.
declare const client: any;
declare function fetchAllPages(c: unknown, path: string): Promise<unknown[]>;

const CLASSES = '/class/classes' as const;

const pageClasses = () => fetchAllPages(client, CLASSES);

function siteZone() {
  return client.get('/site/sites');
}

export async function listClasses() {
  await siteZone();
  return [1].map(() => pageClasses()); // reached through a callback
}

export async function bookClass() {
  return client.post('/class/addclienttoclass', {});
}

export function localOnly() {
  return 42;
}

/** Called by nothing a tool reaches. */
export function orphan() {
  return client.get('/class/classvisits');
}

/** A path the spec does not define, and a method it does not allow. */
export function strays() {
  client.get('/class/nosuchpath');
  return client.post('/class/classes', {});
}
