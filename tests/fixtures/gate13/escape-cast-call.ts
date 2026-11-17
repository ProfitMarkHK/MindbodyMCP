import { mindbodyClient as client } from "../../../src/api/client.js";

export function readClasses() {
  return (client.get as any)("/class/classes");
}
