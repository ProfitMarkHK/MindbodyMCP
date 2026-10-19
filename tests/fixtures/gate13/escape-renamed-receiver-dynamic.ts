import type { IMindbodyClient } from "../../../src/api/client";

// A renamed receiver with a path built at run time.
export function readById(c: IMindbodyClient, id: number) {
  return c.get(`/class/${id}`);
}
