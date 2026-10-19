import type { IMindbodyClient } from "../../../src/api/client";

// A renamed receiver parameter, with the path hoisted to a module constant.
const CLASSES_PATH = "/class/classes";

export function readClasses(api: IMindbodyClient) {
  return api.get(CLASSES_PATH);
}
