import { mindbodyClient as mb } from "../../../src/api/client";

const CLASSES_PATH = "/class/classes";

export function readClasses() {
  return mb.get(CLASSES_PATH);
}
