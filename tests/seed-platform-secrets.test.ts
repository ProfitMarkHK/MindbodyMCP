/**
 * Offline tests for the LOCAL platform-seeding tool. Every op/railway/az call
 * is captured by an injected runner; no platform CLI and no network is used.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SAT_ENV_VAR,
  defaultSatContext,
  type CommandResult,
  type CommandSpec,
  type SeedContext,
} from "../scripts/op-sat.js";
import { REF_FILE_ENV } from "../scripts/mcp-launch.js";
import {
  PLATFORM_KEYS,
  azureSecretName,
  buildAzureSetCommand,
  buildOpReadCommand,
  buildRailwaySetCommand,
  defaultSeedContext,
  main,
  profileForEnvironment,
  resolveValues,
  seed,
} from "../scripts/seed-platform-secrets.js";

const SAT = "ops_fake";
const REFS = [
  "MINDBODY_API_KEY=op://v/i/f",
  "MINDBODY_SITE_ID=op://v/i/f",
  "MINDBODY_SOURCE_NAME=op://v/i/f",
  "MINDBODY_SOURCE_PASSWORD=op://v/i/f",
].join("\n");

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
      const isRead = spec.command === "security" || (spec.command === "op" && spec.args[0] === "read");
      return { exitCode: 0, stdout: isRead ? SAT : "", stderr: "" };
    },
  };
}

function context(home: string, env: NodeJS.ProcessEnv = {}, overrides: Partial<SeedContext> = {}): SeedContext {
  const base = {
    ...defaultSatContext(),
    platform: "darwin" as const,
    home,
    stdinIsTty: false,
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
  it("builds an op read with the SAT in child env only", () => {
    const spec = buildOpReadCommand("op://v/i/f", SAT);
    expect(spec.command).toBe("op");
    expect(spec.args).toEqual(["read", "--no-newline", "op://v/i/f"]);
    expect(spec.env).toEqual({ [SAT_ENV_VAR]: SAT });
    expect(spec.args.join(" ")).not.toContain(SAT);
  });

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

  it("maps environment names to profiles and lists all four variables", () => {
    expect(profileForEnvironment("prod")).toBe("prod");
    expect(profileForEnvironment("production")).toBe("prod");
    expect(profileForEnvironment("sandbox")).toBe("sandbox");
    expect(profileForEnvironment("staging", { MINDBODY_OP_PROFILE: "sandbox" })).toBe("sandbox");
    expect(() => profileForEnvironment("staging")).toThrow(/MINDBODY_OP_PROFILE/);
    expect(PLATFORM_KEYS).toHaveLength(4);
    expect(defaultSeedContext().tempRoot).toBe(tmpdir());
  });
});

describe("resolveValues", () => {
  it("resolves all four refs through op read", async () => {
    const runner = recordingRunner();
    const refs = Object.fromEntries(PLATFORM_KEYS.map((key) => [key, "op://v/i/f"]));
    const values = await resolveValues("prod", refs, SAT, runner);
    expect(values.map(([key]) => key)).toEqual([...PLATFORM_KEYS]);
    expect(values.every(([, value]) => value === SAT)).toBe(true);
    expect(runner.calls.every((spec) => !spec.args.join(" ").includes(SAT))).toBe(true);
  });

  it("uses the pinned site for sandbox and fails on a missing ref for prod", async () => {
    const runner = recordingRunner();
    const refs = Object.fromEntries(
      PLATFORM_KEYS.filter((key) => key !== "MINDBODY_SITE_ID").map((key) => [key, "op://v/i/f"])
    );
    const values = await resolveValues("sandbox", refs, SAT, runner);
    expect(values.find(([key]) => key === "MINDBODY_SITE_ID")?.[1]).toBe("-99");
    await expect(resolveValues("prod", refs, SAT, runner)).rejects.toThrow(/MINDBODY_SITE_ID/);
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
      expect(writes.map((spec) => spec.args[2])).toEqual([...PLATFORM_KEYS]);
      expect(writes.every((spec) => spec.input === SAT)).toBe(true);
      expect(writes.every((spec) => !spec.args.join(" ").includes(SAT))).toBe(true);
      expect(logs).toEqual(PLATFORM_KEYS.map((key) => `seeded ${key}`));
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
          expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
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

  it("fails closed on missing configuration, missing refs and failed writes", async () => {
    const home = mkdtempSync(join(tmpdir(), "seed-errors-"));
    try {
      const runner = recordingRunner();
      await expect(seed("unknown", "prod", context(home, {}, { runner }))).rejects.toThrow(/Unknown platform/);
      await expect(seed("railway", "prod", context(home, {}, { runner }))).rejects.toThrow(/RAILWAY_SERVICE/);
      await expect(seed("azure", "prod", context(home, {}, { runner }))).rejects.toThrow(/AZURE_KEYVAULT/);
      await expect(seed("railway", "prod", context(home, { RAILWAY_SERVICE: "svc" }, { runner }))).rejects.toThrow(
        /Missing 1Password reference file/
      );
      writeRefs(home, "MINDBODY_API_KEY=op://v/i/f\n");
      await expect(
        seed("railway", "prod", context(home, { RAILWAY_SERVICE: "svc" }, { runner }))
      ).rejects.toThrow(/MINDBODY_SITE_ID/);
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
