import { mindbodyClient as client } from "../../../src/api/client";

export function readClasses() {
  return client["get"]("/class/classes");
}
