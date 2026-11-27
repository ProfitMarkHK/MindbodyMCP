/**
 * Offline tests for scripts/mcp-launch.ts. Ref files hold short fake op://
 * pointers; the runner captures every spawn, and no `op` binary is invoked.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SAT_ENV_VAR,
  defaultSatContext,
  type CommandResult,
  type CommandSpec,
  type SatContext,
} from "../scripts/op-sat.js";
import {
  REF_FILE_ENV,
  buildInjectSpec,
  buildLaunchPlan,
  defaultLaunchContext,
  launch,
  parseRefFile,
  refFilePath,
  type LaunchContext,
} from "../scripts/mcp-launch.js";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SAT = "ops_fake";
const SANDBOX_REFS = [
  "MINDBODY_API_KEY=op://v/i/f",
  "MINDBODY_SOURCE_NAME=op://v/i/f",
  "MINDBODY_SOURCE_PASSWORD=op://v/i/f",
].join("\n");
const SANDBOX_VALUES = "MINDBODY_API_KEY=k\nMINDBODY_SOURCE_NAME=n\nMINDBODY_SOURCE_PASSWORD=p\n";

function recordingRunner(results: CommandResult[] = []) {
  const calls: CommandSpec[] = [];
  return {
    calls,
    run(spec: CommandSpec): CommandResult {
      calls.push(spec);
      return results.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

function context(home: string, overrides: Partial<SatContext> = {}): LaunchContext {
  const base: SatContext = { ...defaultSatContext(), platform: "darwin", home, ...overrides };
  return { ...base, env: { HOME: home } };
}

function writeRefFile(home: string, profile: "prod" | "sandbox", text: string): string {
  const dir = join(home, ".config", "mindbody");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${profile}.env`);
  writeFileSync(path, text);
  return path;
}

describe("reference files", () => {
  it("resolves the default path and the environment override", () => {
    expect(refFilePath("prod", {}, "/home/tester")).toBe(join("/home/tester", ".config", "mindbody", "prod.env"));
    expect(refFilePath("sandbox", { [REF_FILE_ENV]: "/tmp/custom.env" }, "/home/tester")).toBe("/tmp/custom.env");
  });

  it("parses only MINDBODY_ assignments, ignoring comments and blanks", () => {
    const parsed = parseRefFile(`# pointer file\n\n${SANDBOX_REFS}\nNOT_A_KEY=ignored\n`);
    expect(Object.keys(parsed).sort()).toEqual(["MINDBODY_API_KEY", "MINDBODY_SOURCE_NAME", "MINDBODY_SOURCE_PASSWORD"]);
    expect(parsed.MINDBODY_API_KEY).toBe("op://v/i/f");
    expect(parseRefFile(`MINDBODY_API_KEY="op://v/i/f"`).MINDBODY_API_KEY).toBe("op://v/i/f");
  });
});

describe("op inject and the server plan", () => {
  it("sends one template line per ref on stdin, with the SAT in the child env only", () => {
    const spec = buildInjectSpec({ MINDBODY_API_KEY: "op://v/i/API_KEY", MINDBODY_SOURCE_NAME: "op://v/i/NAME" }, SAT);
    expect(spec.command).toBe("op");
    expect(spec.args).toEqual(["inject"]);
    expect(spec.input).toBe("MINDBODY_API_KEY={{ op://v/i/API_KEY }}\nMINDBODY_SOURCE_NAME={{ op://v/i/NAME }}\n");
    expect(spec.env).toEqual({ [SAT_ENV_VAR]: SAT });
  });

  it("runs the profile entry under bun with the resolved values in the environment", () => {
    const plan = buildLaunchPlan("sandbox", { MINDBODY_API_KEY: "resolved" }, "/home/tester");
    expect(plan.command).toBe(process.execPath);
    expect(plan.args).toEqual(["run", "scripts/dev-sandbox.ts"]);
    expect(plan.env?.MINDBODY_API_KEY).toBe("resolved");
    expect(plan.stdio).toBe("inherit");
    expect(plan.cwd).toBe(REPO_ROOT);
    expect(buildLaunchPlan("prod", {}).args).toEqual(["run", "src/index.ts"]);
  });
});

describe("launch", () => {
  it("reads the SAT, resolves refs, then spawns the server with inherited stdio", async () => {
    const home = mkdtempSync(join(tmpdir(), "mcp-launch-home-"));
    try {
      writeRefFile(home, "sandbox", SANDBOX_REFS);
      const runner = recordingRunner([
        { exitCode: 0, stdout: `${SAT}\n`, stderr: "" },
        { exitCode: 0, stdout: SANDBOX_VALUES, stderr: "" },
      ]);
      expect(await launch("sandbox", context(home, { runner }))).toBe(0);
      expect(runner.calls.map((spec) => spec.command)).toEqual(["security", "op", process.execPath]);
      const child = runner.calls[2];
      expect(child.args).toEqual(["run", "scripts/dev-sandbox.ts"]);
      expect(child.env).toMatchObject({ MINDBODY_API_KEY: "k", MINDBODY_SOURCE_NAME: "n", MINDBODY_SOURCE_PASSWORD: "p" });
      expect(child.stdio).toBe("inherit");
      expect(child.args.join(" ")).not.toContain(SAT);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("propagates a non-zero child exit code", async () => {
    const home = mkdtempSync(join(tmpdir(), "mcp-launch-exit-"));
    try {
      writeRefFile(home, "sandbox", SANDBOX_REFS);
      const runner = recordingRunner([
        { exitCode: 0, stdout: SAT, stderr: "" },
        { exitCode: 0, stdout: SANDBOX_VALUES, stderr: "" },
        { exitCode: 7, stdout: "", stderr: "" },
      ]);
      expect(await launch("sandbox", context(home, { runner }))).toBe(7);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a bad profile before running anything", async () => {
    const runner = recordingRunner();
    await expect(launch("staging" as "prod", context("/fake/home", { runner }))).rejects.toThrow(
      /Unknown 1Password profile/
    );
    expect(runner.calls).toHaveLength(0);
  });

  it("exposes a default context", () => {
    expect(defaultLaunchContext().env).toBe(process.env);
  });
});
