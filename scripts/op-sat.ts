#!/usr/bin/env bun
/**
 * Local-only tooling for the 1Password SERVICE ACCOUNT TOKEN (SAT).
 *
 * The SAT authorizes the `op` CLI. It is NOT a Mindbody token: the Mindbody API key,
 * source name and source password live in 1Password and are resolved by `op inject`
 * from the ref files described in docs/SECRETS.md.
 *
 * The SAT itself is kept in the operating system's credential store:
 *   macOS    Keychain via `security`
 *   Windows  DPAPI-protected file under %LOCALAPPDATA%
 *   Linux    secret-tool (libsecret)
 *
 * Nothing here contacts Mindbody or publishes anything to a cloud platform.
 * `read` prints the SAT to stdout and nothing else; every other command prints
 * statuses or names only. Never pass the SAT as a command-line argument.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform as hostPlatform } from "node:os";

export type Profile = "prod" | "sandbox";
export type SatOperation = "read" | "install";

/** Service name under which the SAT is stored in the OS credential store. */
export const SERVICE_NAME = "op-service-account";
/** Name of the child-process variable `op` reads; never set on the parent process. */
export const SAT_ENV_VAR = "OP_SERVICE_ACCOUNT_TOKEN";
/** Linux secret-tool uses these fixed attribute names; the profile is the account. */
export const LINUX_SERVICE_ATTR = "mindbody-op-sat";

export interface ProfileConfig {
  profile: Profile;
  account: string;
  vault: string;
  /** Absolute path to the non-secret op:// reference file. */
  refFile: string;
  /** Script the launcher runs for this profile. */
  entry: string;
  label: string;
}

/**
 * Pure profile mapping. `home` is injectable so tests never touch the real home dir.
 * The account and vault values are names, not credentials.
 */
export function profileConfig(profile: Profile, home: string = homedir()): ProfileConfig {
  if (profile !== "prod" && profile !== "sandbox") {
    throw new Error(`Unknown 1Password profile: ${profile}; expected prod or sandbox`);
  }
  const isProd = profile === "prod";
  return {
    profile,
    account: isProd ? "mindbody-prod" : "mindbody-sandbox",
    vault: isProd ? "MindbodyMCP Prod" : "MindbodyMCP Sandbox",
    refFile: join(home, ".config", "mindbody", `${profile}.env`),
    entry: isProd ? "src/index.ts" : "scripts/dev-sandbox.ts",
    label: isProd ? "MindbodyMCP prod 1Password SAT" : "MindbodyMCP sandbox 1Password SAT",
  };
}

/** A command to spawn. `input` is always delivered on stdin, never in `args`. */
export interface CommandSpec {
  command: string;
  args: string[];
  input?: string;
  /** Merged over the parent's environment; a key set to `undefined` is removed from the child. */
  env?: Record<string, string | undefined>;
  stdio?: "pipe" | "inherit";
  cwd?: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface Runner {
  run(spec: CommandSpec): CommandResult | Promise<CommandResult>;
}

export const defaultRunner: Runner = {
  run(spec) {
    const result = spawnSync(spec.command, spec.args, {
      input: spec.input,
      encoding: "utf8",
      // spawnSync drops keys whose value is undefined, so an override can unset an inherited variable.
      env: spec.env ? { ...process.env, ...spec.env } : undefined,
      cwd: spec.cwd,
      stdio: spec.stdio === "inherit" ? "inherit" : "pipe",
    });
    if (result.error) throw result.error;
    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  },
};

/** Everything environment-dependent is injectable; the CLI uses the real values. */
export interface SatContext {
  runner: Runner;
  platform: NodeJS.Platform;
  home: string;
  localAppData: string;
  readStdin: () => string;
}

export function defaultSatContext(): SatContext {
  return {
    runner: defaultRunner,
    platform: hostPlatform(),
    home: homedir(),
    localAppData: process.env.LOCALAPPDATA ?? "",
    readStdin: () => readFileSync(0, "utf8"),
  };
}

/**
 * Pure command builder for the OS store. The token is absent from `args` on every
 * platform; where a tool needs it, it is placed on stdin via `input`.
 */
export function storeCommandFor(
  operation: SatOperation,
  profile: Profile,
  ctx: Pick<SatContext, "platform" | "home" | "localAppData">,
  options: { input?: string } = {}
): CommandSpec {
  const config = profileConfig(profile, ctx.home);
  if (ctx.platform === "darwin") {
    if (operation === "read") {
      return {
        command: "security",
        args: ["find-generic-password", "-a", config.account, "-s", SERVICE_NAME, "-w"],
      };
    }
    // `-w` is LAST and has no argument: security prompts on the terminal. The
    // child inherits stdio so the prompt reaches the real tty. The SAT must
    // never appear in argv.
    return {
      command: "security",
      args: ["add-generic-password", "-a", config.account, "-s", SERVICE_NAME, "-l", config.label, "-U", "-w"],
      stdio: "inherit",
    };
  }
  if (ctx.platform === "win32") {
    if (!ctx.localAppData) {
      throw new Error("LOCALAPPDATA is not set; cannot locate the Windows SAT store");
    }
    const path = join(ctx.localAppData, "mindbody-op-sat", `${profile}.bin`);
    const script =
      operation === "read"
        ? [
            "Add-Type -AssemblyName System.Security",
            "$e=[IO.File]::ReadAllBytes($env:MB_OP_SAT_PATH)",
            "$b=[System.Security.Cryptography.ProtectedData]::Unprotect($e,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
            "[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($b))",
          ].join("; ")
        : [
            "Add-Type -AssemblyName System.Security",
            "[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($env:MB_OP_SAT_PATH)) | Out-Null",
            "$b=[System.Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd().Trim())",
            "$e=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
            "[IO.File]::WriteAllBytes($env:MB_OP_SAT_PATH,$e)",
            'icacls $env:MB_OP_SAT_PATH /inheritance:r /grant:r "$($env:USERNAME):(F)" | Out-Null',
          ].join("; ");
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", script],
      env: { MB_OP_SAT_PATH: path },
      ...(options.input === undefined ? {} : { input: options.input }),
    };
  }
  if (operation === "read") {
    return {
      command: "secret-tool",
      args: ["lookup", "service", LINUX_SERVICE_ATTR, "account", profile],
    };
  }
  return {
    command: "secret-tool",
    args: ["store", "--label", config.label, "service", LINUX_SERVICE_ATTR, "account", profile],
    ...(options.input === undefined ? {} : { input: options.input }),
  };
}

/** `op vault list --format=json` must show exactly the profile's vault. */
export function vaultListHasOnly(stdout: string, vault: string): boolean {
  try {
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed) || parsed.length !== 1) return false;
    return parsed[0]?.name === vault;
  } catch {
    return false;
  }
}

export async function readSat(profile: Profile, ctx: SatContext = defaultSatContext()): Promise<string> {
  const result = await ctx.runner.run(storeCommandFor("read", profile, ctx));
  // stdout/stderr are deliberately never included: either could carry a token.
  if (result.exitCode !== 0) {
    throw new Error(`Unable to read 1Password service account token (SAT) for ${profile} from the OS store`);
  }
  return result.stdout.trim();
}

export async function installSat(profile: Profile, ctx: SatContext = defaultSatContext()): Promise<void> {
  // macOS: `security -w` prompts on the inherited terminal. Windows and Linux: the SAT is piped in.
  const input = ctx.platform === "darwin" ? undefined : ctx.readStdin().trim();
  const result = await ctx.runner.run(storeCommandFor("install", profile, ctx, { input }));
  if (result.exitCode !== 0) {
    throw new Error(`Unable to store the 1Password service account token (SAT) for ${profile} in the OS store`);
  }
}

export interface DoctorStatus {
  satReadable: boolean;
  serviceAccount: boolean;
  expectedVault: boolean;
}

/** Statuses only: no token, no vault value, no `whoami` output is printed. */
export async function doctor(profile: Profile, ctx: SatContext = defaultSatContext()): Promise<DoctorStatus> {
  const config = profileConfig(profile, ctx.home);
  const status: DoctorStatus = { satReadable: false, serviceAccount: false, expectedVault: false };
  let sat: string | undefined;
  try {
    sat = await readSat(profile, ctx);
    status.satReadable = true;
  } catch {
    status.satReadable = false;
  }
  if (sat !== undefined) {
    const childEnv = { [SAT_ENV_VAR]: sat };
    const who = await ctx.runner.run({ command: "op", args: ["whoami"], env: childEnv });
    status.serviceAccount = who.exitCode === 0 && /SERVICE_ACCOUNT/i.test(who.stdout);
    const vaults = await ctx.runner.run({ command: "op", args: ["vault", "list", "--format=json"], env: childEnv });
    status.expectedVault = vaults.exitCode === 0 && vaultListHasOnly(vaults.stdout, config.vault);
  }
  console.log(`sat_readable=${status.satReadable}`);
  console.log(`op_whoami_service_account=${status.serviceAccount}`);
  console.log(`op_vault_exact=${status.expectedVault}`);
  return status;
}

export async function main(argv: string[], ctx: SatContext = defaultSatContext()): Promise<number> {
  const [command, profileArg] = argv;
  const usage = "usage: bun run scripts/op-sat.ts <install|read|doctor> <prod|sandbox>";
  if (command !== "install" && command !== "read" && command !== "doctor") {
    console.error(usage);
    return 2;
  }
  if (profileArg !== "prod" && profileArg !== "sandbox") {
    console.error(usage);
    return 2;
  }
  if (command === "read") {
    console.log(await readSat(profileArg, ctx));
    return 0;
  }
  if (command === "install") {
    await installSat(profileArg, ctx);
    console.log(`SAT stored for ${profileArg}`);
    return 0;
  }
  const status = await doctor(profileArg, ctx);
  return Object.values(status).every(Boolean) ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
