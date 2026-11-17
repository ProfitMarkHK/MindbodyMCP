import { SimpleCache, classCache } from "../../../src/cache/index.js";

// Every way the scanner reads a benign receiver's type from declarations, without a type checker.
interface Deps {
  cache?: SimpleCache;
}

async function names(): Promise<Map<number, string>> {
  return new Map();
}

export class Holder {
  private table: Map<string, string> = new Map();
  constructor(private store: SimpleCache) {}
  read(key: string) {
    return [this.table.get(key), this.store.get(key)];
  }
}

export async function lookups(key: string, deps: Deps, override: SimpleCache | undefined, url: URL, ro: ReadonlyMap<string, number>) {
  const fromReturn = await names(); // declared return type, Promise unwrapped
  const [a, b] = await Promise.all([names(), names()]); // Promise.all destructuring
  const fallback = deps.cache ?? classCache; // interface member ?? imported instance
  const either = override || classCache; // optional annotated parameter || imported instance
  const chained = new Map<string, number>().set(key, 1); // Map#set returns the map
  return [
    fromReturn.get(1),
    a.get(1),
    b.get(2),
    fallback.get(key),
    either.get(key),
    chained.get(key),
    url.searchParams.get(key), // URL#searchParams
    ro.get(key),
  ];
}
