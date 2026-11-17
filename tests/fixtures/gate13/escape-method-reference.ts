import { mindbodyClient as client } from "../../../src/api/client.js";

// The method leaves its receiver, so the call site no longer says `.get`.
export function readClasses(path: string) {
  const read = client.get.bind(client);
  return read(path);
}
