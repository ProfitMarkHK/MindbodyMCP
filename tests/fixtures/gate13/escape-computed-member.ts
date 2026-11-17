import { mindbodyClient as client } from "../../../src/api/client.js";

export function readClasses() {
  return client["get"]("/class/classes");
}
