/**
 * Offline tests for scripts/mcp-launch.ts. Ref files hold short fake op://
 * pointers; the runner captures every spawn, and no `op` binary is invoked.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SAT_ENV_VAR,
  defaultSatContext,
  type CommandResult,
  type CommandSpec,
  type LaunchContext,
  type SatContext,
} from "../scripts/op-sat.js";
import {
  REF_FILE_ENV,
  buildLaunchPlan,
  defaultLaunchContext,
  launch,
  main,
  parseRefFile,
  refFilePath,
  validateRefFile,
} from "../scripts/mcp-launch.js";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SAT = "ops_fake";
const PROD_REFS = [
  "MINDBODY_API_KEY=op://v/i/f",
  "MINDBODY_SITE_ID=op://v/i/f",
  "MINDBODY_SOURCE_NAME=op://v/i/f",
  "MINDBODY_SOURCE_PASSWORD=op://v/i/f",
].join("\n");
const SANDBOX_REFS = [
  "MINDBODY_API_KEY=op://v/i/f",
  "MINDBODY_SOURCE_NAME=op://v/i/f",
  "MINDBODY_SOURCE_PASSWORD=op://v/i/f",
].join("\n");

let logSpy: ReturnType<typeof spyOn> | undefined;
let errorSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  logSpy?.mockRestore();
  logSpy = undefined;
  errorSpy?.mockRestore();
  errorSpy = undefined;
});

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
  const base: SatContext = {
    ...defaultSatContext(),
    platform: "darwin",
    home,
    stdinIsTty: false,
    ...overrides,
  };
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

  it("parses only KEY=op:// assignments, ignoring comments and blanks", () => {
    const parsed = parseRefFile(`# pointer file\n\n${PROD_REFS}\nNOT_A_KEY=ignored\n`);
    expect(Object.keys(parsed).sort()).toEqual([
      "MINDBODY_API_KEY",
      "MINDBODY_SITE_ID",
      "MINDBODY_SOURCE_NAME",
      "MINDBODY_SOURCE_PASSWORD",
    ]);
    expect(parsed.MINDBODY_API_KEY).toBe("op://v/i/f");
    const quote = String.fromCharCode(34);
    const quotedLine = `MINDBODY_API_KEY=${quote}op://v/i/f${quote}`;
    expect(parseRefFile(quotedLine).MINDBODY_API_KEY).toBe("op://v/i/f");
  });

  it("requires a site ref for prod but not for sandbox", () => {
    expect(() => validateRefFile(PROD_REFS, "prod")).not.toThrow();
    expect(() => validateRefFile(SANDBOX_REFS, "sandbox")).not.toThrow();
    expect(() => validateRefFile(SANDBOX_REFS, "prod")).toThrow(/MINDBODY_SITE_ID/);
    expect(() => validateRefFile("MINDBODY_API_KEY=plain", "sandbox")).toThrow(/MINDBODY_SOURCE_NAME/);
  });
});

describe("buildLaunchPlan", () => {
  it("builds an op run plan with only child env carrying the SAT", () => {
    const plan = buildLaunchPlan("sandbox", SAT, { home: "/home/tester" });
    expect(plan.command).toBe("op");
    expect(plan.args).toEqual([
      "run",
      `--env-file=${join("/home/tester", ".config", "mindbody", "sandbox.env")}`,
      "--",
      "bun",
      "run",
      "scripts/dev-sandbox.ts",
    ]);
    expect(plan.env).toEqual({ [SAT_ENV_VAR]: SAT });
    expect(plan.stdio).toBe("inherit");
    expect(plan.cwd).toBe(REPO_ROOT);
    expect(plan.args.join(" ")).not.toContain(SAT);
  });

  it("honours an explicit ref file and the prod entry", () => {
    const plan = buildLaunchPlan("prod", SAT, { refFile: "/tmp/refs.env", home: "/home/tester" });
    expect(plan.args[1]).toBe("--env-file=/tmp/refs.env");
    expect(plan.entry).toBe("src/index.ts");
    expect(buildLaunchPlan("prod", SAT, { env: { [REF_FILE_ENV]: "/tmp/from-env.env" } }).refFile).toBe(
      "/tmp/from-env.env"
    );
  });
});

describe("launch", () => {
  it("validates refs, reads the SAT, then spawns op run with inherited stdio", async () => {
    const home = mkdtempSync(join(tmpdir(), "mcp-launch-home-"));
    try {
      const refFile = writeRefFile(home, "sandbox", SANDBOX_REFS);
      const runner = recordingRunner([{ exitCode: 0, stdout: `${SAT}\n`, stderr: "" }]);
      logSpy = spyOn(console, "log").mockImplementation(() => {});
      expect(await launch("sandbox", context(home, { runner }))).toBe(0);
      expect(runner.calls).toHaveLength(2);
      expect(runner.calls[0].command).toBe("security");
      const child = runner.calls[1];
      expect(child.command).toBe("op");
      expect(child.args).toEqual(["run", `--env-file=${refFile}`, "--", "bun", "run", "scripts/dev-sandbox.ts"]);
      expect(child.env).toEqual({ [SAT_ENV_VAR]: SAT });
      expect(child.stdio).toBe("inherit");
      expect(child.cwd).toBe(REPO_ROOT);
      expect(child.args.join(" ")).not.toContain(SAT);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("fails when the ref file is missing or malformed, before spawning the child", async () => {
    const home = mkdtempSync(join(tmpdir(), "mcp-launch-missing-"));
    try {
      const runner = recordingRunner();
      await expect(launch("sandbox", context(home, { runner }))).rejects.toThrow(/Missing 1Password reference file/);
      expect(runner.calls).toHaveLength(0);
      writeRefFile(home, "prod", "MINDBODY_API_KEY=plain\n");
      await expect(launch("prod", context(home, { runner }))).rejects.toThrow(/op:\/\/ references/);
      expect(runner.calls).toHaveLength(0);
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
        { exitCode: 7, stdout: "", stderr: "" },
      ]);
      logSpy = spyOn(console, "log").mockImplementation(() => {});
      expect(await launch("sandbox", context(home, { runner }))).toBe(7);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a bad CLI profile", async () => {
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["staging"], context("/fake/home"))).toBe(2);
  });

  it("exposes a default context", () => {
    expect(defaultLaunchContext().env).toBe(process.env);
  });
});
