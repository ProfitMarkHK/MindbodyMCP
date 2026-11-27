/**
 * The `prepare` script installs the pre-commit hook on `bun install`.
 *
 * It runs here under Bun's own shell (`--shell=bun`), which is what Windows
 * uses, so a shell construct it cannot parse fails on Linux CI too.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scripts } from "../package.json";

// A git hook exports GIT_DIR and friends, and the pre-commit hook runs this
// suite. Left in place, they would point `git config` at the real repository.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
);

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "prepare-script-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  return Bun.spawnSync(["git", ...args], { cwd, env });
}

function hooksPath(repo: string): string {
  return git(repo, "config", "--local", "--get", "core.hooksPath").stdout.toString().trim();
}

function runPrepare(dir: string) {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { prepare: scripts.prepare } }));
  const result = Bun.spawnSync([process.execPath, "run", "--shell=bun", "prepare"], { cwd: dir, env });
  return { exitCode: result.exitCode, stderr: result.stderr.toString() };
}

describe("prepare script", () => {
  test("sets core.hooksPath in a git checkout", () => {
    git(root, "init", "--quiet");

    expect(runPrepare(root)).toMatchObject({ exitCode: 0 });
    expect(hooksPath(root)).toBe(".githooks");
  });

  test("succeeds outside a git checkout", () => {
    expect(runPrepare(root)).toMatchObject({ exitCode: 0 });
  });

  test("leaves an enclosing repository alone", () => {
    git(root, "init", "--quiet");
    const nested = join(root, "vendor");
    mkdirSync(nested);

    expect(runPrepare(nested)).toMatchObject({ exitCode: 0 });
    expect(hooksPath(root)).toBe("");
  });
});
