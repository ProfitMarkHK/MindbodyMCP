import { fetchAllPages, mindbodyClient as client } from "../../../src/api/client";

// fetchAllPages handed around as a value, so the path is never at a call site.
export function readAny(path: string) {
  const page = fetchAllPages;
  return page(client, path, {}, "X");
}
