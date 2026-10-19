import { SimpleCache } from "../../../src/cache/index";

// Path-keyed lookups on a Map or a cache are not API reads.
const routeTable = new Map<string, number>([["/class/classes", 1]]);
const cache = new SimpleCache();

export function lookups(dynamicKey: string) {
  return [routeTable.get("/class/classes"), routeTable.get(dynamicKey), cache.get<number>(dynamicKey)];
}
