import { execSync } from "node:child_process";

export function listDir(name: string): string {
  return execSync("ls " + name).toString();
}
