/**
 * Offline tests for the LOCAL platform-seeding tool. Every op/railway/az call
 * is captured by an injected runner; no platform CLI and no network is used.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSatContext, type CommandResult, type CommandSpec } from "../scripts/op-sat.js";
import { REF_FILE_ENV } from "../scripts/mcp-launch.js";
import {
  azureSecretName,
  buildAzureSetCommand,
  buildRailwaySetCommand,
  defaultSeedContext,
  main,
  profileForEnvironment,
  seed,
  type SeedContext,
} from "../scripts/seed-platform-secrets.js";

const SAT = "ops_fake";
const PLATFORM_KEYS = ["MINDBODY_API_KEY", "MINDBODY_SITE_ID", "MINDBODY_SOURCE_NAME", "MINDBODY_SOURCE_PASSWORD"];
const REFS = PLATFORM_KEYS.map((key) => `${key}=op://v/i/f`).join("\n");

let logSpy: ReturnType<typeof spyOn> | undefined;
let errorSpy: ReturnType<typeof spyOn> | undefined;
const logs: string[] = [];

afterEach(() => {
  logSpy?.mockRestore();
  logSpy = undefined;
  errorSpy?.mockRestore();
  errorSpy = undefined;
  logs.length = 0;
});

function captureLogs() {
  logs.length = 0;
  logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
}

function recordingRunner(onCall?: (spec: CommandSpec) => void) {
  const calls: CommandSpec[] = [];
  return {
    calls,
    run(spec: CommandSpec): CommandResult {
      calls.push(spec);
      onCall?.(spec);
      // op inject: answer every template placeholder with the fake value.
      if (spec.command === "op") return { exitCode: 0, stdout: spec.input!.replace(/\{\{.*\}\}/g, SAT), stderr: "" };
      return { exitCode: 0, stdout: spec.command === "security" ? SAT : "", stderr: "" };
    },
  };
}

function context(home: string, env: NodeJS.ProcessEnv = {}, overrides: Partial<SeedContext> = {}): SeedContext {
  const base = {
    ...defaultSatContext(),
    platform: "darwin" as const,
    home,
    env: { HOME: home, [REF_FILE_ENV]: join(home, "refs.env"), ...env },
    tempRoot: home,
  };
  return { ...base, ...overrides };
}

function writeRefs(home: string, text = REFS): string {
  mkdirSync(home, { recursive: true });
  const path = join(home, "refs.env");
  writeFileSync(path, text);
  return path;
}

describe("pure command builders", () => {
  it("builds Railway set commands with the value on stdin", () => {
    const spec = buildRailwaySetCommand("MINDBODY_API_KEY", "service", "prod", SAT);
    expect(spec.command).toBe("railway");
    expect(spec.args).toEqual([
      "variable",
      "set",
      "MINDBODY_API_KEY",
      "--stdin",
      "-s",
      "service",
      "-e",
      "prod",
      "--skip-deploys",
    ]);
    expect(spec.input).toBe(SAT);
    expect(spec.args.join(" ")).not.toContain(SAT);
  });

  it("builds Azure set commands with a temp file, never a value in argv", () => {
    const spec = buildAzureSetCommand("prod-mindbody-api-key", "vault", "/tmp/one.txt");
    expect(spec.command).toBe("az");
    expect(spec.args).toEqual([
      "keyvault",
      "secret",
      "set",
      "--vault-name",
      "vault",
      "--name",
      "prod-mindbody-api-key",
      "--file",
      "/tmp/one.txt",
    ]);
    expect(spec.input).toBeUndefined();
    expect(spec.args.join(" ")).not.toContain(SAT);
    expect(azureSecretName("MINDBODY_API_KEY", "prod")).toBe("prod-mindbody-api-key");
    expect(azureSecretName("MINDBODY_API_KEY", "prod", "custom")).toBe("custom-mindbody-api-key");
  });

  it("maps environment names to profiles", () => {
    expect(profileForEnvironment("prod")).toBe("prod");
    expect(profileForEnvironment("production")).toBe("prod");
    expect(profileForEnvironment("sandbox")).toBe("sandbox");
    expect(() => profileForEnvironment("staging")).toThrow(/Cannot map environment staging/);
    expect(defaultSeedContext().tempRoot).toBe(tmpdir());
  });
});

describe("seed", () => {
  it("seeds Railway with names only and the SAT out of argv", async () => {
    const home = mkdtempSync(join(tmpdir(), "seed-railway-"));
    try {
      writeRefs(home);
      const runner = recordingRunner();
      captureLogs();
      expect(await seed("railway", "prod", context(home, { RAILWAY_SERVICE: "svc" }, { runner }))).toBe(0);
      const writes = runner.calls.filter((spec) => spec.command === "railway");
      expect(writes).toHaveLength(4);
      expect(writes.map((spec) => spec.args[2])).toEqual(PLATFORM_KEYS);
      expect(writes.every((spec) => spec.input === SAT)).toBe(true);
      expect(writes.every((spec) => !spec.args.join(" ").includes(SAT))).toBe(true);
      expect(logs).toEqual(PLATFORM_KEYS.map((key) => `seeded ${key}`));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("seeds the pinned sandbox site when the sandbox ref file omits it", async () => {
    const home = mkdtempSync(join(tmpdir(), "seed-sandbox-"));
    try {
      writeRefs(home, REFS.split("\n").filter((line) => !line.startsWith("MINDBODY_SITE_ID")).join("\n"));
      const runner = recordingRunner();
      captureLogs();
      expect(await seed("railway", "sandbox", context(home, { RAILWAY_SERVICE: "svc" }, { runner }))).toBe(0);
      const site = runner.calls.find((spec) => spec.command === "railway" && spec.args[2] === "MINDBODY_SITE_ID");
      expect(site?.input).toBe("-99");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes mode-600 temp files for Azure and removes them in finally", async () => {
    const home = mkdtempSync(join(tmpdir(), "seed-azure-"));
    try {
      writeRefs(home);
      const observed: string[] = [];
      const runner = recordingRunner((spec) => {
        if (spec.command === "az") {
          const file = spec.args[spec.args.length - 1];
          observed.push(file);
          expect(existsSync(file)).toBe(true);
          // NTFS has no POSIX mode bits; Linux CI enforces this.
          if (process.platform !== "win32") expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
          expect(readFileSync(file, "utf8")).toBe(SAT);
        }
      });
      captureLogs();
      expect(await seed("azure", "prod", context(home, { AZURE_KEYVAULT: "vault" }, { runner }))).toBe(0);
      const writes = runner.calls.filter((spec) => spec.command === "az");
      expect(writes).toHaveLength(4);
      expect(writes[0].args[6]).toBe("prod-mindbody-api-key");
      expect(writes.every((spec) => !spec.args.join(" ").includes(SAT))).toBe(true);
      expect(observed.every((path) => !existsSync(path))).toBe(true);
      expect(logs).toEqual(PLATFORM_KEYS.map((key) => `seeded ${key}`));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("fails closed on missing configuration", async () => {
    const home = mkdtempSync(join(tmpdir(), "seed-errors-"));
    try {
      const runner = recordingRunner();
      await expect(seed("unknown", "prod", context(home, {}, { runner }))).rejects.toThrow(/Unknown platform/);
      await expect(seed("railway", "prod", context(home, {}, { runner }))).rejects.toThrow(/RAILWAY_SERVICE/);
      await expect(seed("azure", "prod", context(home, {}, { runner }))).rejects.toThrow(/AZURE_KEYVAULT/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects bad CLI arguments", async () => {
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    expect(await main([], context("/fake/home"))).toBe(2);
    expect(await main(["railway"], context("/fake/home"))).toBe(2);
  });
});
