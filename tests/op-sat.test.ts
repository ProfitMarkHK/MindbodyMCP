/**
 * Offline tests for the local 1Password service-account-token (SAT) tooling.
 * All commands are captured by an injected runner: no OS store, op, or network.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
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
    readStdin: () => SAT,
    ...overrides,
  };
}

describe("profileConfig", () => {
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

});

describe("readSat and installSat", () => {
  it("reads from the injected runner", async () => {
    const runner = recordingRunner([{ exitCode: 0, stdout: `${SAT}\n`, stderr: "" }]);
    expect(await readSat("prod", context({ runner }))).toBe(SAT);
    expect(runner.calls[0].args).toContain("mindbody-prod");
  });

  it("fails closed on a failed store read without echoing output", async () => {
    const failed = recordingRunner([{ exitCode: 1, stdout: SAT, stderr: "" }]);
    await expect(readSat("prod", context({ runner: failed }))).rejects.toThrow(/Unable to read.*SAT/);
  });

  it("pipes the SAT to install and never places it in argv", async () => {
    const runner = recordingRunner();
    await installSat("prod", context({ runner, platform: "win32", localAppData: "/fake/appdata" }));
    expect(runner.calls[0].command).toBe("powershell.exe");
    expect(runner.calls[0].input).toBe(SAT);
    expect(runner.calls[0].args.join(" ")).not.toContain(SAT);
  });

  it("runs a darwin install with inherited stdio and no piped input", async () => {
    const runner = recordingRunner();
    await installSat("prod", context({
      runner,
      platform: "darwin",
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
    expect(status).toEqual({ satReadable: true, serviceAccount: true, expectedVault: true });
    expect(logs).toEqual(["sat_readable=true", "op_whoami_service_account=true", "op_vault_exact=true"]);
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
    expect(status).toEqual({ satReadable: false, serviceAccount: false, expectedVault: false });
    expect(logs).toEqual(["sat_readable=false", "op_whoami_service_account=false", "op_vault_exact=false"]);
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
