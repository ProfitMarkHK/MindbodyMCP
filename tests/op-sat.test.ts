/**
 * Offline tests for the local 1Password service-account-token (SAT) tooling.
 * All commands are captured by an injected runner: no OS store, op, or network.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SAT_ENV_VAR,
  SERVICE_NAME,
  defaultSatContext,
  doctor,
  installSat,
  main,
  profileConfig,
  readSat,
  storeCommandFor,
  useFileFallback,
  validateSatShape,
  vaultListHasOnly,
  type CommandResult,
  type CommandSpec,
  type SatContext,
} from "../scripts/op-sat.js";

const SAT = "ops_fake";
const logs: string[] = [];
let logSpy: ReturnType<typeof spyOn> | undefined;
let errorSpy: ReturnType<typeof spyOn> | undefined;

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

function context(overrides: Partial<SatContext> = {}): SatContext {
  return {
    ...defaultSatContext(),
    platform: "darwin",
    home: "/fake/home",
    localAppData: "/fake/appdata",
    stdinIsTty: false,
    readStdin: () => SAT,
    secretToolAvailable: true,
    hasDbusSession: true,
    ...overrides,
  };
}

describe("profileConfig and SAT shape", () => {
  it("maps both profiles to their account, vault, ref file and entry", () => {
    expect(profileConfig("prod", "/home/tester")).toEqual({
      profile: "prod",
      account: "mindbody-prod",
      vault: "MindbodyMCP Prod",
      refFile: join("/home/tester", ".config", "mindbody", "prod.env"),
      entry: "src/index.ts",
      label: "MindbodyMCP prod 1Password SAT",
    });
    const sandbox = profileConfig("sandbox", "/home/tester");
    expect(sandbox.account).toBe("mindbody-sandbox");
    expect(sandbox.vault).toBe("MindbodyMCP Sandbox");
    expect(sandbox.refFile).toBe(join("/home/tester", ".config", "mindbody", "sandbox.env"));
    expect(sandbox.entry).toBe("scripts/dev-sandbox.ts");
  });

  it("refuses an unknown profile", () => {
    expect(() => profileConfig("staging" as "prod")).toThrow(/Unknown 1Password profile/);
  });

  it("validates the SAT as a non-empty ops_ value and names it in errors", () => {
    expect(validateSatShape(`  ${SAT}  `)).toBe(SAT);
    expect(() => validateSatShape("")).toThrow(/service account token \(SAT\)/);
    expect(() => validateSatShape("mb_fake")).toThrow(/service account token \(SAT\)/);
    expect(() => validateSatShape("ops_")).toThrow(/service account token \(SAT\)/);
  });
});

describe("storeCommandFor", () => {
  it("uses Keychain commands with the SAT never in argv on macOS", () => {
    const read = storeCommandFor("read", "prod", context());
    expect(read).toEqual({
      command: "security",
      args: ["find-generic-password", "-a", "mindbody-prod", "-s", SERVICE_NAME, "-w"],
    });
    const install = storeCommandFor("install", "sandbox", context());
    expect(install.command).toBe("security");
    expect(install.args[install.args.length - 1]).toBe("-w");
    expect(install.args).toContain("mindbody-sandbox");
    expect(install.args.join(" ")).not.toContain(SAT);
    expect(install.stdio).toBe("inherit");
    expect(install.input).toBeUndefined();
  });

  it("uses inherited terminal stdio for a macOS install so security prompts", () => {
    const spec = storeCommandFor("install", "prod", context({ stdinIsTty: true }));
    expect(spec.stdio).toBe("inherit");
    expect(spec.input).toBeUndefined();
  });

  it("uses DPAPI on Windows with the path in env and the SAT on stdin", () => {
    const read = storeCommandFor("read", "sandbox", context({ platform: "win32" }));
    expect(read.command).toBe("powershell.exe");
    expect(read.env?.MB_OP_SAT_PATH).toBe(join("/fake/appdata", "mindbody-op-sat", "sandbox.bin"));
    expect(read.args.join(" ")).toContain("ProtectedData");
    const install = storeCommandFor("install", "prod", context({ platform: "win32" }), { input: SAT });
    expect(install.input).toBe(SAT);
    expect(install.args.join(" ")).not.toContain(SAT);
    expect(install.args.join(" ")).toContain("CurrentUser");
    expect(() => storeCommandFor("read", "prod", context({ platform: "win32", localAppData: "" }))).toThrow(
      /LOCALAPPDATA/
    );
  });

  it("uses secret-tool on Linux with the token on stdin for install", () => {
    const read = storeCommandFor("read", "prod", context({ platform: "linux" }));
    expect(read).toEqual({
      command: "secret-tool",
      args: ["lookup", "service", "mindbody-op-sat", "account", "prod"],
    });
    const install = storeCommandFor("install", "sandbox", context({ platform: "linux" }), { input: SAT });
    expect(install.args).toEqual([
      "store",
      "--label",
      "MindbodyMCP sandbox 1Password SAT",
      "service",
      "mindbody-op-sat",
      "account",
      "sandbox",
    ]);
    expect(install.input).toBe(SAT);
    expect(install.args.join(" ")).not.toContain(SAT);
  });

  it("detects the documented Linux file fallback", () => {
    expect(useFileFallback(context({ platform: "linux", secretToolAvailable: false }))).toBe(true);
    expect(useFileFallback(context({ platform: "linux", hasDbusSession: false }))).toBe(true);
    expect(useFileFallback(context({ platform: "linux" }))).toBe(false);
    expect(useFileFallback(context({ platform: "darwin", secretToolAvailable: false }))).toBe(false);
  });
});

describe("readSat and installSat", () => {
  it("reads from the injected runner and validates the shape", async () => {
    const runner = recordingRunner([{ exitCode: 0, stdout: `${SAT}\n`, stderr: "" }]);
    expect(await readSat("prod", context({ runner }))).toBe(SAT);
    expect(runner.calls[0].args).toContain("mindbody-prod");
  });

  it("fails closed on an empty or failed store read without echoing output", async () => {
    const empty = recordingRunner([{ exitCode: 0, stdout: "", stderr: SAT }]);
    await expect(readSat("prod", context({ runner: empty }))).rejects.toThrow(/Unable to read.*SAT/);
    const failed = recordingRunner([{ exitCode: 1, stdout: SAT, stderr: "" }]);
    await expect(readSat("prod", context({ runner: failed }))).rejects.toThrow(/Unable to read.*SAT/);
  });

  it("uses a mode-600 fallback file when secret-tool or D-Bus is absent", async () => {
    const home = mkdtempSync(join(tmpdir(), "op-sat-home-"));
    try {
      const ctx = context({ platform: "linux", home, secretToolAvailable: false, hasDbusSession: false });
      await expect(readSat("sandbox", ctx)).rejects.toThrow(/No 1Password service account token \(SAT\)/);
      await installSat("sandbox", ctx);
      const path = join(home, ".config", "mindbody-op-sat", "sandbox");
      expect((statSync(path).mode & 0o777).toString(8)).toBe("600");
      expect(await readSat("sandbox", ctx)).toBe(SAT);
      chmodSync(path, 0o644);
      await installSat("sandbox", ctx);
      expect((statSync(path).mode & 0o777).toString(8)).toBe("600");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("pipes the SAT to install and never places it in argv", async () => {
    const runner = recordingRunner();
    await installSat("prod", context({ runner, platform: "win32", localAppData: "/fake/appdata" }));
    expect(runner.calls[0].command).toBe("powershell.exe");
    expect(runner.calls[0].input).toBe(SAT);
    expect(runner.calls[0].args.join(" ")).not.toContain(SAT);
  });

  it("runs a darwin tty install with inherited stdio and no piped input", async () => {
    const runner = recordingRunner();
    await installSat("prod", context({
      runner,
      platform: "darwin",
      stdinIsTty: true,
      readStdin: () => {
        throw new Error("tty install must not read stdin");
      },
    }));
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].command).toBe("security");
    expect(runner.calls[0].args[runner.calls[0].args.length - 1]).toBe("-w");
    expect(runner.calls[0].stdio).toBe("inherit");
    expect(runner.calls[0].input).toBeUndefined();
    expect(runner.calls[0].args.join(" ")).not.toContain(SAT);
  });

  it("rejects a piped macOS install before reading stdin or running any command", async () => {
    const runner = recordingRunner();
    const message =
      "macOS install requires an interactive terminal for the 1Password service account token (SAT): " +
      "security -w reads from the terminal prompt, not stdin";
    await expect(
      installSat("prod", context({
        runner,
        stdinIsTty: false,
        readStdin: () => {
          throw new Error("piped SAT must not be read on macOS");
        },
      }))
    ).rejects.toThrow(message);
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects a win32 tty install before reading stdin or running any command", async () => {
    const runner = recordingRunner();
    const message =
      "Pipe the 1Password service account token (SAT) to install on Windows/Linux: " +
      "an interactive terminal is not supported; stdin must be a pipe";
    await expect(
      installSat("prod", context({
        runner,
        platform: "win32",
        stdinIsTty: true,
        readStdin: () => {
          throw new Error("tty install must not read stdin");
        },
      }))
    ).rejects.toThrow(message);
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects a Linux tty install with secret-tool before reading stdin or running any command", async () => {
    const runner = recordingRunner();
    await expect(
      installSat("prod", context({
        runner,
        platform: "linux",
        secretToolAvailable: true,
        hasDbusSession: true,
        stdinIsTty: true,
        readStdin: () => {
          throw new Error("tty install must not read stdin");
        },
      }))
    ).rejects.toThrow(/Pipe the 1Password service account token \(SAT\) to install on Windows\/Linux/);
    expect(runner.calls).toHaveLength(0);
  });

  it("refuses an invalid piped SAT and a tty install that cannot supply one", async () => {
    const runner = recordingRunner();
    await expect(
      installSat("prod", context({ runner, platform: "win32", readStdin: () => "mb_fake" }))
    ).rejects.toThrow(/Invalid 1Password service account token \(SAT\)/);
    expect(runner.calls).toHaveLength(0);
    await expect(
      installSat("prod", context({ runner, stdinIsTty: true, platform: "linux", secretToolAvailable: false }))
    ).rejects.toThrow(/Pipe the 1Password service account token \(SAT\)/);
  });
});

describe("doctor and CLI", () => {
  it("reports statuses only and checks the exact vault", async () => {
    const runner = recordingRunner([
      { exitCode: 0, stdout: `${SAT}\n`, stderr: "" },
      { exitCode: 0, stdout: "signed in as SERVICE_ACCOUNT", stderr: "" },
      { exitCode: 0, stdout: '[{"name":"MindbodyMCP Prod"}]', stderr: "" },
    ]);
    captureLogs();
    const status = await doctor("prod", context({ runner }));
    expect(status).toEqual({ satShape: true, serviceAccount: true, expectedVault: true });
    expect(logs).toEqual(["sat_shape=true", "op_whoami_service_account=true", "op_vault_exact=true"]);
    expect(logs.join("\n")).not.toContain(SAT);
    expect(runner.calls[1]).toEqual({
      command: "op",
      args: ["whoami"],
      env: { [SAT_ENV_VAR]: SAT },
    });
    expect(runner.calls[2].args).toEqual(["vault", "list", "--format=json"]);
  });

  it("fails closed when the SAT is missing and prints no value", async () => {
    const runner = recordingRunner([{ exitCode: 1, stdout: SAT, stderr: "" }]);
    captureLogs();
    const status = await doctor("sandbox", context({ runner }));
    expect(status).toEqual({ satShape: false, serviceAccount: false, expectedVault: false });
    expect(logs).toEqual(["sat_shape=false", "op_whoami_service_account=false", "op_vault_exact=false"]);
    expect(runner.calls).toHaveLength(1);
  });

  it("validates vault output strictly", () => {
    expect(vaultListHasOnly('[{"name":"MindbodyMCP Prod"}]', "MindbodyMCP Prod")).toBe(true);
    expect(vaultListHasOnly('[{"name":"Other"}]', "MindbodyMCP Prod")).toBe(false);
    expect(vaultListHasOnly('[{"name":"MindbodyMCP Prod"},{"name":"Other"}]', "MindbodyMCP Prod")).toBe(false);
    expect(vaultListHasOnly("not json", "MindbodyMCP Prod")).toBe(false);
  });

  it("rejects bad CLI arguments and returns 0 for a valid install", async () => {
    const runner = recordingRunner();
    captureLogs();
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const ctx = context({ runner, platform: "win32" });
    expect(await main([], ctx)).toBe(2);
    expect(await main(["read", "staging"], ctx)).toBe(2);
    expect(await main(["install", "prod"], ctx)).toBe(0);
    expect(runner.calls).toHaveLength(1);
  });
});
