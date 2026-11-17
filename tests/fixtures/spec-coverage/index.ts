// Fixture for tests/spec-coverage.test.ts: a miniature src/index.ts.
import { listClasses as listClassesTool, bookClass, localOnly } from './tools.js';

declare const client: any;

export const tools = [
  { name: 'listClasses', inputSchema: {} },
  { name: 'listClassesAlias', inputSchema: {} },
  { name: 'bookClass', inputSchema: {} },
  { name: 'readSite', inputSchema: {} },
  { name: 'localOnly', inputSchema: {} },
];

export async function dispatch(name: string) {
  switch (name) {
    case 'listClasses':
    case 'listClassesAlias':
      return listClassesTool();
    case 'bookClass':
      return bookClass();
    case 'readSite':
      return client.get('/site/sites');
    case 'localOnly':
      return localOnly();
    case 'notRegistered':
      return client.get('/staff/staff');
  }
}
